/**
 * 货票与在途 v1 页面纯逻辑（无数据库、无环境变量、无 React；Node/浏览器/单测共用）。
 *
 * 职责（第二轮口径）：
 * - URL 参数还原（市场/状态/关键词/商品/是否包含本次来源未见/页码/每页/详情票）；
 * - 业务状态 5 类中文短标签与语气（到货待上架 / 到货上架 / 部分到货待核 分开）；
 * - 数量展示口径：累计到货/剩余在途未知一律「未提供」+ 待核，**永远不写 0 冒充未知**；
 * - G 运输进度与 H 到货/上架说明分开：列表「业务状态」列主内容就是 G 原文（空写「未填写」，同时详情仍展示），
 *   「预计到仓」列只放 H 原文；到货/分批/上架分类仍只按 H 判断；
 * - 采购单号/SKU/单位等来源未提供时如实写「未提供」，不用运单号顶替；
 * - 时间格式化固定 Asia/Shanghai；来源时间缺失显示「—」；
 * - 来源读取状态（最近成功/本次结果/本次未见）与读取失败分类；
 * - 列表/详情/分页链接与页码，全部走 URL。
 */

import type {
  ShipmentAssociationSavedPayloadDto,
  ShipmentDetailItemDto,
  ShipmentListCountsDto,
  ShipmentListRowDto,
  ShipmentManualStatus,
  ShipmentMarketSummaryDto,
  ShipmentRefreshResultDto,
  ShipmentSourceStatusDto,
  ShipmentStatusClass,
  ShipmentSummaryProductDto,
} from './types';
import { formatCnyValue } from '@/features/catalog/local-display/money-display';
import { resolveSpecification } from '@/features/catalog/specification';

export type Tone = 'neutral' | 'green' | 'amber' | 'red' | 'blue' | 'purple';

export const SHIPMENT_PAGE_SIZES = [20, 50, 100] as const;
export const DEFAULT_SHIPMENT_PAGE_SIZE = 50;
export const MAX_SEARCH_LENGTH = 120;

/** 市场筛选里「来源未给国家」的哨兵值（与 reads.ts 的 p_market 语义一致）。 */
export const UNKNOWN_MARKET_TOKEN = '__unknown__';

export const SHIPMENT_MARKET_ALL = 'all';

/** 列表/详情/搜索文案保持一致：采购单号、运单号、商品名称。 */
export const SHIPMENT_SEARCH_PLACEHOLDER = '搜索采购单号 / 运单号 / 商品名称';
export const SHIPMENT_SEARCH_ARIA = '搜索采购单号、运单号或商品名称';

/* ------------------------------------------------------------------ *
 * 时间与数量（确定性：固定 Asia/Shanghai）
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

/** 来源时间展示：缺失/无效写「—」，不借用读取时间冒充来源时间。 */
export function formatSourceTime(iso: string | null | undefined): string {
  return formatTimestamp(iso) || '—';
}

/** 整数数量显示：千分位；null/NaN 返回空串（不当成 0）。 */
export function formatQuantity(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  const sign = value < 0 ? '-' : '';
  const digits = String(Math.abs(Math.trunc(value))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${digits}`;
}

export function formatQuantityOr(value: number | null | undefined, fallback = '—'): string {
  return formatQuantity(value) || fallback;
}

/* ------------------------------------------------------------------ *
 * 业务状态（5 类）
 * ------------------------------------------------------------------ */

export const SHIPMENT_STATUS_CLASSES: ShipmentStatusClass[] = [
  'in_transit',
  'partial',
  'arrived_pending_shelving',
  'arrived',
  'unknown',
];

export type ShipmentStatusFilter = 'all' | ShipmentStatusClass;

const STATUS_LABELS: Record<ShipmentStatusClass, string> = {
  in_transit: '运输在途',
  partial: '部分到货待核',
  arrived_pending_shelving: '已到货待上架',
  arrived: '已到货上架',
  unknown: '状态未提供待核',
};

const STATUS_TONES: Record<ShipmentStatusClass, Tone> = {
  in_transit: 'blue',
  partial: 'amber',
  arrived_pending_shelving: 'purple',
  arrived: 'green',
  unknown: 'neutral',
};

export function shipmentStatusLabel(status: ShipmentStatusClass | null | undefined): string {
  return (status && STATUS_LABELS[status]) || STATUS_LABELS.unknown;
}

export function shipmentStatusTone(status: ShipmentStatusClass | null | undefined): Tone {
  return (status && STATUS_TONES[status]) || 'neutral';
}

/** 状态计数行（5 类都显示真实计数；0 是计数不是未知值）。 */
export function statusCountsText(counts: ShipmentListCountsDto): string {
  return [
    `${STATUS_LABELS.in_transit} ${counts.inTransit}`,
    `${STATUS_LABELS.partial} ${counts.partial}`,
    `${STATUS_LABELS.arrived_pending_shelving} ${counts.arrivedPendingShelving}`,
    `${STATUS_LABELS.arrived} ${counts.arrived}`,
    `${STATUS_LABELS.unknown} ${counts.unknown}`,
  ].join(' · ');
}

/** 本次来源未见提示：已退出当前列表，但历史事实与原数量保留（不是到货、不是 0）。 */
export function absentSummaryText(absentTickets: number, absentItems: number): string | null {
  const tickets = Number.isFinite(absentTickets) ? Math.max(0, Math.trunc(absentTickets)) : 0;
  const items = Number.isFinite(absentItems) ? Math.max(0, Math.trunc(absentItems)) : 0;
  if (tickets === 0 && items === 0) return null;
  return `本次来源未见 ${tickets} 票 / ${items} 明细（已退出当前列表，历史保留）`;
}

/** 身份待核：来源编号变化但无法唯一确认原票（不猜着合并，也不静默重复）。 */
export function identityPending(status: string | null | undefined): boolean {
  return status === 'pending';
}

/** 状态原文摘要：压成一行并截断；原文只做摘要，不替代短标签结论。 */
export function oneLineText(text: string | null | undefined, max = 26): string {
  const normalized = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}

/** 未给国家的市场显示「未提供」，不猜市场。 */
export function marketText(market: string | null | undefined): string {
  return (market ?? '').trim() || '未提供';
}

export function marketOptionValue(market: string | null | undefined): string {
  return (market ?? '').trim() || UNKNOWN_MARKET_TOKEN;
}

/* ------------------------------------------------------------------ *
 * 数量口径：累计到货 / 剩余在途（未知不写 0）
 * ------------------------------------------------------------------ */

export interface QuantityDisplay {
  text: string;
  pending: boolean;
  tone: Tone;
}

/**
 * 剩余在途：只有服务端明确 known 且给了数字才显示数字；
 * pending 或数字缺失都显示「未提供」并标待核，绝不把未知写成 0。
 */
export function remainingDisplay(
  item: Pick<ShipmentDetailItemDto, 'remainingQuantity' | 'remainingState'>,
): QuantityDisplay {
  if (item.remainingState === 'known'
    && typeof item.remainingQuantity === 'number'
    && Number.isFinite(item.remainingQuantity)) {
    return { text: formatQuantity(item.remainingQuantity), pending: false, tone: 'neutral' };
  }
  return { text: '未提供', pending: true, tone: 'amber' };
}

/** 累计到货：来源未提供逐条到货数量（pending）时显示「未提供」+ 待核，不按发货量补齐。 */
export function receivedDisplay(
  item: Pick<ShipmentDetailItemDto, 'receivedQuantity' | 'receiptBasis'>,
): QuantityDisplay {
  const pending = item.receiptBasis === 'pending';
  if (typeof item.receivedQuantity === 'number' && Number.isFinite(item.receivedQuantity)) {
    return { text: formatQuantity(item.receivedQuantity), pending, tone: pending ? 'amber' : 'neutral' };
  }
  return { text: '未提供', pending: true, tone: 'amber' };
}

const RECEIPT_BASIS_LABELS: Record<string, string> = {
  status_in_transit_zero: '按运输中状态计为未到货',
  status_awaiting_shelving_zero: '整票已到但未上架，按未结束在途计',
  status_arrived_full: '已到货上架（整票或点名商品），按到货量计',
  source_quantity: '来源逐条提供到货数量',
  pending: '来源未提供到货数量，待核',
  manual_correction: '人工修正在途（不按原表）',
};

export function receiptBasisLabel(basis: string | null | undefined): string {
  return (basis && RECEIPT_BASIS_LABELS[basis]) || '到货依据未标注';
}

/** 单位/SKU 列：来源本来就没有这两列，如实显示「来源未提供」，不做换算。 */
export function sourceFieldText(value: string | null | undefined): string {
  return (value ?? '').trim() || '来源未提供';
}

export function noteText(value: string | null | undefined): string {
  return (value ?? '').trim() || '—';
}

/* ------------------------------------------------------------------ *
 * 人工「修正在途」（第八轮）
 * ------------------------------------------------------------------ */

export const MANUAL_STATUSES: ShipmentManualStatus[] = [
  'in_transit',
  'arrived_pending_shelving',
  'fully_shelved',
  'partial_shelved',
  'unknown',
];

const MANUAL_STATUS_LABELS: Record<ShipmentManualStatus, string> = {
  in_transit: '运输中',
  arrived_pending_shelving: '已到货待上架',
  fully_shelved: '全部已上架',
  partial_shelved: '分批上架',
  unknown: '状态未知',
};

const MANUAL_STATUS_TONES: Record<ShipmentManualStatus, Tone> = {
  in_transit: 'blue',
  arrived_pending_shelving: 'purple',
  fully_shelved: 'green',
  partial_shelved: 'amber',
  unknown: 'neutral',
};

export function manualStatusLabel(status: ShipmentManualStatus | null | undefined): string {
  return (status && MANUAL_STATUS_LABELS[status]) || '状态未知';
}

export function manualStatusTone(status: ShipmentManualStatus | null | undefined): Tone {
  return (status && MANUAL_STATUS_TONES[status]) || 'neutral';
}

/**
 * 弹窗默认状态：有 manual 时以 manual 为准（调用方优先取 item.manualStatus），
 * 否则按原表到货依据给最近的人工状态（pending → 状态未知，不猜成 0/到货）。
 */
export function manualStatusFromReceiptBasis(basis: string | null | undefined): ShipmentManualStatus {
  switch (basis) {
    case 'status_in_transit_zero':
      return 'in_transit';
    case 'status_awaiting_shelving_zero':
      return 'arrived_pending_shelving';
    case 'status_arrived_full':
      return 'fully_shelved';
    case 'source_quantity':
      return 'partial_shelved';
    default:
      return 'unknown';
  }
}

/** 人工修正记录的动作标签（apply / restore）。 */
export function manualRevisionActionLabel(action: string | null | undefined): string {
  return action === 'restore' ? '恢复按原表判断' : '人工修正';
}

/** 分批上架的输入方式：直接填商品数量，或按商品库装箱数换算箱数。 */
export type ManualInputMode = 'quantity' | 'boxes';

export interface ManualBoxConversion {
  boxes: number;
  cartonQuantity: number;
  quantity: number;
}

export interface ManualCorrectionPreview {
  ok: boolean;
  /** 非法输入的原因；ok=true 时为空。 */
  error: string | null;
  /** 本次将采用的累计到货；未知（状态未知）为 null，不写 0。 */
  receivedQuantity: number | null;
  /** 本次将采用的剩余在途；未知为 null，不写 0。 */
  remainingQuantity: number | null;
  /** 弹窗展示的算式行（中文，逐行）。 */
  formulaLines: string[];
  /** 按箱输入时的换算明细（箱数 × 装箱数 = 商品数量）；不按箱时为 null。 */
  boxConversion: ManualBoxConversion | null;
}

function parseNonNegativeInteger(raw: string): { ok: boolean; value: number; error: string | null } {
  const text = raw.trim().replace(/[,，\s]/g, '');
  if (!text) return { ok: false, value: 0, error: '请输入数量' };
  if (!/^\d+$/.test(text)) return { ok: false, value: 0, error: '请输入非负整数（不带小数、单位或文字）' };
  const value = Number(text);
  if (!Number.isSafeInteger(value)) return { ok: false, value: 0, error: '数量超出可保存范围' };
  return { ok: true, value, error: null };
}

/**
 * 「修正在途」预览纯函数：发货量 + 人工状态 + 累计已上架输入 → 将采用的累计到货/剩余与算式。
 * 非法输入返回 ok=false + error，数量保持 null（不写 0）；状态未知时累计与剩余都未知。
 * 装箱数只接受商品库 cartonQuantity，不从规格/名称推算。
 */
export function manualCorrectionPreview(input: {
  shippedQuantity: number;
  status: ShipmentManualStatus;
  cumulativeShelvedText: string;
  cartonQuantity: number | null;
  inputMode: ManualInputMode;
}): ManualCorrectionPreview {
  const invalid = (error: string): ManualCorrectionPreview => ({
    ok: false,
    error,
    receivedQuantity: null,
    remainingQuantity: null,
    formulaLines: [],
    boxConversion: null,
  });
  const shipped = input.shippedQuantity;
  if (typeof shipped !== 'number' || !Number.isSafeInteger(shipped) || shipped <= 0) {
    return invalid('发货量无效，无法计算');
  }
  const shippedText = formatQuantity(shipped);

  switch (input.status) {
    case 'in_transit':
    case 'arrived_pending_shelving':
      return {
        ok: true,
        error: null,
        receivedQuantity: 0,
        remainingQuantity: shipped,
        formulaLines: ['累计到货 = 0', `剩余在途 = 发货量 ${shippedText} − 0 = ${shippedText}`],
        boxConversion: null,
      };
    case 'fully_shelved':
      return {
        ok: true,
        error: null,
        receivedQuantity: shipped,
        remainingQuantity: 0,
        formulaLines: [`累计到货 = 发货量 = ${shippedText}`, '剩余在途 = 0'],
        boxConversion: null,
      };
    case 'unknown':
      return {
        ok: true,
        error: null,
        receivedQuantity: null,
        remainingQuantity: null,
        formulaLines: ['累计到货未提供', '剩余在途待核'],
        boxConversion: null,
      };
    case 'partial_shelved': {
      if (input.inputMode === 'boxes') {
        const carton = input.cartonQuantity;
        if (typeof carton !== 'number' || !Number.isSafeInteger(carton) || carton <= 0) {
          return invalid('该商品没有商品库装箱数量，请直接填商品数量');
        }
        const boxes = parseNonNegativeInteger(input.cumulativeShelvedText);
        if (!boxes.ok) return invalid(boxes.error ?? '箱数无效');
        const quantity = boxes.value * carton;
        if (!Number.isSafeInteger(quantity)) return invalid('箱数 × 装箱数超出可保存范围');
        if (quantity > shipped) return invalid(`累计已上架不能超过发货量 ${shippedText}`);
        const remaining = shipped - quantity;
        return {
          ok: true,
          error: null,
          receivedQuantity: quantity,
          remainingQuantity: remaining,
          formulaLines: [
            `箱数 × 装箱数 = ${formatQuantity(boxes.value)} × ${formatQuantity(carton)} = ${formatQuantity(quantity)}`,
            `剩余在途 = ${shippedText} − ${formatQuantity(quantity)} = ${formatQuantity(remaining)}`,
          ],
          boxConversion: { boxes: boxes.value, cartonQuantity: carton, quantity },
        };
      }
      const parsed = parseNonNegativeInteger(input.cumulativeShelvedText);
      if (!parsed.ok) return invalid(parsed.error ?? '累计已上架无效');
      if (parsed.value > shipped) return invalid(`累计已上架不能超过发货量 ${shippedText}`);
      const remaining = shipped - parsed.value;
      return {
        ok: true,
        error: null,
        receivedQuantity: parsed.value,
        remainingQuantity: remaining,
        formulaLines: [
          `累计已上架 = ${formatQuantity(parsed.value)}`,
          `剩余在途 = ${shippedText} − ${formatQuantity(parsed.value)} = ${formatQuantity(remaining)}`,
        ],
        boxConversion: null,
      };
    }
    default:
      return invalid('请选择修正在途状态');
  }
}

/* ------------------------------------------------------------------ *
 * 列表单元格
 * ------------------------------------------------------------------ */

export interface ProductSummaryDisplay {
  primary: string;
  more: string | null;
}

/** 商品摘要：只显示商品名称（最多 3 条）+「等 n 项」，不带数量、不合计。 */
export function productSummaryDisplay(
  row: Pick<ShipmentListRowDto, 'productSummary' | 'itemCount'>,
): ProductSummaryDisplay {
  const names = (row.productSummary ?? []).map((name) => (name ?? '').trim()).filter(Boolean);
  const shown = names.slice(0, 3);
  const totalItems = Number.isFinite(row.itemCount) && row.itemCount > 0 ? row.itemCount : names.length;
  const rest = Math.max(0, totalItems - shown.length);
  return {
    primary: shown.join('、') || '—',
    more: rest > 0 ? `等 ${rest} 项` : null,
  };
}

/**
 * 关联搜索候选的规格文本（第四轮补修）：商品库独立规格原文优先，缺失再从标准名称提取；
 * 与商品库列表/详情的解析同一函数。没有可用规格时返回 null（候选不显示规格标签）。
 */
export function productSearchSpecText(
  row: { specification: string | null; nameCn: string },
): string | null {
  const resolved = resolveSpecification({ specificationText: row.specification, nameCn: row.nameCn });
  return resolved.text || null;
}

/** 采购单号：没有就显示「未提供」，绝不用运单号顶替。 */
export function purchaseOrderText(value: string | null | undefined): string {
  return (value ?? '').trim() || '未提供';
}

/** 运单号原文：可能多张（换行/斜杠分隔），保留原文可读性；没有时「未提供」。 */
export function waybillsText(value: string | null | undefined): string {
  return (value ?? '').trim() || '未提供';
}

/** 第一张运单号（多张按换行、斜杠、空白切分后的第一个非空 token）。 */
export function firstWaybill(value: string | null | undefined): string {
  return (value ?? '').split(/[\s/]+/).map((token) => token.trim()).filter(Boolean)[0] ?? '';
}

/** 详情标题：采购单号 → 第一张运单号 → 「无单号货票」（不再叫「货票号」）。 */
export function ticketTitle(
  purchaseOrder: string | null | undefined,
  waybills: string | null | undefined,
): string {
  const po = (purchaseOrder ?? '').trim();
  if (po) return po;
  const waybill = firstWaybill(waybills);
  if (waybill) return waybill;
  return '无单号货票';
}

/** 「预计到仓」列：H 原文（含分批/待上架/已上架说明）；没有时「—」。 */
export function arrivalColumnText(value: string | null | undefined): string {
  return (value ?? '').trim() || '—';
}

/**
 * 「业务状态」列主内容：G 列「物流情况」原文（如 清关中、派送中），只去掉首尾空白；
 * 空/只有空白写「未填写」，不改写成 H 分类短标签（分类另作副行展示）。
 * 列表该列排序也按本函数结果，保证排序与可见内容一致。
 */
export function transportColumnText(value: string | null | undefined): string {
  return (value ?? '').trim() || '未填写';
}

/* ------------------------------------------------------------------ *
 * 来源读取状态与失败
 * ------------------------------------------------------------------ */

const SOURCE_ERROR_LABELS: Record<string, string> = {
  SOURCE_CLI_MISSING: '来源读取工具不可用',
  SOURCE_CLI_FAILED: '来源读取失败',
  SOURCE_CLI_TIMEOUT: '来源读取超时',
  SOURCE_CLI_BAD_JSON: '来源返回内容无法解析',
  SOURCE_DOC_UNRESOLVED: '来源文档无法定位',
  SOURCE_SHEET_MISSING: '来源工作表不存在',
  SOURCE_HEADER_MISMATCH: '来源表头与约定不一致',
  SOURCE_GRID_INVALID: '来源网格数据无效',
  SOURCE_EMPTY: '来源没有可读取的数据',
  SOURCE_REVISION_MISSING: '来源缺少版本号',
};

export function shipmentErrorCodeLabel(code: string | null | undefined): string | null {
  if (!code) return null;
  return SOURCE_ERROR_LABELS[code] ?? null;
}

/** 失败原因短句：优先中文错误码，其次服务端短原因，不再拼接技术堆栈。 */
export function shipmentErrorMessage(
  code: string | null | undefined,
  message: string | null | undefined,
): string {
  const label = shipmentErrorCodeLabel(code);
  if (label) return label;
  const normalized = oneLineText(message, 60);
  if (normalized) return normalized;
  return '来源读取失败';
}

export interface SourceStatusDisplay {
  tone: Tone;
  /** 最近成功读取（时间 + 票/明细 + 来源更新时间/revision）。 */
  lastSuccessText: string;
  lastSuccessDetail: string;
  /** 本次读取结果（最近一次尝试，或刚完成的刷新结果）。 */
  attemptText: string;
  attemptFailed: boolean;
  /** 后台自动读取状态（是否运行/间隔/最近结果/失败原因/下次计划）。 */
  autoReaderText: string;
  autoReaderFailed: boolean;
}

/** 自动读取状态短句：后台是否在跑、间隔、最近一次结果与下次计划，失败给实际原因。 */
export function shipmentAutoReaderText(
  reader: ShipmentSourceStatusDto['autoReader'] | null | undefined,
): { text: string; failed: boolean } {
  if (!reader) {
    return { text: '自动读取：状态读取失败（不影响手动刷新）', failed: true };
  }
  const interval = `每 ${reader.intervalMinutes} 分钟`;
  if (!reader.enabled) {
    return { text: `自动读取：已停用 · ${interval}`, failed: false };
  }
  const parts: string[] = [reader.workerOnline ? '运行中' : '已启用，后台任务未运行', interval];
  if (reader.running) parts.push('正在读取');
  const failed = reader.lastResult === 'failed';
  if (failed) {
    parts.push(`最近自动读取失败：${shipmentErrorMessage(reader.lastErrorCode, reader.lastErrorMessage)}`
      + (reader.lastFinishedAt ? `（${formatTimestamp(reader.lastFinishedAt)}）` : ''));
  } else if (reader.lastReadAt) {
    const resultText = reader.lastResult === 'unchanged' ? '（内容未变）' : '';
    parts.push(`最近自动读取 ${formatTimestamp(reader.lastReadAt) || '—'}${resultText}`);
  } else {
    parts.push('等待首次自动读取');
  }
  if (reader.nextRunAt) parts.push(`下次计划 ${formatTimestamp(reader.nextRunAt)}`);
  return { text: `自动读取：${parts.join(' · ')}`, failed };
}

export function shipmentSourceStatusDisplay(status: ShipmentSourceStatusDto | null | undefined): SourceStatusDisplay {
  const lastSuccess = status?.lastSuccess ?? null;
  const lastAttempt = status?.lastAttempt ?? null;
  const failure = lastAttempt?.status === 'failed';
  const lastSuccessText = lastSuccess
    ? `最近成功读取 ${formatTimestamp(lastSuccess.readAt) || '—'}`
    : '还没有成功读取';
  const lastSuccessDetail = lastSuccess
    ? `${lastSuccess.ticketCount} 票 / ${lastSuccess.itemCount} 明细`
      + ` · 来源更新 ${formatSourceTime(lastSuccess.documentEditedAt)}`
      + (typeof lastSuccess.revision === 'number' ? ` · revision ${lastSuccess.revision}` : '')
    : '来源数据尚未读取；刷新来源后才有货票';
  let attemptText: string;
  if (failure) {
    attemptText = `本次读取失败：${shipmentErrorMessage(lastAttempt?.errorCode, lastAttempt?.errorMessage)}`
      + (lastAttempt?.readAt ? `（${formatTimestamp(lastAttempt.readAt)}）` : '');
  } else if (lastAttempt) {
    attemptText = `本次读取成功（${formatTimestamp(lastAttempt.readAt) || '时间未记录'}）`;
  } else {
    attemptText = '本次还没有读取记录';
  }
  const autoReader = shipmentAutoReaderText(status?.autoReader);
  return {
    tone: failure ? 'red' : autoReader.failed ? 'amber' : lastSuccess ? 'green' : 'amber',
    lastSuccessText,
    lastSuccessDetail,
    attemptText,
    attemptFailed: failure,
    autoReaderText: autoReader.text,
    autoReaderFailed: autoReader.failed,
  };
}

/** 刷新结果短句：成功给票/明细/新增/更新/未变（有本次未见时追加）；失败只给原因，旧数据不动。 */
export function refreshResultText(result: ShipmentRefreshResultDto): string {
  if (!result.ok) {
    return `本次读取失败：${shipmentErrorMessage(result.errorCode, result.errorMessage)}`;
  }
  const base = `本次读取成功 · 票 ${result.ticketCount} / 明细 ${result.itemCount}`
    + ` · 新增 ${result.createdTickets} / 更新 ${result.updatedTickets} / 未变 ${result.unchangedTickets}`;
  const absent = result.absentTickets > 0
    ? ` · 本次未见 ${result.absentTickets} 票 / ${result.absentItems} 明细`
    : '';
  const adopted = (result.adoptedAssociations ?? 0) > 0
    ? ` · 采用已确认对应 ${result.adoptedAssociations} 条`
    : '';
  return `${base}${adopted}${absent}`;
}

export type ShipmentReadFailureKind = 'forbidden' | 'unavailable' | 'read_failed';

const FORBIDDEN_PATTERN = /FORBIDDEN|DENIED|permission denied|无权|未登录|登录已失效|账号已停用/i;
const UNAVAILABLE_PATTERN = /does not exist|not configured|尚未就绪|未启用|CATALOG_UNAVAILABLE/i;

function errorCodeOf(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : '';
}

export function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : '';
}

/** 读取失败分类：无权限 / 功能未就绪 / 网络传输，三种都明确「没读到」，不显示 0。 */
export function classifyShipmentReadFailure(error: unknown): ShipmentReadFailureKind {
  const code = errorCodeOf(error);
  const message = errorMessageOf(error);
  if (code === '42501' || FORBIDDEN_PATTERN.test(message)) return 'forbidden';
  if (code === '42883' || code === '42P01' || code === '3F000' || UNAVAILABLE_PATTERN.test(message)) return 'unavailable';
  return 'read_failed';
}

/** 详情读取失败短原因（不把 SQL/路径带到页面）；票不存在不算失败。 */
export function shortShipmentFailure(error: unknown): string {
  const kind = classifyShipmentReadFailure(error);
  if (kind === 'forbidden') return '当前账号无权查看该货票';
  if (kind === 'unavailable') return '货票功能尚未就绪';
  return '网络或传输异常';
}

/* ------------------------------------------------------------------ *
 * 商品关联保存结果
 * ------------------------------------------------------------------ */

const ASSOCIATION_ERROR_LABELS: Record<string, string> = {
  SHIPMENT_REVISION_CONFLICT: '该明细已被更新，本次未保存；你的选择已保留，请刷新后重试',
  SHIPMENT_ITEM_NOT_FOUND: '该明细不存在或已被替换',
  SHIPMENT_PRODUCT_NOT_FOUND: '所选商品不存在或已变化',
  SHIPMENT_ASSOCIATION_VERSION_CONFLICT: '该明细已被更新，本次未保存；你的选择已保留，请刷新后重试',
  SHIPMENT_ASSOCIATION_NOT_FOUND: '该明细不存在或已被替换',
  SHIPMENT_ASSOCIATION_PRODUCT_INVALID: '所选商品无效或已变化',
  SHIPMENT_ASSOCIATION_UNCHANGED: '关联没有变化，本次未新增记录',
  SHIPMENT_FORBIDDEN: '当前账号无权修改关联',
  SHIPMENT_INVALID_INPUT: '提交内容不完整，本次未保存',
};

export function associationErrorText(code: string | null | undefined, message: string | null | undefined): string {
  if (code && ASSOCIATION_ERROR_LABELS[code]) return ASSOCIATION_ERROR_LABELS[code];
  const normalized = oneLineText(message, 60);
  return normalized || '保存失败，请重试';
}

/* ------------------------------------------------------------------ *
 * 最近变更记录
 * ------------------------------------------------------------------ */

const REVISION_FIELD_LABELS: Record<string, string> = {
  statusClass: '业务状态',
  transportText: '运输进度',
  arrivalText: '到货与上架说明',
  identityStatus: '身份状态',
  identityNote: '身份待核说明',
  presentInLatestRead: '本次来源可见',
  market: '目的市场',
  customsMethod: '报关方式',
  waybillsText: '运单号',
  purchaseOrder: '采购单号',
  vessel: '船名',
  dispatchedText: '发出时间',
  itemCount: '明细条数',
  quantityPending: '待核数量',
  sourceRowStart: '来源起始行',
  sourceRowEnd: '来源结束行',
  shippedQuantity: '发货量',
  receivedQuantity: '累计到货',
  receiptBasis: '到货依据',
  remainingQuantity: '剩余在途',
  sourceNote: '来源备注',
  productId: '关联商品',
  associationStatus: '关联状态',
  productNameRaw: '来源商品',
  missing: '本次来源未见',
  manualStatus: '人工修正状态',
  manualShelvedQuantity: '人工累计已上架',
  manualActorName: '修正人',
  manualAt: '修正时间',
  manualReviewNeeded: '待复核',
  sourceReceivedQuantity: '原表累计到货',
  sourceReceiptBasis: '原表到货依据',
};

export function revisionFieldLabel(field: string): string {
  return REVISION_FIELD_LABELS[field] || field;
}

export function changedFieldsText(fields: string[] | null | undefined): string {
  const list = (fields ?? []).filter(Boolean);
  if (list.length === 0) return '无字段变化';
  return list.map(revisionFieldLabel).join('、');
}

/* ------------------------------------------------------------------ *
 * URL 参数（全部筛选/分页/详情由 URL 还原）
 * ------------------------------------------------------------------ */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string | null | undefined): boolean {
  return typeof value === 'string' && UUID_PATTERN.test(value.trim());
}

export function normalizePageNumber(raw: number): number {
  if (!Number.isFinite(raw)) return 1;
  const floored = Math.floor(raw);
  return floored >= 1 ? floored : 1;
}

/** 每页条数：只允许 20/50/100（白名单），其余回默认 50。 */
export function normalizeShipmentLimit(raw: number): number {
  if (!Number.isFinite(raw)) return DEFAULT_SHIPMENT_PAGE_SIZE;
  const floored = Math.floor(raw);
  return (SHIPMENT_PAGE_SIZES as readonly number[]).includes(floored)
    ? floored
    : DEFAULT_SHIPMENT_PAGE_SIZE;
}

export function parseShipmentStatusFilter(raw: string | null | undefined): ShipmentStatusFilter {
  const value = (raw ?? '').trim();
  return (SHIPMENT_STATUS_CLASSES as string[]).includes(value) ? value as ShipmentStatusClass : 'all';
}

/** 「包含本次来源未见」：`absent=1` 为开启，其它视为关闭。 */
export function parseIncludeAbsent(raw: string | null | undefined): boolean {
  return ['1', 'true', 'yes'].includes((raw ?? '').trim().toLowerCase());
}

export interface ShipmentQueryState {
  /** 主视图：货票列表 / 货值汇总（共用市场筛选，默认货票列表）。 */
  view: ShipmentView;
  /** 'all' = 不筛；UNKNOWN_MARKET_TOKEN = 来源未给国家；其它为来源国家原文。 */
  market: string;
  status: ShipmentStatusFilter;
  q: string;
  /** 商品筛选（catalog itemId）；空 = 不筛。 */
  product: string;
  /** 是否把「本次来源未见」的历史票也包含在列表与计数里（URL absent=1）。 */
  includeAbsent: boolean;
  page: number;
  limit: number;
  /** 详情票（shipment id）；空 = 不打开详情。 */
  ticket: string;
  /** 详情内定位的明细（shipment_item id）；空 = 不定位。只用于打开详情，列表链接不输出。 */
  item: string;
  /** 打开拆票/合票复核面板（URL review=1）。 */
  review: boolean;
  /** 货值汇总首次打开即展开「未计入」明细（URL excluded=open；经营总览直达用）。 */
  excludedOpen: boolean;
}

export type ShipmentView = 'list' | 'value';

/**
 * 关联保存后的提示（货值汇总全市场/单市场、货票详情抽屉共用同一套文案）：
 * - 清除：固定「已清除本条明细的商品关联。」；
 * - 关联：先写清本条实际去向（已计入货值 / 仍缺进货价 / 数量待核 / 只刷新汇总），
 *   再另起一句写清沿用规则是否保存、以及本次按已保存规则另外关联了几条（取数据库回执）。
 * 结果由服务端保存后按同一口径回读；读不到时只说已刷新，不猜。
 */
export function associationSavedNotice(payload: ShipmentAssociationSavedPayloadDto): string {
  if (payload.cleared) return '已清除本条明细的商品关联。';
  const label = (payload.productLabel ?? '').trim();
  const prefix = label !== '' ? `已关联「${label}」；` : '已关联商品；';
  const outcome = payload.outcome;
  const target = outcome?.state === 'counted'
    ? '已计入货值。'
    : outcome?.state === 'price_missing'
      ? '仍缺进货价，暂未计入货值。'
      : outcome?.state === 'quantity_pending'
        ? '数量待核，暂未计入货值。'
        : '货值汇总与未计入数量已刷新。';
  const rule = payload.ruleRequested
    ? payload.mappingSaved
      ? `已保存「以后同市场同品名沿用」规则；本次按这条规则另外关联 ${payload.ruleAdoptedCount} 条。`
      : `未保存沿用规则（${payload.mappingNote ?? '市场未提供'}）。`
    : '只用于本票，未保存沿用规则。';
  return `${prefix}${target}${rule}`;
}
export const DEFAULT_SHIPMENT_QUERY: ShipmentQueryState = {
  view: 'list',
  market: SHIPMENT_MARKET_ALL,
  status: 'all',
  q: '',
  product: '',
  includeAbsent: false,
  page: 1,
  limit: DEFAULT_SHIPMENT_PAGE_SIZE,
  ticket: '',
  item: '',
  review: false,
  excludedOpen: false,
};

export function parseShipmentView(raw: string | null | undefined): ShipmentView {
  return (raw ?? '').trim() === 'value' ? 'value' : 'list';
}

export function parseShipmentSearchParams(params: URLSearchParams): ShipmentQueryState {
  const rawMarket = (params.get('market') ?? '').trim().slice(0, 40);
  const market = !rawMarket || rawMarket === SHIPMENT_MARKET_ALL ? SHIPMENT_MARKET_ALL : rawMarket;
  const rawQ = (params.get('q') ?? '').trim().slice(0, MAX_SEARCH_LENGTH);
  const rawProduct = (params.get('product') ?? '').trim();
  const rawTicket = (params.get('ticket') ?? '').trim();
  const rawItem = (params.get('item') ?? '').trim();
  return {
    view: parseShipmentView(params.get('view')),
    market,
    status: parseShipmentStatusFilter(params.get('status')),
    q: rawQ,
    product: isUuid(rawProduct) ? rawProduct : '',
    includeAbsent: parseIncludeAbsent(params.get('absent')),
    page: normalizePageNumber(Number(params.get('page') ?? '1')),
    limit: normalizeShipmentLimit(Number(params.get('limit') ?? String(DEFAULT_SHIPMENT_PAGE_SIZE))),
    ticket: isUuid(rawTicket) ? rawTicket : '',
    item: isUuid(rawItem) ? rawItem : '',
    review: ['1', 'true', 'yes'].includes((params.get('review') ?? '').trim().toLowerCase()),
    // 经营总览「查看未计入货票」→ ?view=value&excluded=open：第一次打开就展开具体明细。
    excludedOpen: ['open', '1', 'true'].includes((params.get('excluded') ?? '').trim().toLowerCase()),
  };
}

type ShipmentLinkState = Pick<
  ShipmentQueryState,
  'market' | 'status' | 'q' | 'product' | 'includeAbsent' | 'page' | 'limit'
> & Partial<Pick<ShipmentQueryState, 'view' | 'review'>>;

export function buildShipmentListHref(state: ShipmentLinkState): string {
  const params = new URLSearchParams();
  if (state.view === 'value') params.set('view', 'value');
  if (state.market && state.market !== SHIPMENT_MARKET_ALL) params.set('market', state.market);
  if (state.status && state.status !== 'all') params.set('status', state.status);
  if (state.q) params.set('q', state.q);
  if (isUuid(state.product)) params.set('product', state.product);
  if (state.includeAbsent) params.set('absent', '1');
  if (state.review) params.set('review', '1');
  if (normalizeShipmentLimit(state.limit) !== DEFAULT_SHIPMENT_PAGE_SIZE) {
    params.set('limit', String(normalizeShipmentLimit(state.limit)));
  }
  if (normalizePageNumber(state.page) > 1) params.set('page', String(normalizePageNumber(state.page)));
  const qs = params.toString();
  return qs ? `/dashboard/in-transit?${qs}` : '/dashboard/in-transit';
}

/** 打开某票详情：保留列表筛选、是否包含历史票与页码，只加 ticket（可带 item 定位明细）。 */
export function buildShipmentDetailHref(state: ShipmentLinkState, ticket: string, itemId?: string | null): string {
  const base = buildShipmentListHref(state);
  if (!isUuid(ticket)) return base;
  const params = new URLSearchParams(base.split('?')[1] ?? '');
  params.set('ticket', ticket);
  if (isUuid(itemId)) params.set('item', String(itemId).trim());
  return `/dashboard/in-transit?${params.toString()}`;
}

/* ------------------------------------------------------------------ *
 * 在途汇总（第七轮）
 * ------------------------------------------------------------------ */

/** 汇总金额：精确十进制字符串 → 千分位两位小数；null（没有已计价明细）不给 ¥0。 */
export function summaryValueText(raw: string | null | undefined): string | null {
  return formatCnyValue(raw);
}

/** 市场已能算出的货值合计；没有任何已计价明细时明确说「暂无可计算货值」。 */
export function summaryTotalText(summary: Pick<ShipmentMarketSummaryDto, 'totalValueCny' | 'pricedItemCount'>): string {
  const text = summaryValueText(summary.totalValueCny);
  if (text !== null) return text;
  return summary.pricedItemCount === 0 ? '暂无可计算货值' : '—';
}

/** 商品在途数量：数量全部待核时显示「待核」，不当成 0。 */
export function summaryProductQuantityText(product: Pick<ShipmentSummaryProductDto, 'remainingQuantity' | 'quantityKnownItemCount'>): string {
  return product.quantityKnownItemCount === 0 ? '待核' : formatQuantity(product.remainingQuantity);
}

/** 商品估算货值：没有已计价明细时显示「未计入」，不写 ¥0。 */
export function summaryProductValueText(product: Pick<ShipmentSummaryProductDto, 'valueCny'>): string {
  return summaryValueText(product.valueCny) ?? '未计入';
}

/** 「还有多少条没算进去」+ 原因分解（0 条时说明全部已计入）。 */
export function summaryExcludedText(
  summary: Pick<ShipmentMarketSummaryDto, 'excludedItemCount' | 'excludedByReason'>,
): string {
  if (summary.excludedItemCount === 0) return '未计入 0 条（全部当前明细已计入）';
  const { unbound, quantityPending, priceMissing, reviewPending } = summary.excludedByReason;
  return `未计入 ${summary.excludedItemCount} 条（待复核 ${reviewPending} · 数量待核 ${quantityPending} · 缺单价 ${priceMissing} · 未关联商品 ${unbound}）`;
}

/** 汇总所依据的读取时间：与列表同一「最近一次成功读取」口径。 */
export function summaryReadTimeText(summary: Pick<ShipmentMarketSummaryDto, 'latestReadAt'>): string {
  return formatSourceTime(summary.latestReadAt);
}

/** 页面自动更新探测戳：同一成功快照 + 自动读取时间/结果变化即刷新。 */
export function shipmentLiveStamp(status: ShipmentSourceStatusDto): string {
  return [
    status.lastSuccess?.snapshotId ?? '',
    status.lastSuccess?.readAt ?? '',
    status.autoReader?.lastReadAt ?? '',
    status.autoReader?.lastResult ?? '',
  ].join('|');
}

/** 仅取上海时间 HH:mm（读取失败提示里的旧数据时间）。 */
export function shortClock(iso: string | null | undefined): string {
  const text = formatTimestamp(iso);
  return text ? text.slice(11) : '';
}

/** 读取失败的一句话原因：技术错误码/长报错收成用户能看懂的一行。 */
export function shipmentFailureReason(errorCode: string | null, errorMessage: string | null): string {
  const text = `${errorMessage ?? ''}`;
  if (errorCode === 'SOURCE_CLI_TIMEOUT'
    || /timeout|超时|TLS|ETIMEDOUT|ECONNRESET|ENOTFOUND|socket hang up/i.test(text)) {
    return '飞书读取超时';
  }
  switch (errorCode) {
    case 'SOURCE_CLI_MISSING':
      return '飞书读取工具未就绪';
    case 'SOURCE_CLI_BAD_JSON':
      return '飞书返回无法识别';
    case 'SOURCE_DOC_UNRESOLVED':
    case 'SOURCE_SHEET_MISSING':
    case 'SOURCE_GRID_INVALID':
    case 'SOURCE_HEADER_MISMATCH':
    case 'SOURCE_EMPTY':
      return '飞书表格读取失败';
    default:
      return '飞书读取失败';
  }
}

/**
 * 物流页读取失败时的一行提示：原因 + 当前展示的旧数据时间。
 * 成功时不显示任何状态横栏（读取状态统一在「数据同步」）。
 */
export function shipmentReadFailureText(status: ShipmentSourceStatusDto): string | null {
  const attempt = status.lastAttempt;
  if (!attempt || attempt.status !== 'failed') return null;
  const reason = shipmentFailureReason(attempt.errorCode, attempt.errorMessage);
  const lastSuccessAt = status.lastSuccess?.readAt;
  const clock = shortClock(lastSuccessAt);
  return clock ? `${reason}，当前显示 ${clock} 的数据` : `${reason}，暂无成功数据`;
}

/* ------------------------------------------------------------------ *
 * 分页
 * ------------------------------------------------------------------ */

export function shipmentPageCount(total: number, limit: number): number {
  const size = normalizeShipmentLimit(limit);
  if (!Number.isFinite(total) || total <= 0) return 1;
  return Math.max(1, Math.ceil(total / size));
}

export interface ShipmentPageRange {
  from: number;
  to: number;
  total: number;
  page: number;
  pageCount: number;
  hasPrev: boolean;
  hasNext: boolean;
}

export function shipmentPageRange(total: number, limit: number, page: number): ShipmentPageRange {
  const size = normalizeShipmentLimit(limit);
  const pageCount = shipmentPageCount(total, size);
  const current = Math.min(normalizePageNumber(page), pageCount);
  const safeTotal = Number.isFinite(total) && total > 0 ? Math.trunc(total) : 0;
  const from = safeTotal === 0 ? 0 : (current - 1) * size + 1;
  const to = safeTotal === 0 ? 0 : Math.min(current * size, safeTotal);
  return { from, to, total: safeTotal, page: current, pageCount, hasPrev: current > 1, hasNext: current < pageCount };
}

export function shipmentOffset(page: number, limit: number): number {
  return (normalizePageNumber(page) - 1) * normalizeShipmentLimit(limit);
}

/** 页码：当前页附近最多 7 个 + 首末页，不引入新的分页机制。 */
export function shipmentPageNumbers(page: number, pageCount: number): Array<number | 'gap'> {
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
