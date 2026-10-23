import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const listMock = vi.fn();
const bsNotCreatedMock = vi.fn();
const sourceSearchTokensMock = vi.fn();
const bsSampleMetaMock = vi.fn();
const allBsSampleRowsMock = vi.fn();
const baselineAmountsMapMock = vi.fn();
const requireAdminMock = vi.fn();

vi.mock('./authorization', () => ({
  requireCatalogAdmin: (...args: unknown[]) => requireAdminMock(...args),
}));

vi.mock('./repository', () => ({
  catalogRepository: {
    list: (...args: unknown[]) => listMock(...args),
    bsNotCreatedItemIds: (...args: unknown[]) => bsNotCreatedMock(...args),
    sourceSearchTokensByItem: (...args: unknown[]) => sourceSearchTokensMock(...args),
    bsSampleMeta: (...args: unknown[]) => bsSampleMetaMock(...args),
    allBsSampleRows: (...args: unknown[]) => allBsSampleRowsMock(...args),
    baselineAmountsMap: (...args: unknown[]) => baselineAmountsMapMock(...args),
  },
}));

function masterItem(index: number) {
  return {
    itemId: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, '0')}`,
    iceCode: `W${index}`,
    nameCn: 'Test',
    fields: {},
    barcodeRefs: [],
    humanChoices: { bigseller: 0, jushuitan: 0 },
    newProductConfirmed: false,
    specification: { state: 'not_read', raw: null, reason: '', evidenceRef: '' },
  };
}

describe('getCatalogListPage', () => {
  beforeEach(() => {
    vi.resetModules();
    listMock.mockReset();
    bsNotCreatedMock.mockReset();
    sourceSearchTokensMock.mockReset();
    bsSampleMetaMock.mockReset();
    allBsSampleRowsMock.mockReset();
    baselineAmountsMapMock.mockReset();
    requireAdminMock.mockReset();
    requireAdminMock.mockImplementation(async (scope?: string) => {
      if (scope === 'amount:read') return {};
      return { userId: 'admin' };
    });
  });

  it('keeps main item count when BS projection is not imported', async () => {
    listMock.mockResolvedValue([
      { itemId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', iceCode: 'WM0001', nameCn: 'A', fields: {}, barcodeRefs: [], humanChoices: { bigseller: 0, jushuitan: 0 }, newProductConfirmed: false, specification: { state: 'not_read', raw: null, reason: '', evidenceRef: '' } },
    ]);
    bsSampleMetaMock.mockResolvedValue(null);
    bsNotCreatedMock.mockResolvedValue(new Set());
    sourceSearchTokensMock.mockResolvedValue(new Map());
    baselineAmountsMapMock.mockResolvedValue(new Map());
    const { getCatalogListPage } = await import('./service');
    const page = await getCatalogListPage();
    expect(page.itemsLoadFailed).toBe(false);
    expect(page.itemCount).toBe(1);
    expect(page.displayStatus).toBe('not_imported');
    expect(page.payload?.rows).toHaveLength(1);
  });

  it('keeps main items when auxiliary source token query fails', async () => {
    listMock.mockResolvedValue([
      { itemId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', iceCode: 'WM0001', nameCn: 'A', fields: {}, barcodeRefs: [], humanChoices: { bigseller: 0, jushuitan: 0 }, newProductConfirmed: false, specification: { state: 'not_read', raw: null, reason: '', evidenceRef: '' } },
    ]);
    bsNotCreatedMock.mockResolvedValue(new Set());
    sourceSearchTokensMock.mockRejectedValue(new Error('aux fail'));
    bsSampleMetaMock.mockResolvedValue(null);
    baselineAmountsMapMock.mockResolvedValue(new Map());
    const { getCatalogListPage } = await import('./service');
    const page = await getCatalogListPage();
    expect(page.itemsLoadFailed).toBe(false);
    expect(page.payload?.rows).toHaveLength(1);
    expect(page.auxiliaryErrors?.length).toBeGreaterThan(0);
  });

  it('surfaces main catalog read failure without empty-library disguise', async () => {
    listMock.mockRejectedValue(Object.assign(new Error('denied'), { code: '42501' }));
    const { getCatalogListPage } = await import('./service');
    const page = await getCatalogListPage();
    expect(page.itemsLoadFailed).toBe(true);
    expect(page.itemCount).toBe(0);
    expect(page.payload).toBeNull();
  });

  it.each([
    ['metadata forbidden', () => bsSampleMetaMock.mockRejectedValue(Object.assign(new Error('denied'), { code: '42501' })), 'forbidden'],
    ['metadata read_failed', () => bsSampleMetaMock.mockRejectedValue(Object.assign(new Error('boom'), { code: 'XX000' })), 'read_failed'],
    ['inventory forbidden', () => {
      bsSampleMetaMock.mockResolvedValue({ exportLabel: 'BS' });
      allBsSampleRowsMock.mockRejectedValue(Object.assign(new Error('denied'), { code: '42501' }));
    }, 'forbidden'],
    ['inventory read_failed', () => {
      bsSampleMetaMock.mockResolvedValue({ exportLabel: 'BS' });
      allBsSampleRowsMock.mockRejectedValue(Object.assign(new Error('boom'), { code: 'XX000' }));
    }, 'read_failed'],
  ] as const)('keeps 126 masters when BS %s', async (_label, setup, expectedStatus) => {
    listMock.mockResolvedValue(Array.from({ length: 126 }, (_, i) => masterItem(i)));
    bsNotCreatedMock.mockResolvedValue(new Set());
    sourceSearchTokensMock.mockResolvedValue(new Map());
    baselineAmountsMapMock.mockResolvedValue(new Map());
    setup();
    const { getCatalogListPage } = await import('./service');
    const page = await getCatalogListPage();
    expect(page.itemsLoadFailed).toBe(false);
    expect(page.itemCount).toBe(126);
    expect(page.payload?.rows).toHaveLength(126);
    expect(page.displayStatus).toBe(expectedStatus);
  });
});
