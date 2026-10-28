import type { FieldObservation } from '../types';
import type { AdoptedUnitCost } from './adopted-price';
import type { CatalogDisplayOverview, CatalogDisplayRow, CatalogInventoryItemView, WarehouseScopeView } from './display-types';

function observedText(field: FieldObservation | undefined): string | null {
  if (!field || field.state !== 'observed') return null;
  if (field.meaning === 'explicit_empty') return '';
  if (field.meaning === 'value') return field.raw;
  return null;
}

/** Client-safe inventory view: no line-level rows (detail fetches its own). */
export type CatalogInventoryListView = Omit<CatalogInventoryItemView, 'lines'>;

/** Client-safe list row: no full catalog field map or audit payloads. */
export type CatalogListClientRow = {
  itemId: string;
  itemRevision: number;
  iceCode: string | null;
  nameCn: string;
  newProductConfirmed: boolean;
  humanChoices: { bigseller: number; jushuitan: number };
  specificationText: string;
  englishName: string | null;
  barcodeText: string | null;
  unitText: string | null;
  categoryText: string | null;
  /** Confirmed source SKU raw values (observed) for client-side search only. */
  sourceSearchTokens: string[];
  adoptedUnitCost: AdoptedUnitCost | null;
  materialStatus: string;
  /** 统一库存视图（与商品库存页同一 effective-row 口径）。 */
  inventory: CatalogInventoryListView;
  /** 列表/详情漂移指纹（含全仓）。 */
  inventoryProjectionByWarehouse: Record<string, string>;
};

export type CatalogListClientPayload = {
  basisDocumentSha256: string;
  exportLabel: string | null;
  observationAt: string | null;
  warehouseOptions: string[];
  coverage: CatalogDisplayOverview['coverage'];
  warehouseCoverage: CatalogDisplayOverview['warehouseCoverage'];
  rows: CatalogListClientRow[];
};

function toListView(view: CatalogInventoryItemView): CatalogInventoryListView {
  const clientView: Record<string, unknown> = { ...view };
  delete clientView.lines;
  return clientView as unknown as CatalogInventoryListView;
}

export function toCatalogListClientPayload(
  display: CatalogDisplayOverview,
  sourceSearchTokens: Map<string, string[]> = new Map(),
): CatalogListClientPayload {
  return {
    basisDocumentSha256: display.basisDocumentSha256,
    exportLabel: display.exportLabel,
    observationAt: display.rows.find((row) => row.inventory.lastObservedAt)?.inventory.lastObservedAt ?? null,
    warehouseOptions: display.warehouseOptions,
    coverage: display.coverage,
    warehouseCoverage: display.warehouseCoverage,
    rows: display.rows.map((row) => ({
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
      inventory: toListView(row.inventory),
      inventoryProjectionByWarehouse: row.bsSample.inventoryProjectionByWarehouse,
    })),
  };
}

export function clientRowAsDisplayRow(row: CatalogListClientRow): CatalogDisplayRow {
  const view: CatalogInventoryItemView = { ...row.inventory, lines: [] };
  const allScope: WarehouseScopeView = {
    confirmedOnHandTotal: view.knownSubtotal,
    estimatedValueCny: null,
    valuationState: 'not_computed',
    valuationReason: '当前货值暂未计算（本包不新做估值）',
    confirmedLineCount: 0,
    inventoryState: view.hasPendingTotal ? 'pending_total' : view.hasCurrentData ? 'current' : 'no_source',
    pendingTotal: view.hasPendingTotal,
    pendingSourceRowCount: 0,
    lastObservedAt: view.lastObservedAt,
  };
  return {
    item: {
      itemId: row.itemId,
      revision: row.itemRevision,
      iceCode: row.iceCode,
      codeState: row.iceCode === null ? 'awaiting_code' : 'coded',
      newProductConfirmed: row.newProductConfirmed,
      nameCn: row.nameCn,
      specification: { state: 'not_read', raw: null, reason: 'list projection', evidenceRef: '' },
      barcodeRefs: [],
      fields: {},
      humanChoices: row.humanChoices,
      sourceRecordId: null,
      sourceIdentityVerified: false,
      relationshipUsable: false,
      provenanceRefs: [],
    },
    specificationText: row.specificationText,
    adoptedUnitCost: row.adoptedUnitCost,
    materialStatus: row.materialStatus,
    inventory: view,
    bsSample: {
      exportLabel: null,
      lastObservedAt: view.lastObservedAt,
      confirmedOnHandTotal: view.knownSubtotal,
      confirmedLineCount: 0,
      warehouseOnHand: {},
      warehouseScopes: { ...view.warehouseScopes, all: allScope },
      inventoryProjectionByWarehouse: row.inventoryProjectionByWarehouse,
      estimatedValueCny: null,
      valuationState: 'not_computed',
      valuationReason: '当前货值暂未计算（本包不新做估值）',
      hasCurrentData: view.hasCurrentData,
      hasPendingTotal: view.hasPendingTotal,
      knownSubtotalComplete: view.knownSubtotalComplete,
      pendingTotalWarehouses: view.pendingTotalWarehouses,
      coveredWarehouseCount: view.coveredWarehouseCount,
      scopeWarehouseCount: view.scopeWarehouseCount,
    },
  };
}
