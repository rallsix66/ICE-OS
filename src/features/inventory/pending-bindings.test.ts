import { describe, expect, it } from 'vitest';
import {
  PENDING_BINDING_MARKET_FALLBACK,
  PENDING_BINDING_WAREHOUSE_FALLBACK,
  buildPendingBindingCandidates,
  buildPendingBindingRows,
  groupPendingBindingRows,
  pendingBindingCandidateDiffFields,
  pendingBindingHref,
  pendingBindingRowKey,
  pendingBindingSuggestionLabel,
} from './pending-bindings';
import type { InventoryMappingQueueItemDto, InventoryTargetItemDto } from './types';

function queueItem(overrides: Partial<InventoryMappingQueueItemDto> = {}): InventoryMappingQueueItemDto {
  return {
    externalSku: 'SKU-001',
    warehouseId: 'wh-ph',
    warehouseExternalId: '48787',
    warehouseName: '昕兰PH仓',
    market: 'PH',
    rowCount: 1,
    latestRunAt: '2026-11-09T10:00:00Z',
    suggestion: null,
    candidateId: null,
    currentMapping: null,
    ...overrides,
  };
}

describe('buildPendingBindingRows', () => {
  it('只保留参与仓内的记录，并生成 bigseller:<warehouseId>:<externalSku> 行身份', () => {
    const result = buildPendingBindingRows(
      [
        queueItem(),
        queueItem({ warehouseId: 'wh-vn', warehouseExternalId: '50001', warehouseName: 'VN仓', market: 'VN', externalSku: 'SKU-002' }),
        queueItem({ warehouseId: 'wh-excluded', warehouseExternalId: '99999', warehouseName: '弃用仓', externalSku: 'SKU-003' }),
      ],
      ['wh-ph', 'wh-vn'],
    );
    expect(result.total).toBe(2);
    expect(result.rows.map((row) => row.rowKey)).toEqual([
      'bigseller:wh-ph:SKU-001',
      'bigseller:wh-vn:SKU-002',
    ]);
    expect(result.rows[0]).toMatchObject({
      warehouseId: 'wh-ph',
      warehouseName: '昕兰PH仓',
      market: 'PH',
      externalSku: 'SKU-001',
    });
  });

  it('参与仓为空时不保留任何记录（不把排除仓算进待办）', () => {
    const result = buildPendingBindingRows([queueItem()], []);
    expect(result).toEqual({ rows: [], total: 0 });
  });

  it('同一 (仓, SKU) 只保留一行，数量与行数一致', () => {
    const result = buildPendingBindingRows(
      [queueItem(), queueItem({ suggestion: { itemId: 'i1', iceCode: 'ICE-1', nameCn: '同名', evidence: null } })],
      ['wh-ph'],
    );
    expect(result.total).toBe(1);
    expect(result.rows).toHaveLength(1);
  });

  it('仓库名缺失时用占位文案、市场缺失保留 null（页面显示市场待确认）', () => {
    const result = buildPendingBindingRows(
      [queueItem({ warehouseName: '  ', market: null })],
      ['wh-ph'],
    );
    expect(result.rows[0].warehouseName).toBe(PENDING_BINDING_WAREHOUSE_FALLBACK);
    expect(result.rows[0].market).toBeNull();
    expect(PENDING_BINDING_MARKET_FALLBACK).toBe('市场待确认');
  });

  it('没有 SKU 或仓 id 的脏行被跳过，不生成空 rowKey', () => {
    const result = buildPendingBindingRows(
      [queueItem({ externalSku: '  ' }), queueItem({ warehouseId: '' })],
      ['wh-ph'],
    );
    expect(result).toEqual({ rows: [], total: 0 });
  });
});

describe('pendingBindingSuggestionLabel', () => {
  it('有建议时显示「ICE 货号 · 品名」', () => {
    expect(pendingBindingSuggestionLabel(queueItem({
      suggestion: { itemId: 'i1', iceCode: 'ICE-LS101501', nameCn: '水杨酸啫喱', evidence: null },
    }))).toBe('ICE-LS101501 · 水杨酸啫喱');
  });

  it('只有其中一项时只显示该项，没有建议为 null', () => {
    expect(pendingBindingSuggestionLabel(queueItem({
      suggestion: { itemId: 'i1', iceCode: 'ICE-1', nameCn: null, evidence: null },
    }))).toBe('ICE-1');
    expect(pendingBindingSuggestionLabel(queueItem({
      suggestion: { itemId: 'i1', iceCode: null, nameCn: '只有名称', evidence: null },
    }))).toBe('只有名称');
    expect(pendingBindingSuggestionLabel(queueItem())).toBeNull();
  });
});

describe('pendingBindingRowKey / pendingBindingHref', () => {
  it('rowKey 与 022 的 row_key 拼接规则一致', () => {
    expect(pendingBindingRowKey('wh-ph', 'SKU-001')).toBe('bigseller:wh-ph:SKU-001');
  });

  it('行详情链接带 view=warehouse&source=overseas 以及编码后的 row/q 参数', () => {
    const href = pendingBindingHref({
      rowKey: pendingBindingRowKey('wh-ph', 'SKU 01'),
      externalSku: 'SKU 01',
    });
    expect(href).toBe(
      '/dashboard/inventory?view=warehouse&source=overseas&row=bigseller%3Awh-ph%3ASKU%2001&q=SKU%2001',
    );
  });
});

function targetItem(overrides: Partial<InventoryTargetItemDto> = {}): InventoryTargetItemDto {
  return {
    itemId: 'item-1',
    iceCode: 'ICE-1',
    nameCn: '商品一',
    gtin: '6970000000001',
    specification: '150ml',
    unit: '件',
    ...overrides,
  };
}

describe('分组：按来源 SKU 聚合多个仓', () => {
  it('同一 SKU 出现在两个仓时合成一组，组头带仓名/市场/最近出现；不同 SKU 分开', () => {
    const rows = buildPendingBindingRows(
      [
        queueItem({ externalSku: 'SKU-1', warehouseId: 'wh-ph', warehouseName: 'PH仓', market: 'PH' }),
        queueItem({ externalSku: 'SKU-1', warehouseId: 'wh-vn', warehouseExternalId: '50001', warehouseName: 'VN仓', market: 'VN', latestRunAt: '2026-11-10T02:00:00Z' }),
        queueItem({ externalSku: 'SKU-2', warehouseId: 'wh-ph', warehouseName: 'PH仓', market: 'PH' }),
      ],
      ['wh-ph', 'wh-vn'],
    ).rows;
    const groups = groupPendingBindingRows(rows);
    expect(groups.map((group) => group.externalSku)).toEqual(['SKU-1', 'SKU-2']);
    expect(groups[0]?.rows).toHaveLength(2);
    expect(groups[0]?.warehouses.map((warehouse) => warehouse.warehouseName)).toEqual(['PH仓', 'VN仓']);
    expect(groups[0]?.warehouses[1]).toMatchObject({
      warehouseId: 'wh-vn',
      market: 'VN',
      latestRunAt: '2026-11-10T02:00:00Z',
    });
    expect(groups[1]?.rows).toHaveLength(1);
  });

  it('分组保留仓内已有对应版本（重新确认/换绑要带旧版本）', () => {
    const rows = buildPendingBindingRows(
      [queueItem({ externalSku: 'SKU-9', currentMapping: { id: 'm1', version: 3, itemId: 'item-1', unit: '件', status: 'recheck' } })],
      ['wh-ph'],
    ).rows;
    const group = groupPendingBindingRows(rows)[0];
    expect(group?.rows[0]?.currentVersion).toBe(3);
    expect(group?.warehouses[0]?.currentVersion).toBe(3);
  });

  it('行数据保留队列的最近出现时间、出现行数、验证标记与结构化建议', () => {
    const rows = buildPendingBindingRows(
      [queueItem({
        rowCount: 4,
        latestRunAt: '2026-11-10T03:00:00Z',
        verification: true,
        suggestion: { itemId: 'item-1', iceCode: 'ICE-1', nameCn: '商品一', evidence: 'BS 样表' },
      })],
      ['wh-ph'],
    ).rows;
    expect(rows[0]).toMatchObject({
      externalSku: 'SKU-001',
      warehouseExternalId: '48787',
      rowCount: 4,
      latestRunAt: '2026-11-10T03:00:00Z',
      verification: true,
      suggestion: { itemId: 'item-1', iceCode: 'ICE-1', nameCn: '商品一', evidence: 'BS 样表' },
    });
  });
});

describe('同 SKU 候选款：每款商一个选项（真实 SKU 6974674957332 形状）', () => {
  const priors = [
    {
      warehouseId: 'wh-vn', warehouseName: '越南青林湾仓库', market: 'VN',
      itemId: 'item-ls', iceCode: 'LS101274', nameCn: 'ICE LERSKIN 7% 乙醇酸爽肤水',
      unit: '个', specification: '200ml/瓶', gtin: '6974674957332',
    },
    {
      warehouseId: 'wh-ph', warehouseName: '菲律宾-新创启辰自建仓', market: 'PH',
      itemId: 'item-ls', iceCode: 'LS101274', nameCn: 'ICE LERSKIN 7% 乙醇酸爽肤水',
      unit: '个', specification: '200ml/瓶', gtin: '6974674957332',
    },
    {
      warehouseId: 'wh-my', warehouseName: '喜运达MY仓', market: 'MY',
      itemId: 'item-wm', iceCode: 'WM0094', nameCn: 'ICE LERSKIN 7% 乙醇酸爽肤水(泰国特供版)',
      unit: '个', specification: '200ml/瓶', gtin: '6974674957332',
    },
    {
      warehouseId: 'wh-th', warehouseName: 'DEE-龙仔厝（ICE专属）', market: null,
      itemId: 'item-wm', iceCode: 'WM0094', nameCn: 'ICE LERSKIN 7% 乙醇酸爽肤水(泰国特供版)',
      unit: '个', specification: '200ml/瓶', gtin: '6974674957332',
    },
  ];

  it('每款只出现一次，列出品名/货号/条码/规格、曾选过它的仓与已登记单位', () => {
    const candidates = buildPendingBindingCandidates(priors);
    expect(candidates).toHaveLength(2);
    const ls = candidates.find((candidate) => candidate.iceCode === 'LS101274')!;
    expect(ls.nameCn).toBe('ICE LERSKIN 7% 乙醇酸爽肤水');
    expect(ls.warehouses.map((warehouse) => warehouse.warehouseName)).toEqual([
      '越南青林湾仓库', '菲律宾-新创启辰自建仓',
    ]);
    expect(ls.unit).toBe('个');
    expect(ls.unitConflict).toBe(false);
    expect(ls.unitValues).toEqual(['个']);
    expect(ls.gtin).toBe('6974674957332');
    expect(ls.specification).toBe('200ml/瓶');
  });

  it('两款的实际差异逐条写清：品名不同（泰国特供版），其余相同不冒充差异', () => {
    const candidates = buildPendingBindingCandidates(priors);
    const wm = candidates.find((candidate) => candidate.iceCode === 'WM0094')!;
    expect(wm.diffNotes).toHaveLength(1);
    expect(wm.diffNotes[0]).toContain('品名不同');
    expect(wm.diffNotes[0]).toContain('泰国特供版');
    // 条码/规格/单位一致，不出现在差异里。
    expect(wm.diffNotes.join('')).not.toContain('条码');
    expect(wm.diffNotes.join('')).not.toContain('规格');
  });

  it('缺单位时为 null（页面要求填写）；各仓单位不一致时 unitConflict=true 并列出两值', () => {
    const missing = buildPendingBindingCandidates([{ ...priors[0]!, unit: null }]);
    expect(missing[0]?.unit).toBeNull();
    expect(missing[0]?.unitValues).toEqual([]);
    const conflict = buildPendingBindingCandidates([
      priors[0]!,
      { ...priors[1]!, unit: '件' },
    ]);
    expect(conflict[0]?.unit).toBeNull();
    expect(conflict[0]?.unitConflict).toBe(true);
    expect(conflict[0]?.unitValues).toEqual(['个', '件']);
  });

  it('同 SKU 只有一款候选时不出差异行', () => {
    const candidates = buildPendingBindingCandidates([priors[0]!]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.diffNotes).toEqual([]);
  });
});

describe('候选商品差异：条码/规格/单位逐条标出', () => {
  it('只有一个候选时没有差异', () => {
    expect(pendingBindingCandidateDiffFields([targetItem()])).toEqual([]);
  });

  it('全部候选一致时没有差异', () => {
    expect(pendingBindingCandidateDiffFields([targetItem(), targetItem({ itemId: 'item-2' })])).toEqual([]);
  });

  it('多个候选字段不同时返回差异字段（含空值 vs 有值）', () => {
    expect(pendingBindingCandidateDiffFields([
      targetItem(),
      targetItem({ itemId: 'item-2', gtin: '6970000000002', specification: '150ml', unit: '件' }),
    ])).toEqual(['gtin']);
    expect(pendingBindingCandidateDiffFields([
      targetItem({ specification: '150ml' }),
      targetItem({ itemId: 'item-2', specification: '' }),
    ])).toEqual(['specification']);
    expect(pendingBindingCandidateDiffFields([
      targetItem({ unit: '件' }),
      targetItem({ itemId: 'item-2', unit: '箱' }),
    ])).toEqual(['unit']);
  });
});
