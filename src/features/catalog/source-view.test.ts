import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const coreMock = vi.fn();
const auditMock = vi.fn();
const amountsMock = vi.fn();
const revisionMock = vi.fn();
const historyMock = vi.fn();

vi.mock('./service', () => ({
  getCatalogDetailCore: (...args: unknown[]) => coreMock(...args),
  getCatalogDetailAudit: (...args: unknown[]) => auditMock(...args),
  getCatalogAmounts: (...args: unknown[]) => amountsMock(...args),
  getCatalogDetailRevision: (...args: unknown[]) => revisionMock(...args),
  getCatalogDetailHistoryDisplay: (...args: unknown[]) => historyMock(...args),
}));

const ITEM_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const item = {
  itemId: ITEM_ID,
  iceCode: 'WM0043',
  nameCn: '测试商品',
  revision: 1,
  fields: {},
  barcodeRefs: [],
  humanChoices: { bigseller: 0, jushuitan: 0 },
  newProductConfirmed: false,
};

function audit(overrides: Record<string, unknown> = {}) {
  return {
    candidates: { bigseller: [], jushuitan: [] },
    decisions: [],
    observations: [],
    differences: [],
    artifacts: [],
    ...overrides,
  };
}

describe('getCatalogSourceView business projection', () => {
  beforeEach(() => {
    vi.resetModules();
    coreMock.mockReset();
    auditMock.mockReset();
    amountsMock.mockReset();
    revisionMock.mockReset();
    historyMock.mockReset();
    coreMock.mockResolvedValue({ item, flags: {}, writeAccess: { canWrite: true }, historical: false });
    amountsMock.mockResolvedValue({ adopted: null, observations: [] });
    auditMock.mockResolvedValue(audit());
  });

  it('labels outside-rules records as not adopted and keeps their real warehouse', async () => {
    auditMock.mockResolvedValue(audit({
      candidates: {
        bigseller: [{ observationId: 'o1', sku: 'CHIC-WM0043-P01', name: '测试商品', reviewState: 'outside_rules' }],
        jushuitan: [],
      },
      observations: [{
        observationId: 'o1',
        reviewState: 'outside_rules',
        selectedItemId: null,
        fields: { warehouse: { state: 'observed', raw: 'PH-彩妆日均万单简简单单仓' } },
        scope: { warehouse: { state: 'known', raw: 'PH-彩妆日均万单简简单单仓' } },
      }],
    }));
    const { getCatalogSourceView } = await import('./source-view');
    const view = await getCatalogSourceView(ITEM_ID, 0);
    const system = view.systems.find((entry) => entry.key === 'bigseller')!;
    const record = system.records[0];
    expect(record.confirmation).toBe('outside');
    expect(record.confirmationLabel).toBe('本批未采用');
    expect(record.adoptedInBatch).toBe(false);
    expect(record.sourceWarehouse).toBe('PH-彩妆日均万单简简单单仓');
    expect(system.inventoryNote).toContain('以库存明细中已确认的 BS 样表行为准');
    expect(system.inventoryNote).not.toContain('计入本批已确认库存');
  });

  it('separates adopted correspondence from inventory counting for BS and JST', async () => {
    auditMock.mockResolvedValue(audit({
      candidates: {
        bigseller: [{ observationId: 'b1', sku: 'BS-WM0043', name: '测试商品', reviewState: 'confirmed', conflicts: ['UNMATCHED'] }],
        jushuitan: [{ observationId: 'j1', sku: 'JST-WM0043', name: '测试商品', reviewState: 'confirmed' }],
      },
      observations: [
        { observationId: 'b1', reviewState: 'confirmed', selectedItemId: ITEM_ID, fields: { warehouse: { state: 'observed', raw: 'DEE-龙仔厝' } }, scope: {} },
        { observationId: 'j1', reviewState: 'confirmed', selectedItemId: ITEM_ID, fields: {}, scope: {} },
      ],
    }));
    const { getCatalogSourceView } = await import('./source-view');
    const view = await getCatalogSourceView(ITEM_ID, 0);
    const bs = view.systems.find((system) => system.key === 'bigseller')!;
    const jst = view.systems.find((system) => system.key === 'jushuitan')!;
    expect(bs.records[0].adoptedInBatch).toBe(true);
    expect(bs.records[0].confirmationLabel).toBe('本批已采用对应');
    expect(bs.records[0].sourcePriceRows).toEqual([]);
    /* 后台仍保留早期筛查提示，界面只在未采用记录上展示；这里确认投影没有删除它。 */
    expect(bs.records[0].reviewNotes).toContain('来源尚未建立对应');
    expect(bs.inventoryNote).toContain('以库存明细中已确认的 BS 样表行为准');
    expect(bs.inventoryNote).not.toContain('计入本批已确认库存');
    expect(jst.records[0].adoptedInBatch).toBe(true);
    expect(jst.records[0].confirmationLabel).toBe('本批已采用对应');
    expect(jst.inventoryNote).toContain('国内库存尚未接入');
    expect(jst.inventoryNote).not.toContain('计入本批已确认库存');
  });

  it('keeps empty source distinct from read failure', async () => {
    const { getCatalogSourceView } = await import('./source-view');
    const view = await getCatalogSourceView(ITEM_ID, 0);
    expect(view.sourceRecorded).toBe(false);
    expect(view.systems.flatMap((system) => system.records)).toHaveLength(0);
    expect(view.sourceNote).toContain('不等于商品不存在');
    expect(view.price.state).toBe('available');
  });

  it('distinguishes price read failure from no permission while keeping source records', async () => {
    const sourceAudit = audit({
      candidates: {
        bigseller: [{ observationId: 'o1', sku: 'BS-WM0043', name: '测试商品', reviewState: 'confirmed' }],
        jushuitan: [],
      },
      observations: [{
        observationId: 'o1',
        reviewState: 'confirmed',
        selectedItemId: ITEM_ID,
        fields: { warehouse: { state: 'observed', raw: 'DEE-龙仔厝' } },
        scope: {},
      }],
    });
    auditMock.mockResolvedValue(sourceAudit);
    amountsMock.mockRejectedValueOnce(new Error('无权读取金额'));
    const { getCatalogSourceView } = await import('./source-view');
    const permission = await getCatalogSourceView(ITEM_ID, 0);
    expect(permission.price.state).toBe('no_permission');
    expect(permission.price.adoptedCost).toBeNull();
    expect(permission.systems.find((system) => system.key === 'bigseller')!.records).toHaveLength(1);

    vi.resetModules();
    coreMock.mockResolvedValue({ item, flags: {}, writeAccess: { canWrite: true }, historical: false });
    auditMock.mockResolvedValue(sourceAudit);
    amountsMock.mockRejectedValueOnce(new Error('socket hang up'));
    const retry = await import('./source-view');
    const failed = await retry.getCatalogSourceView(ITEM_ID, 0);
    expect(failed.price.state).toBe('read_failed');
    expect(failed.price.note).toContain('价格读取失败');
    expect(failed.systems.find((system) => system.key === 'bigseller')!.records).toHaveLength(1);
  });

  it('historical source only returns saved facts and requires an explicit current reference', async () => {
    revisionMock.mockResolvedValue({ item: { ...item, revision: 1 }, flags: {}, writeAccess: { canWrite: false }, historical: true, bsSample: null, bsSampleError: null });
    historyMock.mockResolvedValue([{
      revision: 1,
      display: { reasonLabel: '人工修订', recordedAtDisplay: '2026-10-24 12:00', actorLabel: '管理员', changedFields: [] },
    }]);
    const { getCatalogSourceView } = await import('./source-view');
    const view = await getCatalogSourceView(ITEM_ID, 1);
    expect(view.historical).toBe(true);
    expect(view.sourceRecorded).toBe(false);
    expect(view.systems).toHaveLength(0);
    expect(view.price.state).toBe('historical');
    expect(view.currentReferenceAvailable).toBe(true);
  });
});
