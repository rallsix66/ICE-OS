/**
 * 商品库存双视图 v1 —— 纯合并/分页逻辑（无数据库、无 React）。
 *
 * 口径（任务包 UI-02/UI-03/UI-04）：
 * - 海外行来自服务端每仓「最后完整成功批次」读取（read_inventory_warehouse_rows）；
 * - 国内行来自冻结聚水潭表格快照（只读、保留文件日期，不冒充实时库存）；
 * - 两个来源分开计时、分开计数，**不跨来源相加**；来源未对应/未纳入的行原样展示，不计入合计；
 * - 商品汇总的每个市场格按完整筛选范围计算（服务端 SQL 已按完整范围聚合），这里只合并国内格；
 * - 分页在服务端读全量筛选结果后于本模块统一切页，保证两个来源合并后页码/定位稳定。
 */

import type {
  InventoryDomesticRowDto,
  InventoryDomesticSnapshotDto,
  InventoryListItemDto,
  InventoryProductDomesticCellDto,
  InventoryProductSummaryDto,
  InventoryProductSummaryRowDto,
  InventorySourceScope,
  InventoryWarehouseRowDto,
  InventoryWarehouseRowsDto,
} from './types';
import type { InventoryQueryState } from './model';
import { compareStableText, UNKNOWN_MARKET_TOKEN } from './model';

export interface DualQueryState {
  q: string;
  warehouse: string;
  market: string;
  view: InventoryQueryState['view'];
  source: InventorySourceScope;
  page: number;
  limit: number;
  focus: string;
}

export type DualQueryInput = Pick<
  InventoryQueryState,
  'q' | 'warehouse' | 'market' | 'view' | 'source' | 'page' | 'limit' | 'focus'
>;

export interface WarehouseRowsCounts {
  /** 海外：已计入库存行。 */
  adopted: number;
  /** 海外：来源未对应行（不计入）。 */
  unmapped: number;
  /** 海外：对应已确认、等待下一批次。 */
  pendingAdoption: number;
  /** 海外：历史批次已采用、当前对应停用/重核（不计入）。 */
  inactive: number;
  /** 国内：已核对选择且关联到标准商品（计入国内汇总）。 */
  domesticAdopted: number;
  /** 国内：未确认/未关联（不计入任何合计，仍可查）。 */
  domesticUnmapped: number;
}

export interface WarehouseRowsPageResult {
  total: number;
  offset: number;
  limit: number;
  page: number;
  pageCount: number;
  hasPrev: boolean;
  hasNext: boolean;
  /** 当前页（已合并、已排序）。 */
  rows: InventoryWarehouseRowDto[];
  counts: WarehouseRowsCounts;
  overseasIncluded: boolean;
  domesticIncluded: boolean;
  domesticAvailable: boolean;
  domesticReason: string | null;
  /** 国内行涉及的文件日期（YYYY-MM-DD）。 */
  domesticFileDates: string[];
}

export const DOMESTIC_WAREHOUSE_LABEL = '国内 · 原表未注明仓库';

function domesticStatus(row: InventoryDomesticRowDto): 'adopted' | 'unmapped' {
  return row.reviewState === 'manual_selected' && Boolean(row.itemId) ? 'adopted' : 'unmapped';
}

function domesticNote(row: InventoryDomesticRowDto): string | null {
  if (domesticStatus(row) === 'adopted') {
    if (row.quantityState === 'ok') return null;
    if (row.quantityState === 'missing') return '原表实际库存数为空：保留原行，不计入国内数量';
    if (row.quantityState === 'invalid') return '原表实际库存数不是整数：保留原文，不换算、不计入数量';
    return '同一商品存在多条不能合理相加的国内记录：逐行保留并标待核';
  }
  if (row.reviewState === 'manual_selected') return '已核对选择但未关联到标准商品：不纳入国内汇总';
  return `原表选择状态：${row.reviewState || '未标注'}（未纳入国内汇总）`;
}

/** 国内来源行 → 仓库明细行（与海外行同一列表口径，来源单独标记）。 */
export function domesticRowToWarehouseRow(row: InventoryDomesticRowDto): InventoryWarehouseRowDto {
  const status = domesticStatus(row);
  return {
    source: 'domestic',
    rowKey: `domestic:${row.legacyCandidateId}`,
    warehouseId: null,
    warehouseExternalId: null,
    warehouseName: DOMESTIC_WAREHOUSE_LABEL,
    market: null,
    status,
    itemId: row.itemId,
    iceCode: row.iceCode,
    itemName: row.itemNameCn,
    sourceName: row.sourceName,
    externalSku: row.externalSku,
    gtin: null,
    unit: row.unit,
    onHand: row.actualQty,
    orderLocked: null,
    warehouseAvailable: row.availableQty,
    activityReserved: null,
    inTransit: null,
    observationAt: null,
    batchId: null,
    excelRow: row.excelRow,
    mappingStatus: row.reviewState,
    itemRevision: null,
    rawOnHand: row.rawActualText,
    note: row.note ?? domesticNote(row),
    fileDate: row.fileDate,
    fileName: row.fileName,
    cloudAvailableText: row.cloudAvailableText,
  };
}

/** 国内冻结表的来源行按搜索过滤（国内行没有仓库/市场，按仓/市场筛选时不混入）。 */
export function filterDomesticRows(
  rows: InventoryDomesticRowDto[],
  query: Pick<DualQueryInput, 'q' | 'warehouse' | 'market'>,
): InventoryDomesticRowDto[] {
  if (query.warehouse && query.warehouse !== 'all') return [];
  if (query.market && query.market !== 'all') return [];
  const search = (query.q ?? '').trim();
  if (!search) return rows;
  const needle = search.toLowerCase();
  return rows.filter((row) => [row.itemNameCn, row.iceCode, row.externalSku, row.sourceName]
    .some((value) => typeof value === 'string' && value.toLowerCase().includes(needle)));
}

/**
 * 列表有效范围是否包含国内：国内快照没有仓库/市场维度。
 * - 仅国内：只有国内，可以显示；
 * - 全部来源：只有未限定海外仓/市场时才分区显示国内；
 * - 仅海外、或任意明确的海外仓/市场筛选（含未知市场哨兵）：不混入国内。
 * 详情取数与显示必须与列表同一判断，避免从海外范围下钻后仍看到国内数量。
 */
export function domesticIncludedInScope(
  query: Pick<DualQueryInput, 'source' | 'warehouse' | 'market'>,
): boolean {
  return query.source !== 'overseas' && query.warehouse === 'all' && query.market === 'all';
}

function compareRows(a: InventoryWarehouseRowDto, b: InventoryWarehouseRowDto): number {
  const sourceRank = (row: InventoryWarehouseRowDto) => (row.source === 'bigseller' ? 0 : 1);
  return sourceRank(a) - sourceRank(b)
    || compareStableText(a.warehouseName, b.warehouseName)
    || compareStableText(a.itemName ?? a.sourceName, b.itemName ?? b.sourceName)
    || compareStableText(a.externalSku, b.externalSku);
}

/**
 * 合并海外行与国内行，按统一顺序切页。
 * 来源范围同时约束行集合、计数与搜索：仅国内时只有国内有效行（不混入海外-only 商品/数量）。
 */
export function mergeWarehouseRowsPage(input: {
  query: DualQueryInput;
  overseas: InventoryWarehouseRowsDto | null;
  domestic: InventoryDomesticSnapshotDto | null;
}): WarehouseRowsPageResult {
  const { query, overseas, domestic } = input;
  const overseasIncluded = query.source !== 'domestic';
  const domesticAvailable = Boolean(domestic?.available);
  // 国内快照没有仓库/市场维度：有仓/市场下钻时国内行不混入（避免与所选范围矛盾）。
  const domesticIncluded = domesticIncludedInScope(query) && domesticAvailable;
  const limit = Math.max(1, Math.trunc(query.limit || 50));

  // 国内快照只按搜索取行，仓库/市场条件只作用于海外。
  const domesticQuery = { q: query.q, warehouse: 'all', market: 'all' };
  const domesticSourceRows = domesticIncluded
    ? filterDomesticRows(domestic!.rows, domesticQuery).map(domesticRowToWarehouseRow)
    : [];
  const overseasRows = overseasIncluded ? (overseas?.rows ?? []) : [];

  const counts: WarehouseRowsCounts = {
    adopted: overseasRows.filter((row) => row.status === 'adopted').length,
    unmapped: overseasRows.filter((row) => row.status === 'unmapped').length,
    pendingAdoption: overseasRows.filter((row) => row.status === 'pending_adoption').length,
    inactive: overseasRows.filter((row) => row.status === 'inactive').length,
    domesticAdopted: domesticSourceRows.filter((row) => row.status === 'adopted').length,
    domesticUnmapped: domesticSourceRows.filter((row) => row.status === 'unmapped').length,
  };

  const merged = [...overseasRows, ...domesticSourceRows].sort(compareRows);
  const total = merged.length;
  const pageCount = Math.max(1, Math.ceil(total / limit));
  const page = Math.min(Math.max(1, Math.trunc(query.page || 1)), pageCount);
  const offset = (page - 1) * limit;
  const rows = merged.slice(offset, offset + limit);
  const domesticFileDates = [...new Set(domesticSourceRows.map((row) => row.fileDate ?? '').filter(Boolean))].sort();

  return {
    total,
    offset,
    limit,
    page,
    pageCount,
    hasPrev: page > 1,
    hasNext: page < pageCount,
    rows,
    counts,
    overseasIncluded,
    domesticIncluded,
    domesticAvailable,
    domesticReason: domestic?.reason ?? null,
    domesticFileDates,
  };
}

/** 一个商品的国内格：只统计冻结有效选择 + 已关联标准商品的行；缺失不转 0。 */
export function buildDomesticCell(rows: InventoryDomesticRowDto[]): InventoryProductDomesticCellDto | null {
  const selected = rows.filter((row) => domesticStatus(row) === 'adopted');
  if (selected.length === 0) return null;
  let onHand = 0;
  let available = 0;
  let hasOnHand = false;
  let hasAvailable = false;
  let anomaly = false;
  const fileDates = new Set<string>();
  for (const row of selected) {
    if (row.actualQty === null || row.quantityState !== 'ok') anomaly = true;
    else { onHand += row.actualQty; hasOnHand = true; }
    if (row.availableQty !== null) { available += row.availableQty; hasAvailable = true; }
    if (row.fileDate) fileDates.add(row.fileDate);
  }
  return {
    onHand: hasOnHand ? onHand : null,
    available: hasAvailable ? available : null,
    rowCount: selected.length,
    fileDates: [...fileDates].sort(),
    hasQuantityAnomaly: anomaly,
  };
}

const EMPTY_SUMMARY_ROW = {
  knownSubtotal: null,
  unitConflict: false,
  hasPendingTotal: false,
  knownSubtotalComplete: undefined,
  pendingTotalWarehouses: [],
  unitGroups: [],
  coveredWarehouseCount: 0,
  scopeWarehouseCount: 0,
  hasCurrentData: false,
  notMappedWarehouses: [],
  unseenWarehouses: [],
  failedWarehouses: [],
  pendingSourceWarehouses: [],
  hasPendingSourceWarehouses: false,
  pendingAdoptionWarehouses: [],
  hasPendingAdoptionWarehouses: false,
  markets: [],
  hasUnknownMarket: false,
  verificationOnly: false,
  unitUnconfirmed: false,
  itemRevisionMissing: 0,
  lastObservedAt: null,
  mapped: false,
  unitCount: 0,
  marketCells: [],
  overseasOnHand: null,
  overseasSkuCount: 0,
} satisfies Partial<InventoryListItemDto> & Pick<InventoryProductSummaryRowDto, 'marketCells' | 'overseasOnHand' | 'overseasSkuCount'>;

export interface ProductSummaryMergeResult {
  rows: InventoryProductSummaryRowDto[];
  total: number;
  offset: number;
  limit: number;
  page: number;
  pageCount: number;
  hasPrev: boolean;
  hasNext: boolean;
  domesticIncluded: boolean;
  domesticAvailable: boolean;
  domesticReason: string | null;
  /** 只在国内快照里出现的标准商品数（已并入汇总行）。 */
  domesticOnlyItems: number;
  /** 已核对但未关联到标准商品的国内选择数（>0 时页面提示未纳入）。 */
  unlinkedSelected: number;
  /** 当前来源范围下的市场列（按完整筛选范围生成，不是当前页）。 */
  marketColumns: Array<{ key: string; label: string; market: string | null }>;
  /** 完整筛选范围内是否存在“市场待确认（未知仓）”格。 */
  hasUnknownMarket: boolean;
  /** 当前来源范围下，有国内有效选择的商品数（118 = 冻结集期望）。 */
  domesticItemCount: number;
  /** 当前来源范围下的海外商品数（116 = 冻结集期望）。 */
  overseasItemCount: number;
  /** 当前范围内没有标准商品归属的海外来源行（仅提示，不计入）。 */
  unmappedOverseasRows: number;
}

/**
 * 商品汇总 = 服务端「完整筛选范围」的商品行 + 国内冻结格。
 * 来源范围约束商品集合、列与计数：
 * - 仅海外：只有海外商品（116），不生成国内列；
 * - 仅国内：只有有国内有效选择的商品（118），不生成海外市场列/合计；
 * - 全部：海外商品 + 纯国内商品（120）。
 * 只有国内来源的标准商品也要出现在汇总里（不能漏），并保持按货号稳定排序。
 */
export function mergeProductSummary(input: {
  query: DualQueryInput;
  summary: InventoryProductSummaryDto;
  domestic: InventoryDomesticSnapshotDto | null;
}): ProductSummaryMergeResult {
  const { query, summary, domestic } = input;
  const limit = Math.max(1, Math.trunc(query.limit || 50));
  const domesticAvailable = Boolean(domestic?.available);
  // 有仓/市场下钻时国内列不参与（国内快照没有仓库/市场维度，不冒充归属）。
  const domesticIncluded = domesticIncludedInScope(query) && domesticAvailable;
  const domesticOnlyScope = query.source === 'domestic';
  const selectedDomesticRows = domesticIncluded
    ? (domestic!.rows ?? []).filter((row) => domesticStatus(row) === 'adopted')
    : [];

  const byItem = new Map<string, InventoryDomesticRowDto[]>();
  for (const row of selectedDomesticRows) {
    if (!row.itemId) continue;
    const list = byItem.get(row.itemId) ?? [];
    list.push(row);
    byItem.set(row.itemId, list);
  }

  const summaryById = new Map(summary.rows.map((row) => [row.itemId, row]));
  const search = (query.q ?? '').trim().toLowerCase();
  const matchesText = (value: string | null | undefined): boolean =>
    !search || (typeof value === 'string' && value.toLowerCase().includes(search));
  const matchesDomesticRows = (rows: InventoryDomesticRowDto[]): boolean =>
    rows.some((row) => matchesText(row.iceCode) || matchesText(row.itemNameCn)
      || matchesText(row.externalSku) || matchesText(row.sourceName));

  const rows: InventoryProductSummaryRowDto[] = [];

  if (!domesticOnlyScope) {
    for (const base of summary.rows) {
      rows.push({ ...base, domestic: domesticIncluded ? buildDomesticCell(byItem.get(base.itemId) ?? []) : null });
    }
  }

  // 国内范围：以「有国内有效选择」的商品集合为准，一个不漏、也不混入纯海外商品。
  const domesticOnlyItems = domesticOnlyScope
    ? 0
    : [...byItem.keys()].filter((itemId) => !summaryById.has(itemId) && matchesDomesticRows(byItem.get(itemId) ?? [])).length;

  if (domesticIncluded) {
    const extraIds = domesticOnlyScope
      ? [...byItem.keys()]
      : [...byItem.keys()].filter((itemId) => !summaryById.has(itemId));
    for (const itemId of extraIds) {
      const itemRows = byItem.get(itemId) ?? [];
      const base = summaryById.get(itemId);
      if (!base && search && !matchesDomesticRows(itemRows)) continue;
      if (domesticOnlyScope && search) {
        const searchable = matchesText(base?.iceCode) || matchesText(base?.nameCn)
          || matchesText(itemRows[0]?.iceCode) || matchesText(itemRows[0]?.itemNameCn)
          || matchesDomesticRows(itemRows);
        if (!searchable) continue;
      }
      if (base) {
        rows.push({ ...base, domestic: buildDomesticCell(itemRows) });
      } else {
        const first = itemRows[0]!;
        rows.push({
          ...EMPTY_SUMMARY_ROW,
          itemId,
          iceCode: first.iceCode,
          nameCn: first.itemNameCn,
          gtin: null,
          market: null,
          domestic: buildDomesticCell(itemRows),
          marketCells: [],
        });
      }
    }
  }

  if (domesticOnlyScope) {
    rows.forEach((row) => {
      if (!row.domestic) row.domestic = buildDomesticCell(byItem.get(row.itemId) ?? []);
    });
  }

  rows.sort((a, b) => compareStableText(a.iceCode, b.iceCode) || compareStableText(a.nameCn, b.nameCn) || compareStableText(a.itemId, b.itemId));

  const marketColumns = domesticOnlyScope
    ? []
    : summaryMarketColumns({
      marketCells: rows.flatMap((row) => row.marketCells),
      marketOptions: summary.marketOptions ?? [],
      marketFilter: query.market,
    });
  const hasUnknownMarket = domesticOnlyScope
    ? false
    : rows.some((row) => row.marketCells.some((cell) => cell.market === null));

  const total = rows.length;
  const pageCount = Math.max(1, Math.ceil(total / limit));
  const page = Math.min(Math.max(1, Math.trunc(query.page || 1)), pageCount);
  const offset = (page - 1) * limit;

  // 国内商品数也按当前搜索/范围计算（不能搜索后仍写全局 118）。
  const domesticItemCount = domesticIncluded ? rows.filter((row) => row.domestic !== null).length : 0;

  return {
    rows: rows.slice(offset, offset + limit),
    total,
    offset,
    limit,
    page,
    pageCount,
    hasPrev: page > 1,
    hasNext: page < pageCount,
    domesticIncluded,
    domesticAvailable,
    domesticReason: domestic?.reason ?? null,
    domesticOnlyItems,
    unlinkedSelected: domestic?.unlinkedSelectedCount ?? 0,
    marketColumns,
    hasUnknownMarket,
    domesticItemCount,
    overseasItemCount: domesticOnlyScope ? 0 : summary.rows.length,
    unmappedOverseasRows: domesticOnlyScope ? 0 : summary.unmappedOverseasRows,
  };
}

/** 商品汇总市场列：完整筛选范围内的已知市场（按市场代码排序），另加「市场待确认」。 */
export function summaryMarketColumns(input: {
  marketCells: Array<{ market: string | null }>;
  marketOptions: Array<{ market: string }>;
  marketFilter?: string;
}): Array<{ key: string; label: string; market: string | null }> {
  const markets = new Set<string>();
  // 市场待确认哨兵不是市场代码：不能生成 __unknown__ 列，也不应凭其它市场选项生成已知国家列
  // （未知范围里的仓 market 全为空）。业务表头只留“市场待确认”。
  if (input.marketFilter === UNKNOWN_MARKET_TOKEN) {
    // 只保留下面基于 marketCells 的未知列。
  } else if (input.marketFilter && input.marketFilter !== 'all') {
    markets.add(input.marketFilter);
  } else {
    for (const option of input.marketOptions) if (option.market) markets.add(option.market);
    for (const cell of input.marketCells) if (cell.market) markets.add(cell.market);
  }
  const columns: Array<{ key: string; label: string; market: string | null }> = [...markets].sort(compareStableText)
    .map((market) => ({ key: `market-${market}`, label: market, market }));
  const hasUnknown = input.marketCells.some((cell) => cell.market === null);
  if (hasUnknown) columns.push({ key: 'market-unknown', label: '市场待确认', market: null });
  return columns;
}

export function cellFor(
  row: Pick<InventoryProductSummaryRowDto, 'marketCells'>,
  market: string | null,
): InventoryProductSummaryRowDto['marketCells'][number] | null {
  return row.marketCells.find((cell) => cell.market === market) ?? null;
}
