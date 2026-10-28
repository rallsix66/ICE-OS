import { beforeEach, describe, expect, it, vi } from 'vitest';

const listMock = vi.fn();
const bsNotCreatedMock = vi.fn();
const sourceSearchTokensMock = vi.fn();
const baselineAmountsMapMock = vi.fn();
const inventoryCatalogSourcesMock = vi.fn();
const requireAdminMock = vi.fn();

vi.mock('./authorization', () => ({
  requireCatalogAdmin: (...args: unknown[]) => requireAdminMock(...args),
}));

vi.mock('./repository', () => ({
  catalogRepository: {
    list: (...args: unknown[]) => listMock(...args),
    bsNotCreatedItemIds: (...args: unknown[]) => bsNotCreatedMock(...args),
    sourceSearchTokensByItem: (...args: unknown[]) => sourceSearchTokensMock(...args),
    baselineAmountsMap: (...args: unknown[]) => baselineAmountsMapMock(...args),
    inventoryCatalogSources: (...args: unknown[]) => inventoryCatalogSourcesMock(...args),
  },
  intentHash: () => 'intent',
}));

const item = {
  itemId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  iceCode: 'WM0026',
  nameCn: 'ICE LERSKIN双色泥膜',
  fields: {},
  barcodeRefs: [],
  humanChoices: { bigseller: 0, jushuitan: 0 },
  newProductConfirmed: false,
  specification: { state: 'not_read', raw: null, reason: '', evidenceRef: '' },
};

function rawSource() {
  return {
    scope: { id: 'scope', version: 1, warehouseCount: 1, empty: false, lastAllSuccessAt: '2026-10-26T13:11:31.916Z' },
    warehouses: [{ warehouseId: 'wh', externalId: '56519', name: '菲律宾-新创启辰自建仓', market: 'PH', status: 'confirmed' }],
    readStates: [{ warehouseId: 'wh', lastSuccessAt: '2026-10-26T13:11:31.916Z', lastPublishAt: null, lastObservationAt: '2026-10-26T13:11:31.916Z', latestRunStatus: 'success', failed: false, stale: false, lastErrorCode: null }],
    effectiveRows: [
      { itemId: item.itemId, warehouseId: 'wh', warehouseExternalId: '56519', warehouseName: '菲律宾-新创启辰自建仓', market: 'PH', externalSku: 'ICEWM0026', unit: '个', onHand: 4, orderLocked: 0, warehouseAvailable: 4, activityReserved: 0, inTransit: 0, gtin: null, observedAt: '2026-10-26T13:11:31.916Z', batchId: 'b', excelRow: 446, itemRevision: 1, mappingId: 'm', verification: false, unitConfirmed: true },
    ],
    mappings: [{ itemId: item.itemId, warehouseId: 'wh', externalSku: 'ICEWM0026', unit: '个', version: 1, verification: false, unitConfirmed: true }],
    candidates: [],
    latestRun: { runId: 'run', exportFinishedAt: '2026-10-26T13:11:31.916Z' },
    sourceRows: [{ warehouseExternalId: '56519', externalSku: 'ICEWM0026', excelRow: 446, productName: 'x', onHand: 4 }],
  };
}

describe('getCatalogListPage (unified inventory source)', () => {
  beforeEach(() => {
    vi.resetModules();
    listMock.mockReset().mockResolvedValue([item]);
    bsNotCreatedMock.mockReset().mockResolvedValue(new Set());
    sourceSearchTokensMock.mockReset().mockResolvedValue(new Map());
    baselineAmountsMapMock.mockReset().mockResolvedValue(new Map());
    inventoryCatalogSourcesMock.mockReset();
    requireAdminMock.mockReset().mockImplementation(async (scope?: string) => (scope === 'amount:read' ? {} : { userId: 'admin' }));
  });

  it('reads the inventory module and keeps the main item list', async () => {
    inventoryCatalogSourcesMock.mockResolvedValue(rawSource());
    const { getCatalogListPage } = await import('./service');
    const page = await getCatalogListPage();
    expect(page.itemsLoadFailed).toBe(false);
    expect(page.itemCount).toBe(1);
    expect(page.displayStatus).toBe('loaded');
    expect(page.payload?.warehouseOptions).toEqual(['菲律宾-新创启辰自建仓']);
    expect(page.payload?.rows[0].inventory.knownSubtotal).toBe('4');
  });

  it('shows not_imported without falling back to the old BS sample when the inventory read model is missing', async () => {
    inventoryCatalogSourcesMock.mockRejectedValue(Object.assign(new Error('missing'), { code: '42883' }));
    const { getCatalogListPage } = await import('./service');
    const page = await getCatalogListPage();
    expect(page.displayStatus).toBe('not_imported');
    expect(page.payload?.rows).toHaveLength(1);
    expect(page.payload?.rows[0].inventory.hasCurrentData).toBe(false);
  });

  it('classifies forbidden without inventing 0 inventory', async () => {
    inventoryCatalogSourcesMock.mockRejectedValue(Object.assign(new Error('denied'), { code: '42501' }));
    const { getCatalogListPage } = await import('./service');
    const page = await getCatalogListPage();
    expect(page.displayStatus).toBe('forbidden');
    expect(page.payload?.rows[0].inventory.hasCurrentData).toBe(false);
  });

  it('classifies an unexpected read failure as read_failed', async () => {
    inventoryCatalogSourcesMock.mockRejectedValue(Object.assign(new Error('boom'), { code: 'XX000' }));
    const { getCatalogListPage } = await import('./service');
    const page = await getCatalogListPage();
    expect(page.displayStatus).toBe('read_failed');
    expect(page.payload?.rows[0].inventory.hasCurrentData).toBe(false);
  });

  it('keeps main items when auxiliary source-token read fails', async () => {
    sourceSearchTokensMock.mockRejectedValue(new Error('aux fail'));
    inventoryCatalogSourcesMock.mockResolvedValue(rawSource());
    const { getCatalogListPage } = await import('./service');
    const page = await getCatalogListPage();
    expect(page.itemsLoadFailed).toBe(false);
    expect(page.payload?.rows).toHaveLength(1);
    expect(page.auxiliaryErrors?.length).toBeGreaterThan(0);
  });
});
