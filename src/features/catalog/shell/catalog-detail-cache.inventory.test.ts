import { describe, expect, it } from 'vitest';

import {
  buildDetailInventoryProjectionToken,
  buildDetailInventoryProjectionTokenFromRows,
  buildListProjectionToken,
  buildListProjectionTokenFromView,
  detailScopeFromView,
  maskDetailViewForAuthFailure,
  normalizeDetailWarehouse,
  writeDetailCache,
  readDetailCache,
  type CatalogDetailCacheContext,
  type CatalogDetailView,
} from './catalog-detail-cache';
import type { CatalogListClientRow } from '../local-display/list-client-types';
import type { CatalogInventoryItemView } from '../local-display/display-types';

const PH = '菲律宾-新创启辰自建仓';
const VN = '越南青林湾仓库';
const context: CatalogDetailCacheContext = { principalKey: 'user-a', amountAllowed: true, displayBasisSha256: 'basis-a' };

function inventoryView(overrides: Partial<CatalogInventoryItemView> = {}): CatalogInventoryItemView {
  return {
    hasCurrentData: true,
    mapped: true,
    knownSubtotal: '10',
    knownSubtotalComplete: true,
    hasPendingTotal: false,
    pendingTotalWarehouses: [],
    coveredWarehouseCount: 2,
    scopeWarehouseCount: 2,
    lastObservedAt: '2026-10-26T13:11:31.916Z',
    markets: ['VN', 'PH'],
    hasUnknownMarket: false,
    verificationOnly: false,
    unitUnconfirmed: false,
    unitConflict: false,
    unitGroupCount: 1,
    warehouseScopes: {
      [VN]: { confirmedOnHandTotal: '10', estimatedValueCny: null, valuationState: 'not_computed', valuationReason: null, confirmedLineCount: 1, inventoryState: 'current', pendingTotal: false, pendingSourceRowCount: 0, lastObservedAt: '2026-10-26T13:11:31.916Z' },
      [PH]: { confirmedOnHandTotal: '4', estimatedValueCny: null, valuationState: 'not_computed', valuationReason: null, confirmedLineCount: 1, inventoryState: 'current', pendingTotal: false, pendingSourceRowCount: 0, lastObservedAt: '2026-10-26T13:11:31.916Z' },
    },
    lines: [],
    inventoryProjectionByWarehouse: { all: 'all\0x', [VN]: 'vn', [PH]: 'ph' },
    ...overrides,
  };
}

function listRow(view = inventoryView()): CatalogListClientRow {
  return {
    itemId: 'id-1', itemRevision: 1, iceCode: 'WM0026', nameCn: 'ICE LERSKIN双色泥膜', newProductConfirmed: false,
    humanChoices: { bigseller: 0, jushuitan: 0 }, specificationText: '—', englishName: null, barcodeText: null,
    unitText: null, categoryText: null, sourceSearchTokens: [], adoptedUnitCost: null, materialStatus: '资料已承接',
    inventory: view, inventoryProjectionByWarehouse: view.inventoryProjectionByWarehouse,
  };
}

function detailView(): CatalogDetailView {
  return {
    item: {
      itemId: 'id-1', revision: 1, iceCode: 'WM0026', nameCn: 'ICE LERSKIN双色泥膜',
      specification: { state: 'not_read', raw: null, reason: '', evidenceRef: '' }, barcodeRefs: [], fields: {},
      humanChoices: { bigseller: 0, jushuitan: 0 }, newProductConfirmed: false, codeState: 'coded',
      sourceRecordId: null, sourceIdentityVerified: false, relationshipUsable: false, provenanceRefs: [],
    },
    flags: { brushPending: false, bsNotCreated: false },
    writeAccess: { canWrite: false, isScoped: false },
    historical: false,
    bsSample: {
      status: 'loaded', sourceLabel: 'BigSeller 自动导出', observationAt: '2026-10-26T13:11:31.916Z',
      item: { itemId: 'id-1', iceCode: 'WM0026', nameCn: 'ICE LERSKIN双色泥膜' },
      rows: [
        { warehouse: VN, warehouseExternalId: '50455', externalSku: '697000000001', unit: '个', onHand: '10', orderLocked: '0', warehouseAvailable: '10', activityReserved: '0', inTransit: '0', observedAt: '2026-10-26T13:11:31.916Z', excelRow: 5, selectionState: 'confirmed' },
        { warehouse: PH, warehouseExternalId: '56519', externalSku: 'ICEWM0026', unit: '个', onHand: '4', orderLocked: '0', warehouseAvailable: '4', activityReserved: '0', inTransit: '0', observedAt: '2026-10-26T13:11:31.916Z', excelRow: 446, selectionState: 'confirmed' },
      ],
      warehouses: [],
      totals: { knownSubtotal: '10', knownSubtotalComplete: true, unitConflict: false, hasPendingTotal: false, pendingTotalWarehouses: [], hasCurrentData: true, lastObservedAt: '2026-10-26T13:11:31.916Z', coverage: { scopeWarehouses: 2, coveredWarehouses: 2 }, byUnit: [] },
      valuation: { confirmedOnHandTotal: '10', estimatedValueCny: null, valuationState: 'not_computed', valuationReason: '暂未计算', confirmedLineCount: 2, inventoryState: 'current', pendingTotal: false, lastObservedAt: '2026-10-26T13:11:31.916Z' },
      adoptedUnitCost: null,
      basisDocumentSha256: 'basis-a',
      warnings: [],
    },
    bsSampleError: null,
  } as CatalogDetailView;
}

describe('catalog detail cache with unified inventory', () => {
  it('normalizes scope and list projection changes when pending total flips', () => {
    expect(normalizeDetailWarehouse(undefined)).toBe('all');
    const plain = buildListProjectionToken(listRow(), PH, true);
    const pending = buildListProjectionToken(listRow(inventoryView({
      hasPendingTotal: true,
      warehouseScopes: {
        [VN]: inventoryView().warehouseScopes[VN],
        [PH]: { ...inventoryView().warehouseScopes[PH], confirmedOnHandTotal: null, pendingTotal: true, inventoryState: 'pending_total' },
      },
    })), PH, true);
    expect(plain).not.toBe(pending);
  });

  it('detail inventory token equals list row projection for the same rows', () => {
    const view = detailView();
    const fromView = buildDetailInventoryProjectionToken(view, PH);
    const loaded = view.bsSample as { status: 'loaded'; rows: Array<{ warehouse: string; externalSku: string; onHand: string; orderLocked: string; warehouseAvailable: string; activityReserved: string; inTransit: string }> };
    const slices = loaded.rows.map((row) => ({
      warehouse: row.warehouse,
      sku: row.externalSku,
      onHand: row.onHand,
      orderLocked: row.orderLocked,
      warehouseAvailable: row.warehouseAvailable,
      activityReserved: row.activityReserved,
      inTransit: row.inTransit,
    }));
    const fromRows = buildDetailInventoryProjectionTokenFromRows(slices, PH);
    expect(fromView).toBe(fromRows);
  });

  it('scopes cache entries and masks prices on auth failure', () => {
    const view = detailView();
    const scope = detailScopeFromView(view, undefined, context);
    expect(scope.displayBasisSha256).toBe('basis-a');
    const entry = writeDetailCache(view, undefined, context);
    expect(readDetailCache({ itemId: 'id-1', warehouse: 'all' }, context)?.scope.itemId).toBe('id-1');
    expect(entry.storedAt).toBeGreaterThan(0);
    const masked = maskDetailViewForAuthFailure(view);
    expect(masked.bsSampleError?.code).toBe('forbidden');
    expect(masked.bsSample?.status === 'loaded' ? masked.bsSample.adoptedUnitCost : null).toBeNull();
  });

  it('buildListProjectionTokenFromView mirrors the list token for the same inventory', () => {
    const view = detailView();
    const fromView = buildListProjectionTokenFromView(view, 'all', true);
    const fromList = buildListProjectionToken(listRow(), 'all', true);
    expect(fromView).toBe(fromList);
  });
});
