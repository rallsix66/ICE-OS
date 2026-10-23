import { describe, expect, it } from 'vitest';
import {
  buildDetailInventoryProjectionToken,
  buildListProjectionTokenFromView,
  clearDetailCache,
  detailScopeFromView,
  invalidateDetailCacheForPrincipal,
  invalidateDetailCacheItem,
  maskDetailViewForAuthFailure,
  normalizeDetailWarehouse,
  readDetailCache,
  resolveBackgroundDetailFetch,
  scopesMatch,
  writeDetailCache,
  type CatalogDetailCacheContext,
  type CatalogDetailView,
} from './catalog-detail-cache';

const contextA: CatalogDetailCacheContext = {
  principalKey: 'user-a',
  amountAllowed: true,
  displayBasisSha256: 'basis-a',
};

const contextB: CatalogDetailCacheContext = {
  principalKey: 'user-b',
  amountAllowed: true,
  displayBasisSha256: 'basis-a',
};

function mockView(itemId: string, revision: number, warehouseValuation: string): CatalogDetailView {
  return {
    item: {
      itemId,
      revision,
      iceCode: 'WM0043',
      nameCn: 'test',
      specification: { state: 'not_read', raw: null, reason: '', evidenceRef: '' },
      barcodeRefs: [],
      fields: {},
      humanChoices: { bigseller: 0, jushuitan: 0 },
      newProductConfirmed: false,
      codeState: 'coded',
      sourceRecordId: null,
      sourceIdentityVerified: false,
      relationshipUsable: false,
      provenanceRefs: [],
    },
    flags: { brushPending: false, bsNotCreated: false },
    writeAccess: { canWrite: false, isScoped: false },
    historical: false,
    bsSample: {
      status: 'loaded',
      exportLabel: null,
      rows: [],
      adoptedUnitCost: null,
      basisDocumentSha256: 'basis-a',
      valuation: {
        confirmedOnHandTotal: '1',
        estimatedValueCny: warehouseValuation,
        valuationState: 'valued',
        valuationReason: null,
        confirmedLineCount: 1,
      },
    },
    bsSampleError: null,
  } as CatalogDetailView;
}

describe('catalog detail cache scope', () => {
  it('normalizes warehouse and rejects cross-warehouse display scope', () => {
    expect(normalizeDetailWarehouse(undefined)).toBe('all');
    const allView = mockView('id-1', 1, '21623.7');
    const allScope = detailScopeFromView(allView, undefined, contextA);
    expect(scopesMatch(allScope, { ...allScope })).toBe(true);
    expect(scopesMatch(allScope, { itemId: 'id-1', warehouse: '菲律宾-新创启辰自建仓', itemRevision: 1, listProjectionToken: allScope.listProjectionToken, detailProjectionToken: allScope.detailProjectionToken, authToken: allScope.authToken, displayBasisSha256: allScope.displayBasisSha256 })).toBe(false);
  });

  it('caches per item and warehouse and invalidates on item', () => {
    clearDetailCache();
    const view = mockView('id-2', 2, '100');
    writeDetailCache(view, '菲律宾-新创启辰自建仓', contextA);
    const hit = readDetailCache({ itemId: 'id-2', warehouse: '菲律宾-新创启辰自建仓' }, contextA);
    expect(hit?.view.bsSample?.valuation?.estimatedValueCny).toBe('100');
    expect(readDetailCache({ itemId: 'id-2', warehouse: 'all' }, contextA)).toBeNull();
    invalidateDetailCacheItem('id-2');
    expect(readDetailCache({ itemId: 'id-2', warehouse: '菲律宾-新创启辰自建仓' }, contextA)).toBeNull();
  });

  it('rejects cache when auth context or revision changes', () => {
    clearDetailCache();
    const view = mockView('id-3', 3, '50');
    writeDetailCache(view, undefined, contextA);
    const loadedScope = detailScopeFromView(view, undefined, contextA);
    expect(readDetailCache({ itemId: 'id-3', warehouse: 'all' }, contextB)).toBeNull();
    expect(readDetailCache({ itemId: 'id-3', warehouse: 'all' }, contextA, { ...loadedScope, itemRevision: 99 })).toBeNull();
  });

  it('masks protected amounts after forbidden background resolution', () => {
    const view = mockView('id-4', 1, '123.45');
    const resolution = resolveBackgroundDetailFetch({
      success: false,
      error: '当前账户无权访问商品资料。',
      cachedView: view,
    });
    expect(resolution.kind).toBe('failure');
    if (resolution.kind === 'failure') {
      expect(resolution.retainMasked?.bsSample?.valuation?.estimatedValueCny).toBeNull();
      expect(maskDetailViewForAuthFailure(view).bsSampleError?.code).toBe('forbidden');
    }
  });

  it('changes detail inventory token when locked quantity changes', () => {
    const base = mockView('id-inv', 1, '100');
    type BsInventoryRow = {
      warehouse: string;
      sku: string;
      onHand: string;
      orderLocked: string;
      warehouseAvailable: string;
      activityReserved: string;
      inTransit: string;
    };
    const inventoryRow: BsInventoryRow = {
      warehouse: '菲律宾-新创启辰自建仓',
      sku: 'SKU1',
      onHand: '10',
      orderLocked: '1',
      warehouseAvailable: '9',
      activityReserved: '0',
      inTransit: '0',
    };
    const withRows = {
      ...base,
      bsSample: {
        ...base.bsSample!,
        rows: [inventoryRow],
      },
    } as CatalogDetailView;
    const changed = {
      ...withRows,
      bsSample: {
        ...withRows.bsSample!,
        rows: [{ ...inventoryRow, orderLocked: '4', warehouseAvailable: '6' }],
      },
    } as CatalogDetailView;
    const tokenA = buildDetailInventoryProjectionToken(withRows, '菲律宾-新创启辰自建仓');
    const tokenB = buildDetailInventoryProjectionToken(changed, '菲律宾-新创启辰自建仓');
    expect(tokenA).not.toBe(tokenB);
    expect(buildListProjectionTokenFromView(withRows, 'all', true)).toBe(buildListProjectionTokenFromView(changed, 'all', true));
  });

  it('rejects cache when display basis changes', () => {
    clearDetailCache();
    const view = mockView('id-basis', 1, '10');
    writeDetailCache(view, undefined, contextA);
    expect(readDetailCache({ itemId: 'id-basis', warehouse: 'all' }, { ...contextA, displayBasisSha256: 'basis-b' })).toBeNull();
  });

  it('stores response display basis on loaded scope (not list context) for authority comparison', () => {
    const view = {
      ...mockView('id-basis-sync', 1, '10'),
      bsSample: {
        ...mockView('id-basis-sync', 1, '10').bsSample!,
        basisDocumentSha256: 'basis-from-detail',
      },
    } as CatalogDetailView;
    const loaded = detailScopeFromView(view, undefined, contextA);
    expect(loaded.displayBasisSha256).toBe('basis-from-detail');
    expect(
      scopesMatch(loaded, {
        itemId: loaded.itemId,
        warehouse: loaded.warehouse,
        itemRevision: loaded.itemRevision,
        listProjectionToken: loaded.listProjectionToken,
        detailProjectionToken: loaded.detailProjectionToken,
        authToken: loaded.authToken,
        displayBasisSha256: contextA.displayBasisSha256,
      }),
    ).toBe(false);
  });

  it('rejects cache when list inventory projection changes but aggregates match', () => {
    clearDetailCache();
    const view = mockView('id-lock', 1, '100');
    const withRows = {
      ...view,
      bsSample: {
        ...view.bsSample!,
        rows: [{
          warehouse: '菲律宾-新创启辰自建仓',
          sku: 'SKU1',
          onHand: '10',
          orderLocked: '1',
          warehouseAvailable: '9',
          activityReserved: '0',
          inTransit: '0',
        }],
      },
    } as CatalogDetailView;
    writeDetailCache(withRows, '菲律宾-新创启辰自建仓', contextA);
    const scope = detailScopeFromView(withRows, '菲律宾-新创启辰自建仓', contextA);
    const staleExpected = {
      itemRevision: 1,
      listProjectionToken: scope.listProjectionToken,
      detailProjectionToken: `${scope.listProjectionToken}\0inv:stale-token`,
      displayBasisSha256: contextA.displayBasisSha256,
    };
    expect(readDetailCache({ itemId: 'id-lock', warehouse: '菲律宾-新创启辰自建仓' }, contextA, staleExpected)).toBeNull();
  });

  it('clears principal-bound cache entries', () => {
    clearDetailCache();
    writeDetailCache(mockView('id-5', 1, '1'), undefined, contextA);
    writeDetailCache(mockView('id-6', 1, '2'), undefined, contextB);
    invalidateDetailCacheForPrincipal('user-a');
    expect(readDetailCache({ itemId: 'id-5', warehouse: 'all' }, contextA)).toBeNull();
    expect(readDetailCache({ itemId: 'id-6', warehouse: 'all' }, contextB)).not.toBeNull();
  });
});
