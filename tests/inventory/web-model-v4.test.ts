import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildConfirmBatch,
  buildConfirmMappingsIntent,
  buildDisableMappingIntent,
  buildManualSyncIntent,
  buildRecheckMappingIntent,
  buildSettingsIntent,
  canonicalJson,
  intentForActionPayload,
  inventoryWriteLocked,
  legacyIntentTextForAction,
  pendingRecoveryKey,
  type ConfirmMappingInput,
  type MappingDraft,
} from '@/features/inventory/model';
import {
  clearLocalUnknownRequest,
  getLocalUnknownSnapshot,
  localRecoveryKey,
  localUnknownOwnerCheck,
  readLocalUnknownRequest,
  saveLocalUnknownRequest,
  subscribeLocalUnknown,
  type LocalUnknownRequest,
} from '@/features/inventory/client-pending';
import type { InventoryPendingActionDto } from '@/features/inventory/types';

/**
 * R2/R3 v4 页面纯逻辑补测（不连库、不启动浏览器）：
 * - 统一写锁 = 服务端 pending 或 本地保留原请求；
 * - 本地记录 v2 归属（actor/account）与旧 v1 记录只保留待核实；
 * - 恢复状态 key 随 requestId/intent/actor/account 改变（新请求不得继承旧 not_found）；
 * - R3 混合批量：首次行 + 重确认行同一批提交的逐行版本要求；
 * - intent v4 无歧义：旧 v3 指纹碰撞的反例在新编码下不再相等，且登记 payload 可重算出同一 intent。
 */

const ITEM_A = '10000000-0000-4000-8000-000000000001';
const ITEM_B = '10000000-0000-4000-8000-000000000002';
const STORAGE_KEY = 'inventory.localUnknownRequest.v1';

class FakeStorage {
  private map = new Map<string, string>();

  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }
}

const fakeStorage = new FakeStorage();

beforeAll(() => {
  // client-pending 只在调用时访问 window.sessionStorage；node 环境注入最小替身即可覆盖读写/清除逻辑。
  (globalThis as unknown as { window: unknown }).window = { sessionStorage: fakeStorage };
});

afterAll(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

beforeEach(() => {
  fakeStorage.clear();
  clearLocalUnknownRequest();
});

function draft(overrides: Partial<MappingDraft> & Pick<MappingDraft, 'rowKey' | 'externalSku' | 'warehouseExternalIds'>): MappingDraft {
  return {
    itemId: ITEM_A,
    itemLabel: '',
    unit: '件',
    reason: '验证数据，业务包装单位待确认',
    expectedVersion: null,
    note: '',
    verification: true,
    ...overrides,
  };
}

function settingsPayload() {
  return { enabled: true, intervalMinutes: 30, scopeProvided: true, warehouseIds: ['w2', 'w1'] };
}

describe('R2 v4 统一写锁', () => {
  it('服务端 pending 或本地原请求任一存在即锁新写', () => {
    expect(inventoryWriteLocked(null, false)).toBe(false);
    expect(inventoryWriteLocked(undefined, false)).toBe(false);
    expect(inventoryWriteLocked({ requestId: 'r', action: 'x', createdAt: null, payload: {} }, false)).toBe(true);
    expect(inventoryWriteLocked(null, true)).toBe(true);
    expect(inventoryWriteLocked({ requestId: 'r', action: 'x', createdAt: null, payload: {} }, true)).toBe(true);
  });

  it('他人 pending（foreign）与本人 pending 一样锁新写', () => {
    const foreign: InventoryPendingActionDto = {
      requestId: null,
      action: 'update_inventory_sync_settings',
      createdAt: '2026-10-26T00:00:00.000Z',
      payload: {},
      foreign: true,
    };
    expect(inventoryWriteLocked(foreign, false)).toBe(true);
  });
});

describe('R2 v4 本地恢复记录 v2 归属', () => {
  const viewer = { actorId: '11111111-1111-4111-8111-111111111101', accountId: 'acct-1' };

  it('本地记录保存服务端身份/登记状态，读取为可信 v2', () => {
    saveLocalUnknownRequest({
      requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      action: 'update_inventory_sync_settings',
      intent: 'a'.repeat(64),
      payload: settingsPayload(),
      actorId: viewer.actorId,
      accountId: viewer.accountId,
      registration: 'registered',
    });
    const local = readLocalUnknownRequest();
    expect(local).not.toBeNull();
    expect(local?.schemaVersion).toBe(2);
    expect(local?.trusted).toBe(true);
    expect(local?.intentVersion).toBe('v4');
    expect(local?.actorId).toBe(viewer.actorId);
    expect(local?.accountId).toBe(viewer.accountId);
    expect(local?.registration).toBe('registered');
    expect(getLocalUnknownSnapshot()?.requestId).toBe(local?.requestId);
  });

  it('登记未知（registration:unknown）同样是 v2 可信记录，但页面文案应区别“未确认是否到达”', () => {
    saveLocalUnknownRequest({
      requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      action: 'request_inventory_manual_sync',
      intent: 'b'.repeat(64),
      payload: {},
      actorId: viewer.actorId,
      accountId: viewer.accountId,
      registration: 'unknown',
    });
    const local = readLocalUnknownRequest();
    expect(local?.registration).toBe('unknown');
    expect(local?.trusted).toBe(true);
  });

  it('旧 v1 记录：保留、trusted=false、intentVersion=v3，不自动归给当前管理员', () => {
    fakeStorage.setItem(STORAGE_KEY, JSON.stringify({
      requestId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      action: 'update_inventory_sync_settings',
      intent: 'c'.repeat(64),
      payload: settingsPayload(),
      createdAt: '2026-10-25T00:00:00.000Z',
    }));
    const local = readLocalUnknownRequest();
    expect(local).not.toBeNull();
    expect(local?.schemaVersion).toBe(2);
    expect(local?.trusted).toBe(false);
    expect(local?.intentVersion).toBe('v3');
    expect(local?.actorId).toBe('');
    const check = localUnknownOwnerCheck(local, viewer);
    expect(check.trusted).toBe(false);
    expect(check.reason).toContain('旧格式');
    // 旧记录仍计入写锁，并且只能按 requestId 精确清除。
    expect(inventoryWriteLocked(null, Boolean(local))).toBe(true);
    clearLocalUnknownRequest('dddddddd-dddd-4ddd-8ddd-dddddddddddd');
    expect(readLocalUnknownRequest()).not.toBeNull();
    clearLocalUnknownRequest(local!.requestId);
    expect(readLocalUnknownRequest()).toBeNull();
  });

  it('同 actor/account 可信；换管理员（actor 不同）只待核实；账号不同也拒绝', () => {
    const local: LocalUnknownRequest = {
      schemaVersion: 2,
      requestId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      action: 'confirm_inventory_mapping',
      intent: 'd'.repeat(64),
      intentVersion: 'v4',
      payload: { mappings: [] },
      createdAt: '2026-10-26T00:00:00.000Z',
      actorId: '11111111-1111-4111-8111-111111111101',
      accountId: 'acct-1',
      registration: 'unknown',
      trusted: true,
    };
    expect(localUnknownOwnerCheck(local, viewer)).toEqual({ trusted: true, reason: null });
    const otherAdmin = { actorId: '11111111-1111-4111-8111-111111111104', accountId: 'acct-1' };
    const foreign = localUnknownOwnerCheck(local, otherAdmin);
    expect(foreign.trusted).toBe(false);
    expect(foreign.reason).toContain('另一位管理员');
    const otherAccount = { actorId: viewer.actorId, accountId: 'acct-2' };
    const accountMismatch = localUnknownOwnerCheck(local, otherAccount);
    expect(accountMismatch.trusted).toBe(false);
    expect(accountMismatch.reason).toContain('另一个来源账号');
    expect(localUnknownOwnerCheck(local, null).trusted).toBe(false);
    // 没有本地记录时不算“他人请求”。
    expect(localUnknownOwnerCheck(null, null)).toEqual({ trusted: true, reason: null });
  });

  it('本地订阅在新记录/清除时通知 useSyncExternalStore', () => {
    let calls = 0;
    const unsubscribe = subscribeLocalUnknown(() => { calls += 1; });
    saveLocalUnknownRequest({
      requestId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      action: 'request_inventory_manual_sync',
      intent: 'e'.repeat(64),
      payload: {},
      actorId: viewer.actorId,
      accountId: viewer.accountId,
      registration: 'unknown',
    });
    clearLocalUnknownRequest('ffffffff-ffff-4fff-8fff-ffffffffffff');
    unsubscribe();
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('恢复状态 key 随 requestId/intent/actor/account 改变（新请求重置旧核对结果）', () => {
    const base: LocalUnknownRequest = {
      schemaVersion: 2,
      requestId: 'r1',
      action: 'update_inventory_sync_settings',
      intent: 'a'.repeat(64),
      intentVersion: 'v4',
      payload: {},
      createdAt: '2026-10-26T00:00:00.000Z',
      actorId: 'actor-1',
      accountId: 'acct-1',
      registration: 'unknown',
      trusted: true,
    };
    const keys = new Set([
      localRecoveryKey(base),
      localRecoveryKey({ ...base, requestId: 'r2' }),
      localRecoveryKey({ ...base, intent: 'b'.repeat(64) }),
      localRecoveryKey({ ...base, actorId: 'actor-2' }),
      localRecoveryKey({ ...base, accountId: 'acct-2' }),
      localRecoveryKey(null),
    ]);
    expect(keys.size).toBe(6);
    const pendingA: InventoryPendingActionDto = {
      requestId: 'r1', action: 'update_inventory_sync_settings', createdAt: null, payload: {},
      intent: 'a'.repeat(64), actorId: 'actor-1', accountId: 'acct-1',
    };
    const pendingKeys = new Set([
      pendingRecoveryKey(pendingA),
      pendingRecoveryKey({ ...pendingA, requestId: 'r2' }),
      pendingRecoveryKey({ ...pendingA, intent: 'b'.repeat(64) }),
      pendingRecoveryKey({ ...pendingA, actorId: 'actor-2' }),
      pendingRecoveryKey({ ...pendingA, accountId: 'acct-2' }),
      pendingRecoveryKey(null),
    ]);
    expect(pendingKeys.size).toBe(6);
  });
});

describe('R3 v4 混合批量（首次行 + 重确认行）', () => {
  const firstKey = 'W-A::SKU-A';
  const reconfirmKey = 'W-B::SKU-B';
  const first = draft({ rowKey: firstKey, externalSku: 'SKU-A', warehouseExternalIds: ['W-A'], itemId: ITEM_A });
  const reconfirm = draft({
    rowKey: reconfirmKey,
    externalSku: 'SKU-B',
    warehouseExternalIds: ['W-B'],
    itemId: ITEM_B,
    expectedVersion: 3,
  });

  it('旧整批 requireVersion 会把首次行误判（修复前反例）', () => {
    const legacyPlan = buildConfirmBatch({
      selectedRowKeys: [firstKey, reconfirmKey],
      drafts: [first, reconfirm],
      requireVersion: true,
    });
    expect(legacyPlan.ok).toBe(false);
    expect(legacyPlan.errors.join('；')).toContain('重新确认/换绑必须带页面看到的旧版本');
  });

  it('按行版本：首次行 null + 重确认行旧版本可同批提交', () => {
    const plan = buildConfirmBatch({
      selectedRowKeys: [firstKey, reconfirmKey],
      drafts: [first, reconfirm],
      reconfirmRowKeys: [reconfirmKey],
    });
    expect(plan.ok).toBe(true);
    expect(plan.errors).toEqual([]);
    expect(plan.entries).toHaveLength(2);
    const firstEntry = plan.entries.find((entry) => entry.externalSku === 'SKU-A');
    const reconfirmEntry = plan.entries.find((entry) => entry.externalSku === 'SKU-B');
    expect(firstEntry?.expectedVersion).toBeNull();
    expect(reconfirmEntry?.expectedVersion).toBe(3);
  });

  it('重确认行缺旧版本仍拒绝（服务端旧版本拒绝的前端前置校验不变）', () => {
    const plan = buildConfirmBatch({
      selectedRowKeys: [firstKey, reconfirmKey],
      drafts: [first, { ...reconfirm, expectedVersion: null }],
      reconfirmRowKeys: [reconfirmKey],
    });
    expect(plan.ok).toBe(false);
    expect(plan.errors.join('；')).toContain('重新确认/换绑必须带页面看到的旧版本');
  });

  it('首次行单独仍允许 expectedVersion=null', () => {
    const plan = buildConfirmBatch({
      selectedRowKeys: [firstKey],
      drafts: [first],
      reconfirmRowKeys: [],
    });
    expect(plan.ok).toBe(true);
    expect(plan.entries[0]?.expectedVersion).toBeNull();
  });
});

describe('intent v4 无歧义与登记 payload 一致性', () => {
  const oneMapping: ConfirmMappingInput = {
    externalSku: 'SKU-A',
    warehouseExternalId: 'W-A',
    itemId: ITEM_A,
    unit: '件',
    expectedVersion: null,
    reason: '验证确认 A',
    note: `备注 A|verification=true;SKU-B|W-B|${ITEM_B}|件||验证确认 B|备注 B`,
    verification: true,
  };
  const twoMappings: ConfirmMappingInput[] = [
    { ...oneMapping, note: '备注 A' },
    {
      externalSku: 'SKU-B',
      warehouseExternalId: 'W-B',
      itemId: ITEM_B,
      unit: '件',
      expectedVersion: null,
      reason: '验证确认 B',
      note: '备注 B',
      verification: true,
    },
  ];

  it('旧 v3 指纹拼接歧义可复现，但 v4 结构化编码不再相等（已知反例消除）', () => {
    const legacyOne = legacyIntentTextForAction('confirm_inventory_mapping', { mappings: [oneMapping] });
    const legacyTwo = legacyIntentTextForAction('confirm_inventory_mapping', { mappings: twoMappings });
    expect(legacyOne).toBe(legacyTwo);
    const v4One = buildConfirmMappingsIntent([oneMapping]);
    const v4Two = buildConfirmMappingsIntent(twoMappings);
    expect(v4One).toMatch(/^[a-f0-9]{64}$/);
    expect(v4Two).toMatch(/^[a-f0-9]{64}$/);
    expect(v4One).not.toBe(v4Two);
  });

  it('confirm 意图与确认集合顺序无关，但与内容严格绑定', () => {
    const a: ConfirmMappingInput = { ...oneMapping, note: 'A' };
    const b: ConfirmMappingInput = { ...twoMappings[1], note: 'B' };
    expect(buildConfirmMappingsIntent([a, b])).toBe(buildConfirmMappingsIntent([b, a]));
    expect(buildConfirmMappingsIntent([a, b])).not.toBe(buildConfirmMappingsIntent([a, { ...b, note: 'B2' }]));
  });

  it('canonicalJson 对对象键排序、字符串转义，分离符不产生歧义', () => {
    expect(canonicalJson({ b: 1, a: 'x|y;z' })).toBe('{"a":"x|y;z","b":1}');
    expect(canonicalJson({ a: 'x|y;z' })).not.toBe(canonicalJson({ a: 'x', b: 'y;z' }));
    expect(canonicalJson([1, 2, 3])).not.toBe(canonicalJson([3, 2, 1]));
  });

  it('五个写动作：登记 payload 按 v4 编码重算必须等于传入 intent', () => {
    // settings：与 saveSyncSettingsAction 内部构造一致（warehouseIds 去重排序）。
    const settings = { enabled: true, intervalMinutes: 45, scopeProvided: true, warehouseIds: ['w1', 'w2'] };
    expect(intentForActionPayload('update_inventory_sync_settings', settings))
      .toBe(buildSettingsIntent({ enabled: true, intervalMinutes: 45, scopeProvided: true, warehouseIds: ['w1', 'w2'] }));
    // manual
    expect(intentForActionPayload('request_inventory_manual_sync', {})).toBe(buildManualSyncIntent());
    // confirm：与页面 buildConfirmBatch → intent 一致
    const plan = buildConfirmBatch({
      selectedRowKeys: ['W-A::SKU-A'],
      drafts: [draft({ rowKey: 'W-A::SKU-A', externalSku: 'SKU-A', warehouseExternalIds: ['W-A'] })],
      reconfirmRowKeys: [],
    });
    expect(plan.ok).toBe(true);
    const confirmIntent = buildConfirmMappingsIntent(plan.entries);
    expect(intentForActionPayload('confirm_inventory_mapping', { mappings: plan.entries })).toBe(confirmIntent);
    // recheck / disable：payload 含 note: reason（服务端只比较 mappingId/expectedVersion/reason）
    const recheck = { mappingId: ITEM_A, expectedVersion: 2, reason: '理由', note: '理由' };
    expect(intentForActionPayload('recheck_inventory_mapping', recheck))
      .toBe(buildRecheckMappingIntent({ mappingId: ITEM_A, expectedVersion: 2, reason: '理由' }));
    expect(intentForActionPayload('recheck_inventory_mapping', { ...recheck, note: undefined, reason: undefined as unknown as string })).toBeNull();
    const disable = { mappingId: ITEM_B, expectedVersion: 4, reason: '停用理由', note: '停用理由' };
    expect(intentForActionPayload('disable_inventory_mapping', disable))
      .toBe(buildDisableMappingIntent({ mappingId: ITEM_B, expectedVersion: 4, reason: '停用理由' }));
  });
});
