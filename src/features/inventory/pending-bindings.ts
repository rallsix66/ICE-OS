import type { InventoryMappingQueueItemDto, InventoryTargetItemDto } from './types';

/**
 * 商品库存页「待处理」清单：参与库存计算、仍未确认绑定商品的海外仓记录。
 *
 * 数据来自 `catalog.read_inventory_mapping_queue`（队列 RPC 已排除 status='confirmed' 的
 * 绑定，并只返回候选/未确认对）。这里再做一层「参与仓」过滤：
 * 不在 `overview.scope.warehouseIds` 里的仓（如已弃用仓）不参与库存计算，也不应占用待办数字。
 *
 * 纯函数：页面 DTO → 行/分组/候选差异（不读库、不依赖 React），便于用真实/构造数据单测。
 */

/** 同 SKU 建议（结构化保留，弹窗里用于「其他仓曾绑过」/差异对照）。 */
export interface PendingBindingSuggestion {
  itemId: string;
  iceCode: string | null;
  nameCn: string | null;
  evidence: string | null;
}

/** 一行待绑定记录；rowKey 与 `db/catalog/022_inventory_dual_view.sql` 的 row_key 一致。 */
export interface PendingBindingRow {
  /** bigseller:<warehouseId>:<externalSku>，用于行详情 URL 的 row 参数。 */
  rowKey: string;
  warehouseId: string;
  warehouseExternalId: string;
  warehouseName: string;
  market: string | null;
  externalSku: string;
  /** 队列里的本次出现行数与最近出现时间（服务端事实；缺失不补 0）。 */
  rowCount: number;
  latestRunAt: string | null;
  candidateId: string | null;
  candidateStatus: string | null;
  mappingStatus: string | null;
  /** 该仓该 SKU 已有对应时的版本（重新确认/换绑必须带）；首次为 null。 */
  currentVersion: number | null;
  currentUnit: string | null;
  verification: boolean;
  unitUnconfirmed: boolean;
  reason: string | null;
  suggestion: PendingBindingSuggestion | null;
  /** 有同 SKU 建议时 =「ICE 货号 · 品名」；没有建议为 null（页面不臆造）。 */
  suggestionLabel: string | null;
}

export interface PendingBindingRowsResult {
  rows: PendingBindingRow[];
  total: number;
}

/** 服务端读取结果：读取失败不带数量（不得用 0 冒充）。 */
export type PendingBindingsReadResult =
  | { state: 'ok'; rows: PendingBindingRow[]; total: number }
  | { state: 'read_failed'; rows: []; total: null; error: string };

/** 轻量计数（首屏 Suspense 用）：只给数量，不下发 141 行。 */
export type PendingBindingCountResult =
  | { state: 'ok'; count: number }
  | { state: 'read_failed'; count: null; error: string };

/** 同 SKU 在其他仓已 confirmed 的绑定：弹窗里优先展示，供人工确认是否同一商品。 */
export interface PendingBindingPriorBinding {
  warehouseId: string;
  warehouseName: string;
  market: string | null;
  itemId: string;
  iceCode: string | null;
  nameCn: string | null;
  /** 该仓已确认绑定的库存单位（mapping.unit 优先）；没登记时为 null。 */
  unit: string | null;
  /** 目标商品规格（商品资料读得到时）；读不到为 null，不臆造。 */
  specification: string | null;
  /** 目标商品最近入库的 69 条码（读得到时）；读不到为 null。 */
  gtin: string | null;
}

/** 每款商品只出现一次的可选候选项（同 SKU 其他仓曾选过它）。 */
export interface PendingBindingCandidate {
  itemId: string;
  iceCode: string | null;
  nameCn: string | null;
  specification: string | null;
  gtin: string | null;
  /** 用于核对并直接沿用的已登记库存单位；各仓不一致或缺失时为 null。 */
  unit: string | null;
  /** 该商品各仓登记过的单位（去重、保持出现顺序）；页面在缺失/不一致时如实列出。 */
  unitValues: string[];
  /** 各仓登记单位不一致（页面显示两个值并请用户填写）。 */
  unitConflict: boolean;
  /** 曾选过这款商品的仓（仓名 + 中文市场）。 */
  warehouses: Array<{ warehouseId: string; warehouseName: string; market: string | null }>;
  /** 与另一款候选的实际差异（只写有差异的字段与值；单候选时为空）。 */
  diffNotes: string[];
}

/** 组内一个仓的待绑定事实（勾选本次要绑定的仓用）。 */
export interface PendingBindingWarehouseRef {
  rowKey: string;
  warehouseId: string;
  warehouseExternalId: string;
  warehouseName: string;
  market: string | null;
  latestRunAt: string | null;
  rowCount: number;
  currentVersion: number | null;
}

/** 待处理弹窗分组：一个来源 SKU 一组，组内是涉及的仓。 */
export interface PendingBindingGroup {
  externalSku: string;
  rows: PendingBindingRow[];
  warehouses: PendingBindingWarehouseRef[];
}

export const PENDING_BINDING_MARKET_FALLBACK = '市场待确认';
export const PENDING_BINDING_WAREHOUSE_FALLBACK = '未命名仓库';

/** 与 022 的 row_key 拼接规则保持一致：`bigseller:<warehouseId>:<externalSku>`。 */
export function pendingBindingRowKey(warehouseId: string, externalSku: string): string {
  return `bigseller:${warehouseId}:${externalSku}`;
}

/** 行详情（仓库 × 来源 SKU）URL：页面用 row 恢复详情，q 便于详情/搜索同一 SKU。 */
export function pendingBindingHref(row: Pick<PendingBindingRow, 'rowKey' | 'externalSku'>): string {
  return `/dashboard/inventory?view=warehouse&source=overseas&row=${encodeURIComponent(row.rowKey)}&q=${encodeURIComponent(row.externalSku)}`;
}

/** 建议展示文案：「ICE 货号 · 品名」；缺一项时只显示有的那一项，都没有则为 null。 */
export function pendingBindingSuggestionLabel(item: InventoryMappingQueueItemDto): string | null {
  const suggestion = item.suggestion;
  if (!suggestion) return null;
  const code = (suggestion.iceCode ?? '').trim();
  const name = (suggestion.nameCn ?? '').trim();
  if (code && name) return `${code} · ${name}`;
  return code || name || null;
}

function suggestionOf(item: InventoryMappingQueueItemDto): PendingBindingSuggestion | null {
  const suggestion = item.suggestion;
  if (!suggestion) return null;
  const iceCode = (suggestion.iceCode ?? '').trim() || null;
  const nameCn = (suggestion.nameCn ?? '').trim() || null;
  const evidence = (suggestion.evidence ?? '').trim() || null;
  if (!suggestion.itemId && !iceCode && !nameCn) return null;
  return { itemId: suggestion.itemId, iceCode, nameCn, evidence };
}

/**
 * 队列 DTO → 待绑定行。
 *
 * - 只保留参与仓（scopeWarehouseIds）内的记录；空 scope 表示没有仓参与，结果自然为 0；
 * - 按 rowKey 去重（分页读取可能重叠时不让同一行重复计数）；
 * - 保持队列返回顺序（仓外部编号、SKU），不另造排序。
 */
export function buildPendingBindingRows(
  items: readonly InventoryMappingQueueItemDto[],
  scopeWarehouseIds: readonly string[],
): PendingBindingRowsResult {
  const scope = new Set(scopeWarehouseIds.map((id) => id.trim()).filter(Boolean));
  const seen = new Set<string>();
  const rows: PendingBindingRow[] = [];
  for (const item of items) {
    const warehouseId = (item.warehouseId ?? '').trim();
    const externalSku = (item.externalSku ?? '').trim();
    if (!warehouseId || !externalSku) continue;
    if (!scope.has(warehouseId)) continue;
    const rowKey = pendingBindingRowKey(warehouseId, externalSku);
    if (seen.has(rowKey)) continue;
    seen.add(rowKey);
    rows.push({
      rowKey,
      warehouseId,
      warehouseExternalId: (item.warehouseExternalId ?? '').trim(),
      warehouseName: (item.warehouseName ?? '').trim() || PENDING_BINDING_WAREHOUSE_FALLBACK,
      market: (item.market ?? '').trim() || null,
      externalSku,
      rowCount: Number.isFinite(item.rowCount) ? Math.max(0, Math.trunc(item.rowCount)) : 0,
      latestRunAt: item.latestRunAt ?? null,
      candidateId: item.candidateId ?? null,
      candidateStatus: item.candidateStatus ?? null,
      mappingStatus: item.mappingStatus ?? null,
      currentVersion: item.currentMapping?.version ?? null,
      currentUnit: item.currentMapping?.unit ?? null,
      verification: item.verification === true || item.unitUnconfirmed === true,
      unitUnconfirmed: item.unitUnconfirmed === true,
      reason: (item.reason ?? '').trim() || null,
      suggestion: suggestionOf(item),
      suggestionLabel: pendingBindingSuggestionLabel(item),
    });
  }
  return { rows, total: rows.length };
}

/**
 * 按来源 SKU 分组：组头需要「涉及哪些仓（仓名 + 市场）+ 每仓最近出现时间」，
 * 组内保持服务端队列顺序（仓外部编号、SKU）；不合并/不丢行。
 */
export function groupPendingBindingRows(rows: readonly PendingBindingRow[]): PendingBindingGroup[] {
  const bySku = new Map<string, PendingBindingGroup>();
  for (const row of rows) {
    const key = row.externalSku.trim();
    if (!key) continue;
    let group = bySku.get(key);
    if (!group) {
      group = { externalSku: key, rows: [], warehouses: [] };
      bySku.set(key, group);
    }
    group.rows.push(row);
    group.warehouses.push({
      rowKey: row.rowKey,
      warehouseId: row.warehouseId,
      warehouseExternalId: row.warehouseExternalId,
      warehouseName: row.warehouseName,
      market: row.market,
      latestRunAt: row.latestRunAt,
      rowCount: row.rowCount,
      currentVersion: row.currentVersion,
    });
  }
  return [...bySku.values()];
}

/** 候选商品要展示的可核对字段（货号是身份本身，已上屏，不再重复算“差异”）。 */
const CANDIDATE_COMPARE_FIELDS: Array<{
  key: 'nameCn' | 'gtin' | 'specification' | 'unit';
  label: string;
}> = [
  { key: 'nameCn', label: '品名' },
  { key: 'gtin', label: '条码' },
  { key: 'specification', label: '规格' },
  { key: 'unit', label: '已登记库存单位' },
];

function candidateValue(candidate: PendingBindingCandidate, key: (typeof CANDIDATE_COMPARE_FIELDS)[number]['key']): string {
  const value = candidate[key];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 同 SKU「其他仓曾选过」的绑定 → 每款商品**一个**候选项（按 itemId 去重）：
 * - 列出这款商品的品名/货号/条码/规格，以及哪些仓曾选过它；
 * - 已登记的库存单位：各仓一致就给出用于核对（页面直接沿用，不再要求填写），
 *   不一致或缺失时 unit=null（页面要求用户填写）；
 * - 与另一款候选的真实差异逐条写清（只比较读得到的字段，缺值不猜）。
 */
export function buildPendingBindingCandidates(
  priors: readonly PendingBindingPriorBinding[],
): PendingBindingCandidate[] {
  type Accumulator = {
    itemId: string;
    iceCode: string | null;
    nameCn: string | null;
    specification: string | null;
    gtin: string | null;
    warehouses: PendingBindingCandidate['warehouses'];
    unitValues: Set<string>;
  };
  const byItem = new Map<string, Accumulator>();
  for (const prior of priors) {
    const itemId = prior.itemId.trim();
    if (!itemId) continue;
    const unit = (prior.unit ?? '').trim();
    const existing = byItem.get(itemId);
    if (!existing) {
      byItem.set(itemId, {
        itemId,
        iceCode: (prior.iceCode ?? '').trim() || null,
        nameCn: (prior.nameCn ?? '').trim() || null,
        specification: (prior.specification ?? '').trim() || null,
        gtin: (prior.gtin ?? '').trim() || null,
        unitValues: new Set(unit ? [unit] : []),
        warehouses: [{
          warehouseId: prior.warehouseId,
          warehouseName: (prior.warehouseName ?? '').trim() || PENDING_BINDING_WAREHOUSE_FALLBACK,
          market: (prior.market ?? '').trim() || null,
        }],
      });
      continue;
    }
    if (!existing.iceCode && prior.iceCode) existing.iceCode = prior.iceCode.trim() || null;
    if (!existing.nameCn && prior.nameCn) existing.nameCn = prior.nameCn.trim() || null;
    if (!existing.specification && prior.specification) existing.specification = prior.specification.trim() || null;
    if (!existing.gtin && prior.gtin) existing.gtin = prior.gtin.trim() || null;
    if (unit) existing.unitValues.add(unit);
    if (!existing.warehouses.some((warehouse) => warehouse.warehouseId === prior.warehouseId)) {
      existing.warehouses.push({
        warehouseId: prior.warehouseId,
        warehouseName: (prior.warehouseName ?? '').trim() || PENDING_BINDING_WAREHOUSE_FALLBACK,
        market: (prior.market ?? '').trim() || null,
      });
    }
  }
  const candidates = [...byItem.values()].map((entry): PendingBindingCandidate => {
    const units = [...entry.unitValues];
    return {
      itemId: entry.itemId,
      iceCode: entry.iceCode,
      nameCn: entry.nameCn,
      specification: entry.specification,
      gtin: entry.gtin,
      unit: units.length === 1 ? units[0]! : null,
      unitValues: units,
      unitConflict: units.length > 1,
      warehouses: entry.warehouses,
      diffNotes: [],
    };
  });
  // 与另一款的实际差异：只在全局一致时才算「相同」；单候选没有差异行。
  for (const candidate of candidates) {
    if (candidates.length < 2) continue;
    const notes: string[] = [];
    for (const field of CANDIDATE_COMPARE_FIELDS) {
      const own = candidateValue(candidate, field.key);
      const others = candidates
        .filter((other) => other.itemId !== candidate.itemId)
        .map((other) => candidateValue(other, field.key))
        .filter((value) => value !== own);
      if (others.length === 0) continue;
      const unique = [...new Set(others)];
      notes.push(`${field.label}不同：本款「${own || '未填写'}」，另一款「${unique.join(' / ') || '未填写'}」`);
    }
    candidate.diffNotes = notes;
  }
  candidates.sort((left, right) => (
    right.warehouses.length - left.warehouses.length
    || (left.iceCode ?? '').localeCompare(right.iceCode ?? '', 'zh-Hans-CN')
    || left.itemId.localeCompare(right.itemId)
  ));
  return candidates;
}

/** 候选商品差异字段（搜索结果里的多候选比较；同 SKU 候选卡另见 diffNotes）。 */
export type PendingBindingCandidateDiffField = 'gtin' | 'specification' | 'unit';

function candidateFieldValue(candidate: InventoryTargetItemDto, field: PendingBindingCandidateDiffField): string {
  if (field === 'gtin') return (candidate.gtin ?? '').trim();
  if (field === 'specification') return (candidate.specification ?? '').trim();
  return (candidate.unit ?? '').trim();
}

/**
 * 多个候选商品时，哪些字段彼此不同（含“有值 vs 空值”）。
 * 页面据此把差异逐条标出，避免盲选；不去猜测缺失值。
 */
export function pendingBindingCandidateDiffFields(
  candidates: readonly InventoryTargetItemDto[],
): PendingBindingCandidateDiffField[] {
  if (candidates.length < 2) return [];
  const fields: PendingBindingCandidateDiffField[] = ['gtin', 'specification', 'unit'];
  return fields.filter((field) => {
    const values = new Set(candidates.map((candidate) => candidateFieldValue(candidate, field)));
    return values.size > 1;
  });
}
