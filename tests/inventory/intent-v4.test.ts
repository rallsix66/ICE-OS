import { describe, it, expect } from 'vitest';
import {
  buildConfirmBatch,
  buildConfirmMappingsIntent,
  buildDisableMappingIntent,
  buildManualSyncIntent,
  buildRecheckMappingIntent,
  buildSettingsIntent,
  canonicalJson,
  confirmMappingsIntentText,
  intentForActionPayload,
  legacyIntentTextForAction,
  pendingRecoveryKey,
  type ConfirmMappingInput,
  type MappingDraft,
} from '../../src/features/inventory/model';

/**
 * R2 v4：完整内容 / 无歧义 intent 的纯逻辑反例。
 * 原 v3 反例：一条备注 84 字含 `|`/`;` 的映射，与两条不同 SKU/仓/商品的映射得到同一 intent。
 */
const itemA = '10000000-0000-4000-8000-000000000001';
const itemB = '10000000-0000-4000-8000-000000000002';

const oneMapping: ConfirmMappingInput[] = [{
  externalSku: 'SKU-A',
  warehouseExternalId: 'W-A',
  itemId: itemA,
  unit: '件',
  expectedVersion: null,
  reason: '验证确认 A',
  note: '备注 A|verification=true;SKU-B|W-B|10000000-0000-4000-8000-000000000002|件||验证确认 B|备注 B',
  verification: true,
}];

const twoMappings: ConfirmMappingInput[] = [
  {
    externalSku: 'SKU-A', warehouseExternalId: 'W-A', itemId: itemA, unit: '件',
    expectedVersion: null, reason: '验证确认 A', note: '备注 A', verification: true,
  },
  {
    externalSku: 'SKU-B', warehouseExternalId: 'W-B', itemId: itemB, unit: '件',
    expectedVersion: null, reason: '验证确认 B', note: '备注 B', verification: true,
  },
];

function draft(overrides: Partial<MappingDraft>): MappingDraft {
  return {
    rowKey: `${overrides.warehouseExternalIds?.[0] ?? 'W-A'}::${overrides.externalSku ?? 'SKU-A'}`,
    externalSku: 'SKU-A',
    itemId: itemA,
    itemLabel: 'A',
    unit: '件',
    reason: '确认',
    warehouseExternalIds: ['W-A'],
    expectedVersion: null,
    note: '',
    verification: false,
    ...overrides,
  };
}

describe('intent v4 structured encoding', () => {
  it('one free-text mapping and two different mappings no longer collide', () => {
    const one = buildConfirmMappingsIntent(oneMapping);
    const two = buildConfirmMappingsIntent(twoMappings);
    expect(one).not.toBe(two);
    expect(one).toMatch(/^[a-f0-9]{64}$/);
    expect(two).toMatch(/^[a-f0-9]{64}$/);
    // 旧 v3 编码在同样输入下确实碰撞（保留为历史反例的证据，不再用于新写）。
    const legacyOne = legacyIntentTextForAction('confirm_inventory_mapping', { mappings: oneMapping });
    const legacyTwo = legacyIntentTextForAction('confirm_inventory_mapping', { mappings: twoMappings });
    expect(legacyOne).toBe(legacyTwo);
    // 新编码文本是结构化 JSON 数组：一条映射就是一个对象，备注里的分隔符只在字符串内部。
    const textOne = confirmMappingsIntentText(oneMapping);
    expect(textOne.startsWith('inventory.confirm_mappings.v4|[')).toBe(true);
    const parsed = JSON.parse(textOne.slice('inventory.confirm_mappings.v4|'.length)) as string[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect((JSON.parse(parsed[0]) as { note: string }).note).toBe(oneMapping[0].note);
  });

  it('canonical JSON sorts object keys and escapes free text', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson(['x|y;z', '中文'])).toBe('["x|y;z","中文"]');
    expect(canonicalJson({ note: 'a|b;c' })).toBe('{"note":"a|b;c"}');
    expect(canonicalJson({ note: null })).toBe('{"note":null}');
  });

  it('mapping order does not change the intent; content changes do', () => {
    expect(buildConfirmMappingsIntent(twoMappings)).toBe(buildConfirmMappingsIntent([...twoMappings].reverse()));
    const changed = twoMappings.map((entry, index) => (index === 0 ? { ...entry, unit: '箱' } : entry));
    expect(buildConfirmMappingsIntent(changed)).not.toBe(buildConfirmMappingsIntent(twoMappings));
  });

  it('intentForActionPayload recomputes every action from its complete payload', () => {
    const settingsPayload = {
      enabled: true, intervalMinutes: 60, scopeProvided: true,
      warehouseIds: ['w2', 'w1'],
    };
    expect(intentForActionPayload('update_inventory_sync_settings', settingsPayload))
      .toBe(buildSettingsIntent({ enabled: true, intervalMinutes: 60, scopeProvided: true, warehouseIds: ['w1', 'w2'] }));
    expect(intentForActionPayload('request_inventory_manual_sync', {})).toBe(buildManualSyncIntent());
    expect(intentForActionPayload('confirm_inventory_mapping', { mappings: twoMappings }))
      .toBe(buildConfirmMappingsIntent(twoMappings));
    expect(intentForActionPayload('recheck_inventory_mapping', {
      mappingId: 'm1', expectedVersion: 3, reason: '核对',
    })).toBe(buildRecheckMappingIntent({ mappingId: 'm1', expectedVersion: 3, reason: '核对' }));
    expect(intentForActionPayload('disable_inventory_mapping', {
      mappingId: 'm1', expectedVersion: 3, reason: '停用',
    })).toBe(buildDisableMappingIntent({ mappingId: 'm1', expectedVersion: 3, reason: '停用' }));
  });

  it('R3: mixed first-confirm + reconfirm batch validates per row', () => {
    const first = draft({ rowKey: 'W-A::SKU-A', externalSku: 'SKU-A', warehouseExternalIds: ['W-A'], expectedVersion: null });
    const reconfirm = draft({
      rowKey: 'W-B::SKU-B', externalSku: 'SKU-B', warehouseExternalIds: ['W-B'], expectedVersion: 3,
    });
    const plan = buildConfirmBatch({
      selectedRowKeys: [first.rowKey, reconfirm.rowKey],
      drafts: [first, reconfirm],
      reconfirmRowKeys: [reconfirm.rowKey],
    });
    expect(plan.ok).toBe(true);
    expect(plan.entries).toHaveLength(2);
    expect(plan.entries.find((entry) => entry.externalSku === 'SKU-A')?.expectedVersion).toBeNull();
    expect(plan.entries.find((entry) => entry.externalSku === 'SKU-B')?.expectedVersion).toBe(3);

    // 重新确认行缺少页面所见版本 → 拒绝（服务端旧版本校验仍保留）。
    const missingVersion = buildConfirmBatch({
      selectedRowKeys: [first.rowKey, reconfirm.rowKey],
      drafts: [first, { ...reconfirm, expectedVersion: null }],
      reconfirmRowKeys: [reconfirm.rowKey],
    });
    expect(missingVersion.ok).toBe(false);
    // 只选首次行 → 允许（不得因同批有重确认行而被强制带旧版本）。
    const onlyFirst = buildConfirmBatch({
      selectedRowKeys: [first.rowKey],
      drafts: [first],
      reconfirmRowKeys: [reconfirm.rowKey],
    });
    expect(onlyFirst.ok).toBe(true);
  });

  it('pending recovery key binds actor and account, not only requestId', () => {
    const base = {
      requestId: 'r1', action: 'update_inventory_sync_settings', createdAt: null, payload: {}, intent: 'i1',
      actorId: 'actor-a', accountId: 'acc-1', foreign: false, mine: true, status: 'pending',
    };
    expect(pendingRecoveryKey(base)).not.toBe(pendingRecoveryKey({ ...base, actorId: 'actor-b' }));
    expect(pendingRecoveryKey(base)).not.toBe(pendingRecoveryKey({ ...base, accountId: 'acc-2' }));
    expect(pendingRecoveryKey(base)).not.toBe(pendingRecoveryKey({ ...base, intent: 'i2' }));
  });
});
