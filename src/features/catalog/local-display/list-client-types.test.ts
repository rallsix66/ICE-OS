import { describe, expect, it } from 'vitest';
import { clientRowAsDisplayRow, toCatalogListClientPayload } from './list-client-types';
import type { CatalogDisplayOverview } from './display-types';

const sampleOverview: CatalogDisplayOverview = {
  basisDocumentSha256: 'abc',
  exportLabel: 'BS 2026-10-15',
  warehouseOptions: ['菲越'],
  coverage: { pricedItemCount: 1, valuedItemCount: 1, missingPriceIceCodes: [], bsConfirmedLines: 1, bsUnselectedLines: 0 },
  warehouseCoverage: { 菲越: { bsConfirmedLines: 1, bsUnselectedLines: 0 } },
  rows: [{
    item: {
      itemId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      revision: 1,
      iceCode: 'WM0001',
      codeState: 'coded',
      newProductConfirmed: false,
      nameCn: '测试',
      specification: { state: 'observed', meaning: 'value', raw: '100ml', evidenceRef: 'e' },
      barcodeRefs: [{ state: 'observed', meaning: 'value', raw: '690000', evidenceRef: 'e' }],
      fields: { englishName: { state: 'observed', meaning: 'value', raw: 'Test', evidenceRef: 'e' }, unit: { state: 'observed', meaning: 'value', raw: '瓶', evidenceRef: 'e' } },
      humanChoices: { bigseller: 1, jushuitan: 0 },
      sourceRecordId: null,
      sourceIdentityVerified: false,
      relationshipUsable: false,
      provenanceRefs: [],
    },
    specificationText: '100ml',
    adoptedUnitCost: { state: 'priced', amountCny: '5.18', evidenceRef: 'e', sourceRow: 1 },
    materialStatus: '资料已承接',
    bsSample: {
      exportLabel: 'BS',
      confirmedOnHandTotal: '10',
      confirmedLineCount: 1,
      warehouseOnHand: { 菲越: '10' },
      warehouseScopes: { 菲越: { confirmedOnHandTotal: '10', confirmedLineCount: 1, estimatedValueCny: '51.80', valuationState: 'valued', valuationReason: null } },
      inventoryProjectionByWarehouse: { all: 'all\0', 菲越: '菲越\0' },
      estimatedValueCny: '51.80',
      valuationState: 'valued',
      valuationReason: null,
    },
  }],
};

describe('toCatalogListClientPayload', () => {
  it('drops full field maps from list rows', () => {
    const payload = toCatalogListClientPayload(sampleOverview);
    expect(payload.rows[0]?.englishName).toBe('Test');
    expect(payload.rows[0]).not.toHaveProperty('fields');
    expect(Object.keys(clientRowAsDisplayRow(payload.rows[0]!).item.fields)).toHaveLength(0);
  });
});
