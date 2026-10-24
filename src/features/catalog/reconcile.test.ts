import { describe, expect, it } from 'vitest';
import {
  appliedRevisionFromReceipt,
  parseRequestOutcomeInput,
  resolveCatalogRequestOutcome,
  type CatalogRequestOutcomeDeps,
  type CatalogRequestOutcomeInput,
  type CatalogRequestReceipt,
} from './reconcile';

const ITEM_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_ITEM_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const REQUEST_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_REQUEST_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const ACTOR_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const OTHER_ACTOR_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const INTENT_A = 'a'.repeat(64);
const INTENT_B = 'b'.repeat(64);

const codeInput = (overrides: Partial<Extract<CatalogRequestOutcomeInput, { kind: 'initial_code' }>> = {}): CatalogRequestOutcomeInput => ({
  kind: 'initial_code',
  itemId: ITEM_ID,
  expectedRevision: 3,
  requestId: REQUEST_ID,
  code: 'WM0043',
  reason: '首次补码',
  ...overrides,
});

const revisionInput = (overrides: Partial<Extract<CatalogRequestOutcomeInput, { kind: 'nonprice_revision' }>> = {}): CatalogRequestOutcomeInput => ({
  kind: 'nonprice_revision',
  itemId: ITEM_ID,
  expectedRevision: 4,
  requestId: REQUEST_ID,
  reason: '核对工厂',
  fields: { factory: { state: 'observed', meaning: 'value', raw: '工厂 A', evidenceRef: 'manual:1' } },
  ...overrides,
});

function baselineServer(seed: {
  receipt?: { requestId: string; actorId: string; receipt: CatalogRequestReceipt } | null;
  intent?: string;
  originKind?: 'baseline' | 'new_item' | null;
}) {
  const calls = { baseline: 0, origin: 0, scoped: 0 };
  const deps: CatalogRequestOutcomeDeps = {
    actorId: ACTOR_ID,
    expectedBaselineIntent: seed.intent ?? INTENT_A,
    async readReceipt(requestId) {
      calls.baseline += 1;
      const entry = seed.receipt;
      if (!entry || entry.requestId !== requestId || entry.actorId !== ACTOR_ID) return null;
      return entry.receipt;
    },
    async readOriginKind() {
      calls.origin += 1;
      return seed.originKind === undefined ? 'baseline' : seed.originKind;
    },
    async readScopedReceipt() {
      calls.scoped += 1;
      return null;
    },
  };
  return { deps, calls };
}

function scopedServer(receipts: Record<string, { itemId: string; revision?: number } | null>, intent = INTENT_A) {
  const calls = { baseline: 0, origin: 0, scoped: 0 };
  const deps: CatalogRequestOutcomeDeps = {
    actorId: ACTOR_ID,
    expectedBaselineIntent: intent,
    async readReceipt() { calls.baseline += 1; return null; },
    async readOriginKind() { calls.origin += 1; return 'new_item'; },
    async readScopedReceipt(input) {
      calls.scoped += 1;
      const hit = receipts[input.requestId];
      return hit ? { itemId: hit.itemId, result: { itemId: hit.itemId, revision: hit.revision } } : null;
    },
  };
  return { deps, calls };
}

describe('parseRequestOutcomeInput（完整原意图）', () => {
  it('accepts full initial_code and nonprice_revision payloads', () => {
    expect(parseRequestOutcomeInput(codeInput())).toMatchObject({ kind: 'initial_code', code: 'WM0043' });
    expect(parseRequestOutcomeInput(revisionInput())).toMatchObject({
      kind: 'nonprice_revision',
      fields: { factory: { state: 'observed', meaning: 'value', raw: '工厂 A' } },
    });
  });

  it.each([
    ['not an object', 'x'],
    ['unknown kind', { ...codeInput(), kind: 'publish_baseline' }],
    ['bad item id', { ...codeInput(), itemId: 'item-1' }],
    ['bad request id', { ...codeInput(), requestId: 'req' }],
    ['zero revision', { ...codeInput(), expectedRevision: 0 }],
    ['missing code', { kind: 'initial_code', itemId: ITEM_ID, requestId: REQUEST_ID, expectedRevision: 1, reason: 'x' }],
    ['missing fields', { kind: 'nonprice_revision', itemId: ITEM_ID, requestId: REQUEST_ID, expectedRevision: 1, reason: 'x' }],
    ['empty fields', { ...revisionInput(), fields: {} }],
    ['extra unknown key', { ...codeInput(), intentSha256: 'client-supplied' }],
  ])('rejects %s', (_label, input) => {
    expect(() => parseRequestOutcomeInput(input)).toThrow('CATALOG_INVALID_INPUT');
  });
});

describe('appliedRevisionFromReceipt', () => {
  it('reads only a positive integer revision from the stored result', () => {
    expect(appliedRevisionFromReceipt({ result: { revision: 4 } })).toBe(4);
    expect(appliedRevisionFromReceipt({ result: {} })).toBeNull();
    expect(appliedRevisionFromReceipt({ result: { revision: '4' } })).toBeNull();
    expect(appliedRevisionFromReceipt({ result: null })).toBeNull();
  });
});

describe('resolveCatalogRequestOutcome（只读、只认真实回执）', () => {
  it('applied：基线回执的 request/action/item/revision/intent 全部一致', async () => {
    const server = baselineServer({
      receipt: { requestId: REQUEST_ID, actorId: ACTOR_ID, receipt: {
        action: 'append_nonprice_revision', itemId: ITEM_ID, intentSha256: INTENT_A,
        result: { itemId: ITEM_ID, revision: 5 },
      } },
    });
    expect(await resolveCatalogRequestOutcome(server.deps, revisionInput())).toEqual({
      status: 'applied', revision: 5, actionLabel: '非价格资料修订',
    });
  });

  it('scope_mismatch：同 requestId 但回执 intent 不同（另一字段/理由/意图）', async () => {
    const server = baselineServer({
      receipt: { requestId: REQUEST_ID, actorId: ACTOR_ID, receipt: {
        action: 'append_nonprice_revision', itemId: ITEM_ID, intentSha256: INTENT_B,
        result: { itemId: ITEM_ID, revision: 5 },
      } },
    });
    expect(await resolveCatalogRequestOutcome(server.deps, revisionInput())).toEqual({
      status: 'scope_mismatch', revision: null, actionLabel: null,
    });
  });

  it('scope_mismatch：回执缺少 intent 时不认领（旧数据不能替代原意图）', async () => {
    const server = baselineServer({
      receipt: { requestId: REQUEST_ID, actorId: ACTOR_ID, receipt: {
        action: 'append_nonprice_revision', itemId: ITEM_ID, intentSha256: null,
        result: { itemId: ITEM_ID, revision: 5 },
      } },
    });
    expect((await resolveCatalogRequestOutcome(server.deps, revisionInput())).status).toBe('scope_mismatch');
  });

  it('scope_mismatch：回执动作/商品/版本不一致', async () => {
    const wrongAction = baselineServer({
      receipt: { requestId: REQUEST_ID, actorId: ACTOR_ID, receipt: {
        action: 'assign_initial_code', itemId: ITEM_ID, intentSha256: INTENT_A,
        result: { revision: 5 },
      } },
    });
    expect((await resolveCatalogRequestOutcome(wrongAction.deps, revisionInput())).status).toBe('scope_mismatch');
    const wrongItem = baselineServer({
      receipt: { requestId: REQUEST_ID, actorId: ACTOR_ID, receipt: {
        action: 'append_nonprice_revision', itemId: OTHER_ITEM_ID, intentSha256: INTENT_A,
        result: { revision: 5 },
      } },
    });
    expect((await resolveCatalogRequestOutcome(wrongItem.deps, revisionInput())).status).toBe('scope_mismatch');
    const wrongRevision = baselineServer({
      receipt: { requestId: REQUEST_ID, actorId: ACTOR_ID, receipt: {
        action: 'append_nonprice_revision', itemId: ITEM_ID, intentSha256: INTENT_A,
        result: { revision: 9 },
      } },
    });
    expect((await resolveCatalogRequestOutcome(wrongRevision.deps, revisionInput())).status).toBe('scope_mismatch');
  });

  it('no_receipt：另一操作者的回执不可见；不查 scoped，也不推断“未提交”', async () => {
    const server = baselineServer({
      receipt: { requestId: REQUEST_ID, actorId: OTHER_ACTOR_ID, receipt: {
        action: 'assign_initial_code', itemId: ITEM_ID, intentSha256: INTENT_A,
        result: { revision: 4 },
      } },
    });
    expect(await resolveCatalogRequestOutcome(server.deps, codeInput())).toEqual({
      status: 'no_receipt', revision: null, actionLabel: null,
    });
    expect(server.calls.scoped).toBe(0);
  });

  it('no_receipt：商品不存在/无回执时不区分“未提交”', async () => {
    const server = baselineServer({ receipt: null, originKind: null });
    expect((await resolveCatalogRequestOutcome(server.deps, codeInput())).status).toBe('no_receipt');
  });

  it('scoped：真实 request 回执存在才 applied，且版本必须 = expectedRevision+1', async () => {
    const server = scopedServer({ [REQUEST_ID]: { itemId: ITEM_ID, revision: 4 } });
    expect(await resolveCatalogRequestOutcome(server.deps, codeInput())).toEqual({
      status: 'applied', revision: 4, actionLabel: '首次货号分配',
    });
    expect(server.calls.baseline).toBe(0);
  });

  it('scoped：只有“expectedRevision+1 版本事实”、没有任何 request 回执时不得 applied', async () => {
    const server = scopedServer({});
    expect((await resolveCatalogRequestOutcome(server.deps, revisionInput())).status).toBe('no_receipt');
  });

  it('scoped：两个不同 requestId 都没有回执时都只能是 no_receipt（不会互相冒领同一版本事实）', async () => {
    const server = scopedServer({});
    for (const requestId of [REQUEST_ID, OTHER_REQUEST_ID]) {
      const outcome = await resolveCatalogRequestOutcome(server.deps, codeInput({ requestId }));
      expect(outcome).toEqual({ status: 'no_receipt', revision: null, actionLabel: null });
    }
  });

  it('scoped：同 requestId 但回执版本/商品不一致时 scope_mismatch', async () => {
    const wrongRevision = scopedServer({ [REQUEST_ID]: { itemId: ITEM_ID, revision: 9 } });
    expect((await resolveCatalogRequestOutcome(wrongRevision.deps, codeInput())).status).toBe('scope_mismatch');
    const wrongItem = scopedServer({ [REQUEST_ID]: { itemId: OTHER_ITEM_ID, revision: 4 } });
    expect((await resolveCatalogRequestOutcome(wrongItem.deps, codeInput())).status).toBe('scope_mismatch');
  });

  it('接口没有任何写入/重发能力，核对不改变输入与调用结果', async () => {
    const server = baselineServer({
      receipt: { requestId: REQUEST_ID, actorId: ACTOR_ID, receipt: {
        action: 'assign_initial_code', itemId: ITEM_ID, intentSha256: INTENT_A,
        result: { revision: 4 },
      } },
    });
    const before = JSON.stringify(server.deps);
    const first = await resolveCatalogRequestOutcome(server.deps, codeInput());
    const second = await resolveCatalogRequestOutcome(server.deps, codeInput());
    expect(first).toEqual(second);
    expect(JSON.stringify(server.deps)).toBe(before);
    expect(Object.keys(server.deps).sort()).toEqual(['actorId', 'expectedBaselineIntent', 'readOriginKind', 'readReceipt', 'readScopedReceipt']);
  });
});
