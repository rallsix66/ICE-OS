import 'server-only';

import { cache } from 'react';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { catalogRepository } from '../repository';
import type { DbIdentity } from '@/lib/database/app-db';
import type { CatalogItemDto, PreparedFinancial } from '../types';
import { adoptedUnitCostFromFinancial } from './adopted-price';
import type {
  CatalogDisplayOverview,
  CatalogDisplayRow,
  CatalogInventorySourceLine,
  InventoryWarehouseState,
  WarehouseScopeView,
} from './display-types';
import type { CatalogListClientPayload } from './list-client-types';
export type { CatalogDisplayOverview, CatalogDisplayRow, CatalogDisplayValuationState } from './display-types';
import { buildInventoryCatalogSource, emptyInventoryView, type InventoryCatalogRaw, type InventoryCatalogSource } from './inventory-source';
import { buildDetailInventoryProjectionTokenFromRows } from '../shell/catalog-detail-cache';
import { requireCatalogAdmin } from '../authorization';
import { loadPreparedBsSampleInventory, type PreparedBsSampleInventory } from '../sources/bs-sample-inventory-adapter';

const BASIS_PATH = 'docs/catalog/local-sample-valuation-basis-20261021.json';
const NOT_COMPUTED_REASON = '当前货值暂未计算（本包不新做估值：旧样表价格不能乘新库存冒充当前货值）';

export class CatalogDisplayReadError extends Error {
  constructor(
    readonly code: 'forbidden' | 'read_failed' | 'not_available',
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'CatalogDisplayReadError';
  }
}

export const basisDocumentSha256 = cache(async function basisDocumentSha256(): Promise<string> {
  const bytes = await fs.readFile(path.join(process.cwd(), BASIS_PATH));
  return createHash('sha256').update(bytes).digest('hex');
});

function specText(item: CatalogItemDto): string {
  const spec = item.specification;
  if (spec.state === 'observed' && spec.meaning === 'value') return spec.raw;
  if (spec.state === 'observed' && spec.meaning === 'explicit_empty') return '';
  return '—';
}

function rowSlice(line: CatalogInventorySourceLine) {
  return {
    warehouse: line.warehouse,
    sku: line.externalSku,
    onHand: line.onHand,
    orderLocked: line.orderLocked,
    warehouseAvailable: line.warehouseAvailable,
    activityReserved: line.activityReserved,
    inTransit: line.inTransit,
  };
}

function inventoryProjectionsForItem(lines: CatalogInventorySourceLine[], warehouses: string[]): Record<string, string> {
  const slices = lines.map(rowSlice);
  const out: Record<string, string> = {
    all: buildDetailInventoryProjectionTokenFromRows(slices, 'all'),
  };
  for (const warehouse of warehouses) {
    out[warehouse] = buildDetailInventoryProjectionTokenFromRows(slices, warehouse);
  }
  return out;
}

function buildRow(
  item: CatalogItemDto,
  financial: PreparedFinancial | null,
  source: InventoryCatalogSource | null,
  amountAllowed: boolean,
  notCreatedBs: boolean,
): CatalogDisplayRow {
  const inventory = source?.byItem.get(item.itemId) ?? emptyInventoryView(source);
  const adoptedUnitCost = amountAllowed ? adoptedUnitCostFromFinancial(financial) : null;
  const warehouseOnHand: Record<string, string | null> = {};
  for (const [name, scope] of Object.entries(inventory.warehouseScopes)) {
    warehouseOnHand[name] = scope.confirmedOnHandTotal;
  }
  let materialStatus = '资料已承接';
  if (item.newProductConfirmed && !item.iceCode) materialStatus = '新品，待补货号';
  else if (notCreatedBs) materialStatus = 'BS尚未建档';
  return {
    item,
    specificationText: specText(item),
    adoptedUnitCost,
    bsSample: {
      exportLabel: source?.sourceLabel ?? null,
      lastObservedAt: inventory.lastObservedAt,
      confirmedOnHandTotal: inventory.knownSubtotal,
      confirmedLineCount: inventory.lines.length,
      warehouseOnHand,
      warehouseScopes: { ...inventory.warehouseScopes },
      inventoryProjectionByWarehouse: inventoryProjectionsForItem(inventory.lines, source?.warehouseOptions ?? []),
      estimatedValueCny: null,
      valuationState: 'not_computed',
      valuationReason: NOT_COMPUTED_REASON,
      hasCurrentData: inventory.hasCurrentData,
      hasPendingTotal: inventory.hasPendingTotal,
      knownSubtotalComplete: inventory.knownSubtotalComplete,
      pendingTotalWarehouses: inventory.pendingTotalWarehouses,
      coveredWarehouseCount: inventory.coveredWarehouseCount,
      scopeWarehouseCount: inventory.scopeWarehouseCount,
    },
    inventory,
    materialStatus,
  };
}

function classifyReadError(error: unknown): CatalogDisplayReadError {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: string }).code) : '';
  if (code === '42501' || code === 'INSUFFICIENT_PRIVILEGE') return new CatalogDisplayReadError('forbidden', '当前账号无权读取库存数据', error);
  if (code === '42883' || code === 'PGRST202') {
    return new CatalogDisplayReadError('not_available', '库存模块尚未升级（缺少统一库存读模型）；库存不显示、不回退旧样表', error);
  }
  return new CatalogDisplayReadError('read_failed', 'BigSeller 库存读取失败', error);
}

export async function loadInventoryCatalogSource(identity: DbIdentity): Promise<InventoryCatalogSource | null> {
  const raw = await catalogRepository.inventoryCatalogSources(identity);
  if (!raw || typeof raw !== 'object') return null;
  return buildInventoryCatalogSource(raw as InventoryCatalogRaw);
}

type DisplayPreload = {
  items?: Awaited<ReturnType<typeof catalogRepository.list>>;
  bsNotCreatedIds?: Set<string>;
  sourceSearchTokens?: Map<string, string[]>;
};

export async function buildCatalogDisplayOverview(
  identity: DbIdentity,
  options: { amountAllowed: boolean; preload?: DisplayPreload },
): Promise<CatalogDisplayOverview | null> {
  let source: InventoryCatalogSource | null;
  try {
    source = await loadInventoryCatalogSource(identity);
  } catch (error) {
    throw classifyReadError(error);
  }
  if (!source) return null;
  let items: Awaited<ReturnType<typeof catalogRepository.list>>;
  let bsNotCreatedIds: Set<string>;
  try {
    items = options.preload?.items ?? await catalogRepository.list(identity, { baselinePublishedOnly: true });
    bsNotCreatedIds = options.preload?.bsNotCreatedIds ?? await catalogRepository.bsNotCreatedItemIds(identity);
  } catch (error) {
    throw classifyReadError(error);
  }
  const financialByItem = new Map<string, PreparedFinancial | null>();
  if (options.amountAllowed) {
    try {
      const batch = await catalogRepository.baselineAmountsMap(identity);
      for (const item of items) financialByItem.set(item.itemId, batch.get(item.itemId) ?? null);
    } catch {
      /* 价格读取失败不影响库存与主资料；价格单元格按缺价显示。 */
    }
  }
  const displayRows = items.map((item) => buildRow(
    item,
    financialByItem.get(item.itemId) ?? null,
    source,
    options.amountAllowed,
    bsNotCreatedIds.has(item.itemId),
  ));
  const missingPriceIceCodes = displayRows.filter((row) => row.adoptedUnitCost?.state === 'missing' || row.adoptedUnitCost?.state === 'parse_failed').map((row) => row.item.iceCode ?? '(缺码)');
  return {
    basisDocumentSha256: await basisDocumentSha256(),
    exportLabel: source.sourceLabel,
    warehouseOptions: source.warehouseOptions,
    rows: displayRows,
    warehouseCoverage: source.warehouseCoverage,
    coverage: {
      pricedItemCount: displayRows.filter((row) => row.adoptedUnitCost?.state === 'priced').length,
      valuedItemCount: 0,
      missingPriceIceCodes,
      bsConfirmedLines: source.lineCount,
      bsUnselectedLines: 0,
      inventoryLineCount: source.lineCount,
      coveredItemCount: displayRows.filter((row) => row.inventory.hasCurrentData).length,
      pendingTotalItemCount: displayRows.filter((row) => row.inventory.hasPendingTotal).length,
      pendingSourceRowCount: Object.values(source.warehouseCoverage).reduce((sum, entry) => sum + entry.pendingSourceRows, 0),
    },
  };
}

function observedText(field: CatalogItemDto['fields'][string] | undefined): string | null {
  if (!field || field.state !== 'observed') return null;
  if (field.meaning === 'explicit_empty') return '';
  if (field.meaning === 'value') return field.raw;
  return null;
}

export async function buildCatalogListFallbackFromItems(
  identity: DbIdentity,
  items: CatalogItemDto[],
  amountAllowed: boolean,
  preload?: { bsNotCreatedIds?: Set<string>; sourceSearchTokens?: Map<string, string[]> },
): Promise<CatalogListClientPayload> {
  const [bsNotCreatedIds, sourceSearchTokens] = await Promise.all([
    preload?.bsNotCreatedIds ?? catalogRepository.bsNotCreatedItemIds(identity),
    preload?.sourceSearchTokens ?? catalogRepository.sourceSearchTokensByItem(identity),
  ]);
  const notCreated = (itemId: string) => bsNotCreatedIds.has(itemId);
  const financialByItem = new Map<string, PreparedFinancial | null>();
  if (amountAllowed) {
    try {
      const batch = await catalogRepository.baselineAmountsMap(identity);
      for (const item of items) financialByItem.set(item.itemId, batch.get(item.itemId) ?? null);
    } catch {
      /* 缺价显示“成本待补充”，不影响主资料。 */
    }
  }
  const emptyView = emptyInventoryView(null);
  const displayRows: CatalogDisplayRow[] = items.map((item) => {
    const financial = financialByItem.get(item.itemId) ?? null;
    const adoptedUnitCost = amountAllowed ? adoptedUnitCostFromFinancial(financial) : null;
    let materialStatus = '资料已承接';
    if (item.newProductConfirmed && !item.iceCode) materialStatus = '新品，待补货号';
    else if (notCreated(item.itemId)) materialStatus = 'BS尚未建档';
    return {
      item,
      specificationText: specText(item),
      adoptedUnitCost,
      materialStatus,
      inventory: emptyView,
      bsSample: {
        exportLabel: null,
        lastObservedAt: null,
        confirmedOnHandTotal: null,
        confirmedLineCount: 0,
        warehouseOnHand: {},
        warehouseScopes: {},
        inventoryProjectionByWarehouse: { all: 'all\0' },
        estimatedValueCny: null,
        valuationState: 'not_available',
        valuationReason: '库存模块未接入；不显示为库存 0，也没有旧样表回退',
        hasCurrentData: false,
        hasPendingTotal: false,
        knownSubtotalComplete: false,
        pendingTotalWarehouses: [],
        coveredWarehouseCount: 0,
        scopeWarehouseCount: 0,
      },
    };
  });
  const basisHash = await basisDocumentSha256().catch(() => '');
  return {
    basisDocumentSha256: basisHash,
    exportLabel: null,
    observationAt: null,
    warehouseOptions: [],
    coverage: {
      pricedItemCount: displayRows.filter((row) => row.adoptedUnitCost?.state === 'priced').length,
      valuedItemCount: 0,
      missingPriceIceCodes: displayRows.filter((row) => row.adoptedUnitCost?.state === 'missing' || row.adoptedUnitCost?.state === 'parse_failed').map((row) => row.item.iceCode ?? '(缺码)'),
      bsConfirmedLines: 0,
      bsUnselectedLines: 0,
      inventoryLineCount: 0,
      coveredItemCount: 0,
      pendingTotalItemCount: 0,
      pendingSourceRowCount: 0,
    },
    warehouseCoverage: {},
    rows: displayRows.map((row) => ({
      itemId: row.item.itemId,
      itemRevision: row.item.revision,
      iceCode: row.item.iceCode,
      nameCn: row.item.nameCn,
      newProductConfirmed: row.item.newProductConfirmed,
      humanChoices: row.item.humanChoices,
      specificationText: row.specificationText,
      englishName: observedText(row.item.fields.englishName),
      barcodeText: observedText(row.item.fields.barcode) ?? observedText(row.item.barcodeRefs[0]),
      unitText: observedText(row.item.fields.unit),
      categoryText: observedText(row.item.fields.category),
      sourceSearchTokens: sourceSearchTokens.get(row.item.itemId) ?? [],
      adoptedUnitCost: row.adoptedUnitCost,
      materialStatus: row.materialStatus,
      inventory: row.inventory,
      inventoryProjectionByWarehouse: row.bsSample.inventoryProjectionByWarehouse,
    })),
  };
}

/** 详情读模型：同一 effective-row 口径（库存模块 read_inventory_item），不再读旧 BS 样表。 */
export interface CatalogInventoryDetailView {
  status: 'loaded' | 'not_available';
  sourceLabel: string | null;
  observationAt: string | null;
  item: { itemId: string; iceCode: string | null; nameCn: string | null };
  rows: CatalogInventorySourceLine[];
  warehouses: Array<{
    warehouseId: string;
    externalId: string;
    name: string;
    market: string | null;
    status: string;
    reason: string | null;
    rows: CatalogInventorySourceLine[];
    pendingSourceRows: Array<{ externalSku: string; excelRow: number | null; onHand: number | null; mapped: boolean }>;
    pendingSourceRowCount: number;
    mappedSkus: string[];
    adoptedSkus: string[];
    pendingAdoptionSkus: string[];
    lastSuccessAt: string | null;
    lastObservationAt: string | null;
    lastErrorCode: string | null;
  }>;
  totals: {
    knownSubtotal: string | null;
    knownSubtotalComplete: boolean;
    unitConflict: boolean;
    hasPendingTotal: boolean;
    pendingTotalWarehouses: Array<{ warehouseId: string; externalId: string; name: string; unit: string | null; rows: Array<{ externalSku: string; onHand: string | null; excelRow: number | null; observedAt: string | null }> }>;
    hasCurrentData: boolean;
    lastObservedAt: string | null;
    coverage: { scopeWarehouses: number; coveredWarehouses: number } | null;
    byUnit: Array<{ unit: string | null; subtotal: string | null; knownOnHand: number; rowCount: number; warehouseCount: number; hasUnknownQuantity: boolean }>;
  };
  valuation: WarehouseScopeView;
  adoptedUnitCost: PreparedFinancial | null;
  basisDocumentSha256: string | null;
  warnings: string[];
}

function lineFromRow(warehouse: string, warehouseExternalId: string, row: Record<string, unknown>): CatalogInventorySourceLine {
  const qty = (value: unknown) => (value == null ? null : String(value));
  return {
    warehouse,
    warehouseExternalId,
    externalSku: String(row.externalSku ?? ''),
    unit: row.unit == null ? null : String(row.unit),
    onHand: qty(row.onHand),
    orderLocked: qty(row.orderLocked),
    warehouseAvailable: qty(row.warehouseAvailable),
    activityReserved: qty(row.activityReserved),
    inTransit: qty(row.inTransit),
    observedAt: row.observedAt == null ? null : String(row.observedAt),
    excelRow: row.excelRow == null ? null : Number(row.excelRow),
    selectionState: 'confirmed',
  };
}

/** 库存读模型把 coverage 放在响应顶层；缺失时保持“未读取”，不用 0/0 冒充。 */
function readCoverage(detail: Record<string, unknown>): { scopeWarehouses: number; coveredWarehouses: number } | null {
  const raw = detail.coverage;
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const scopeWarehouses = Number(record.scopeWarehouses);
  const coveredWarehouses = Number(record.coveredWarehouses);
  if (!Number.isFinite(scopeWarehouses) || !Number.isFinite(coveredWarehouses)) return null;
  return { scopeWarehouses, coveredWarehouses };
}

export async function getCatalogItemInventory(itemId: string, warehouse?: string) {
  const identity = await requireCatalogAdmin();
  const amountAllowed = await requireCatalogAdmin('amount:read').then(() => true).catch(() => false);
  const warehouses = await catalogRepository.inventoryWarehouses(identity);
  const target = warehouse?.trim();
  const targetWarehouse = target && target !== 'all' ? warehouses.find((entry) => entry.name === target) : null;
  if (target && target !== 'all' && !targetWarehouse) {
    return { status: 'not_available' as const, message: '该仓库不在参与范围或已改名；请刷新列表后重试。' };
  }
  const detail = await catalogRepository.inventoryItemDetail(identity, itemId, targetWarehouse?.warehouseId ?? null, false) as Record<string, unknown> | null;
  if (!detail || !detail.item) return { status: 'not_available' as const, message: '库存模块未接入；不显示为库存 0，也没有旧样表回退。' };
  const item = detail.item as { itemId: string; iceCode?: string | null; nameCn?: string | null };
  const rawWarehouses = Array.isArray(detail.warehouses) ? detail.warehouses as Array<Record<string, unknown>> : [];
  const mappedWarehouses = rawWarehouses.map((entry) => {
    const name = String(entry.name ?? '');
    const externalId = String(entry.externalId ?? '');
    const rows = (Array.isArray(entry.rows) ? entry.rows as Array<Record<string, unknown>> : []).map((row) => lineFromRow(name, externalId, row));
    return {
      warehouseId: String(entry.warehouseId ?? ''),
      externalId,
      name,
      market: entry.market == null ? null : String(entry.market),
      status: String(entry.status ?? ''),
      reason: entry.reason == null ? null : String(entry.reason),
      rows,
      pendingSourceRows: (Array.isArray(entry.pendingSourceRows) ? entry.pendingSourceRows as Array<Record<string, unknown>> : []).map((row) => ({
        externalSku: String(row.externalSku ?? ''),
        excelRow: row.excelRow == null ? null : Number(row.excelRow),
        onHand: row.onHand == null ? null : Number(row.onHand),
        mapped: Boolean(row.mapped),
      })),
      pendingSourceRowCount: Number(entry.pendingSourceRowCount ?? 0),
      mappedSkus: Array.isArray(entry.mappedSkus) ? entry.mappedSkus.map(String) : [],
      adoptedSkus: Array.isArray(entry.adoptedSkus) ? entry.adoptedSkus.map(String) : [],
      pendingAdoptionSkus: Array.isArray(entry.pendingAdoptionSkus) ? entry.pendingAdoptionSkus.map(String) : [],
      lastSuccessAt: entry.lastSuccessAt == null ? null : String(entry.lastSuccessAt),
      lastObservationAt: entry.lastObservationAt == null ? null : String(entry.lastObservationAt),
      lastErrorCode: entry.lastErrorCode == null ? null : String(entry.lastErrorCode),
    };
  });
  const rows = mappedWarehouses.flatMap((entry) => entry.rows);
  const totals = (detail.totals ?? {}) as Record<string, unknown>;
  const byUnit = Array.isArray(totals.byUnit) ? totals.byUnit as Array<Record<string, unknown>> : [];
  const pendingTotals = Array.isArray(totals.pendingTotalWarehouses) ? totals.pendingTotalWarehouses as Array<Record<string, unknown>> : [];
  const selected = targetWarehouse ? mappedWarehouses.find((entry) => entry.warehouseId === targetWarehouse.warehouseId) : undefined;
  const hasPendingTotal = Boolean(totals.hasPendingTotal) || pendingTotals.length > 0;
  const coverage = readCoverage(detail);
  const coverageComplete = coverage ? coverage.coveredWarehouses >= coverage.scopeWarehouses : false;
  /* 单仓与全仓都以 SQL 返回的同一份 scoped 汇总为准（p_warehouse 已把范围缩到该仓）。 */
  const selectedState: InventoryWarehouseState = selected
    ? selected.status === 'failed'
      ? 'failed'
      : selected.status === 'current'
        ? (hasPendingTotal ? 'pending_total' : 'current')
        : selected.status === 'unseen'
          ? 'unseen'
          : selected.reason === 'unmapped_source'
            ? 'unmapped_source'
            : selected.reason === 'no_source'
              ? 'no_source'
              : 'no_data'
    : 'no_source';
  const valuation: WarehouseScopeView = {
    confirmedOnHandTotal: totals.knownSubtotal == null ? null : String(totals.knownSubtotal),
    estimatedValueCny: null,
    valuationState: 'not_computed',
    valuationReason: NOT_COMPUTED_REASON,
    confirmedLineCount: selected ? selected.rows.length : rows.length,
    inventoryState: selected
      ? selectedState
      : hasPendingTotal
        ? 'pending_total'
        : rows.length > 0
          ? 'current'
          : 'no_source',
    pendingTotal: hasPendingTotal,
    knownSubtotalComplete: Boolean(totals.knownSubtotalComplete) && coverageComplete
      && (!selected || selected.pendingSourceRowCount === 0),
    pendingSourceRowCount: selected
      ? selected.pendingSourceRowCount
      : mappedWarehouses.reduce((sum, entry) => sum + entry.pendingSourceRowCount, 0),
    lastObservedAt: totals.lastObservedAt == null ? null : String(totals.lastObservedAt),
  };
  const financial = amountAllowed ? await catalogRepository.amounts(identity, itemId) : null;
  const basisHash = await basisDocumentSha256().catch(() => null);
  return {
    status: 'loaded' as const,
    sourceLabel: 'BigSeller 自动导出',
    observationAt: (totals.lastObservedAt == null ? null : String(totals.lastObservedAt)),
    item: { itemId: item.itemId, iceCode: item.iceCode ?? null, nameCn: item.nameCn ?? null },
    rows,
    warehouses: mappedWarehouses,
    totals: {
      knownSubtotal: totals.knownSubtotal == null ? null : String(totals.knownSubtotal),
      knownSubtotalComplete: Boolean(totals.knownSubtotalComplete),
      unitConflict: Boolean(totals.unitConflict),
      hasPendingTotal,
      pendingTotalWarehouses: pendingTotals.map((group) => ({
        warehouseId: String(group.warehouseId ?? ''),
        externalId: String(group.externalId ?? ''),
        name: String(group.name ?? ''),
        unit: group.unit == null ? null : String(group.unit),
        rows: (Array.isArray(group.rows) ? group.rows as Array<Record<string, unknown>> : []).map((row) => ({
          externalSku: String(row.externalSku ?? ''),
          onHand: row.onHand == null ? null : String(row.onHand),
          excelRow: row.excelRow == null ? null : Number(row.excelRow),
          observedAt: row.observedAt == null ? null : String(row.observedAt),
        })),
      })),
      hasCurrentData: Boolean(totals.hasCurrentData) || rows.length > 0,
      lastObservedAt: totals.lastObservedAt == null ? null : String(totals.lastObservedAt),
      coverage,
      byUnit: byUnit.map((group) => ({
        unit: group.unit == null ? null : String(group.unit),
        subtotal: group.subtotal == null ? null : String(group.subtotal),
        knownOnHand: Number(group.knownOnHand ?? 0),
        rowCount: Number(group.rowCount ?? 0),
        warehouseCount: Number(group.warehouseCount ?? 0),
        hasUnknownQuantity: Boolean(group.hasUnknownQuantity),
      })),
    },
    valuation,
    adoptedUnitCost: financial,
    basisDocumentSha256: basisHash,
    warnings: (Array.isArray(detail.scopedWarnings) ? detail.scopedWarnings as unknown[] : []).map(String),
  };
}

/** 兼容旧动作名：库存详情仍从统一库存读模型读取，不读旧 BS 样表。 */
export const getCatalogItemBsSample = getCatalogItemInventory;

/** 旧 BS 样表仅作历史证据：保留显式导入入口，不再被商品库列表/详情读取。 */
export async function prepareBsSampleImportPayload(extractedPath: string): Promise<PreparedBsSampleInventory & { basisDocumentSha256: string }> {
  const prepared = await loadPreparedBsSampleInventory(extractedPath);
  const basisHash = await basisDocumentSha256();
  return { ...prepared, basisDocumentSha256: basisHash };
}
