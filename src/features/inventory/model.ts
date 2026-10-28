/**
 * 商品库存与 BigSeller 自动同步 v1 —— 修复包 v2 页面纯逻辑
 * （无数据库、无环境变量、无 React；可被 Node/浏览器/单测共用）。
 *
 * 职责：
 * - 状态/触发方式/逐仓结果/文件校验/错误码 → 中文业务文案与下一步；
 * - 频率输入（分钟或小时）→ 服务端统一分钟（5–1440），越界给原因；
 * - 同步页 `?run=&mapQ=&mapPage=` 与库存页筛选 query 规范化、保留上下文的链接；
 * - 库存列表/详情的展示口径：只展示服务端 effective rows 的合计/缺口，不另算；
 * - 商品对应 R2：搜索/分页 query、手动选择草稿校验、批量只作用于勾选行；
 * - R5：pending 状态机（未决/找到/明确未找到/查询失败）与“禁用新写”判定；
 * - R7：范围未修改 / 明确清空空范围、市场选项、手动同步阻断原因；
 * - 幂等 intent = sha256(规范载荷) 的 64 位小写 hex（DB 校验 ^[a-f0-9]{64}$）。
 */

import type {
  ConfirmedMappingView,
  InventoryItemDetailDto,
  InventoryItemHistoryDto,
  InventoryItemWarehouseDto,
  InventoryListDto,
  InventoryListItemDto,
  InventoryListUnitGroupDto,
  InventoryListWarehouseRefDto,
  InventoryMappingQueueDto,
  InventoryMappingQueueItemDto,
  InventoryMarketOptionDto,
  InventoryOverviewDto,
  InventoryPendingActionDto,
  InventoryPendingAdoptionWarehouseDto,
  InventoryPendingSourceRowDto,
  InventoryPendingSourceWarehouseDto,
  InventoryProductDomesticCellDto,
  InventoryProductMarketCellDto,
  InventoryReconcileState,
  InventoryRunSummaryDto,
  InventoryScopeDto,
  InventorySourceScope,
  InventoryViewMode,
  InventoryWarehouseReadStateV2Dto,
  InventoryWarehouseRowDto,
  InventoryWarehouseSummaryDto,
} from './types';

export type Tone = 'neutral' | 'green' | 'amber' | 'red' | 'blue';

export const MIN_INTERVAL_MINUTES = 5;
export const MAX_INTERVAL_MINUTES = 1440;
export const DEFAULT_INTERVAL_MINUTES = 60;
export const INVENTORY_PAGE_SIZE = 50;
export const MAX_INVENTORY_PAGE_SIZE = 200;
export const MAX_SEARCH_LENGTH = 120;
export const MAPPING_QUEUE_PAGE_SIZE = 20;
export const MAX_CONFIRM_ROWS = 100;

/* ------------------------------------------------------------------ *
 * 时间与数字显示（确定性：固定 Asia/Shanghai）
 * ------------------------------------------------------------------ */

const SHANGHAI_TIME_ZONE = 'Asia/Shanghai';
const shanghaiFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: SHANGHAI_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** ISO 字符串 → 'YYYY-MM-DD HH:mm'（上海时间）。无效/缺失返回空串，不编造时间。 */
export function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return '';
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return '';
  const parts = shanghaiFormatter.formatToParts(new Date(timestamp));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  const year = value('year');
  const month = value('month');
  const day = value('day');
  const hour = value('hour');
  const minute = value('minute');
  if (!year || !month || !day || !hour || !minute) return '';
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

export function timestampOr(iso: string | null | undefined, fallback = '暂无记录'): string {
  return formatTimestamp(iso) || fallback;
}

/** 整数数量显示：千分位；null/NaN 不当成 0。 */
export function formatQuantity(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  const sign = value < 0 ? '-' : '';
  const digits = String(Math.abs(Math.trunc(value))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${digits}`;
}

export function formatQuantityOr(value: number | null | undefined, fallback = '—'): string {
  return formatQuantity(value) || fallback;
}

/**
 * 确定性字符串比较（Unicode 码点），不依赖服务器/浏览器的 locale/ICU。
 * 用于首屏列表排序：`localeCompare` 在 Node 与 Chromium 下可能给出不同顺序，导致 hydration 文本不一致。
 */
export function compareStableText(a: string | null | undefined, b: string | null | undefined): number {
  const left = a ?? '';
  const right = b ?? '';
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/* ------------------------------------------------------------------ *
 * 任务状态 / 触发方式 / 逐仓结果 / 问题行 / 错误码
 * ------------------------------------------------------------------ */

export interface RunStatusDisplay {
  label: string;
  tone: Tone;
  active: boolean;
  nextStep: string;
}

const RUN_STATUS: Record<string, RunStatusDisplay> = {
  queued: { label: '等待执行', tone: 'blue', active: true, nextStep: '后台每 10 秒领取一次任务；请确认页面下方“后台在线”。' },
  running: { label: '下载中', tone: 'blue', active: true, nextStep: '正在从 BigSeller 导出下载，完成后本页刷新可见结果。' },
  downloading: { label: '下载中', tone: 'blue', active: true, nextStep: '正在从 BigSeller 导出下载，完成后本页刷新可见结果。' },
  parsing: { label: '检查文件', tone: 'blue', active: true, nextStep: '正在按表头检查文件；表头/关键字段不对会整份文件阻断，不会悄悄少算。' },
  publishing: { label: '保存库存', tone: 'blue', active: true, nextStep: '正在逐仓保存库存批次；坏仓阻断该仓，好仓可独立成功。' },
  success: { label: '全部成功', tone: 'green', active: false, nextStep: '本次范围内全部仓库都已按本次观测时间保存；可到「商品库存」核对数量与来源时间。' },
  partial: {
    label: '部分成功',
    tone: 'amber',
    active: false,
    nextStep: '部分仓库没成功：失败/阻断仓保留上一成功批次并标旧时间，范围“最后全部成功时间”不刷新；按逐仓原因处理后重新同步。',
  },
  failed: { label: '失败', tone: 'red', active: false, nextStep: '本次没有仓库保存成功；上一成功批次仍然保留，按错误原因处理后再重新同步。' },
  needs_login: {
    label: '需要登录',
    tone: 'amber',
    active: false,
    nextStep: 'BigSeller 登录已失效：后台已停止自动重试。请先在浏览器亲自登录，再按运行说明由管理员确认后恢复自动同步；本页不提供绕过登录的按钮。',
  },
  outcome_unknown: {
    label: '结果待核对',
    tone: 'amber',
    active: false,
    nextStep: '保存结果暂未确认：后台会按原请求核对回执，不会重复发布；请勿新建重复任务。',
  },
};

const UNKNOWN_RUN_STATUS: RunStatusDisplay = {
  label: '状态未标注',
  tone: 'neutral',
  active: false,
  nextStep: '遇到未识别的任务状态；请刷新页面，仍异常时联系管理员查看后台日志。',
};

export function runStatusDisplay(status: string | null | undefined): RunStatusDisplay {
  return (status && RUN_STATUS[status]) || UNKNOWN_RUN_STATUS;
}

export function isActiveRunStatus(status: string | null | undefined): boolean {
  return runStatusDisplay(status).active;
}

const TRIGGER_LABELS: Record<string, string> = {
  manual: '手动触发',
  schedule: '自动计划',
  retry: '失败重试',
  recovery: '重启恢复',
};

export function triggerLabel(kind: string | null | undefined): string {
  return (kind && TRIGGER_LABELS[kind]) || '触发方式未标注';
}

const PARSE_STATUS_LABELS: Record<string, string> = {
  invalid_quantity: '数量无法解析（该行未采用，整仓阻断）',
  missing_warehouse: '缺少仓库（该行无法归属，整文件阻断）',
  missing_sku: '缺少外部 SKU（该行未采用，整仓阻断）',
  duplicate_sku: '同仓同 SKU 重复（阻断该仓，不随意求和）',
  combo_sku: '组合 SKU（整文件阻断，不发布）',
  unmapped_sku: '未对应来源 SKU（数量保留，不计入商品合计）',
};

export function parseStatusLabel(status: string | null | undefined): string {
  return (status && PARSE_STATUS_LABELS[status]) || '解析异常（该行未采用）';
}

const RUN_WAREHOUSE_STATUS_LABELS: Record<string, string> = {
  success: '已发布',
  published: '已发布',
  failed: '失败（保留上一成功批次）',
  blocked: '阻断（本次不发布该仓）',
  no_rows: '本次无数据（不发布、不清零）',
  no_data: '本次无数据（不发布、不清零）',
  empty: '本次无数据（不发布、不清零）',
  stale: '旧观测（不推进成功时间）',
  skipped: '已跳过',
  pending: '未执行',
};

export function runWarehouseStatusLabel(status: string | null | undefined): string {
  return (status && RUN_WAREHOUSE_STATUS_LABELS[status]) || '状态未标注';
}

const FILE_VALIDATION_STATUS_LABELS: Record<string, string> = {
  ok: '文件校验通过',
  blocked: '文件校验阻断（整份不发布）',
  unknown: '文件校验状态未标注',
};

export function fileValidationStatusLabel(status: string | null | undefined): string {
  return (status && FILE_VALIDATION_STATUS_LABELS[status]) || FILE_VALIDATION_STATUS_LABELS.unknown;
}

/** 数量列表头证据：真实结构可能是 {on_hand:'现有库存'}，展示时拼成可读文本。 */
export function quantityHeaderDisplay(value: string | Record<string, string> | null | undefined): string {
  if (!value) return '未标注';
  if (typeof value === 'string') return value.trim() || '未标注';
  const entries = Object.entries(value)
    .map(([key, header]) => `${key === 'on_hand' ? '现有库存' : key} → ${String(header)}`)
    .filter(Boolean);
  return entries.length > 0 ? entries.join('；') : '未标注';
}

const ACCOUNT_IDENTITY_LABELS: Record<string, string> = {
  unknown: '采集身份未标注',
  verified: '采集账号身份已核验',
  missing: '采集账号身份缺失（不发布）',
  mismatch: '采集账号身份与绑定账号不一致（不发布）',
};

export function accountIdentityLabel(status: string | null | undefined): string {
  return (status && ACCOUNT_IDENTITY_LABELS[status]) || ACCOUNT_IDENTITY_LABELS.unknown;
}

export function summarizeWarehouseCounts(summary: InventoryWarehouseSummaryDto | null | undefined): string {
  const published = Number(summary?.published ?? 0) || 0;
  const failed = Number(summary?.failed ?? 0) || 0;
  const noRows = Number(summary?.noRows ?? 0) || 0;
  const blocked = Number(summary?.blocked ?? 0) || 0;
  const parts: string[] = [];
  if (published > 0) parts.push(`发布 ${published} 仓`);
  if (blocked > 0) parts.push(`阻断 ${blocked} 仓`);
  if (failed > 0) parts.push(`失败 ${failed} 仓`);
  if (noRows > 0) parts.push(`无数据 ${noRows} 仓`);
  if (parts.length === 0) return '暂无逐仓结果';
  return parts.join(' · ');
}

export const ERROR_CODE_LABELS: Record<string, string> = {
  LOGIN_REQUIRED: 'BigSeller 登录已失效，需要人工重新登录',
  EXPORT_TIMEOUT: 'BigSeller 导出超时（后台有重试上限）',
  HEADER_INVALID: '导出文件表头不符合约定，整份文件阻断',
  FILE_EMPTY: '导出文件没有可读取的数据行，整份文件阻断',
  FILE_CORRUPTED: '导出文件损坏，整份文件阻断',
  INVENTORY_EXPORT_CONFLICT: '同一任务登记了不同的导出文件，已拒绝',
  INVENTORY_BATCH_CONFLICT: '同一任务同一仓库内容与已保存结果冲突，已拒绝',
  INVENTORY_WAREHOUSE_OUT_OF_SCOPE: '仓库已不在本次允许发布的范围内，未发布',
  INVENTORY_WAREHOUSE_UNKNOWN: '所选仓库不在该账号的仓库清单里，请重新选择',
  INVENTORY_WAREHOUSE_INCOMPLETE: '该仓登记的原行与发布子集不一致（缺行/多行/内容不同），已阻断',
  INVENTORY_WAREHOUSE_BLOCKED: '该仓存在异常行（数量/重复/组合），已阻断该仓',
  INVENTORY_FILE_BLOCKED: '文件级校验未通过（表头/组合 SKU/无法归仓），整份不发布',
  INVENTORY_ACCOUNT_IDENTITY_UNVERIFIED: '采集账号身份未核验或与绑定账号不一致，不发布',
  INVENTORY_OBSERVATION_MISSING: '缺少本次观测时间（export_finished_at），不允许发布或恢复',
  INVENTORY_LEASE_LOST: '后台执行权已被接管，旧执行者未继续写入',
  INVENTORY_MAPPING_VERSION_CONFLICT: '商品对应关系版本已变化，本次未覆盖',
  INVENTORY_MAPPING_UNIT_CONFLICT: '单位与该商品已确认单位不一致，未自动换算（需人工核对）',
  INVENTORY_MAPPING_NOT_FOUND: '对应关系不存在或已被删除，请刷新后重新核对',
  INVENTORY_MAPPING_NOT_CONFIRMED: '该对应关系已不是生效状态，无需重复停用',
  INVENTORY_MAPPING_UNCHANGED: '已存在完全相同的对应关系，本次没有新增版本',
  INVENTORY_MAPPING_INVALID: '对应内容不完整（外部 SKU、仓库、商品、单位或理由缺失），本次未绑定',
  INVENTORY_PENDING_NOT_FOUND: '没有找到原请求的待核对记录（可能已处理或已清理）；可刷新页面确认最新状态',
  INVENTORY_PENDING_ALREADY_RESOLVED: '原请求已经处理过（锁已解除）',
  INVENTORY_FORBIDDEN: '当前账户无权执行该操作',
  INVENTORY_UNIT_CONFLICT: '单位与该商品已确认单位不一致，未自动换算（需人工核对）',
  INVENTORY_REQUEST_CONFLICT: '请求编号已用于另一项操作，已拒绝',
  INVENTORY_REQUEST_INVALID: '请求编号或请求指纹无效，本次未处理；请刷新页面后重试',
  INVENTORY_REQUEST_INCOMPLETE: '原请求还没有完成回执，请稍后按原请求核对，不要新建重复请求',
  INVENTORY_INVALID_REQUEST: '请求编号或请求指纹无效，本次未处理；请刷新页面后重试',
  INVENTORY_PENDING_RECOVERY_REQUIRED: '存在未完成原请求：请先核对原请求，不能发起新的写操作',
  INVENTORY_ACCOUNT_MISSING: '还没有绑定 BigSeller 账号，无法执行该操作',
  INVENTORY_ACCOUNT_NEEDS_LOGIN: 'BigSeller 登录已失效，无法开始同步；请先人工重新登录',
  INVENTORY_ACCOUNT_DISABLED: 'BigSeller 账号已停用，无法开始同步',
  INVENTORY_SCOPE_EMPTY: '参与仓库为空，已停止发布；请先在数据同步页选择参与仓库',
  INVENTORY_INTERVAL_INVALID: '同步频率不在 5–1440 分钟范围内，设置未保存',
  INVENTORY_INVALID_INPUT: '提交内容不完整或格式不正确，本次未处理',
  INVENTORY_RUN_NOT_FOUND: '没有找到该同步任务（可能不在授权范围或已被清理）',
  INVENTORY_ITEM_NOT_FOUND: '没有找到该商品身份，可能资料已变化',
  INVENTORY_PUBLISH_FAILED: '该仓保存失败，保留上一成功批次',
  INVENTORY_READ_FAILED: '库存读取失败，本次没有读到数据',
};

/** 返回可读原因；未识别错误码给中性说明（原始码只放次要小字，不上主文案）。 */
export function errorCodeLabel(code: string | null | undefined): string | null {
  if (!code) return null;
  return ERROR_CODE_LABELS[code] ?? '来源系统或后台返回未识别的错误';
}

/** 对应确认被跳过/拒绝的原因 → 中文（服务端 skipped[].reason/code）。 */
const MAPPING_REASON_LABELS: Record<string, string> = {
  INVENTORY_MAPPING_UNCHANGED: '已存在相同对应，本次未新增版本',
  INVENTORY_MAPPING_VERSION_CONFLICT: '旧版本已变化，未覆盖',
  INVENTORY_MAPPING_INVALID: '内容不完整',
  INVENTORY_UNIT_CONFLICT: '单位与该商品已确认单位不一致',
  INVENTORY_MAPPING_UNIT_CONFLICT: '单位与该商品已确认单位不一致',
  INVENTORY_WAREHOUSE_UNKNOWN: '仓库不在账号清单/范围',
  INVENTORY_ITEM_NOT_FOUND: '目标商品不存在或已变化',
  INVENTORY_MAPPING_NOT_FOUND: '原对应关系不存在',
};

export function mappingSkipReasonLabel(reason: string | null | undefined): string {
  const code = (reason ?? '').trim().split(':')[0];
  if (!code) return '未通过服务端核对';
  return MAPPING_REASON_LABELS[code] ?? '未通过服务端核对（原因见错误码）';
}

/* ------------------------------------------------------------------ *
 * 账号 / 后台 / 仓库 / 范围
 * ------------------------------------------------------------------ */

export interface StateDisplay {
  label: string;
  tone: Tone;
  hint: string;
}

const LOGIN_STATES: Record<string, StateDisplay> = {
  active: { label: '登录有效', tone: 'green', hint: '账号登录状态正常，后台可按计划自动读取。' },
  needs_login: {
    label: '需要重新登录',
    tone: 'amber',
    hint: '请在浏览器里亲自登录 BigSeller；本包没有“已重新登录”确认入口，后台会停止自动重试，需按运行说明由管理员复位账号状态后才能继续。不要索要或填写明文密码给系统。',
  },
  disabled: { label: '账号已停用', tone: 'neutral', hint: '账号已停用，自动同步不会执行；如需恢复请由管理员在后台确认。' },
};

export function loginStateDisplay(status: string | null | undefined): StateDisplay {
  return (status && LOGIN_STATES[status]) || {
    label: '登录状态未知',
    tone: 'neutral',
    hint: '还没有读到登录状态；可刷新本页重试。',
  };
}

export function workerStateDisplay(worker: { online: boolean; lastSeenAt: string | null } | null | undefined): StateDisplay {
  if (!worker) {
    return { label: '后台未登记', tone: 'amber', hint: '后台程序还没登记心跳：请确认后台进程已启动（关闭业务网页不影响后台运行）。' };
  }
  if (worker.online) {
    return { label: '后台在线', tone: 'green', hint: '后台最近有心跳，会按计划执行自动同步。' };
  }
  return { label: '后台离线', tone: 'amber', hint: '后台最近没有心跳：自动同步会暂停；这不等于数据被清零，上一成功批次仍然保留。' };
}

const WAREHOUSE_STATUS_LABELS: Record<string, string> = {
  confirmed: '已确认参与',
  candidate: '待确认（不发布）',
  excluded: '已排除',
};

export function warehouseStatusLabel(status: string | null | undefined): string {
  return (status && WAREHOUSE_STATUS_LABELS[status]) || '状态未标注';
}

/** 范围展示：明确空范围必须说“已停止发布”，不能只说“0 个仓库”。 */
export interface ScopeDisplay {
  empty: boolean;
  count: number;
  version: number;
  label: string;
  notice: string;
  tone: Tone;
}

export function scopeDisplay(scope: Pick<InventoryScopeDto, 'empty' | 'warehouseCount' | 'version'>): ScopeDisplay {
  const count = Math.max(0, Math.trunc(scope.warehouseCount));
  const empty = scope.empty === true || count === 0;
  if (empty) {
    return {
      empty: true,
      count: 0,
      version: Math.max(0, Math.trunc(scope.version)),
      label: '参与仓库为空：已停止发布',
      notice: '当前保存的是“明确空范围”：不会回退旧范围、不会自动选全部仓库、自动与手动任务都不会发布。重新勾选参与仓库并保存后恢复。',
      tone: 'amber',
    };
  }
  return {
    empty: false,
    count,
    version: Math.max(0, Math.trunc(scope.version)),
    label: `参与仓库 ${count} 个`,
    notice: '只发布勾选范围内的仓库；新增仓库先进入待确认，不会悄悄扩大范围。',
    tone: 'blue',
  };
}

export interface ScopeChangeState {
  /** unchanged = 不改范围；changed = 提交新勾选；cleared = 明确清空（二次确认后提交）。 */
  kind: 'unchanged' | 'changed' | 'cleared';
  scopeProvided: boolean;
  warehouseIds: string[];
  requiresConfirm: boolean;
}

export function resolveScopeChange(input: {
  savedWarehouseIds: string[];
  draftWarehouseIds: string[];
}): ScopeChangeState {
  const saved = [...new Set(input.savedWarehouseIds.filter(Boolean))].sort();
  const draft = [...new Set(input.draftWarehouseIds.filter(Boolean))].sort();
  if (draft.length === 0) {
    return saved.length === 0
      ? { kind: 'unchanged', scopeProvided: false, warehouseIds: [], requiresConfirm: false }
      : { kind: 'cleared', scopeProvided: true, warehouseIds: [], requiresConfirm: true };
  }
  if (saved.join(',') === draft.join(',')) {
    return { kind: 'unchanged', scopeProvided: false, warehouseIds: [], requiresConfirm: false };
  }
  return { kind: 'changed', scopeProvided: true, warehouseIds: draft, requiresConfirm: false };
}

/** “不改范围”与“明确清空”的勾选初值（用 scope.warehouseIds，兼容旧 labels）。 */
export function selectedScopeWarehouseIds(overview: Pick<InventoryOverviewDto, 'scope' | 'warehouses'>): string[] {
  const ids = (overview.scope.warehouseIds ?? []).filter(Boolean);
  if (ids.length > 0) return ids;
  const labels = new Set((overview.scope.labels ?? []).map((label) => label.trim()).filter(Boolean));
  return overview.warehouses.filter((warehouse) => labels.has(warehouse.name.trim())).map((warehouse) => warehouse.id);
}

export interface WarehouseSuccessRow {
  warehouseId: string;
  name: string;
  lastSuccessAt: string | null;
  lastPublishAt: string | null;
  lastRunStatus: string | null;
  stale: boolean;
  failed: boolean;
  lastErrorCode: string | null;
}

export function warehouseSuccessRows(overview: Pick<InventoryOverviewDto, 'warehouses' | 'scope' | 'warehouseState'>): WarehouseSuccessRow[] {
  const stateById = new Map(overview.warehouseState.map((state) => [state.warehouseId, state]));
  const byId = new Map(overview.warehouses.map((warehouse) => [warehouse.id, warehouse]));
  const byName = new Map(overview.warehouses.map((warehouse) => [warehouse.name.trim(), warehouse]));
  const ordered: Array<{ id: string; name: string; status: string }> = [];
  const seen = new Set<string>();
  const scopeIds = (overview.scope.warehouseIds ?? []).filter(Boolean);
  for (const warehouseId of scopeIds) {
    const warehouse = byId.get(warehouseId);
    if (warehouse && !seen.has(warehouse.id)) {
      seen.add(warehouse.id);
      ordered.push(warehouse);
    }
  }
  if (ordered.length === 0) {
    for (const label of overview.scope.labels ?? []) {
      const warehouse = byName.get(label.trim());
      if (warehouse && !seen.has(warehouse.id)) {
        seen.add(warehouse.id);
        ordered.push(warehouse);
      }
    }
  }
  return ordered.map((warehouse) => {
    const state = stateById.get(warehouse.id);
    return {
      warehouseId: warehouse.id,
      name: warehouse.name,
      lastSuccessAt: state?.lastSuccessAt ?? null,
      lastPublishAt: state?.lastPublishAt ?? null,
      lastRunStatus: state?.lastRunStatus ?? null,
      stale: state?.stale ?? false,
      failed: state?.failed ?? false,
      lastErrorCode: state?.lastErrorCode ?? null,
    };
  });
}

/** 每仓状态文案：失败/旧值必须显式标出来。 */
export function warehouseStateLabel(state: Pick<InventoryWarehouseStateDtoLike, 'lastSuccessAt' | 'lastRunStatus' | 'failed' | 'stale'>): {
  label: string;
  tone: Tone;
  note: string | null;
} {
  if (!state.lastSuccessAt) {
    if (state.failed || state.stale) {
      return {
        label: '失败（尚无成功值）',
        tone: 'red',
        note: '该仓最近一次任务未成功，且还没有成功批次：不显示 0，也不当作空仓；按任务详情里的原因处理后重试。',
      };
    }
    return { label: '尚无成功记录', tone: 'amber', note: '该仓还没有成功发布的批次；不显示 0，也不当作空仓。' };
  }
  if (state.failed || state.stale) {
    return {
      label: '失败 / 保留旧值',
      tone: 'red',
      note: `该仓最近一次任务未成功：当前数量保留 ${formatTimestamp(state.lastSuccessAt)} 的上一成功批次，来源时间不会刷新。`,
    };
  }
  return { label: '正常', tone: 'green', note: null };
}

interface InventoryWarehouseStateDtoLike {
  lastSuccessAt: string | null;
  lastRunStatus: string | null;
  failed: boolean;
  stale: boolean;
  lastErrorCode?: string | null;
  lastPublishAt?: string | null;
  warehouseId?: string;
  name?: string;
}

/* ------------------------------------------------------------------ *
 * 频率
 * ------------------------------------------------------------------ */

export interface IntervalParseResult {
  ok: boolean;
  minutes: number;
  reason: string;
}

export type IntervalUnit = 'minutes' | 'hours';

export function normalizeIntervalInput(rawValue: string, unit: IntervalUnit): IntervalParseResult {
  const trimmed = (rawValue ?? '').trim();
  if (!trimmed) return { ok: false, minutes: 0, reason: '请填写同步频率（整数分钟或整数小时）。' };
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, minutes: 0, reason: '频率只能填正整数分钟或整数小时；请去掉小数、负号、空格或文字。' };
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
    return { ok: false, minutes: 0, reason: '频率超出可保存范围，请填 5–1440 分钟（或 1–24 小时）。' };
  }
  const minutes = unit === 'hours' ? value * 60 : value;
  if (!Number.isSafeInteger(minutes)) {
    return { ok: false, minutes: 0, reason: '频率超出可保存范围，请填 5–1440 分钟（或 1–24 小时）。' };
  }
  if (minutes < MIN_INTERVAL_MINUTES) {
    return { ok: false, minutes, reason: `频率不能小于 ${MIN_INTERVAL_MINUTES} 分钟；这是为了避免意外密集导出，不是 BigSeller 的平台限额。` };
  }
  if (minutes > MAX_INTERVAL_MINUTES) {
    const shown = unit === 'hours' ? `当前填的 ${value} 小时 = ${minutes} 分钟` : `当前填的 ${minutes} 分钟`;
    return { ok: false, minutes, reason: `${shown}，超过 24 小时（${MAX_INTERVAL_MINUTES} 分钟）的上限。` };
  }
  return { ok: true, minutes, reason: '' };
}

export function intervalDisplay(minutes: number | null | undefined): { inputValue: string; inputUnit: IntervalUnit; display: string } {
  const value = typeof minutes === 'number' && Number.isFinite(minutes) ? Math.trunc(minutes) : DEFAULT_INTERVAL_MINUTES;
  const display = value > 0 && value % 60 === 0 ? `每 ${value / 60} 小时（${value} 分钟）` : `每 ${value} 分钟`;
  return { inputValue: String(value), inputUnit: 'minutes', display };
}

/** 空范围/账号失效时“立即同步”应被阻断的原因；null = 允许提交。 */
export function manualSyncBlockedReason(input: {
  scopeEmpty: boolean;
  accountStatus: string | null | undefined;
}): string | null {
  if (input.scopeEmpty) return '参与仓库为空：已停止发布，无法同步；请先在数据同步页重新勾选参与仓库并保存。';
  const login = loginStateDisplay(input.accountStatus);
  if (input.accountStatus === 'needs_login') return 'BigSeller 登录已失效：请先人工重新登录并由管理员复位账号状态后再同步。';
  if (input.accountStatus === 'disabled') return 'BigSeller 账号已停用，无法同步。';
  if (input.accountStatus === 'unknown') return null;
  return login.label === '登录有效' ? null : null;
}

/* ------------------------------------------------------------------ *
 * 同步页 query：?run= & ?mapQ= & ?mapPage=
 * ------------------------------------------------------------------ */

export interface SyncQueryState {
  run: string;
  mapQ: string;
  mapPage: number;
}

export const DEFAULT_SYNC_QUERY: SyncQueryState = { run: '', mapQ: '', mapPage: 1 };

export function parseSyncSearchParams(params: URLSearchParams): SyncQueryState {
  const rawRun = (params.get('run') ?? '').trim();
  const mapQ = (params.get('mapQ') ?? '').trim().slice(0, MAX_SEARCH_LENGTH);
  return {
    run: isUuid(rawRun) ? rawRun : '',
    mapQ,
    mapPage: normalizePageNumber(Number(params.get('mapPage') ?? '1')),
  };
}

export function buildSyncUrl(state: SyncQueryState): string {
  const params = new URLSearchParams();
  if (isUuid(state.run)) params.set('run', state.run);
  if (state.mapQ) params.set('mapQ', state.mapQ);
  if (state.mapPage > 1) params.set('mapPage', String(state.mapPage));
  const qs = params.toString();
  return qs ? `/dashboard/sync?${qs}` : '/dashboard/sync';
}

export function buildSyncQueueHref(state: SyncQueryState, page: number): string {
  return buildSyncUrl({ ...state, mapPage: normalizePageNumber(page) });
}

export function mappingQueueOffset(page: number, pageSize = MAPPING_QUEUE_PAGE_SIZE): number {
  return (normalizePageNumber(page) - 1) * pageSize;
}

/* ------------------------------------------------------------------ *
 * 库存页 query（搜索/仓库/市场/分页/详情/全仓）
 * ------------------------------------------------------------------ */

export interface InventoryQueryState {
  q: string;
  warehouse: string;
  market: string;
  /** 双视图：仓库明细（默认）/ 商品汇总。 */
  view: InventoryViewMode;
  /** 来源范围：海外 / 国内快照 / 全部（两个视图共用；不跨来源相加）。 */
  source: InventorySourceScope;
  page: number;
  limit: number;
  item: string;
  /** 跨视图定位目标（商品 UUID）：商品汇总 ↔ 仓库明细互相定位时高亮该商品，不参与服务端过滤。 */
  focus: string;
  /** 仓库明细展开的行键（来源+仓+SKU）；空 = 未展开。 */
  row: string;
  /** 详情显式“查看全仓”；列表始终沿用筛选。 */
  allWarehouses: boolean;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MARKET_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,24}$/;

export function isUuid(value: string | null | undefined): boolean {
  return typeof value === 'string' && UUID_PATTERN.test(value.trim());
}

export function normalizePageNumber(raw: number): number {
  if (!Number.isFinite(raw)) return 1;
  const floored = Math.floor(raw);
  return floored >= 1 ? floored : 1;
}

export function normalizeLimit(raw: number): number {
  if (!Number.isFinite(raw)) return INVENTORY_PAGE_SIZE;
  const floored = Math.floor(raw);
  if (floored < 1) return INVENTORY_PAGE_SIZE;
  return Math.min(floored, MAX_INVENTORY_PAGE_SIZE);
}

export const DEFAULT_INVENTORY_QUERY: InventoryQueryState = {
  q: '',
  warehouse: 'all',
  market: 'all',
  view: 'warehouse',
  source: 'all',
  page: 1,
  limit: INVENTORY_PAGE_SIZE,
  item: '',
  focus: '',
  row: '',
  allWarehouses: false,
};

export function parseInventoryView(raw: string | null | undefined): InventoryViewMode {
  return raw === 'product' ? 'product' : 'warehouse';
}

export function parseInventorySourceScope(raw: string | null | undefined): InventorySourceScope {
  if (raw === 'overseas' || raw === 'domestic') return raw;
  return 'all';
}

export function parseInventorySearchParams(params: URLSearchParams): InventoryQueryState {
  const rawQ = (params.get('q') ?? '').trim().slice(0, MAX_SEARCH_LENGTH);
  const rawWarehouse = (params.get('warehouse') ?? '').trim();
  const rawMarket = (params.get('market') ?? '').trim();
  const warehouse = isUuid(rawWarehouse) ? rawWarehouse : 'all';
  const market = rawMarket === '' || rawMarket === 'all'
    ? 'all'
    : (MARKET_TOKEN_PATTERN.test(rawMarket) ? rawMarket : 'all');
  const rawItem = (params.get('item') ?? '').trim();
  const item = isUuid(rawItem) ? rawItem : '';
  const rawFocus = (params.get('focus') ?? '').trim();
  const focus = isUuid(rawFocus) ? rawFocus : '';
  const rawRow = (params.get('row') ?? '').trim().slice(0, 220);
  const row = /^[A-Za-z0-9:_-]{1,220}$/.test(rawRow) ? rawRow : '';
  const allWarehouses = Boolean(item) && ['1', 'true', 'yes'].includes((params.get('all') ?? '').toLowerCase());
  return {
    q: rawQ,
    warehouse,
    market,
    view: parseInventoryView(params.get('view')),
    source: parseInventorySourceScope(params.get('source')),
    page: normalizePageNumber(Number(params.get('page') ?? '1')),
    limit: INVENTORY_PAGE_SIZE,
    item,
    focus,
    row,
    allWarehouses,
  };
}

export function buildInventoryListHref(
  state: Pick<InventoryQueryState, 'q' | 'warehouse' | 'market' | 'page'> &
    Partial<Pick<InventoryQueryState, 'view' | 'source' | 'focus' | 'row'>>,
): string {
  const params = new URLSearchParams();
  if (state.q) params.set('q', state.q);
  if (state.warehouse && state.warehouse !== 'all') params.set('warehouse', state.warehouse);
  if (state.market && state.market !== 'all') params.set('market', state.market);
  if (state.view === 'product') params.set('view', 'product');
  if (state.source && state.source !== 'all') params.set('source', state.source);
  if (state.focus) params.set('focus', state.focus);
  if (state.row) params.set('row', state.row);
  if (state.page > 1) params.set('page', String(state.page));
  const qs = params.toString();
  return qs ? `/dashboard/inventory?${qs}` : '/dashboard/inventory';
}

export function buildInventoryDetailHref(
  state: InventoryQueryState,
  options: { allWarehouses?: boolean } = {},
): string {
  if (!isUuid(state.item)) return buildInventoryListHref(state);
  const params = new URLSearchParams();
  if (state.q) params.set('q', state.q);
  if (state.warehouse && state.warehouse !== 'all') params.set('warehouse', state.warehouse);
  if (state.market && state.market !== 'all') params.set('market', state.market);
  if (state.view === 'product') params.set('view', 'product');
  if (state.source && state.source !== 'all') params.set('source', state.source);
  if (state.focus) params.set('focus', state.focus);
  if (state.row) params.set('row', state.row);
  if (state.page > 1) params.set('page', String(state.page));
  params.set('item', state.item);
  if (options.allWarehouses) params.set('all', '1');
  return `/dashboard/inventory?${params.toString()}`;
}

/** 详情“查看全仓/回到筛选视角”的链接。 */
export function buildInventoryDetailScopeHref(state: InventoryQueryState, allWarehouses: boolean): string {
  return buildInventoryDetailHref(state, { allWarehouses });
}

export function buildInventoryUrl(state: InventoryQueryState): string {
  if (isUuid(state.item)) return buildInventoryDetailHref(state, { allWarehouses: state.allWarehouses });
  return buildInventoryListHref(state);
}

export function inventoryPageCount(total: number, limit: number): number {
  const size = normalizeLimit(limit);
  if (!Number.isFinite(total) || total <= 0) return 1;
  return Math.max(1, Math.ceil(total / size));
}

export interface InventoryPageRange {
  from: number;
  to: number;
  total: number;
  page: number;
  pageCount: number;
  hasPrev: boolean;
  hasNext: boolean;
}

export function inventoryPageRange(total: number, limit: number, page: number): InventoryPageRange {
  const size = normalizeLimit(limit);
  const pageCount = inventoryPageCount(total, size);
  const current = Math.min(normalizePageNumber(page), pageCount);
  const safeTotal = Number.isFinite(total) && total > 0 ? Math.trunc(total) : 0;
  const from = safeTotal === 0 ? 0 : (current - 1) * size + 1;
  const to = safeTotal === 0 ? 0 : Math.min(current * size, safeTotal);
  return { from, to, total: safeTotal, page: current, pageCount, hasPrev: current > 1, hasNext: current < pageCount };
}

/** 详情视角说明：默认沿用列表筛选，只有显式“全仓”才全仓。 */
export function inventoryScopeLabel(input: {
  scopeMode: 'filtered' | 'all';
  warehouseName?: string | null;
  market?: string | null;
}): string {
  if (input.scopeMode === 'all') return '视角：全仓（显式切换，不沿用列表筛选）';
  const parts: string[] = [];
  if (input.market && input.market !== 'all') parts.push(`市场 ${input.market}`);
  if (input.warehouseName) parts.push(`仓库 ${input.warehouseName}`);
  return parts.length > 0 ? `视角：沿用列表筛选（${parts.join(' / ')}）` : '视角：沿用列表筛选（全部仓库）';
}

/* ------------------------------------------------------------------ *
 * 库存列表 / 详情展示（只展示服务端口径）
 * ------------------------------------------------------------------ */

export function marketOptionsForUi(options: InventoryMarketOptionDto[] | null | undefined): InventoryMarketOptionDto[] {
  return (options ?? [])
    .filter((option) => Boolean(option?.market))
    .map((option) => ({
      market: option.market,
      warehouseNames: [...new Set((option.warehouseNames ?? []).filter(Boolean))],
      warehouseCount: Math.max(0, Math.trunc(option.warehouseCount ?? 0)),
    }))
    .sort((a, b) => compareStableText(a.market, b.market));
}

export function marketOptionLabel(option: InventoryMarketOptionDto): string {
  const names = option.warehouseNames.length > 0 ? `：${option.warehouseNames.join('、')}` : '';
  return `${option.market}（${option.warehouseCount} 仓${names}）`;
}

/**
 * 市场展示：多个已知市场给集合，未知仓单独提示；单市场筛选保留该市场。
 * 不把跨多市场写成“市场待确认”，也不猜未知市场值。
 */
export function marketsDisplay(
  markets: string[] | null | undefined,
  hasUnknownMarket: boolean | undefined,
  scopeMarket?: string | null,
): { text: string; hasUnknown: boolean; known: string[] } {
  const known = [...new Set((markets ?? []).map((market) => market.trim()).filter(Boolean))]
    .sort(compareStableText);
  const hasUnknown = hasUnknownMarket === true;
  const filtered = scopeMarket && scopeMarket !== 'all' && scopeMarket !== UNKNOWN_MARKET_TOKEN
    ? scopeMarket
    : null;
  const knownText = filtered
    ? filtered
    : known.length > 0
      ? known.join(' / ')
      : '';
  const unknownText = hasUnknown ? '部分仓市场待确认' : '';
  const text = knownText && unknownText
    ? `${knownText}（${unknownText}）`
    : knownText || unknownText || '市场待确认';
  return { text, hasUnknown, known };
}

/** 未对应缺口原因：有来源但未对应 / 没有该 SKU 的来源记录。 */
export function gapReasonLabel(reason: string | null | undefined): string {
  if (reason === 'unmapped_source') return '有来源但未对应';
  if (reason === 'no_source') return '没有该 SKU 的来源记录';
  if (reason === 'unseen') return '本次未见';
  if (reason === 'failed') return '失败沿用旧值';
  return '未覆盖';
}

function warehouseSourceText(ref: InventoryListWarehouseRefDto): string {
  const skus = (ref.sourceSkus ?? []).filter(Boolean);
  const count = ref.sourceRowCount ?? null;
  if (skus.length === 0) {
    return count !== null && count > 0 ? `来源 ${count} 行` : '';
  }
  const shown = skus.slice(0, 3).join('、');
  const more = skus.length > 3 ? ` 等 ${skus.length} 个 SKU` : '';
  return `${count !== null && count > 0 ? `来源 ${count} 行：` : '来源 SKU：'}${shown}${more}`;
}

/** 一条待确认来源行：SKU=数量（0 明确写成“来源 0，待确认归属”），附原文件行号。 */
export function pendingSourceRowText(row: InventoryPendingSourceRowDto): string {
  const qty = row.onHand === null || row.onHand === undefined
    ? '数量未提供'
    : row.onHand === 0
      ? '来源 0，待确认归属'
      : formatQuantity(row.onHand);
  const excelRow = row.excelRow !== null && row.excelRow !== undefined ? `（原文件行 ${row.excelRow}）` : '';
  return `${row.externalSku || '未标 SKU'}=${qty}${excelRow}`;
}

/** 同仓还有来源待确认：已计入合计 SKU + 待确认来源行（只提示核对，不计入合计）。 */
export function pendingSourceWarehouseText(entry: InventoryPendingSourceWarehouseDto): string {
  const rows = (entry.pendingSourceRows ?? []).filter((row) => row.mapped !== true);
  const pendingSkus = (entry.pendingSkus ?? []).filter(Boolean);
  const fallbackRows: InventoryPendingSourceRowDto[] = rows.length > 0
    ? rows
    : pendingSkus.map((sku) => ({ externalSku: sku, excelRow: null, onHand: null, mapped: false }));
  const shown = fallbackRows.slice(0, 3).map(pendingSourceRowText).join('、');
  const count = entry.pendingSourceRowCount ?? fallbackRows.length;
  const more = `等 ${count} 行`;
  // “已计入合计”只能用真正采用（adoptedSkus）；confirmed mapping（mappedSkus）不能冒充已计入。
  const adopted = (entry.adoptedSkus ?? []).filter(Boolean);
  const adoptedText = adopted.length > 0 ? `已计入合计 SKU ${adopted.join('、')}` : '本仓暂无已计入合计 SKU';
  return `${entry.name}（${adoptedText}；待确认源行 ${shown || '—'} ${more}）`;
}

/** 列表/详情共用的“同仓还有来源待确认”整句；列表与详情同范围同解释。 */
export function pendingSourceWarehousesText(
  entries: InventoryPendingSourceWarehouseDto[] | null | undefined,
): string | null {
  const list = (entries ?? []).filter((entry) => (entry.pendingSourceRowCount ?? 0) > 0);
  if (list.length === 0) return null;
  return `同仓还有来源待确认：${list.map(pendingSourceWarehouseText).join('、')}`;
}

/** 一条“对应已确认、尚未采用”：仓 + 等待采用的 SKU + 真正已计入的 SKU（两种状态可区分）。 */
export function pendingAdoptionWarehouseText(entry: InventoryPendingAdoptionWarehouseDto): string {
  const pending = (entry.pendingAdoptionSkus ?? []).filter(Boolean);
  const adopted = (entry.adoptedSkus ?? []).filter(Boolean);
  const adoptedText = adopted.length > 0 ? `已计入合计 SKU ${adopted.join('、')}` : '本仓暂无已计入合计 SKU';
  return `${entry.name}（等待采用 SKU ${pending.join('、')}；${adoptedText}）`;
}

/** 列表/详情共用的“对应已确认、等待下一次完整同步采用”整句；不计入合计。 */
export function pendingAdoptionWarehousesText(
  entries: InventoryPendingAdoptionWarehouseDto[] | null | undefined,
): string | null {
  const list = (entries ?? []).filter((entry) => (entry.pendingAdoptionSkus ?? []).length > 0);
  if (list.length === 0) return null;
  return `对应已确认、等待下一次完整同步采用：${list.map(pendingAdoptionWarehouseText).join('、')}`;
}

export interface ListCoverageDisplay {
  complete: boolean;
  subtotalLabel: string;
  subtotalText: string;
  coverageText: string;
  gapText: string;
  tone: Tone;
}

/** 列表一行：服务端给的合计/覆盖/缺口直接展示；5/7 绝不能同时说“缺口：无”。 */
export function listCoverageDisplay(item: InventoryListItemDto): ListCoverageDisplay {
  const notMapped = item.notMappedWarehouses ?? [];
  const unseen = item.unseenWarehouses ?? [];
  const failed = item.failedWarehouses ?? [];
  const scopeCount = item.coverage?.scopeWarehouses
    ?? (item.scopeWarehouseCount || item.coveredWarehouseCount + notMapped.length + unseen.length + failed.length);
  const coveredCount = item.coverage?.coveredWarehouses ?? item.coveredWarehouseCount;
  const noCurrent = item.unitConflict !== true
    && (item.hasCurrentData === false
      || (item.knownSubtotal === null && item.unitGroups.length === 0 && coveredCount === 0));
  const gapParts: string[] = [];
  const unmappedSource = notMapped.filter((entry) => entry.reason !== 'no_source');
  const noSource = notMapped.filter((entry) => entry.reason === 'no_source');
  if (unmappedSource.length > 0) {
    gapParts.push(`有来源但未对应：${unmappedSource
      .map((entry) => `${entry.name}${warehouseSourceText(entry) ? `（${warehouseSourceText(entry)}）` : ''}`)
      .join('、')}`);
  }
  if (noSource.length > 0) {
    gapParts.push(`没有该 SKU 的来源记录：${noSource.map((entry) => entry.name).join('、')}`);
  }
  if (unseen.length > 0) {
    gapParts.push(`本次未见：${unseen
      .map((entry) => (entry.lastKnownQty === null || entry.lastKnownQty === undefined
        ? entry.name
        : `${entry.name}（上次已知 ${formatQuantity(entry.lastKnownQty)}）`))
      .join('、')}`);
  }
  if (failed.length > 0) {
    gapParts.push(`失败沿用旧值：${failed
      .map((entry) => `${entry.name}（${timestampOr(entry.lastSuccessAt, '旧时间未记录')}）`)
      .join('、')}`);
  }
  // R1 v4: same-warehouse partial gap (an adopted SKU co-exists with other not-yet-mapped source rows).
  const pendingSourceText = pendingSourceWarehousesText(item.pendingSourceWarehouses);
  if (pendingSourceText) gapParts.push(pendingSourceText);
  // R1 v4 final: confirmed mapping that has not been adopted by the next complete batch yet.
  const pendingAdoptionText = pendingAdoptionWarehousesText(item.pendingAdoptionWarehouses);
  if (pendingAdoptionText) gapParts.push(pendingAdoptionText);
  if (noCurrent) {
    return {
      complete: false,
      subtotalLabel: item.mapped ? '尚未同步 / 暂无当前值' : '未对应',
      subtotalText: item.mapped ? '尚无当前库存' : '未对应，无当前库存',
      coverageText: `覆盖 ${coveredCount}/${scopeCount} 仓`,
      gapText: gapParts.length > 0
        ? `缺口：${gapParts.join('；')}；不显示为 0，数量未计入合计。`
        : (
          item.mapped
            ? '该商品在当前范围还没有成功批次或本次未见；不显示为 0 库存。'
            : '该商品在当前范围没有生效的仓级对应；不显示为 0 库存，数量未计入合计。'
        ),
      tone: 'amber',
    };
  }
  const hasPendingTotal = item.hasPendingTotal === true;
  const complete = !item.unitConflict
    && !hasPendingTotal
    && !item.verificationOnly
    && item.knownSubtotal !== null
    && coveredCount === scopeCount
    && gapParts.length === 0;
  const verification = item.verificationOnly
    ? '验证数据（业务包装单位待确认，不作为正式业务合计）'
    : null;
  const pendingTotalNote = hasPendingTotal
    ? '同仓多个来源编码：逐行显示，合计待核对（未确认合计口径前不擅自相加）'
    : null;
  const subtotalLabel = item.unitConflict
    ? '多单位不可合计'
    : hasPendingTotal
      ? '合计待核对'
      : verification
        ? '验证数据小计'
        : complete
          ? '多仓合计'
          : '已知小计（不完整）';
  const subtotalText = item.unitConflict
    ? '单位不一致'
    : item.knownSubtotal === null
      ? (hasPendingTotal ? '逐行显示' : '暂无已知数量')
      : formatQuantity(item.knownSubtotal);
  const gapText = [
    gapParts.length > 0 ? `缺口：${gapParts.join('；')}` : null,
    pendingTotalNote,
    verification,
  ].filter(Boolean).join('；') || '缺口：无';
  return {
    complete,
    subtotalLabel,
    subtotalText,
    coverageText: `覆盖 ${coveredCount}/${scopeCount} 仓`,
    gapText,
    tone: complete ? 'green' : 'amber',
  };
}

export function listMappingLabel(item: InventoryListItemDto): { label: string; tone: Tone } {
  const missing = (item.notMappedWarehouses ?? []).length;
  const unseen = (item.unseenWarehouses ?? []).length;
  if (!item.mapped || missing >= item.scopeWarehouseCount) return { label: '未对应', tone: 'amber' };
  if (missing > 0 || unseen > 0) return { label: '部分仓缺值', tone: 'amber' };
  return { label: '已对应', tone: 'green' };
}

export interface ItemRowStatusDisplay {
  label: string;
  tone: Tone;
  quantityText: string;
  quantityTone: Tone;
  note: string | null;
}

/** 详情逐行状态：current / stale / failed / unseen / not_mapped（带原因：有来源未对应/无来源）。 */
export function itemRowStatusDisplay(row: InventoryItemWarehouseDto): ItemRowStatusDisplay {
  const qty = formatQuantity(row.onHand);
  const reason = row.reason ?? row.gapReason;
  if (row.status === 'not_mapped') {
    const pendingRows = (row.pendingSourceRows ?? []).filter((entry) => entry.mapped !== true);
    const hasSource = reason !== 'no_source'
      && ((row.sourceRowCount ?? 0) > 0 || pendingRows.length > 0);
    const rowText = pendingRows.slice(0, 3).map(pendingSourceRowText).join('、');
    const skuText = (row.sourceSkus ?? []).slice(0, 3).join('、');
    const sourceText = hasSource
      ? `有来源但未对应（来源 ${row.sourceRowCount ?? pendingRows.length} 行${skuText ? `：${skuText}` : ''}${rowText ? `；待确认源行 ${rowText}` : ''}）`
      : '没有该 SKU 的来源记录';
    return {
      label: reason === 'no_source' ? '无来源记录' : '未对应',
      tone: 'amber',
      quantityText: qty || '数量保留（无有效值）',
      quantityTone: 'amber',
      note: `${sourceText}：数量保留但不计入商品合计。`,
    };
  }
  if (row.status === 'unseen') {
    const last = row.lastKnownQty === null || row.lastKnownQty === undefined
      ? '无上次已知数量'
      : `上次已知 ${formatQuantity(row.lastKnownQty)}${row.lastKnownAt ? `（${formatTimestamp(row.lastKnownAt)}）` : ''}`;
    const pendingRows = (row.pendingSourceRows ?? []).filter((entry) => entry.mapped !== true);
    const pendingText = pendingRows.length > 0
      ? `；同仓另有来源待确认（未对应来源行不计入合计）：${pendingRows.slice(0, 3).map(pendingSourceRowText).join('、')}`
      : '';
    return {
      label: '本次未见',
      tone: 'amber',
      quantityText: '本次未见',
      quantityTone: 'amber',
      note: `该仓最新完整批次没有这一行：不计入本次合计；${last}，只作展示${pendingText}。`,
    };
  }
  if (row.status === 'stale' || row.status === 'failed' || row.failed) {
    return {
      label: '失败沿用旧值',
      tone: 'red',
      quantityText: qty || '无有效数量',
      quantityTone: 'red',
      note: `该仓最近一次任务失败：数量沿用 ${timestampOr(row.observedAt ?? row.lastSuccessAt, '旧时间未记录')} 的上一成功批次${row.lastErrorCode ? `（${errorCodeLabel(row.lastErrorCode) ?? row.lastErrorCode}）` : ''}；不是本次观测值。`,
    };
  }
  const pendingRows = (row.pendingSourceRows ?? []).filter((entry) => entry.mapped !== true);
  const pendingNote = pendingRows.length > 0
    ? `同仓另有来源待确认（未对应来源行不计入合计）：${pendingRows.slice(0, 3).map(pendingSourceRowText).join('、')}${pendingRows.length > 3 ? ` 等 ${pendingRows.length} 行` : ''}。`
    : null;
  if (row.onHand === 0) {
    return { label: '有当前库存', tone: 'green', quantityText: '0（真实零库存）', quantityTone: 'neutral', note: pendingNote };
  }
  if (qty) {
    return { label: '有当前库存', tone: 'green', quantityText: qty, quantityTone: 'neutral', note: pendingNote };
  }
  return {
    label: '无有效库存',
    tone: 'amber',
    quantityText: '来源未提供数量',
    quantityTone: 'amber',
    note: '来源行存在但没有有效数量；不等于 0，也不计入合计。',
  };
}

export function itemRowStatusLabel(status: string | null | undefined): string {
  if (status === 'current') return '有当前库存';
  if (status === 'stale') return '失败保留旧值';
  if (status === 'failed') return '失败沿用旧值';
  if (status === 'unseen') return '本次未见';
  if (status === 'not_mapped') return '未对应';
  return '状态未标注';
}

/**
 * 详情合计/覆盖：用服务端 coverage + 逐仓原因，保证“覆盖 5/7”时绝不显示“缺口：无”，
 * 详情按同一筛选范围列出所有仓（含空 rows），四类缺口分别说明。
 */
export interface DetailTotalsDisplay {
  label: string;
  subtotalText: string;
  coverageText: string;
  gapText: string;
  unitGroupsText: string;
  unitConflict: boolean;
  tone: Tone;
}

function detailGapParts(rows: InventoryItemWarehouseDto[]): string[] {
  const parts: string[] = [];
  const byReason = new Map<string, string[]>();
  for (const row of rows) {
    if (row.status === 'current') continue;
    const reason = row.reason ?? row.gapReason
      ?? (row.status === 'stale' || row.status === 'failed' ? 'failed'
        : row.status === 'unseen' ? 'unseen' : 'not_mapped');
    const key = reason === 'not_mapped' ? 'unmapped_source' : reason;
    const list = byReason.get(key) ?? [];
    const count = row.sourceRowCount ?? null;
    const skuText = (row.sourceSkus ?? []).slice(0, 3).join('、');
    const detail = count !== null && count > 0
      ? `（来源 ${count} 行${skuText ? `：${skuText}` : ''}）`
      : (skuText ? `（来源 SKU：${skuText}）` : '');
    const pendingRows = (row.pendingSourceRows ?? []).filter((entry) => entry.mapped !== true);
    const rowDetail = pendingRows.length > 0
      ? `；待确认源行 ${pendingRows.slice(0, 3).map(pendingSourceRowText).join('、')}`
      : '';
    list.push(`${row.warehouseName}${detail}${rowDetail}`);
    byReason.set(key, list);
  }
  for (const [reason, names] of byReason) {
    parts.push(`${gapReasonLabel(reason)}：${names.join('、')}`);
  }
  return parts;
}

/**
 * 详情逐仓的“同仓来源待确认 / 对应已确认等待采用”列表：只给展示（含原文件行号/数量），不参与合计。
 * 同一仓在详情里会按来源 SKU 展开成多行，这里按仓去重，保证每仓只出现一次。
 * 只含“对应已确认、等待下一次完整同步采用”（无待确认来源行）的仓也要出现，两种状态可区分。
 */
export interface DetailPendingSourceGroup {
  warehouseId: string;
  warehouseName: string;
  /** 真正已计入当前合计的 SKU。 */
  adoptedSkus: string[];
  /** 当前 confirmed 对应 SKU（= adopted ∪ pendingAdoption）。 */
  mappedSkus: string[];
  /** 对应已确认、等待下一次完整同步采用的 SKU（不计入合计）。 */
  pendingAdoptionSkus: string[];
  pendingSourceRows: InventoryPendingSourceRowDto[];
}

export function detailPendingSourceDisplay(detail: InventoryItemDetailDto): DetailPendingSourceGroup[] {
  const groups = new Map<string, DetailPendingSourceGroup>();
  const ensure = (warehouseId: string, warehouseName: string): DetailPendingSourceGroup => {
    const existing = groups.get(warehouseId);
    if (existing) return existing;
    const created: DetailPendingSourceGroup = {
      warehouseId,
      warehouseName,
      adoptedSkus: [],
      mappedSkus: [],
      pendingAdoptionSkus: [],
      pendingSourceRows: [],
    };
    groups.set(warehouseId, created);
    return created;
  };
  for (const row of detail.warehouses ?? []) {
    const pendingRows = (row.pendingSourceRows ?? []).filter((entry) => entry.mapped !== true);
    const pendingAdoption = (row.pendingAdoptionSkus ?? []).filter(Boolean);
    if (pendingRows.length === 0 && pendingAdoption.length === 0) continue;
    const group = ensure(row.warehouseId, row.warehouseName);
    if (group.pendingSourceRows.length === 0) group.pendingSourceRows = pendingRows;
    if (group.adoptedSkus.length === 0) group.adoptedSkus = row.adoptedSkus ?? [];
    if (group.mappedSkus.length === 0) group.mappedSkus = row.mappedSkus ?? [];
    if (group.pendingAdoptionSkus.length === 0) group.pendingAdoptionSkus = pendingAdoption;
  }
  // Summary-level list also covers a warehouse whose rows are empty in this view but whose current mapping
  // is confirmed and not adopted yet.
  for (const entry of detail.pendingAdoptionWarehouses ?? []) {
    const group = ensure(entry.warehouseId, entry.name);
    if (group.adoptedSkus.length === 0) group.adoptedSkus = entry.adoptedSkus ?? [];
    if (group.mappedSkus.length === 0) group.mappedSkus = entry.mappedSkus ?? [];
    if (group.pendingAdoptionSkus.length === 0) group.pendingAdoptionSkus = entry.pendingAdoptionSkus ?? [];
  }
  return [...groups.values()];
}

export function detailTotalsDisplay(detail: InventoryItemDetailDto): DetailTotalsDisplay {
  const rows = detail.warehouses ?? [];
  const currentRows = rows.filter((row) => row.status === 'current');
  const totals = detail.totals;
  const unitConflict = totals?.unitConflict === true;
  const byUnit = totals?.byUnit ?? [];
  const known = totals?.knownSubtotal ?? null;
  const coverage = detail.coverage;
  const scopeWarehouses = coverage?.scopeWarehouses
    ?? new Set(rows.map((row) => row.warehouseId)).size;
  const coveredWarehouses = coverage?.coveredWarehouses ?? currentRows.length;
  const unitGroupsText = byUnit.length > 1
    ? `单位分组：${byUnit.map((group) => `${group.unit ?? '未标单位'} ${formatQuantityOr(group.knownSubtotal, '—')}（${group.rowCount} 行）`).join('；')}`
    : byUnit.length === 1
      ? `单位：${byUnit[0].unit ?? '未标单位'}`
      : '没有可合计的单位组';
  const gapParts = detailGapParts(rows);
  const pendingSourceText = pendingSourceWarehousesText(detail.pendingSourceWarehouses);
  if (pendingSourceText) gapParts.push(pendingSourceText);
  const pendingAdoptionText = pendingAdoptionWarehousesText(detail.pendingAdoptionWarehouses);
  if (pendingAdoptionText) gapParts.push(pendingAdoptionText);
  const verification = detail.verificationOnly
    ? '验证数据（业务包装单位待确认，不作为正式业务合计）'
    : null;
  const gapText = gapParts.length > 0
    ? `缺口：${gapParts.join('；')}${verification ? `；${verification}` : ''}`
    : (verification ?? '缺口：无');
  return {
    label: unitConflict
      ? '多单位不可合计'
      : verification
        ? '验证数据小计'
        : known === null ? '暂无已知合计' : '已知合计（同单位）',
    subtotalText: unitConflict ? '单位不一致' : known === null ? '暂无已知数量' : formatQuantity(known),
    coverageText: `有当前值 ${coveredWarehouses}/${scopeWarehouses} 仓`,
    gapText,
    unitGroupsText,
    unitConflict,
    tone: unitConflict || gapParts.length > 0 || verification ? 'amber' : 'green',
  };
}

export function verificationNotice(
  verificationOnly: boolean | undefined,
  unitUnconfirmed: boolean | undefined,
): string | null {
  if (!verificationOnly && !unitUnconfirmed) return null;
  return '验证数据：业务包装单位待确认，不作为正式业务合计（来源数量与历史仍保留）。';
}

export function verificationBadge(mapping: {
  verification?: boolean;
  unitUnconfirmed?: boolean;
  reason?: string | null;
}): string | null {
  if (mapping.verification || mapping.unitUnconfirmed) return '验证数据（业务单位待确认）';
  if ((mapping.reason ?? '').includes('验证数据')) return '验证数据（业务单位待确认）';
  return null;
}

export interface HistoryRowDisplay {
  label: string;
  publishedAtText: string;
  changeText: string;
  rowStatusLabel: string;
  sourceText: string;
}

export function historyRowDisplay(entry: InventoryItemHistoryDto, index: number): HistoryRowDisplay {
  const previous = typeof entry.previousOnHand === 'number' ? formatQuantity(entry.previousOnHand) : '无有效数量';
  const current = typeof entry.onHand === 'number' ? formatQuantity(entry.onHand) : '无有效数量';
  const revisionText = entry.itemRevision === null || entry.itemRevision === undefined
    ? '当时资料版本缺失'
    : `资料第 ${entry.itemRevision} 版`;
  return {
    label: `第 ${index + 1} 次发布`,
    publishedAtText: formatTimestamp(entry.publishedAt) || '时间未标注',
    changeText: typeof entry.previousOnHand === 'number' ? `${previous} → ${current}` : current,
    rowStatusLabel: entry.rowStatus === 'adopted'
      ? '已采用（计入当时合计）'
      : entry.rowStatus === 'unmapped'
        ? '未对应（数量保留，不计入合计）'
        : entry.rowStatus === 'disabled'
          ? '已停用对应（历史事实保留）'
          : '状态未标注',
    sourceText: `${entry.externalSku || '未标 SKU'} · ${entry.unit ?? '未标单位'} · ${revisionText}`,
  };
}

export function groupRowsByUnit(rows: InventoryItemWarehouseDto[]): Array<{ unit: string | null; rows: InventoryItemWarehouseDto[] }> {
  const groups = new Map<string, { unit: string | null; rows: InventoryItemWarehouseDto[] }>();
  for (const row of rows) {
    const key = (row.unit ?? '').trim();
    const group = groups.get(key) ?? { unit: row.unit, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/* ------------------------------------------------------------------ *
 * 商品对应 R2：草稿校验 / 批量 / 显示
 * ------------------------------------------------------------------ */

export function mappingSuggestionDisplay(item: InventoryMappingQueueItemDto): {
  title: string;
  evidenceText: string;
  sourceText: string;
  hasSuggestion: boolean;
} {
  const suggestion = item.suggestion;
  if (!suggestion) {
    return {
      title: '暂无建议',
      evidenceText: '没有同 SKU 的已确认样表记录可作建议；请手动搜索并选择目标商品，不要凭空绑定。',
      sourceText: '',
      hasSuggestion: false,
    };
  }
  const code = (suggestion.iceCode ?? '').trim();
  const name = (suggestion.nameCn ?? '').trim();
  const title = code && name ? `${code} · ${name}` : code || name || '未命名商品';
  const evidence = (suggestion.evidence ?? '').trim();
  const sourceParts: string[] = [];
  if (suggestion.sourceSku) sourceParts.push(`来源 SKU ${suggestion.sourceSku}`);
  if (suggestion.sourceWarehouse) sourceParts.push(`来源仓 ${suggestion.sourceWarehouse}`);
  if (suggestion.source) sourceParts.push(`证据来源 ${suggestion.source === 'bs_sample_export' ? 'BS 冻结样表' : suggestion.source === 'mapping_candidate' ? '候选记录' : suggestion.source}`);
  return {
    title,
    evidenceText: evidence ? `建议出处：${evidence}` : '建议出处：来源记录未提供说明',
    sourceText: sourceParts.join(' · '),
    hasSuggestion: true,
  };
}

export function currentMappingStatusLabel(status: string | null | undefined): string {
  if (status === 'confirmed') return '已确认';
  if (status === 'recheck') return '待重核（已停止归集）';
  if (status === 'disabled') return '已停用';
  return '未标注';
}

/** 页面行身份 = 仓库外部编码 + 来源 SKU（同账号下唯一确定一个待处理对）。 */
export function mappingRowKey(warehouseExternalId: string | null | undefined, externalSku: string | null | undefined): string {
  return `${(warehouseExternalId ?? '').trim()}::${(externalSku ?? '').trim()}`;
}

/** 手动确认/换绑草稿：单位、理由必须由操作者显式填写，没有默认值。 */
export interface MappingDraft {
  /** account + warehouseExternalId + externalSku 的行身份（选择/批量查找都用它）。 */
  rowKey: string;
  externalSku: string;
  itemId: string;
  itemLabel: string;
  unit: string;
  reason: string;
  warehouseExternalIds: string[];
  /** 换绑/重新确认时必带：页面看到的旧版本；首次建立为 null。 */
  expectedVersion: number | null;
  note: string;
  /** 验证数据（业务包装单位待确认）：不冒充正式业务采用。 */
  verification: boolean;
}

export function emptyMappingDraft(
  rowKey: string,
  externalSku: string,
  expectedVersion: number | null = null,
): MappingDraft {
  return {
    rowKey,
    externalSku,
    itemId: '',
    itemLabel: '',
    unit: '',
    reason: '',
    warehouseExternalIds: [],
    expectedVersion,
    note: '',
    verification: false,
  };
}

/** 队列行 → 草稿：行身份/仓库/旧版本/验证标记都来自同一行，避免跨仓合并。 */
export function mappingDraftForQueueItem(item: InventoryMappingQueueItemDto): MappingDraft {
  return {
    ...emptyMappingDraft(
      mappingRowKey(item.warehouseExternalId, item.externalSku),
      item.externalSku,
      item.currentMapping?.version ?? null,
    ),
    warehouseExternalIds: item.warehouseExternalId ? [item.warehouseExternalId] : [],
    verification: item.verification === true || item.unitUnconfirmed === true,
  };
}

export interface MappingDraftValidation {
  ok: boolean;
  errors: string[];
  payload: Array<{
    externalSku: string;
    warehouseExternalId: string;
    itemId: string;
    unit: string;
    reason: string;
    note: string | null;
    expectedVersion: number | null;
    verification: boolean;
  }>;
}

/**
 * 单行草稿校验 → 按“每个勾选仓一条”的确认 payload。
 * - 仓库必须来自该 SKU 出现仓（externalId 非空）；
 * - 单位必填（不默认“件”）；理由必填；
 * - 有 currentMapping（换绑/重新确认）时必须带页面看到的旧版本；首次建立 null。
 */
export function validateMappingDraft(
  draft: MappingDraft,
  options: { requireVersion?: boolean } = {},
): MappingDraftValidation {
  const errors: string[] = [];
  const unit = draft.unit.trim();
  const reason = draft.reason.trim();
  const selected = draft.warehouseExternalIds.filter((entry) => entry.trim());
  if (!draft.itemId.trim()) errors.push('请选择目标商品');
  if (!unit) errors.push(`请填写单位（不自动使用“件”；行：${draft.externalSku}${selected[0] ? ` / 仓 ${selected[0]}` : ''}）`);
  if (!reason) errors.push(`请填写确认理由（行：${draft.externalSku}${selected[0] ? ` / 仓 ${selected[0]}` : ''}）`);
  if (selected.length === 0) errors.push('请选择至少一个出现仓库');
  if (options.requireVersion && (draft.expectedVersion === null || !Number.isSafeInteger(draft.expectedVersion))) {
    errors.push(`重新确认/换绑必须带页面看到的旧版本（行：${draft.externalSku}）`);
  }
  if (draft.expectedVersion !== null && (!Number.isSafeInteger(draft.expectedVersion) || draft.expectedVersion < 1)) {
    errors.push('旧版本号无效，请刷新后重试');
  }
  const payload = errors.length === 0
    ? selected.map((warehouseExternalId) => ({
      externalSku: draft.externalSku.trim(),
      warehouseExternalId: warehouseExternalId.trim(),
      itemId: draft.itemId.trim(),
      unit,
      reason,
      note: draft.note.trim() || null,
      expectedVersion: draft.expectedVersion,
      verification: draft.verification,
    }))
    : [];
  return { ok: errors.length === 0, errors, payload };
}

export interface ConfirmBatchEntry {
  externalSku: string;
  warehouseExternalId: string;
  itemId: string;
  unit: string;
  reason: string;
  note: string | null;
  expectedVersion: number | null;
  verification: boolean;
}

export interface ConfirmBatchPlan {
  ok: boolean;
  errors: string[];
  entries: ConfirmBatchEntry[];
  incompleteRowKeys: string[];
}

/**
 * 批量确认：只作用于**明确勾选**的行（selectedRowKeys = 仓+SKU 行身份），未勾选不提交；
 * 每行按同一行身份找草稿（不得退化为纯 SKU，避免同 SKU 跨仓误合并）。
 */
export function buildConfirmBatch(input: {
  selectedRowKeys: string[];
  drafts: MappingDraft[];
  /**
   * 已有当前对应、必须以“页面所见版本”重新确认的行身份（仓库外部编码 + 来源 SKU）。
   * 版本要求按行判断：本集合内的行必须带旧版本；首次确认行 expectedVersion=null 合法。
   * 兼容旧调用：未提供时退回 requireVersion（整批）。
   */
  reconfirmRowKeys?: string[];
  requireVersion?: boolean;
}): ConfirmBatchPlan {
  const selected = new Set(input.selectedRowKeys.map((key) => key.trim()).filter(Boolean));
  const reconfirm = new Set((input.reconfirmRowKeys ?? []).map((key) => key.trim()).filter(Boolean));
  const perRowVersion = input.reconfirmRowKeys !== undefined;
  const entries: ConfirmBatchEntry[] = [];
  const errors: string[] = [];
  const incomplete: string[] = [];
  if (selected.size === 0) {
    return { ok: false, errors: ['请先勾选要确认的对应行（不会默认全选）'], entries: [], incompleteRowKeys: [] };
  }
  for (const rowKey of selected) {
    const draft = input.drafts.find((entry) => entry.rowKey === rowKey);
    if (!draft) {
      errors.push(`${rowKey}：缺少确认内容`);
      incomplete.push(rowKey);
      continue;
    }
    const label = `${draft.warehouseExternalIds[0] ?? ''} / ${draft.externalSku}`;
    // 每行按自己的状态检查：首次行允许 null；重新确认/换绑必须带页面所见版本。
    const requireVersion = perRowVersion ? reconfirm.has(rowKey) : input.requireVersion === true;
    const validation = validateMappingDraft(draft, { requireVersion });
    if (!validation.ok) {
      errors.push(`${label}：${validation.errors.join('、')}`);
      incomplete.push(rowKey);
      continue;
    }
    entries.push(...validation.payload);
  }
  if (entries.length > MAX_CONFIRM_ROWS) {
    return { ok: false, errors: [`一次最多确认 ${MAX_CONFIRM_ROWS} 条，请分批处理`], entries: [], incompleteRowKeys: incomplete };
  }
  return { ok: errors.length === 0, errors, entries, incompleteRowKeys: incomplete };
}

export function confirmOutcomeMessage(applied: number, skipped: unknown): string {
  const skippedList = Array.isArray(skipped) ? skipped : [];
  if (skippedList.length === 0) {
    return `已提交 ${applied} 条对应；只有下一次完整读取发布后才会进入商品合计（旧批次数量不会立即转移）。`;
  }
  const reasons = skippedList
    .slice(0, 5)
    .map((entry) => {
      const record = (entry ?? {}) as Record<string, unknown>;
      const sku = typeof record.externalSku === 'string' ? record.externalSku : '';
      const reason = typeof record.reason === 'string' ? record.reason : (typeof record.code === 'string' ? record.code : '');
      return `${sku ? `${sku}：` : ''}${mappingSkipReasonLabel(reason)}`;
    })
    .join('；');
  return `已提交 ${applied} 条对应；${skippedList.length} 条未绑定（${reasons}）。不会自动换算单位或覆盖旧历史。`;
}

export function recheckOutcomeMessage(): string {
  return '已发起重核：该对应立即退出当前汇总（旧数量不再计入商品合计），历史批次保留；等人工确认后由下一次完整批次采用。';
}

export function disableMappingOutcomeMessage(): string {
  return '已停用该对应关系：该商品立即退出当前汇总（历史批次仍按当时关系保留，不重写历史）。';
}

/* ------------------------------------------------------------------ *
 * R5 pending 状态机（纯逻辑）
 * ------------------------------------------------------------------ */

const PENDING_ACTION_LABELS: Record<string, string> = {
  update_inventory_sync_settings: '保存自动同步设置',
  request_inventory_manual_sync: '立即同步',
  confirm_inventory_mapping: '确认/换绑商品对应',
  disable_inventory_mapping: '停用商品对应',
  recheck_inventory_mapping: '重核商品对应',
};

export function pendingActionLabel(action: string | null | undefined): string {
  return (action && PENDING_ACTION_LABELS[action]) || '原请求';
}

export interface PendingPanelDisplay {
  /** 是否处于未决状态（服务端会拒绝新写）。 */
  locked: boolean;
  title: string;
  detail: string;
  tone: Tone;
}

export function pendingPanelDisplay(pending: InventoryPendingActionDto | null): PendingPanelDisplay {
  if (!pending) {
    return { locked: false, title: '没有未完成原请求', detail: '', tone: 'neutral' };
  }
  if (pending.foreign) {
    return {
      locked: true,
      title: `账号有另一位管理员的未完成请求：${pendingActionLabel(pending.action)}`,
      detail: `发起时间 ${timestampOr(pending.createdAt, '未记录')}。这不是你的原请求：本页不显示 requestId/参数，也不提供核对或重试；请等待对方核对或联系管理员。在未完成前新的写操作会被服务端拒绝。`,
      tone: 'amber',
    };
  }
  return {
    locked: true,
    title: `原请求待核对：${pendingActionLabel(pending.action)}`,
    detail: `发起时间 ${timestampOr(pending.createdAt, '未记录')}。在核对完成前，新的写操作会被服务端拒绝（避免覆盖原请求）。`,
    tone: 'amber',
  };
}

/** 恢复状态绑定 key：account/actor/requestId/完整 intent；切换 pending 即重置旧结果。 */
export function pendingRecoveryKey(pending: InventoryPendingActionDto | null): string {
  if (!pending) return 'none';
  if (pending.foreign) return `foreign:${pending.action}:${pending.createdAt ?? ''}`;
  return `${pending.requestId ?? ''}:${pending.intent ?? ''}:${pending.actorId ?? ''}:${pending.accountId ?? ''}`;
}

/** 本地未知请求 + 服务端 pending 共同锁新写：任一存在即不得发起新的写操作。 */
export function inventoryWriteLocked(
  pending: InventoryPendingActionDto | null | undefined,
  hasLocalUnknown: boolean,
): boolean {
  return Boolean(pending) || hasLocalUnknown;
}

/** 组件在 pending 未决期间必须禁用新写按钮（含他人 pending：服务端也拒绝新写）。 */
export function pendingBlocksWrites(pending: InventoryPendingActionDto | null | undefined): boolean {
  return Boolean(pending);
}

export interface ReconcileDisplay {
  tone: Tone;
  title: string;
  nextStep: string;
  canRetry: boolean;
  dismissPending: boolean;
}

/**
 * 核对结果：
 * - found：找到业务回执且 pending 已解除；
 * - not_found：仅当服务端显式 found=false（原请求确实没生效）；
 * - found_unlock_failed：找到回执但解除 pending 失败 → 原请求仍保留，继续核对；
 * - failed：NULL/畸形/异常/无权限 → 不代表未生效，保留锁。
 */
export function reconcileStateDisplay(state: InventoryReconcileState): ReconcileDisplay {
  if (state === 'found') {
    return {
      tone: 'green',
      title: '已核对到原请求回执',
      nextStep: '原请求已生效，没有重复写入；锁已解除，可刷新查看最新状态。',
      canRetry: false,
      dismissPending: true,
    };
  }
  if (state === 'found_unlock_failed') {
    return {
      tone: 'red',
      title: '已找到业务回执，但恢复锁未解除',
      nextStep: '业务已生效（不会重放写入），但解除原请求失败：原请求仍保留，请继续核对；在确认解开前不要发起新的写操作，本页不会提示“已解锁”。',
      canRetry: false,
      dismissPending: false,
    };
  }
  if (state === 'failed_terminal') {
    return {
      tone: 'amber',
      title: '原操作失败，已处理完',
      nextStep: '原请求已在服务端结案（没有业务效果，也不会再次执行）：本地恢复记录与写锁已清除，可以修正设置/对应后重新操作；新操作会使用新的请求编号。',
      canRetry: false,
      dismissPending: true,
    };
  }
  if (state === 'not_found') {
    return {
      tone: 'amber',
      title: '明确未找到原请求回执',
      nextStep: '服务端明确返回未找到（原请求未落库）。可以“重试原操作（同 requestId + 同 intent）”，只会产生一份结果；也可以放弃并不再提交。',
      canRetry: true,
      dismissPending: false,
    };
  }
  return {
    tone: 'red',
    title: '核对失败（响应为空/异常/无权限）',
    nextStep: '这不代表原请求未生效：请保留原请求，稍后继续核对；不要发起新的写操作，本页不会把核对失败变成写动作、也不会判成“明确未找到”。',
    canRetry: false,
    dismissPending: false,
  };
}

export function unlockFailedMessage(base: string): string {
  return `${base}（业务已生效，但恢复锁未确认解除：原请求仍保留，请刷新后继续核对，不要重复提交。）`;
}

export function pendingPayloadForRetry(
  pending: InventoryPendingActionDto | null,
): { kind: string; payload: Record<string, unknown> } | null {
  if (!pending) return null;
  return { kind: pending.action, payload: pending.payload ?? {} };
}

/* ------------------------------------------------------------------ *
 * 动作结果文案
 * ------------------------------------------------------------------ */

export function manualSyncOutcomeMessage(result: { deduped: boolean; runId: string | null; scopeEmpty?: boolean }): string {
  if (result.scopeEmpty) return '参与仓库为空：已停止发布，无法同步；请先重新选择参与仓库。';
  if (result.deduped) {
    return '已有正在执行的同步任务：本次没有重复排队，也不会改变自动计划的下次时间。';
  }
  return '立即同步已生效：后台下一次心跳会领取任务；手动同步不会改变自动计划的下次时间。';
}

export interface SettingsOutcomeInput {
  enabled: boolean;
  intervalMinutes: number;
  warehouseCount: number;
  scopeProvided: boolean;
  scopeEmpty: boolean;
  previousEnabled?: boolean | null;
  previousIntervalMinutes?: number | null;
  nextRunAt?: string | null;
}

export function settingsOutcomeMessage(input: SettingsOutcomeInput): string {
  const parts: string[] = [];
  if (input.previousEnabled !== undefined && input.previousEnabled !== input.enabled) {
    parts.push(input.enabled ? '已开启自动同步' : '已关闭自动同步（只取消以后的自动触发，正在执行的任务继续，手动同步仍可用）');
  }
  if (input.previousIntervalMinutes !== undefined && input.previousIntervalMinutes !== input.intervalMinutes) {
    parts.push(`频率已改为${intervalDisplay(input.intervalMinutes).display}`);
  }
  if (input.scopeProvided) {
    parts.push(input.scopeEmpty ? '参与仓库已明确清空：已停止发布（不回退旧范围）' : `参与仓库已更新为 ${input.warehouseCount} 个`);
  } else {
    parts.push('参与仓库范围未修改');
  }
  if (parts.length === 0) parts.push('设置已保存（内容与原来相同）');
  if (input.enabled) {
    const next = formatTimestamp(input.nextRunAt);
    parts.push(next ? `下次计划时间 ${next}` : '下次计划时间待后台确认');
  }
  return `${parts.join('；')}。`;
}

export function reconcileOutcomeMessage(state: InventoryReconcileState): string {
  return reconcileStateDisplay(state).nextStep;
}

/* ------------------------------------------------------------------ *
 * 读取失败分类
 * ------------------------------------------------------------------ */

export type ReadFailureKind = 'forbidden' | 'unavailable' | 'read_failed';

const FORBIDDEN_PATTERN = /无权限|未登录|登录已失效|账户已停用|FORBIDDEN|DENIED|permission denied/i;
const UNAVAILABLE_PATTERN = /CATALOG_UNAVAILABLE|function .* does not exist|relation .* does not exist|does not exist|尚未就绪|未启用|not configured/i;
const TRANSPORT_PATTERN = /timeout|timed out|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|Connection terminated|socket|network|fetch failed|connection|连接|超时/i;

export function errorCodeOf(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : '';
}

export function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : '';
}

export function classifyReadFailure(error: unknown): ReadFailureKind {
  const code = errorCodeOf(error);
  const message = errorMessageOf(error);
  if (code === '42501' || FORBIDDEN_PATTERN.test(message)) return 'forbidden';
  if (code === '42883' || code === '42P01' || code === '3F000' || UNAVAILABLE_PATTERN.test(message)) return 'unavailable';
  return 'read_failed';
}

export interface ActionErrorInfo {
  code: string;
  message: string;
  outcomeUnknown: boolean;
  /** 确定失败（可 complete(failed)）；未知/连接中断应保持 pending。 */
  definite: boolean;
}

const PENDING_RECOVERY_CODES = new Set(['INVENTORY_PENDING_RECOVERY_REQUIRED']);

export function classifyActionError(error: unknown): ActionErrorInfo {
  const code = errorCodeOf(error);
  const raw = errorMessageOf(error);
  const baseCode = raw.split(':')[0].trim();
  if (PENDING_RECOVERY_CODES.has(baseCode)) {
    return {
      code: baseCode,
      message: '存在未完成原请求：请先核对原请求，不能发起新的写操作。',
      outcomeUnknown: false,
      definite: false,
    };
  }
  if (ERROR_CODE_LABELS[baseCode]) {
    return {
      code: baseCode,
      message: `${ERROR_CODE_LABELS[baseCode]}；本次没有改动库存或配置。`,
      outcomeUnknown: false,
      definite: true,
    };
  }
  if (code === '42501' || FORBIDDEN_PATTERN.test(raw)) {
    return {
      code: 'FORBIDDEN',
      message: '当前账户无权执行该操作：需要已启用的管理员账号；本页不替你隐藏按钮假装已授权。',
      outcomeUnknown: false,
      definite: true,
    };
  }
  if (code === '42883' || code === '42P01' || UNAVAILABLE_PATTERN.test(raw)) {
    return {
      code: 'UNAVAILABLE',
      message: '后台库存同步功能尚未就绪（数据库函数缺失或未启用）；本次没有改动任何数据。',
      outcomeUnknown: false,
      definite: false,
    };
  }
  if (TRANSPORT_PATTERN.test(raw)) {
    return {
      code: 'OUTCOME_UNKNOWN',
      message: '提交结果暂未确认（连接中断）。请先“核对原请求”，不要直接发起重复操作。',
      outcomeUnknown: true,
      definite: false,
    };
  }
  if (/INVALID|invalid input|格式|校验/i.test(raw)) {
    return {
      code: 'INVALID_INPUT',
      message: '提交内容不完整或格式不正确，本次未处理；请检查范围、频率、单位与对应关系后重试。',
      outcomeUnknown: false,
      definite: true,
    };
  }
  return {
    code: 'ACTION_FAILED',
    message: '同步操作未完成；请确认权限与后台状态后重试，必要时联系管理员查看后台日志。',
    outcomeUnknown: false,
    definite: true,
  };
}

/* ------------------------------------------------------------------ *
 * 列表空态 / 未接入 / 任务列表辅助
 * ------------------------------------------------------------------ */

export function listEmptyStateText(input: { total: number; hasFilters: boolean; readFailed?: boolean }): { title: string; body: string } {
  if (input.readFailed) {
    return { title: '库存读取失败（网络或传输异常）', body: '本次没有读到数据；这不等于没有库存或没有商品。可刷新重试。' };
  }
  if (input.total > 0) return { title: '当前没有可显示的记录', body: '可尝试清空筛选或返回第一页。' };
  if (input.hasFilters) {
    return { title: '没有符合条件的商品', body: '清空筛选可恢复列表；搜索支持货号、69 编码、名称和外部 SKU。' };
  }
  return {
    title: '还没有库存记录',
    body: '库存来自 BigSeller 自动读取并逐仓发布；还没有成功批次时不显示 0，也不当作零库存。',
  };
}

export interface NotConnectedSourceDisplay {
  key: string;
  name: string;
  detail: string;
}

export const NOT_CONNECTED_SOURCES: NotConnectedSourceDisplay[] = [
  { key: 'jushuitan', name: '聚水潭国内库存（表格快照）', detail: '本包只读展示冻结表格快照（文件日期见库存页），尚未自动同步；不显示为实时库存，也不并入海外仓合计。' },
  { key: 'feishu_logistics', name: '飞书物流表', detail: '本包未接入：飞书物流在途与库存数量分开，不能用它改写库存。' },
  { key: 'golucky', name: '喜运达在途轨迹', detail: '本包未接入：物流在途不补 0，也不计入 BigSeller 来源在途。' },
];

export function domesticStateLabel(state: string | null | undefined): string {
  return state === 'not_connected' || !state ? '未接入' : '已接入';
}

export function runListRowLabel(run: InventoryRunSummaryDto): string {
  const when = formatTimestamp(run.plannedFor) || formatTimestamp(run.startedAt) || '时间未标注';
  return `${when} · ${triggerLabel(run.triggerKind)}`;
}

const WARNING_LABELS: Record<string, string> = {
  not_seen_last_run: '本次导出未见：保留上次已知数量，不补 0、不计入本次合计。',
  not_seen: '本次导出未见：保留上次已知数量，不补 0、不计入本次合计。',
  last_update_failed: '该仓最近一次更新失败：保留上一成功批次的数量，更新时间与失败标记不被刷新。',
  publish_failed_keep_previous: '该仓最近一次发布失败：保留上一成功批次的数量，不当作 0。',
  unmapped: '存在未对应的来源 SKU：数量保留，但不计入商品合计。',
  unit_mismatch: '仓库单位不一致：只显示各仓数量，不做合计。',
  missing_warehouse: '本次导出缺仓：缺仓不等于空仓，不发布空批次、不清零。',
  scope_changed: '参与仓库范围已变化：不继承旧范围“全部成功”状态。',
  account_level_disabled: '历史账号级默认对应已停用：只认仓级 confirmed 对应，不再自动归集。',
};

export function scopedWarningsDisplay(warnings: string[] | null | undefined): string[] {
  if (!Array.isArray(warnings)) return [];
  return warnings
    .map((warning) => (typeof warning === 'string' ? warning.trim() : ''))
    .filter(Boolean)
    .map((warning) => {
      if (WARNING_LABELS[warning]) return WARNING_LABELS[warning];
      if (/[\u3400-\u9fff]/.test(warning)) return warning;
      return '存在需要核对的情况（详情见后台记录）。';
    });
}

/** 列表合计覆盖=完整时也不能声称“全仓成功”，只是“当前值齐全”。 */
export function listCoverageClaim(coversAllScope: boolean): string {
  return coversAllScope ? '本次范围当前值齐全' : '已知小计，不当作完整总量';
}

export function mappingQueuePageRange(total: number, page: number): { from: number; to: number; page: number; pageCount: number; hasPrev: boolean; hasNext: boolean } {
  const size = MAPPING_QUEUE_PAGE_SIZE;
  const pageCount = total <= 0 ? 1 : Math.max(1, Math.ceil(total / size));
  const current = Math.min(normalizePageNumber(page), pageCount);
  const safeTotal = total > 0 ? Math.trunc(total) : 0;
  const from = safeTotal === 0 ? 0 : (current - 1) * size + 1;
  const to = safeTotal === 0 ? 0 : Math.min(current * size, safeTotal);
  return { from, to, page: current, pageCount, hasPrev: current > 1, hasNext: current < pageCount };
}

export function confirmedMappingViewFromItem(
  itemId: string,
  itemLabel: string,
  mapping: { id: string; externalSku: string; warehouseId: string | null; warehouseName: string | null; version: number; unit: string | null; status: string; confirmedAt: string | null; reason?: string | null },
): ConfirmedMappingView {
  return {
    itemId,
    itemLabel,
    mappingId: mapping.id,
    externalSku: mapping.externalSku,
    warehouseId: mapping.warehouseId,
    warehouseName: mapping.warehouseName,
    version: mapping.version,
    unit: mapping.unit,
    status: mapping.status,
    confirmedAt: mapping.confirmedAt,
    reason: mapping.reason ?? null,
  };
}

/* ------------------------------------------------------------------ *
 * SHA-256 + 幂等 intent（64 位小写 hex；params 见 §1.4）
 * ------------------------------------------------------------------ */

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/** 纯 TS SHA-256 → 64 位小写十六进制（DB 的 p_intent 校验）。 */
export function sha256Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLength = bytes.length * 8;
  const paddedLength = ((bytes.length + 9 + 63) >> 6) << 6;
  const buffer = new Uint8Array(paddedLength);
  buffer.set(bytes);
  buffer[bytes.length] = 0x80;
  const view = new DataView(buffer.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);
  const hash = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const w15 = words[index - 15];
      const w2 = words[index - 2];
      const s0 = rotateRight(w15, 7) ^ rotateRight(w15, 18) ^ (w15 >>> 3);
      const s1 = rotateRight(w2, 17) ^ rotateRight(w2, 19) ^ (w2 >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }
    let a = hash[0]; let b = hash[1]; let c = hash[2]; let d = hash[3];
    let e = hash[4]; let f = hash[5]; let g = hash[6]; let h = hash[7];
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + SHA256_K[index] + words[index]) >>> 0;
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0; d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    hash[0] = (hash[0] + a) >>> 0; hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0; hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0; hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0; hash[7] = (hash[7] + h) >>> 0;
  }
  let hex = '';
  for (let index = 0; index < hash.length; index += 1) hex += hash[index].toString(16).padStart(8, '0');
  return hex;
}

export interface SettingsIntentInput {
  enabled: boolean;
  intervalMinutes: number;
  scopeProvided: boolean;
  warehouseIds: string[];
}

/**
 * 无歧义结构化编码（intent v4 的唯一序列化函数）：
 * - 对象键按码点排序；数组保持调用方给定的顺序（需要无序的调用方先自行排序）；
 * - 字符串按 JSON 转义（引号、反斜杠、`|`、`;`、换行都转义，不再用自由文本分隔符拼接）。
 * 这样“一条备注里含分隔符”与“两条不同映射”不可能得到同一规范文本。
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return 'null';
}

function canonicalWarehouseIds(ids: string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))].sort();
}

export function manualSyncIntentText(): string {
  return 'inventory.manual_sync.v3|{}';
}

export function settingsIntentText(input: SettingsIntentInput): string {
  return `inventory.settings.v4|${canonicalJson({
    enabled: input.enabled,
    intervalMinutes: Math.trunc(input.intervalMinutes),
    scopeProvided: input.scopeProvided,
    scope: input.scopeProvided ? canonicalWarehouseIds(input.warehouseIds) : [],
  })}`;
}

export interface ConfirmMappingInput {
  externalSku: string;
  warehouseExternalId: string;
  itemId: string;
  unit: string;
  reason: string;
  note?: string | null;
  expectedVersion: number | null;
  /** 验证数据（业务包装单位待确认）：不冒充正式业务采用。 */
  verification?: boolean;
}

export function confirmMappingsIntentText(mappings: ConfirmMappingInput[]): string {
  // 每个 map 条目都是结构化对象；数组按条目规范文本排序（确认集合与顺序无关）。
  const items = mappings
    .map((mapping) => canonicalJson({
      externalSku: mapping.externalSku.trim(),
      warehouseExternalId: mapping.warehouseExternalId.trim(),
      itemId: mapping.itemId.trim(),
      unit: mapping.unit.trim(),
      expectedVersion: mapping.expectedVersion === null ? null : Math.trunc(mapping.expectedVersion),
      reason: mapping.reason.trim(),
      note: (mapping.note ?? '').trim() || null,
      verification: mapping.verification === true,
    }))
    .sort();
  return `inventory.confirm_mappings.v4|${canonicalJson(items)}`;
}

export interface DisableMappingInput {
  mappingId: string;
  expectedVersion: number;
  reason: string;
}

export function disableMappingIntentText(input: DisableMappingInput): string {
  return `inventory.disable_mapping.v2|${canonicalJson({
    mappingId: input.mappingId.trim(),
    expectedVersion: Math.trunc(input.expectedVersion),
    reason: input.reason.trim(),
  })}`;
}

export interface RecheckMappingInput {
  mappingId: string;
  expectedVersion: number;
  reason: string;
}

export function recheckMappingIntentText(input: RecheckMappingInput): string {
  return `inventory.recheck_mapping.v2|${canonicalJson({
    mappingId: input.mappingId.trim(),
    expectedVersion: Math.trunc(input.expectedVersion),
    reason: input.reason.trim(),
  })}`;
}

export function buildSettingsIntent(input: SettingsIntentInput): string {
  return sha256Hex(settingsIntentText(input));
}

/**
 * 旧版（v3）intent 文本，仅用于识别/兼容历史本地记录与历史 pending：
 * 新写一律使用 v4 结构化编码，不得再生成这些文本。
 */
export function legacyIntentTextForAction(action: string, payload: Record<string, unknown>): string | null {
  if (action === 'request_inventory_manual_sync') return 'inventory.manual_sync.v2';
  if (action === 'update_inventory_sync_settings') {
    const enabled = payload.enabled === true;
    const intervalMinutes = Number.isSafeInteger(Number(payload.intervalMinutes)) ? Math.trunc(Number(payload.intervalMinutes)) : null;
    const scopeProvided = payload.scopeProvided === true;
    const warehouseIds = Array.isArray(payload.warehouseIds)
      ? (payload.warehouseIds as unknown[]).filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      : [];
    if (intervalMinutes === null) return null;
    const warehouses = scopeProvided ? [...new Set(warehouseIds.map((id) => id.trim()).filter(Boolean))].sort().join(',') : '';
    return `inventory.settings.v2|enabled=${enabled ? 'true' : 'false'}|interval=${intervalMinutes}|scopeProvided=${scopeProvided ? 'true' : 'false'}|scope=${warehouses}`;
  }
  if (action === 'confirm_inventory_mapping') {
    const mappings = Array.isArray(payload.mappings) ? payload.mappings as ConfirmMappingInput[] : [];
    if (mappings.length === 0) return null;
    const items = mappings
      .map((mapping) => [
        (mapping.externalSku ?? '').trim(),
        (mapping.warehouseExternalId ?? '').trim(),
        (mapping.itemId ?? '').trim(),
        (mapping.unit ?? '').trim(),
        mapping.expectedVersion === null || mapping.expectedVersion === undefined ? '' : String(Math.trunc(mapping.expectedVersion)),
        (mapping.reason ?? '').trim(),
        (mapping.note ?? '').trim(),
        mapping.verification === true ? 'verification=true' : 'verification=false',
      ].join('|'))
      .sort();
    return `inventory.confirm_mappings.v3|${items.join(';')}`;
  }
  const mappingId = typeof payload.mappingId === 'string' ? payload.mappingId.trim() : '';
  const expectedVersion = Number(payload.expectedVersion);
  const reason = (typeof payload.reason === 'string' ? payload.reason : '')
    || (typeof payload.note === 'string' ? payload.note : '');
  if (action === 'recheck_inventory_mapping') {
    if (!mappingId || !Number.isSafeInteger(expectedVersion) || !reason.trim()) return null;
    return `inventory.recheck_mapping.v1|${mappingId}|${Math.trunc(expectedVersion)}|${reason.trim()}`;
  }
  if (action === 'disable_inventory_mapping') {
    if (!mappingId || !Number.isSafeInteger(expectedVersion) || !reason.trim()) return null;
    return `inventory.disable_mapping.v2|${mappingId}|${Math.trunc(expectedVersion)}|${reason.trim()}`;
  }
  return null;
}

/** 按当前（v4）编码重算；旧 v3 编码只在 legacyIntentTextForAction 中保留识别能力。 */
export function intentForActionPayload(action: string, payload: Record<string, unknown>): string | null {
  const read = (key: string) => payload[key];
  if (action === 'update_inventory_sync_settings') {
    const enabled = typeof read('enabled') === 'boolean' ? read('enabled') as boolean : null;
    const intervalMinutes = typeof read('intervalMinutes') === 'number' ? Math.trunc(read('intervalMinutes') as number) : null;
    const scopeProvided = read('scopeProvided') === true;
    const warehouseIds = Array.isArray(read('warehouseIds'))
      ? (read('warehouseIds') as unknown[]).filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      : [];
    if (enabled === null || intervalMinutes === null) return null;
    return buildSettingsIntent({ enabled, intervalMinutes, scopeProvided, warehouseIds });
  }
  if (action === 'request_inventory_manual_sync') return buildManualSyncIntent();
  if (action === 'confirm_inventory_mapping') {
    const mappings = Array.isArray(read('mappings')) ? read('mappings') as ConfirmMappingInput[] : [];
    if (mappings.length === 0) return null;
    return buildConfirmMappingsIntent(mappings);
  }
  if (action === 'recheck_inventory_mapping') {
    const mappingId = typeof read('mappingId') === 'string' ? read('mappingId') as string : '';
    const expectedVersion = Number(read('expectedVersion'));
    const reason = (typeof read('reason') === 'string' ? read('reason') as string : '')
      || (typeof read('note') === 'string' ? read('note') as string : '');
    if (!mappingId || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || !reason.trim()) return null;
    return buildRecheckMappingIntent({ mappingId, expectedVersion, reason });
  }
  if (action === 'disable_inventory_mapping') {
    const mappingId = typeof read('mappingId') === 'string' ? read('mappingId') as string : '';
    const expectedVersion = Number(read('expectedVersion'));
    const reason = (typeof read('reason') === 'string' ? read('reason') as string : '')
      || (typeof read('note') === 'string' ? read('note') as string : '');
    if (!mappingId || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || !reason.trim()) return null;
    return buildDisableMappingIntent({ mappingId, expectedVersion, reason });
  }
  return null;
}

export function buildManualSyncIntent(): string {
  return sha256Hex(manualSyncIntentText());
}

export function buildConfirmMappingsIntent(mappings: ConfirmMappingInput[]): string {
  return sha256Hex(confirmMappingsIntentText(mappings));
}

export function buildDisableMappingIntent(input: DisableMappingInput): string {
  return sha256Hex(disableMappingIntentText(input));
}

export function buildRecheckMappingIntent(input: RecheckMappingInput): string {
  return sha256Hex(recheckMappingIntentText(input));
}

/* ------------------------------------------------------------------ *
 * 待重试/恢复 payload（与 begin_inventory_pending_action 原样存一致）
 * ------------------------------------------------------------------ */

export interface PendingSettingsPayload {
  enabled: boolean;
  intervalMinutes: number;
  scopeProvided: boolean;
  warehouseIds: string[];
}

export interface PendingConfirmPayload {
  mappings: ConfirmMappingInput[];
}

export interface PendingMappingActionPayload {
  mappingId?: string;
  expectedVersion?: number;
  reason?: string;
  note?: string;
}

export function pendingRetryKindLabel(kind: string | null | undefined): string {
  return pendingActionLabel(kind);
}

export function reconcileKindFromPendingAction(action: string | null | undefined): string {
  if (action === 'update_inventory_sync_settings') return 'settings';
  if (action === 'request_inventory_manual_sync') return 'manual';
  if (action === 'confirm_inventory_mapping') return 'confirm';
  if (action === 'disable_inventory_mapping') return 'disable';
  if (action === 'recheck_inventory_mapping') return 'recheck';
  return '';
}

export function readPendingSettingsPayload(payload: Record<string, unknown>): PendingSettingsPayload | null {
  if (typeof payload.enabled !== 'boolean' || typeof payload.intervalMinutes !== 'number') return null;
  return {
    enabled: payload.enabled,
    intervalMinutes: Math.trunc(payload.intervalMinutes),
    scopeProvided: payload.scopeProvided === true,
    warehouseIds: Array.isArray(payload.warehouseIds)
      ? payload.warehouseIds.map((entry) => (typeof entry === 'string' ? entry : '')).filter(Boolean)
      : [],
  };
}

export function readPendingConfirmPayload(payload: Record<string, unknown>): PendingConfirmPayload | null {
  const mappings = Array.isArray(payload.mappings) ? payload.mappings : [];
  if (mappings.length === 0) return null;
  return { mappings: mappings as ConfirmMappingInput[] };
}

export function readPendingMappingActionPayload(payload: Record<string, unknown>): PendingMappingActionPayload | null {
  const mappingId = typeof payload.mappingId === 'string' ? payload.mappingId : '';
  const expectedVersion = typeof payload.expectedVersion === 'number' ? Math.trunc(payload.expectedVersion) : NaN;
  const reason = typeof payload.reason === 'string' ? payload.reason : (typeof payload.note === 'string' ? payload.note : '');
  if (!isUuid(mappingId) || !Number.isSafeInteger(expectedVersion) || !reason.trim()) return null;
  return { mappingId, expectedVersion, reason };
}

/* ------------------------------------------------------------------ *
 * 列表/详情的“同一查询上下文”辅助（R1）
 * ------------------------------------------------------------------ */

export function listWarehouseName(list: Pick<InventoryListDto, 'items'>, warehouseId: string): string | null {
  for (const item of list.items) {
    for (const ref of [...(item.notMappedWarehouses ?? []), ...(item.unseenWarehouses ?? []), ...(item.failedWarehouses ?? [])]) {
      if (ref.warehouseId === warehouseId) return ref.name;
    }
  }
  return null;
}

export function detailRowsForScope<T extends { warehouseName: string }>(rows: T[], scopeMode: 'filtered' | 'all'): T[] {
  return scopeMode === 'all' ? rows : rows;
}

export function unitGroupsSummary(groups: InventoryListUnitGroupDto[]): string {
  if (groups.length === 0) return '没有可合计的单位组';
  return groups
    .map((group) => `${group.unit ?? '未标单位'}：${formatQuantityOr(group.knownSubtotal, '—')}（${group.rowCount} 行）`)
    .join('；');
}

export { type InventoryMappingQueueDto };

/* ------------------------------------------------------------------ *
 * 双视图：仓库明细 / 商品汇总（v1）
 * ------------------------------------------------------------------ */

export function viewModeLabel(view: InventoryViewMode): string {
  return view === 'product' ? '商品汇总' : '仓库明细';
}

export function sourceScopeLabel(source: InventorySourceScope): string {
  if (source === 'overseas') return '仅海外（BigSeller）';
  if (source === 'domestic') return '仅国内（表格快照）';
  return '海外 + 国内表格快照';
}

export function sourceScopeIncludesOverseas(source: InventorySourceScope): boolean {
  return source !== 'domestic';
}

export function sourceScopeIncludesDomestic(source: InventorySourceScope): boolean {
  return source !== 'overseas';
}

/** 国内表格快照的固定口径说明：文件日期、未注明仓库/单位/观测时间，不冒充实时库存。 */
export const DOMESTIC_SNAPSHOT_LABEL = '国内（聚水潭表格快照）';

export function domesticSnapshotNotice(fileDates: string[]): string {
  const dates = [...new Set(fileDates.filter(Boolean))].sort();
  const dateText = dates.length > 0 ? `文件日期 ${dates.join(' / ')}` : '文件日期见原表';
  return `${DOMESTIC_SNAPSHOT_LABEL}：${dateText}；原表未注明仓库、单位与确切观测时间，不冒充实时库存，也不与海外来源跨来源相加。`;
}

export interface WarehouseRowStatusDisplay {
  label: string;
  tone: Tone;
}

export function warehouseRowStatusDisplay(row: Pick<InventoryWarehouseRowDto, 'source' | 'status'>): WarehouseRowStatusDisplay {
  if (row.source === 'domestic') {
    return row.status === 'adopted'
      ? { label: '已核对选择（计入国内）', tone: 'green' }
      : { label: '未纳入国内汇总（待确认归属）', tone: 'amber' };
  }
  if (row.status === 'adopted') return { label: '已计入库存', tone: 'green' };
  if (row.status === 'pending_adoption') return { label: '已确认，待下一完整批次采用（不计入）', tone: 'blue' };
  if (row.status === 'inactive') return { label: '历史已采用，当前对应停用/重核（不计入）', tone: 'amber' };
  return { label: '来源未对应（不计入）', tone: 'amber' };
}

/** 仓库明细主视觉：名称优先、SKU 为辅；未对应显示来源名称并标待确认归属。 */
export interface WarehouseRowTitleDisplay {
  title: string;
  subtitle: string;
  pendingOwner: boolean;
}

export function warehouseRowTitleDisplay(row: Pick<InventoryWarehouseRowDto, 'source' | 'status' | 'itemName' | 'iceCode' | 'sourceName' | 'externalSku' | 'gtin'>): WarehouseRowTitleDisplay {
  const mapped = row.status !== 'unmapped' && Boolean(row.itemName || row.iceCode);
  const title = mapped
    ? (row.itemName ?? row.iceCode ?? row.externalSku)
    : (row.sourceName?.trim() ? row.sourceName : row.externalSku);
  const parts: string[] = [];
  if (mapped && row.iceCode) parts.push(row.iceCode);
  if (!mapped) parts.push('待确认归属');
  parts.push(`来源 SKU ${row.externalSku}`);
  if (mapped && row.gtin) parts.push(`69 ${row.gtin}`);
  return { title, subtitle: parts.join(' · '), pendingOwner: !mapped };
}

/** 商品汇总格：数量未知/待合计时不写 0。 */
export function marketCellQuantity(cell: Pick<InventoryProductMarketCellDto, 'onHand' | 'hasPendingTotal'>): string {
  if (cell.hasPendingTotal) return '待核对';
  return formatQuantityOr(cell.onHand, '—');
}

export function marketCellLabel(cell: Pick<InventoryProductMarketCellDto, 'market'>): string {
  return cell.market ?? '市场待确认';
}

export function domesticCellQuantity(cell: InventoryProductDomesticCellDto | null): string {
  if (!cell || cell.onHand === null) return '—';
  return formatQuantityOr(cell.onHand, '—');
}

export function domesticCellMeta(cell: InventoryProductDomesticCellDto | null): string {
  if (!cell || cell.rowCount === 0) return '无国内选择';
  const dates = [...new Set(cell.fileDates.filter(Boolean))].sort();
  const dateText = dates.length > 0 ? dates.join('/') : '日期见原表';
  return `${cell.rowCount} 条有效选择 · 文件 ${dateText}${cell.hasQuantityAnomaly ? ' · 含未注明数量行' : ''}`;
}

/** 未知市场的筛选值：仓库 market 为空（不猜国家，也不匹配任意市场）。 */
export const UNKNOWN_MARKET_TOKEN = '__unknown__';

export function isUnknownMarketToken(value: string | null | undefined): boolean {
  return value === UNKNOWN_MARKET_TOKEN;
}

/** 市场范围短标签（市场下拉已删除，只在有国家下钻时显示一个可清除标签）。 */
export function marketScopeLabel(market: string): string {
  if (market === 'all') return '';
  return market === UNKNOWN_MARKET_TOKEN ? '市场待确认（未知仓）' : `市场 ${market}`;
}

/**
 * 商品汇总格 → 仓库明细（同商品同市场，可定位）。
 * 未知市场格（market=null）使用 __unknown__ 哨兵，只定位 market 为空的仓，不退化成全部市场。
 */
export function buildProductToWarehouseHref(
  state: Pick<InventoryQueryState, 'q' | 'warehouse' | 'market' | 'source'>,
  item: { iceCode: string | null; nameCn: string | null; itemId: string },
  market: string | null,
): string {
  const params = new URLSearchParams();
  const search = item.iceCode ?? item.nameCn ?? '';
  if (search) params.set('q', search);
  if (state.warehouse && state.warehouse !== 'all') params.set('warehouse', state.warehouse);
  params.set('market', market ?? UNKNOWN_MARKET_TOKEN);
  const source: InventorySourceScope = market ? 'overseas' : (state.source === 'domestic' ? 'all' : state.source);
  if (source !== 'all') params.set('source', source);
  params.set('focus', item.itemId);
  return `/dashboard/inventory?${params.toString()}`;
}

/** 库存 → 唯一维护入口（来源 SKU 对应）：带商品/仓/SKU 定位与可校验的 back 原筛选。 */
export function buildInventoryMappingHref(
  query: InventoryQueryState,
  target: { itemId: string | null; warehouseId: string | null; externalSku: string },
): string {
  const params = new URLSearchParams();
  params.set('from', 'inventory');
  if (target.itemId) params.set('item', target.itemId);
  if (target.warehouseId) params.set('warehouse', target.warehouseId);
  if (target.externalSku) params.set('sku', target.externalSku);
  const back = buildInventoryListHref({
    q: query.q,
    warehouse: query.warehouse,
    market: query.market,
    view: query.view,
    source: query.source,
    focus: target.itemId ?? query.focus,
    page: query.page,
  });
  params.set('back', back);
  return `/dashboard/catalog/mappings?${params.toString()}`;
}

/** 库存列表行详情（弹层）URL：保留筛选/页码，带上行键与商品，供刷新/直接打开还原。 */
export function buildInventoryRowDetailHref(
  state: InventoryQueryState,
  target: { rowKey: string; itemId?: string | null },
): string {
  const params = new URLSearchParams();
  if (state.q) params.set('q', state.q);
  if (state.warehouse !== 'all') params.set('warehouse', state.warehouse);
  if (state.market !== 'all') params.set('market', state.market);
  if (state.view === 'product') params.set('view', 'product');
  if (state.source !== 'all') params.set('source', state.source);
  if (state.focus) params.set('focus', state.focus);
  if (state.page > 1) params.set('page', String(state.page));
  if (target.itemId && isUuid(target.itemId)) params.set('item', target.itemId);
  if (target.rowKey) params.set('row', target.rowKey);
  return `/dashboard/inventory?${params.toString()}`;
}

/** 商品资料（商品库详情弹窗）：直接打开该商品，返回时用浏览器后退回到原库存筛选。 */
export function buildCatalogItemHref(itemId: string, iceCode: string | null): string {
  const params = new URLSearchParams();
  params.set('detail', itemId);
  if (iceCode) params.set('q', iceCode);
  return `/dashboard/catalog?${params.toString()}`;
}

/** 分页页码：当前页附近最多 7 个页码 + 首末页（不引入新的分页平台）。 */
export function inventoryPageNumbers(page: number, pageCount: number): Array<number | 'gap'> {
  const total = Math.max(1, Math.trunc(pageCount));
  const current = Math.min(Math.max(1, Math.trunc(page)), total);
  const pages = new Set<number>([1, total]);
  for (let offset = -2; offset <= 2; offset += 1) {
    const value = current + offset;
    if (value >= 1 && value <= total) pages.add(value);
  }
  const sorted = [...pages].sort((a, b) => a - b);
  const result: Array<number | 'gap'> = [];
  for (const value of sorted) {
    const last = result.at(-1);
    if (typeof last === 'number' && value - last > 1) result.push('gap');
    result.push(value);
  }
  return result;
}

/** 仓库明细行 → 商品汇总（定位到标准商品）。 */
export function buildWarehouseToProductHref(
  state: Pick<InventoryQueryState, 'q' | 'warehouse' | 'market' | 'source'>,
  itemId: string,
  search: string,
): string {
  const params = new URLSearchParams();
  if (search) params.set('q', search);
  if (state.warehouse && state.warehouse !== 'all') params.set('warehouse', state.warehouse);
  if (state.market && state.market !== 'all') params.set('market', state.market);
  if (state.source !== 'all') params.set('source', state.source);
  params.set('view', 'product');
  params.set('focus', itemId);
  return `/dashboard/inventory?${params.toString()}`;
}

/** 逐仓读取状态（同步页 / 仓库明细顶部共用文案）。 */
export function warehouseReadStateDisplay(state: Pick<InventoryWarehouseReadStateV2Dto, 'failed' | 'stale' | 'lastErrorCode' | 'lastSuccessAt' | 'batchRows'>): {
  label: string;
  tone: Tone;
  detail: string;
} {
  if (state.failed) {
    return {
      label: state.lastSuccessAt ? '本次失败，沿用上次成功数据' : '本次失败，尚无成功数据',
      tone: 'red',
      detail: errorCodeLabel(state.lastErrorCode) ?? '失败原因未提供',
    };
  }
  if (state.batchRows > 0) {
    return { label: '当前批次已发布', tone: 'green', detail: `本批 ${state.batchRows} 行来源` };
  }
  return { label: '还没有成功批次', tone: 'neutral', detail: '尚未发布过完整成功批次' };
}

/** 同步页逐仓结果：文件保存成功 ≠ SKU 全部已对应。 */
export function warehouseSyncResultText(state: Pick<InventoryWarehouseReadStateV2Dto, 'failed' | 'adoptedRows' | 'unmappedRows' | 'batchRows'>): string {
  if (state.failed) return '本次失败';
  if (state.batchRows === 0) return '无成功批次';
  if (state.unmappedRows > 0) return `同步成功，另有 ${state.unmappedRows} 条来源待对应`;
  return '同步成功，来源已全部对应';
}

export function warehouseRowsCountsText(counts: { adopted: number; unmapped: number; pendingAdoption: number; inactive?: number }): string {
  const inactive = counts.inactive && counts.inactive > 0 ? ` · 历史采用现停用 ${counts.inactive} 行` : '';
  return `已计入 ${counts.adopted} 行 · 来源未对应 ${counts.unmapped} 行${counts.pendingAdoption > 0 ? ` · 待下一批次 ${counts.pendingAdoption} 行` : ''}${inactive}`;
}

export function warehouseRowQuantitySummary(row: Pick<InventoryWarehouseRowDto, 'source' | 'unit' | 'onHand' | 'warehouseAvailable'>): { primary: string; secondary: string | null } {
  const primary = formatQuantityOr(row.onHand, '—');
  const unit = row.unit && row.source === 'bigseller' ? ` ${row.unit}` : '';
  const available = row.warehouseAvailable !== null && row.warehouseAvailable !== undefined
    ? `${formatQuantityOr(row.warehouseAvailable, '—')}${unit}`
    : null;
  return {
    primary: `${primary}${unit}`,
    secondary: available === null ? null : (row.source === 'domestic' ? `可用数 ${available}` : `整仓可用 ${available}`),
  };
}

/**
 * 仓库行“本次未见但有历史值”的短说明：只对未计入本批的海外行显示上次已知数量/旧时间。
 * 本批有原数量（inactive）时以行内原数量为准，不重复；旧值只作展示，不当本次库存。
 */
export function warehouseRowLastKnownText(
  row: Pick<InventoryWarehouseRowDto, 'source' | 'status' | 'onHand' | 'lastKnownQty' | 'lastKnownAt'>,
): string | null {
  if (row.source !== 'bigseller') return null;
  if (row.status !== 'pending_adoption' && row.status !== 'inactive') return null;
  if (row.lastKnownQty === null || row.lastKnownQty === undefined) return null;
  if (row.onHand !== null && row.onHand !== undefined) return null;
  const at = row.lastKnownAt ? `（${formatTimestamp(row.lastKnownAt)}）` : '';
  return `本次未见该 SKU：上次已知 ${formatQuantity(row.lastKnownQty)}${at}，只作展示、不计入本次合计。`;
}

/** 国内快照记录在详情里的状态短标签（不冒充海外对应状态）。 */
export function domesticReviewLabel(state: string | null | undefined): string {
  if (state === 'manual_selected') return '已核对选择';
  if (state === 'pending') return '待核对';
  if (state === 'ignored') return '已忽略';
  if (state === 'rejected') return '已排除';
  if (state === 'candidate') return '候选';
  return state ? `原表状态：${state}` : '原表状态未标注';
}

/** 商品汇总行的海外合计显示（多单位/未知不凑数）。 */
export function productOverseasTotalText(row: Pick<InventoryProductSummaryRowDtoLike, 'overseasOnHand' | 'unitConflict' | 'hasPendingTotal'>): string {
  if (row.unitConflict) return '多单位，不合计';
  if (row.hasPendingTotal) return '合计待核对';
  return formatQuantityOr(row.overseasOnHand, '—');
}

type InventoryProductSummaryRowDtoLike = {
  overseasOnHand: number | null;
  unitConflict: boolean;
  hasPendingTotal?: boolean;
};
