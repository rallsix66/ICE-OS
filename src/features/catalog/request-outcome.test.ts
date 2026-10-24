import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 服务端接线断言（V4-04）：
 * 用只暴露只读方法的 catalogRepository / newItemRepository 替身加载真实 service 层，
 * 任何写/重发路径都会因缺方法而抛错；证明核对只读、只认真实回执、不靠版本事实推断。
 */
const ITEM_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REQUEST_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ACTOR_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SCOPE_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const INTENT = 'a'.repeat(64);

const readRequest = vi.fn();
const readOriginKind = vi.fn();
const readHistory = vi.fn();
const readCurrentRevision = vi.fn();
const readProfileDisplayNames = vi.fn();
const readHistoryRevision = vi.fn();
const readScopedReceipt = vi.fn();
const writeContext = vi.fn();
const newItemIntent = vi.fn();
const authorize = vi.fn();

vi.mock('./repository', () => ({
  intentHash: () => INTENT,
  catalogRepository: {
    request: (...args: unknown[]) => readRequest(...args),
    originKind: (...args: unknown[]) => readOriginKind(...args),
    history: (...args: unknown[]) => readHistory(...args),
    currentRevision: (...args: unknown[]) => readCurrentRevision(...args),
    profileDisplayNames: (...args: unknown[]) => readProfileDisplayNames(...args),
    historyRevision: (...args: unknown[]) => readHistoryRevision(...args),
  },
}));
vi.mock('./new-item/service', () => ({
  getNewItemWriteContext: (...args: unknown[]) => writeContext(...args),
  assignNewItemCode: vi.fn(),
  appendNewItemRevision: vi.fn(),
  recoverNewItemRequest: vi.fn(),
}));
vi.mock('./new-item/repository', () => ({
  newItemIntent: (...args: unknown[]) => newItemIntent(...args),
  newItemRepository: { receipt: (...args: unknown[]) => readScopedReceipt(...args) },
}));
vi.mock('./authorization', () => ({ requireCatalogAdmin: (...args: unknown[]) => authorize(...args) }));

const { checkCatalogRequestOutcome, getCatalogDetailHistoryDisplay, getCatalogRevisionEvidence } = await import('./service');

const revisionRow = (overrides: Record<string, unknown>) => ({
  itemId: ITEM_ID,
  revision: 1,
  iceCode: 'WM0043',
  codeState: 'coded',
  newProductConfirmed: false,
  nameCn: '滋越润肤乳',
  specification: { state: 'not_read', raw: null, reason: '尚未承接该字段', evidenceRef: 'e' },
  barcodeRefs: [],
  fields: {},
  humanChoices: { bigseller: 0, jushuitan: 0 },
  sourceRecordId: null,
  sourceIdentityVerified: false,
  relationshipUsable: false,
  provenanceRefs: [],
  revisionAudit: { reason: 'accepted frozen baseline', actorId: ACTOR_ID, recordedAt: '2026-10-23T02:05:00.000Z', evidenceRef: 'match-bundle.json#0' },
  ...overrides,
});

const codeInput = { kind: 'initial_code' as const, itemId: ITEM_ID, requestId: REQUEST_ID, expectedRevision: 1, code: 'WM0043', reason: '首次补码' };
const revisionInput = {
  kind: 'nonprice_revision' as const, itemId: ITEM_ID, requestId: REQUEST_ID, expectedRevision: 2, reason: '核对工厂',
  fields: { factory: { state: 'observed' as const, meaning: 'value' as const, raw: '工厂 A', evidenceRef: 'manual:1' } },
};

beforeEach(() => {
  readRequest.mockReset();
  readOriginKind.mockReset();
  readHistory.mockReset();
  readCurrentRevision.mockReset();
  readProfileDisplayNames.mockReset();
  readHistoryRevision.mockReset();
  readScopedReceipt.mockReset();
  writeContext.mockReset();
  newItemIntent.mockReset();
  authorize.mockReset();
  authorize.mockResolvedValue({ profileUserId: ACTOR_ID });
  newItemIntent.mockReturnValue('scoped-intent');
});

describe('checkCatalogRequestOutcome（服务层接线）', () => {
  it('applied：基线只查一次真实回执（含 intent），不查版本事实、不调用任何写方法', async () => {
    readOriginKind.mockResolvedValue('baseline');
    readRequest.mockResolvedValue({ action: 'assign_initial_code', itemId: ITEM_ID, intentSha256: INTENT, result: { itemId: ITEM_ID, revision: 2 } });
    const outcome = await checkCatalogRequestOutcome(codeInput);
    expect(outcome).toEqual({ status: 'applied', revision: 2, actionLabel: '首次货号分配' });
    expect(readRequest).toHaveBeenCalledTimes(1);
    expect(readRequest).toHaveBeenCalledWith({ profileUserId: ACTOR_ID }, REQUEST_ID);
    expect(readHistory).not.toHaveBeenCalled();
  });

  it('基线回执 intent 不相同 → scope_mismatch，不认领', async () => {
    readOriginKind.mockResolvedValue('baseline');
    readRequest.mockResolvedValue({ action: 'assign_initial_code', itemId: ITEM_ID, intentSha256: 'b'.repeat(64), result: { revision: 2 } });
    await expect(checkCatalogRequestOutcome(codeInput)).resolves.toEqual({ status: 'scope_mismatch', revision: null, actionLabel: null });
  });

  it('重复核对只重复读回执，没有写调用（替身不提供任何写方法）', async () => {
    readOriginKind.mockResolvedValue('baseline');
    readRequest.mockResolvedValue(null);
    await expect(checkCatalogRequestOutcome(revisionInput)).resolves.toEqual({ status: 'no_receipt', revision: null, actionLabel: null });
    await expect(checkCatalogRequestOutcome(revisionInput)).resolves.toEqual({ status: 'no_receipt', revision: null, actionLabel: null });
    expect(readRequest).toHaveBeenCalledTimes(2);
    expect(readHistory).not.toHaveBeenCalled();
  });

  it('no_receipt 不使用 not_authorized 或“未提交”口径，也不重发', async () => {
    readOriginKind.mockResolvedValue(null);
    readRequest.mockResolvedValue(null);
    const outcome = await checkCatalogRequestOutcome(codeInput);
    expect(outcome.status).toBe('no_receipt');
    expect(outcome.actionLabel).toBeNull();
  });

  it('无核对权限 → not_authorized（撤权不等于原事务失败），且不发起任何读', async () => {
    authorize.mockRejectedValue(new Error('无权限：需要管理员角色'));
    const outcome = await checkCatalogRequestOutcome(codeInput);
    expect(outcome).toEqual({ status: 'not_authorized', revision: null, actionLabel: null });
    expect(readRequest).not.toHaveBeenCalled();
  });

  it('模块未启用仍抛错（环境状态不是权限状态），交给调用方分类展示', async () => {
    authorize.mockRejectedValue(new Error('CATALOG_UNAVAILABLE'));
    await expect(checkCatalogRequestOutcome(codeInput)).rejects.toThrow('CATALOG_UNAVAILABLE');
    expect(readRequest).not.toHaveBeenCalled();
  });

  it('非法入参在查库前被拒绝', async () => {
    await expect(checkCatalogRequestOutcome({ ...codeInput, kind: 'publish_baseline' })).rejects.toThrow('CATALOG_INVALID_INPUT');
    await expect(checkCatalogRequestOutcome({ ...codeInput, itemId: 'x' })).rejects.toThrow('CATALOG_INVALID_INPUT');
    await expect(checkCatalogRequestOutcome({ ...codeInput, intentSha256: 'client' })).rejects.toThrow('CATALOG_INVALID_INPUT');
    expect(readRequest).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
  });

  it('scoped 新品：只认 catalog.new_item_request 的真实回执，不读版本事实', async () => {
    readOriginKind.mockResolvedValue('new_item');
    writeContext.mockResolvedValue({ scopeId: SCOPE_ID });
    readScopedReceipt.mockResolvedValue({ itemId: ITEM_ID, revision: 2 });
    const outcome = await checkCatalogRequestOutcome(codeInput);
    expect(outcome).toEqual({ status: 'applied', revision: 2, actionLabel: '首次货号分配' });
    expect(readScopedReceipt).toHaveBeenCalledWith(
      { profileUserId: ACTOR_ID }, REQUEST_ID, SCOPE_ID, 'assign_initial_code', 'scoped-intent',
    );
    expect(readHistory).not.toHaveBeenCalled();
    expect(readRequest).not.toHaveBeenCalled();
  });

  it('scoped 新品：无回执时保持 no_receipt（仅有 expectedRevision+1 版本事实不算成功）', async () => {
    readOriginKind.mockResolvedValue('new_item');
    writeContext.mockResolvedValue({ scopeId: SCOPE_ID });
    readScopedReceipt.mockResolvedValue(null);
    await expect(checkCatalogRequestOutcome(codeInput)).resolves.toEqual({ status: 'no_receipt', revision: null, actionLabel: null });
    expect(readHistory).not.toHaveBeenCalled();
  });

  it('scoped 新品：失去发布权/上下文不可得 → not_authorized，不猜成功或未提交', async () => {
    readOriginKind.mockResolvedValue('new_item');
    writeContext.mockResolvedValue(null);
    await expect(checkCatalogRequestOutcome(codeInput)).resolves.toEqual({ status: 'not_authorized', revision: null, actionLabel: null });
    expect(readScopedReceipt).not.toHaveBeenCalled();
  });
});

describe('getCatalogDetailHistoryDisplay（服务层接线）', () => {
  it('显示名读取失败 → actorLabel 为 null，历史事实仍返回（不回退当前资料）', async () => {
    readHistory.mockResolvedValue([
      revisionRow({ revision: 2, revisionAudit: { reason: '人工核对规格', actorId: ACTOR_ID, recordedAt: '2026-10-23T16:05:00.000Z', evidenceRef: 'manual-request:1' } }),
      revisionRow({ revision: 1 }),
    ]);
    readCurrentRevision.mockResolvedValue(2);
    readOriginKind.mockResolvedValue('baseline');
    readProfileDisplayNames.mockRejectedValue(new Error('permission denied'));
    const rows = await getCatalogDetailHistoryDisplay(ITEM_ID);
    expect(rows).toHaveLength(2);
    expect(rows[0].display).toMatchObject({ isCurrent: true, kind: 'revision', reasonLabel: '人工核对规格', actorLabel: null });
    expect(rows[1].display).toMatchObject({ isCurrent: false, kind: 'initial', reasonLabel: '初始资料承接（系统批量）', actorLabel: null, changedFields: [] });
  });

  it('显示名可核实时使用 profiles.display_name；空历史不查额外表', async () => {
    readHistory.mockResolvedValue([revisionRow({ revision: 1 })]);
    readCurrentRevision.mockResolvedValue(1);
    readOriginKind.mockResolvedValue('baseline');
    readProfileDisplayNames.mockResolvedValue(new Map([[ACTOR_ID, '张管理']]));
    const [only] = await getCatalogDetailHistoryDisplay(ITEM_ID);
    expect(only.display.actorLabel).toBe('张管理');
    expect(only.display.recordedAtDisplay).toBe('2026-10-23 10:05');

    readHistory.mockResolvedValue([]);
    await expect(getCatalogDetailHistoryDisplay(ITEM_ID)).resolves.toEqual([]);
  });

  it('非法商品标识直接拒绝，不查库', async () => {
    await expect(getCatalogDetailHistoryDisplay('not-an-id')).rejects.toThrow('CATALOG_INVALID_INPUT');
    expect(readHistory).not.toHaveBeenCalled();
  });
});

describe('getCatalogRevisionEvidence（服务层接线）', () => {
  it('按 item + revision 读取授权原始证据；版本不存在回 null', async () => {
    readHistoryRevision.mockResolvedValue(revisionRow({ revision: 2 }));
    const evidence = await getCatalogRevisionEvidence(ITEM_ID, 2);
    expect(evidence).toEqual({
      reason: 'accepted frozen baseline',
      actorId: ACTOR_ID,
      evidenceRef: 'match-bundle.json#0',
      recordedAt: '2026-10-23T02:05:00.000Z',
    });
    readHistoryRevision.mockResolvedValue(null);
    await expect(getCatalogRevisionEvidence(ITEM_ID, 9)).resolves.toBeNull();
  });

  it('非法版本号被拒绝', async () => {
    await expect(getCatalogRevisionEvidence(ITEM_ID, 0)).rejects.toThrow('CATALOG_INVALID_INPUT');
    expect(readHistoryRevision).not.toHaveBeenCalled();
  });
});
