import 'server-only';

import type {
  CatalogInventoryItemView,
  CatalogInventorySourceLine,
  CatalogPendingTotalGroup,
  InventoryWarehouseState,
  WarehouseScopeView,
} from './display-types';
import { formatQuantity, parseQuantity } from './decimal';

/**
 * 商品库与商品库存统一数据源：本模块只消费库存模块的 effective-row 读模型
 * (`catalog.read_inventory_catalog_sources()`)，不再读取旧 BS 样表库存行。
 *
 * 口径与库存页 `inventory_item_summary` 一致：
 * - 同商品同仓多个来源编码：每行保留；该仓合计显示“合计待核对”，不擅自相加；
 * - 单码行：按单位分组；只有单一单位时给出已知小计；多单位不合计；
 * - 缺口原因（未对应/无来源/本次未见/失败）与库存页同一规则；
 * - 数量是来源原值（单个商品计数），不乘除装箱数。
 */

export interface InventoryCatalogRaw {
  scope: { id?: string | null; version?: number | null; warehouseCount: number; empty: boolean; lastAllSuccessAt: string | null };
  warehouses: Array<{ warehouseId: string; externalId: string; name: string; market: string | null; status: string }>;
  readStates: Array<{
    warehouseId: string;
    lastSuccessAt: string | null;
    lastPublishAt: string | null;
    lastObservationAt: string | null;
    latestRunStatus: string | null;
    failed: boolean;
    stale: boolean;
    lastErrorCode: string | null;
  }>;
  effectiveRows: Array<{
    itemId: string;
    warehouseId: string;
    warehouseExternalId: string;
    warehouseName: string;
    market: string | null;
    externalSku: string;
    unit: string | null;
    onHand: number | null;
    orderLocked: number | null;
    warehouseAvailable: number | null;
    activityReserved: number | null;
    inTransit: number | null;
    gtin: string | null;
    observedAt: string | null;
    batchId: string | null;
    excelRow: number | null;
    itemRevision: number | null;
    mappingId: string;
    verification: boolean;
    unitConfirmed: boolean;
  }>;
  mappings: Array<{
    itemId: string;
    warehouseId: string;
    externalSku: string;
    unit: string | null;
    version: number;
    verification: boolean;
    unitConfirmed: boolean;
  }>;
  candidates: Array<{ itemId: string | null; warehouseId: string | null; externalSku: string; status: string }>;
  latestRun: { runId: string; exportFinishedAt: string | null } | null;
  sourceRows: Array<{ warehouseExternalId: string; externalSku: string; excelRow: number; productName: string | null; onHand: number | null }>;
}

export interface InventoryCatalogSource {
  warehouseOptions: string[];
  warehouses: InventoryCatalogRaw['warehouses'];
  scopeWarehouseCount: number;
  lastAllSuccessAt: string | null;
  observationAt: string | null;
  sourceLabel: string;
  byItem: Map<string, CatalogInventoryItemView>;
  warehouseCoverage: Record<string, { adoptedRows: number; pendingSourceRows: number }>;
  lineCount: number;
}

const SOURCE_LABEL = 'BigSeller 自动导出';

function qtyText(value: number | null): string | null {
  return value === null ? null : String(value);
}

function asNumber(value: number | null): number | null {
  return value === null ? null : Number(value);
}

function projectionForLines(lines: CatalogInventorySourceLine[], warehouse: string | undefined): string {
  const rows = (warehouse ? lines.filter((line) => line.warehouse === warehouse) : lines)
    .map((line) => [
      line.warehouse,
      line.externalSku,
      line.onHand ?? '',
      line.orderLocked ?? '',
      line.warehouseAvailable ?? '',
      line.activityReserved ?? '',
      line.inTransit ?? '',
    ].join('|'))
    .sort()
    .join('\n');
  return `${warehouse ?? 'all'}\0${rows}`;
}

function sumOnHandLines(lines: CatalogInventorySourceLine[], warehouse?: string): { total: number | null; count: number } {
  const selected = warehouse ? lines.filter((line) => line.warehouse === warehouse) : lines;
  let total = 0;
  let known = 0;
  for (const line of selected) {
    if (line.onHand === null) continue;
    const parsed = parseQuantity(line.onHand);
    if (parsed === null) return { total: null, count: selected.length };
    total += Number(parsed);
    known += 1;
  }
  if (known === 0) return { total: null, count: 0 };
  return { total, count: selected.length };
}

function warehouseState(params: {
  state: InventoryCatalogRaw['readStates'][number] | undefined;
  adoptedRows: CatalogInventorySourceLine[];
  mappedSkus: string[];
  pendingSourceRowCount: number;
}): InventoryWarehouseState {
  const { state, adoptedRows, mappedSkus, pendingSourceRowCount } = params;
  if (state?.failed) return 'failed';
  if (adoptedRows.length > 0) return 'current';
  if (mappedSkus.length > 0) return 'unseen';
  if (pendingSourceRowCount > 0) return 'unmapped_source';
  if (!state || state.lastSuccessAt === null) return 'no_data';
  return 'no_source';
}

/** 当前商品在本仓的实际观测时间（逐行取最大）；没有行时保留空，不拿最新 run 时间冒充。 */
function lastObservedAtOf(lines: CatalogInventorySourceLine[]): string | null {
  let latest: string | null = null;
  for (const line of lines) {
    if (line.observedAt && (!latest || line.observedAt > latest)) latest = line.observedAt;
  }
  return latest;
}

/** 同商品同仓多个来源编码：逐行展示，不给出任何“完整合计”。 */
function pendingGroups(lines: CatalogInventorySourceLine[]): CatalogPendingTotalGroup[] {
  const groups = new Map<string, CatalogInventorySourceLine[]>();
  for (const line of lines) {
    const key = `${line.warehouseExternalId}\0${line.unit ?? ''}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(line);
    groups.set(key, bucket);
  }
  const out: CatalogPendingTotalGroup[] = [];
  for (const bucket of groups.values()) {
    if (bucket.length < 2) continue;
    out.push({
      warehouseId: '',
      externalId: bucket[0].warehouseExternalId,
      name: bucket[0].warehouse,
      unit: bucket[0].unit,
      rows: bucket
        .map((line) => ({ externalSku: line.externalSku, onHand: line.onHand, excelRow: line.excelRow, observedAt: line.observedAt }))
        .sort((a, b) => a.externalSku.localeCompare(b.externalSku)),
    });
  }
  return out.sort((a, b) => a.externalId.localeCompare(b.externalId));
}

function isPendingLine(line: CatalogInventorySourceLine, groups: CatalogPendingTotalGroup[]): boolean {
  for (const group of groups) {
    if (group.externalId !== line.warehouseExternalId) continue;
    if ((group.unit ?? '') !== (line.unit ?? '')) continue;
    return group.rows.some((row) => row.externalSku === line.externalSku);
  }
  return false;
}

export function buildInventoryCatalogSource(raw: InventoryCatalogRaw): InventoryCatalogSource {
  const warehouses = [...raw.warehouses].sort((a, b) => a.externalId.localeCompare(b.externalId));
  const readStateByWh = new Map(raw.readStates.map((state) => [state.warehouseId, state]));
  const warehouseByExternal = new Map(warehouses.map((warehouse) => [warehouse.externalId, warehouse]));
  const marketByExternal = new Map(warehouses.map((warehouse) => [warehouse.externalId, warehouse.market]));

  const mappingsByItem = new Map<string, InventoryCatalogRaw['mappings']>();
  for (const mapping of raw.mappings) {
    const list = mappingsByItem.get(mapping.itemId) ?? [];
    list.push(mapping);
    mappingsByItem.set(mapping.itemId, list);
  }
  const candidatesByItem = new Map<string, InventoryCatalogRaw['candidates']>();
  for (const candidate of raw.candidates) {
    if (!candidate.itemId) continue;
    const list = candidatesByItem.get(candidate.itemId) ?? [];
    list.push(candidate);
    candidatesByItem.set(candidate.itemId, list);
  }

  const linesByItem = new Map<string, CatalogInventorySourceLine[]>();
  for (const row of raw.effectiveRows) {
    const line: CatalogInventorySourceLine = {
      warehouse: row.warehouseName,
      warehouseExternalId: row.warehouseExternalId,
      externalSku: row.externalSku,
      unit: row.unit,
      onHand: qtyText(asNumber(row.onHand)),
      orderLocked: qtyText(asNumber(row.orderLocked)),
      warehouseAvailable: qtyText(asNumber(row.warehouseAvailable)),
      activityReserved: qtyText(asNumber(row.activityReserved)),
      inTransit: qtyText(asNumber(row.inTransit)),
      observedAt: row.observedAt,
      excelRow: row.excelRow,
      selectionState: 'confirmed',
    };
    const list = linesByItem.get(row.itemId) ?? [];
    list.push(line);
    linesByItem.set(row.itemId, list);
  }

  const knownCodesByItem = new Map<string, Set<string>>();
  for (const [itemId, mappings] of mappingsByItem) {
    knownCodesByItem.set(itemId, new Set(mappings.map((mapping) => mapping.externalSku)));
  }
  for (const [itemId, candidates] of candidatesByItem) {
    const set = knownCodesByItem.get(itemId) ?? new Set<string>();
    for (const candidate of candidates) set.add(candidate.externalSku);
    knownCodesByItem.set(itemId, set);
  }

  const mappingKey = (warehouseExternalId: string, externalSku: string) => `${warehouseExternalId}\0${externalSku}`;
  const mappingKeys = new Set(raw.mappings.map((mapping) => {
    const warehouse = [...warehouseByExternal.values()].find((entry) => entry.warehouseId === mapping.warehouseId);
    return warehouse ? mappingKey(warehouse.externalId, mapping.externalSku) : '';
  }));
  const sourceRowsByWarehouse = new Map<string, InventoryCatalogRaw['sourceRows']>();
  for (const row of raw.sourceRows) {
    const list = sourceRowsByWarehouse.get(row.warehouseExternalId) ?? [];
    list.push(row);
    sourceRowsByWarehouse.set(row.warehouseExternalId, list);
  }

  const itemIds = new Set<string>([
    ...linesByItem.keys(),
    ...mappingsByItem.keys(),
    ...candidatesByItem.keys(),
  ]);

  const warehouseCoverage: InventoryCatalogSource['warehouseCoverage'] = {};
  for (const warehouse of warehouses) {
    warehouseCoverage[warehouse.name] = { adoptedRows: 0, pendingSourceRows: 0 };
  }

  const byItem = new Map<string, CatalogInventoryItemView>();
  for (const itemId of itemIds) {
    const lines = linesByItem.get(itemId) ?? [];
    const pending = pendingGroups(lines);
    const unambiguous = lines.filter((line) => !isPendingLine(line, pending));
    const unitSet = new Set(unambiguous.map((line) => line.unit ?? ''));
    const singleUnit = unitSet.size === 1;
    const known = singleUnit ? sumOnHandLines(unambiguous) : { total: null, count: 0 };
    const itemLastObservedAt = lastObservedAtOf(lines);
    const markets = [...new Set(lines.map((line) => marketByExternal.get(line.warehouseExternalId) ?? null).filter((market): market is string => Boolean(market)))];
    const hasUnknownMarket = lines.some((line) => !marketByExternal.get(line.warehouseExternalId));
    const adoptedWarehouseIds = new Set(lines.map((line) => line.warehouseExternalId));
    const completeItem = pending.length === 0 && singleUnit && known.total !== null
      && adoptedWarehouseIds.size === raw.scope.warehouseCount;

    const warehouseScopes: Record<string, WarehouseScopeView> = {};
    for (const warehouse of warehouses) {
      const warehouseLines = lines.filter((line) => line.warehouseExternalId === warehouse.externalId);
      const pendingForWarehouse = pending.filter((group) => group.externalId === warehouse.externalId);
      const mappedSkus = (mappingsByItem.get(itemId) ?? [])
        .filter((mapping) => mapping.warehouseId === warehouse.warehouseId)
        .map((mapping) => mapping.externalSku);
      const knownCodes = knownCodesByItem.get(itemId) ?? new Set<string>();
      const pendingSourceRows = (sourceRowsByWarehouse.get(warehouse.externalId) ?? [])
        .filter((row) => knownCodes.has(row.externalSku) && !mappingKeys.has(mappingKey(warehouse.externalId, row.externalSku)));
      const state = warehouseState({
        state: readStateByWh.get(warehouse.warehouseId),
        adoptedRows: warehouseLines,
        mappedSkus,
        pendingSourceRowCount: pendingSourceRows.length,
      });
      const pendingTotal = pendingForWarehouse.length > 0;
      const subtotal = pendingTotal ? { total: null as number | null, count: 0 } : sumOnHandLines(warehouseLines);
      const inventoryState: InventoryWarehouseState = state === 'failed'
        ? 'failed'
        : pendingTotal
          ? 'pending_total'
          : state;
      const knownSubtotalComplete = inventoryState === 'current'
        && warehouseLines.length > 0
        && subtotal.total !== null
        && pendingSourceRows.length === 0;
      warehouseScopes[warehouse.name] = {
        confirmedOnHandTotal: subtotal.total === null ? null : formatQuantity(BigInt(subtotal.total)),
        estimatedValueCny: null,
        valuationState: 'not_computed',
        valuationReason: '当前货值暂未计算（本包不新做估值）',
        confirmedLineCount: warehouseLines.length,
        inventoryState,
        pendingTotal,
        knownSubtotalComplete,
        pendingSourceRowCount: pendingSourceRows.length,
        lastObservedAt: lastObservedAtOf(warehouseLines),
      };
      if (warehouseLines.length > 0) warehouseCoverage[warehouse.name].adoptedRows += warehouseLines.length;
      if (pendingSourceRows.length > 0) warehouseCoverage[warehouse.name].pendingSourceRows += pendingSourceRows.length;
    }

    const allScope: WarehouseScopeView = {
      confirmedOnHandTotal: known.total === null ? null : formatQuantity(BigInt(known.total)),
      estimatedValueCny: null,
      valuationState: 'not_computed',
      valuationReason: '当前货值暂未计算（本包不新做估值）',
      confirmedLineCount: lines.length,
      inventoryState: pending.length > 0 ? 'pending_total' : lines.length > 0 ? 'current' : 'no_source',
      pendingTotal: pending.length > 0,
      knownSubtotalComplete: completeItem,
      pendingSourceRowCount: Object.values(warehouseScopes).reduce((sum, scope) => sum + (scope.pendingSourceRowCount ?? 0), 0),
      lastObservedAt: itemLastObservedAt,
    };
    const projections: Record<string, string> = { all: projectionForLines(lines, undefined) };
    for (const warehouse of warehouses) projections[warehouse.name] = projectionForLines(lines, warehouse.name);
    warehouseScopes.all = allScope;

    byItem.set(itemId, {
      hasCurrentData: lines.length > 0,
      mapped: (mappingsByItem.get(itemId) ?? []).length > 0,
      knownSubtotal: known.total === null ? null : formatQuantity(BigInt(known.total)),
      knownSubtotalComplete: completeItem,
      hasPendingTotal: pending.length > 0,
      pendingTotalWarehouses: pending.map((group) => ({
        ...group,
        warehouseId: warehouseByExternal.get(group.externalId)?.warehouseId ?? '',
      })),
      coveredWarehouseCount: adoptedWarehouseIds.size,
      scopeWarehouseCount: raw.scope.warehouseCount,
      lastObservedAt: itemLastObservedAt,
      markets,
      hasUnknownMarket,
      verificationOnly: (mappingsByItem.get(itemId) ?? []).some((mapping) => mapping.verification),
      unitUnconfirmed: (mappingsByItem.get(itemId) ?? []).some((mapping) => !mapping.unitConfirmed),
      unitConflict: unitSet.size > 1,
      unitGroupCount: unitSet.size,
      warehouseScopes,
      lines,
      inventoryProjectionByWarehouse: projections,
    });
  }

  let observationAt: string | null = null;
  for (const row of raw.effectiveRows) {
    if (row.observedAt && (!observationAt || row.observedAt > observationAt)) observationAt = row.observedAt;
  }
  observationAt = observationAt ?? raw.scope.lastAllSuccessAt ?? null;
  return {
    warehouseOptions: warehouses.map((warehouse) => warehouse.name),
    warehouses,
    scopeWarehouseCount: raw.scope.warehouseCount,
    lastAllSuccessAt: raw.scope.lastAllSuccessAt,
    observationAt,
    sourceLabel: SOURCE_LABEL,
    byItem,
    warehouseCoverage,
    lineCount: raw.effectiveRows.length,
  };
}

/** 商品没有任何来源记录时，仍要显示真实的“无来源/未接入”，不显示 0。 */
export function emptyInventoryView(source: InventoryCatalogSource | null): CatalogInventoryItemView {
  const warehouses = source?.warehouses ?? [];
  const warehouseScopes: Record<string, WarehouseScopeView> = {};
  for (const warehouse of warehouses) {
    warehouseScopes[warehouse.name] = {
      confirmedOnHandTotal: null,
      estimatedValueCny: null,
      valuationState: 'not_computed',
      valuationReason: '当前货值暂未计算（本包不新做估值）',
      confirmedLineCount: 0,
      inventoryState: 'no_source',
      pendingTotal: false,
      pendingSourceRowCount: 0,
      lastObservedAt: null,
    };
  }
  return {
    hasCurrentData: false,
    mapped: false,
    knownSubtotal: null,
    knownSubtotalComplete: false,
    hasPendingTotal: false,
    pendingTotalWarehouses: [],
    coveredWarehouseCount: 0,
    scopeWarehouseCount: source?.scopeWarehouseCount ?? 0,
    lastObservedAt: null,
    markets: [],
    hasUnknownMarket: false,
    verificationOnly: false,
    unitUnconfirmed: false,
    unitConflict: false,
    unitGroupCount: 0,
    warehouseScopes,
    lines: [],
    inventoryProjectionByWarehouse: { all: 'all\0' },
  };
}
