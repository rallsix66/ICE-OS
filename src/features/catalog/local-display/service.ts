import 'server-only';

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { catalogRepository } from '../repository';
import type { DbIdentity } from '@/lib/database/app-db';
import type { CatalogItemDto, PreparedFinancial } from '../types';
import { adoptedUnitCostFromFinancial } from './adopted-price';
import type { CatalogDisplayOverview, CatalogDisplayRow } from './display-types';
export type { CatalogDisplayOverview, CatalogDisplayRow, CatalogDisplayValuationState } from './display-types';
import { formatQuantity, parseQuantity } from './decimal';
import { loadPreparedBsSampleInventory, type PreparedBsSampleInventory } from '../sources/bs-sample-inventory-adapter';
import { type InventoryRowSlice, type WarehouseScopeView, warehouseScopeView } from './warehouse-valuation';

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

export async function basisDocumentSha256(): Promise<string> {
  const bytes = await fs.readFile(path.join(process.cwd(), BASIS_PATH));
  return createHash('sha256').update(bytes).digest('hex');
}

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

export async function buildCatalogDisplayOverview(identity: DbIdentity, options: { amountAllowed: boolean }): Promise<CatalogDisplayOverview | null> {
  const meta = await catalogRepository.bsSampleMeta(identity);
  if (!meta) return null;
  let items;
  let inventoryRows;
  let decisions;
  try {
    [items, inventoryRows, decisions] = await Promise.all([
      catalogRepository.list(identity, { baselinePublishedOnly: true }),
      catalogRepository.allBsSampleRows(identity),
      catalogRepository.decisions(identity),
    ]);
  } catch (error) {
    throw classifyReadError(error);
  }
  const exportLabel = typeof meta.exportLabel === 'string' ? meta.exportLabel : null;
  const warehouses = [...new Set(inventoryRows.map((r) => r.warehouse))].sort();
  const notCreated = (itemId: string) => decisions.some((d) => d.selectedItemId === itemId
    && d.entryKind === 'history:batch_bs_not_created' && d.summary.sourceSystem === 'bigseller' && d.summary.status === 'user_confirmed_not_created');
  const financialByItem = new Map<string, PreparedFinancial | null>();
  if (options.amountAllowed) {
    await Promise.all(items.map(async (item) => {
      financialByItem.set(item.itemId, await catalogRepository.amounts(identity, item.itemId));
    }));
  }
  const displayRows = items.map((item) => buildRow(item, financialByItem.get(item.itemId) ?? null, inventoryRows, exportLabel, options.amountAllowed, notCreated(item.itemId), warehouses));
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

export async function prepareBsSampleImportPayload(extractedPath: string): Promise<PreparedBsSampleInventory & { basisDocumentSha256: string }> {
  const prepared = await loadPreparedBsSampleInventory(extractedPath);
  const basisHash = await basisDocumentSha256();
  return { ...prepared, basisDocumentSha256: basisHash };
}
