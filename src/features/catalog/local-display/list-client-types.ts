import type { FieldObservation } from '../types';
import type { AdoptedUnitCost } from './adopted-price';
import type { CatalogDisplayOverview, CatalogDisplayRow, WarehouseScopeView } from './display-types';

function observedText(field: FieldObservation | undefined): string | null {
  if (!field || field.state !== 'observed') return null;
  if (field.meaning === 'explicit_empty') return '';
  if (field.meaning === 'value') return field.raw;
  return null;
}

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
  bsSample: {
    confirmedOnHandTotal: string | null;
    confirmedLineCount: number;
    warehouseScopes: Record<string, WarehouseScopeView>;
    estimatedValueCny: string | null;
    valuationState: CatalogDisplayRow['bsSample']['valuationState'];
    valuationReason: string | null;
  };
  inventoryProjectionByWarehouse: Record<string, string>;
};

export type CatalogListClientPayload = {
  basisDocumentSha256: string;
  exportLabel: string | null;
  warehouseOptions: string[];
  coverage: CatalogDisplayOverview['coverage'];
  warehouseCoverage: CatalogDisplayOverview['warehouseCoverage'];
  rows: CatalogListClientRow[];
};

export function toCatalogListClientPayload(
  display: CatalogDisplayOverview,
  sourceSearchTokens: Map<string, string[]> = new Map(),
): CatalogListClientPayload {
  return {
    basisDocumentSha256: display.basisDocumentSha256,
    exportLabel: display.exportLabel,
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

export function clientRowAsDisplayRow(row: CatalogListClientRow): CatalogDisplayRow {
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
    bsSample: {
      exportLabel: null,
      confirmedOnHandTotal: row.bsSample.confirmedOnHandTotal,
      confirmedLineCount: row.bsSample.confirmedLineCount,
      warehouseOnHand: {},
      warehouseScopes: row.bsSample.warehouseScopes,
      inventoryProjectionByWarehouse: row.inventoryProjectionByWarehouse,
      estimatedValueCny: row.bsSample.estimatedValueCny,
      valuationState: row.bsSample.valuationState,
      valuationReason: row.bsSample.valuationReason,
    },
  };
}
