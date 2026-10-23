import 'server-only';

import { cache } from 'react';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { catalogRepository } from '../repository';
import type { DbIdentity } from '@/lib/database/app-db';
import type { CatalogItemDto, PreparedFinancial } from '../types';
import { adoptedUnitCostFromFinancial } from './adopted-price';
import type { CatalogDisplayOverview, CatalogDisplayRow } from './display-types';
import type { CatalogListClientPayload } from './list-client-types';
export type { CatalogDisplayOverview, CatalogDisplayRow, CatalogDisplayValuationState } from './display-types';
import { formatQuantity, parseQuantity } from './decimal';
import { loadPreparedBsSampleInventory, type PreparedBsSampleInventory } from '../sources/bs-sample-inventory-adapter';
import { buildDetailInventoryProjectionTokenFromRows } from '../shell/catalog-detail-cache';
import { type InventoryRowSlice, type WarehouseScopeView, warehouseScopeView } from './warehouse-valuation';

type BsInventoryRowFull = Awaited<ReturnType<typeof catalogRepository.allBsSampleRows>>[number];

function inventoryProjectionsForItem(
  inventoryRows: BsInventoryRowFull[],
  itemId: string,
  warehouses: string[],
): Record<string, string> {
  const itemRows = inventoryRows.filter((row) => row.itemId === itemId);
  const mapped = itemRows.map((row) => ({
    warehouse: row.warehouse,
    sku: row.sku,
    onHand: row.onHand,
    orderLocked: row.orderLocked,
    warehouseAvailable: row.warehouseAvailable,
    activityReserved: row.activityReserved,
    inTransit: row.inTransit,
  }));
  const out: Record<string, string> = {
    all: buildDetailInventoryProjectionTokenFromRows(mapped, 'all'),
  };
  for (const wh of warehouses) {
    out[wh] = buildDetailInventoryProjectionTokenFromRows(mapped, wh);
  }
  return out;
}

const BASIS_PATH = 'docs/catalog/local-sample-valuation-basis-20261021.json';

export class CatalogDisplayReadError extends Error {
  constructor(
    readonly code: 'forbidden' | 'read_failed',
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

function sumOnHand(rows: InventoryRowSlice[], itemId: string, warehouse?: string): bigint | null {
  let total: bigint | null = null;
  for (const row of rows) {
    if (row.itemId !== itemId || row.selectionState !== 'confirmed') continue;
    if (warehouse && row.warehouse !== warehouse) continue;
    const qty = parseQuantity(row.onHand);
    if (qty === null) return null;
    total = (total ?? BigInt(0)) + qty;
  }
  return total;
}

function warehouseTotals(rows: InventoryRowSlice[], itemId: string, warehouses: string[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const wh of warehouses) {
    const total = sumOnHand(rows, itemId, wh);
    out[wh] = total === null ? null : formatQuantity(total);
  }
  return out;
}

function buildRow(
  item: CatalogItemDto,
  financial: PreparedFinancial | null,
  inventoryRows: InventoryRowSlice[],
  inventoryRowsFull: BsInventoryRowFull[],
  exportLabel: string | null,
  amountAllowed: boolean,
  notCreatedBs: boolean,
  warehouses: string[],
): CatalogDisplayRow {
  const adoptedUnitCost = amountAllowed ? adoptedUnitCostFromFinancial(financial) : null;
  const allScope = warehouseScopeView(inventoryRows, item.itemId, undefined, financial, amountAllowed, notCreatedBs);
  const warehouseScopes: Record<string, WarehouseScopeView> = {};
  for (const wh of warehouses) {
    warehouseScopes[wh] = warehouseScopeView(inventoryRows, item.itemId, wh, financial, amountAllowed, notCreatedBs);
  }
  let materialStatus = '资料已承接';
  if (item.newProductConfirmed && !item.iceCode) materialStatus = '新品，待补货号';
  else if (notCreatedBs) materialStatus = 'BS尚未建档';
  return {
    item,
    specificationText: specText(item),
    adoptedUnitCost,
    bsSample: {
      exportLabel,
      confirmedOnHandTotal: allScope.confirmedOnHandTotal,
      confirmedLineCount: allScope.confirmedLineCount,
      warehouseOnHand: warehouseTotals(inventoryRows, item.itemId, warehouses),
      warehouseScopes,
      inventoryProjectionByWarehouse: inventoryProjectionsForItem(inventoryRowsFull, item.itemId, warehouses),
      estimatedValueCny: allScope.estimatedValueCny,
      valuationState: allScope.valuationState,
      valuationReason: allScope.valuationReason,
    },
    materialStatus,
  };
}

function classifyReadError(error: unknown): CatalogDisplayReadError {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: string }).code) : '';
  if (code === '42501') return new CatalogDisplayReadError('forbidden', '应用身份无权读取 BS 样表库存投影', error);
  return new CatalogDisplayReadError('read_failed', 'BS 样表库存投影读取失败', error);
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
  let meta;
  try {
    meta = await catalogRepository.bsSampleMeta(identity);
  } catch (error) {
    throw classifyReadError(error);
  }
  if (!meta) return null;
  let items;
  let inventoryRows;
  let bsNotCreatedIds;
  try {
    [items, inventoryRows, bsNotCreatedIds] = await Promise.all([
      options.preload?.items ?? catalogRepository.list(identity, { baselinePublishedOnly: true }),
      catalogRepository.allBsSampleRows(identity),
      options.preload?.bsNotCreatedIds ?? catalogRepository.bsNotCreatedItemIds(identity),
    ]);
  } catch (error) {
    throw classifyReadError(error);
  }
  const exportLabel = typeof meta.exportLabel === 'string' ? meta.exportLabel : null;
  const warehouses = [...new Set(inventoryRows.map((r) => r.warehouse))].sort();
  const notCreated = (itemId: string) => bsNotCreatedIds.has(itemId);
  const financialByItem = new Map<string, PreparedFinancial | null>();
  if (options.amountAllowed) {
    const batch = await catalogRepository.baselineAmountsMap(identity);
    for (const item of items) {
      financialByItem.set(item.itemId, batch.get(item.itemId) ?? null);
    }
  }
  const displayRows = items.map((item) => buildRow(
    item,
    financialByItem.get(item.itemId) ?? null,
    inventoryRows,
    inventoryRows,
    exportLabel,
    options.amountAllowed,
    notCreated(item.itemId),
    warehouses,
  ));
  const missingPriceIceCodes = displayRows.filter((r) => r.adoptedUnitCost?.state === 'missing' || r.adoptedUnitCost?.state === 'parse_failed').map((r) => r.item.iceCode ?? '(缺码)');
  const warehouseCoverage: CatalogDisplayOverview['warehouseCoverage'] = {};
  for (const wh of warehouses) {
    warehouseCoverage[wh] = {
      bsConfirmedLines: inventoryRows.filter((r) => r.warehouse === wh && r.selectionState === 'confirmed').length,
      bsUnselectedLines: inventoryRows.filter((r) => r.warehouse === wh && r.selectionState === 'unselected').length,
    };
  }
  return {
    basisDocumentSha256: await basisDocumentSha256(),
    exportLabel,
    warehouseOptions: warehouses,
    rows: displayRows,
    warehouseCoverage,
    coverage: {
      pricedItemCount: displayRows.filter((r) => r.adoptedUnitCost?.state === 'priced').length,
      valuedItemCount: displayRows.filter((r) => r.bsSample.valuationState === 'valued').length,
      missingPriceIceCodes,
      bsConfirmedLines: inventoryRows.filter((r) => r.selectionState === 'confirmed').length,
      bsUnselectedLines: inventoryRows.filter((r) => r.selectionState === 'unselected').length,
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
    const batch = await catalogRepository.baselineAmountsMap(identity);
    for (const item of items) financialByItem.set(item.itemId, batch.get(item.itemId) ?? null);
  }
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
      bsSample: {
        exportLabel: null,
        confirmedOnHandTotal: null,
        confirmedLineCount: 0,
        warehouseOnHand: {},
        warehouseScopes: {},
        inventoryProjectionByWarehouse: { all: 'all\0' },
        estimatedValueCny: null,
        valuationState: 'not_applicable',
        valuationReason: notCreated(item.itemId) ? 'BS尚未建档（本批用户确认），不显示为库存0' : null,
      },
    };
  });
  const basisHash = await basisDocumentSha256().catch(() => '');
  return {
    basisDocumentSha256: basisHash,
    exportLabel: null,
    warehouseOptions: [],
    coverage: {
      pricedItemCount: displayRows.filter((r) => r.adoptedUnitCost?.state === 'priced').length,
      valuedItemCount: 0,
      missingPriceIceCodes: displayRows.filter((r) => r.adoptedUnitCost?.state === 'missing' || r.adoptedUnitCost?.state === 'parse_failed').map((r) => r.item.iceCode ?? '(缺码)'),
      bsConfirmedLines: 0,
      bsUnselectedLines: 0,
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
      bsSample: {
        confirmedOnHandTotal: row.bsSample.confirmedOnHandTotal,
        confirmedLineCount: row.bsSample.confirmedLineCount,
        warehouseScopes: row.bsSample.warehouseScopes,
        estimatedValueCny: row.bsSample.estimatedValueCny,
        valuationState: row.bsSample.valuationState,
        valuationReason: row.bsSample.valuationReason,
      },
      inventoryProjectionByWarehouse: row.bsSample.inventoryProjectionByWarehouse,
    })),
  };
}

export async function prepareBsSampleImportPayload(extractedPath: string): Promise<PreparedBsSampleInventory & { basisDocumentSha256: string }> {
  const prepared = await loadPreparedBsSampleInventory(extractedPath);
  const basisHash = await basisDocumentSha256();
  return { ...prepared, basisDocumentSha256: basisHash };
}
