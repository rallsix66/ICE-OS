import { describe, expect, it } from 'vitest';

import {
  applyGroupingInterpretationHash,
  applyGroupingOverrides,
  attachEvidenceBindings,
  buildAssociationCarryoverPlan,
  buildEvidenceGroupingState,
  buildGroupingOverrideForDecision,
  buildRawGroupingState,
  groupingReviewTicketKeys,
  detectGroupingChanges,
  groupingInterpretationSignature,
} from './grouping';
import type {
  ParsedShipmentTicket,
  ShipmentGroupingOverrideDto,
  ShipmentGroupingReviewDto,
  ShipmentGroupingStateTicket,
} from './types';

function item(name: string, quantity: number, sourceRow: number) {
  const norm = name.toLowerCase().replace(/\s+/g, '');
  return {
    itemKey: `${norm}#0`,
    productNameRaw: name,
    productNameNorm: norm,
    shippedQuantity: quantity,
    sourceReceivedQuantity: null,
    sourceReceiptBasis: null,
    sourceRow,
    sourceNote: null,
  };
}

function parsedTicket(
  ticketKey: string,
  start: number,
  items: Array<ReturnType<typeof item>>,
): ParsedShipmentTicket {
  return {
    ticketKey,
    ticketNo: ticketKey.replace(/^(WB|PO|FB):/, ''),
    sourceRowStart: start,
    sourceRowEnd: start + items.length - 1,
    market: '泰国',
    customsMethod: null,
    waybillsText: ticketKey.startsWith('WB:') ? ticketKey.slice(3) : null,
    purchaseOrder: ticketKey.startsWith('PO:') ? ticketKey.slice(3) : null,
    transportText: null,
    arrivalText: null,
    vessel: null,
    dispatchedText: null,
    statusClass: 'in_transit',
    receivedBasis: 'status_in_transit_zero',
    items,
  };
}

function stateTicket(
  ticketKey: string,
  start: number,
  items: Array<ReturnType<typeof item>>,
  productIds: Array<string | null> = items.map(() => null),
): ShipmentGroupingStateTicket {
  return {
    shipmentId: `id-${ticketKey}`,
    ticketKey,
    ticketNo: ticketKey,
    market: '泰国',
    waybillsText: null,
    purchaseOrder: null,
    sourceRowStart: start,
    sourceRowEnd: start + items.length - 1,
    items: items.map((entry, index) => ({
      itemId: `${ticketKey}-item-${index}`,
      productId: productIds[index] ?? null,
      productNameRaw: entry.productNameRaw,
      productNameNorm: entry.productNameNorm,
      shippedQuantity: entry.shippedQuantity,
    })),
  };
}

function override(
  kind: 'merge' | 'split',
  spec: ShipmentGroupingOverrideDto['spec'],
  id = 'ov-1',
): ShipmentGroupingOverrideDto {
  return {
    id,
    reviewId: `review-${id}`,
    kind,
    signature: 'sig',
    spec,
    active: true,
    createdAt: '2026-11-06T00:00:00.000Z',
  };
}

describe('第十二轮：分组覆盖（merge / split）', () => {
  it('合并覆盖：两张票的明细按一票处理，键不冲突，行范围取并集', () => {
    const tickets = [
      parsedTicket('WB:A', 2, [item('产品A', 10, 2), item('产品B', 20, 3)]),
      parsedTicket('WB:B', 4, [item('产品C', 30, 4), item('产品D', 40, 5)]),
    ];
    const result = applyGroupingOverrides(tickets, [override('merge', {
      kind: 'merge', targetKey: 'WB:A', absorbedKeys: ['WB:B'],
    })]);
    expect(result).toHaveLength(1);
    expect(result[0]!.ticketKey).toBe('WB:A');
    expect(result[0]!.items.map((entry) => entry.productNameRaw))
      .toEqual(['产品A', '产品B', '产品C', '产品D']);
    expect(result[0]!.sourceRowStart).toBe(2);
    expect(result[0]!.sourceRowEnd).toBe(5);
  });

  it('合并覆盖：同品名明细重新编号，避免同票 itemKey 冲突', () => {
    const tickets = [
      parsedTicket('WB:A', 2, [item('产品A', 10, 2)]),
      parsedTicket('WB:B', 3, [item('产品A', 5, 3)]),
    ];
    const result = applyGroupingOverrides(tickets, [override('merge', {
      kind: 'merge', targetKey: 'WB:A', absorbedKeys: ['WB:B'],
    })]);
    expect(result[0]!.items.map((entry) => entry.itemKey)).toEqual(['产品a#0', '产品a#1']);
    expect(result[0]!.items.map((entry) => entry.shippedQuantity)).toEqual([10, 5]);
  });

  it('拆开覆盖：按原明细把商品分回两张票，来源票保留自己那一组', () => {
    const tickets = [parsedTicket('WB:A', 2, [
      item('产品A', 10, 2), item('产品B', 20, 3), item('产品C', 30, 4),
    ])];
    const result = applyGroupingOverrides(tickets, [override('split', {
      kind: 'split',
      sourceKey: 'WB:A',
      groups: [
        { ticketKey: 'WB:A', ticketNo: 'A', market: '泰国', customsMethod: null, waybillsText: 'A', purchaseOrder: null, products: [{ productNameNorm: '产品a', shippedQuantity: 10 }] },
        { ticketKey: 'WB:B', ticketNo: 'B', market: '泰国', customsMethod: null, waybillsText: 'B', purchaseOrder: null, products: [{ productNameNorm: '产品b', shippedQuantity: 20 }, { productNameNorm: '产品c', shippedQuantity: 30 }] },
      ],
    })]);
    expect(result.map((ticket) => ticket.ticketKey)).toEqual(['WB:A', 'WB:B']);
    expect(result[0]!.items.map((entry) => entry.productNameRaw)).toEqual(['产品A']);
    expect(result[1]!.items.map((entry) => entry.productNameRaw)).toEqual(['产品B', '产品C']);
    expect(result[1]!.statusClass).toBe('in_transit');
  });

  it('拆开覆盖：来源键不在任何组时丢弃空的来源票，只保留分出的票', () => {
    const tickets = [parsedTicket('WB:MERGED', 2, [item('产品A', 10, 2), item('产品B', 20, 3)])];
    const result = applyGroupingOverrides(tickets, [override('split', {
      kind: 'split',
      sourceKey: 'WB:MERGED',
      groups: [
        { ticketKey: 'WB:A', ticketNo: 'A', market: '泰国', customsMethod: null, waybillsText: 'A', purchaseOrder: null, products: [{ productNameNorm: '产品a', shippedQuantity: 10 }] },
        { ticketKey: 'WB:B', ticketNo: 'B', market: '泰国', customsMethod: null, waybillsText: 'B', purchaseOrder: null, products: [{ productNameNorm: '产品b', shippedQuantity: 20 }] },
      ],
    })]);
    expect(result.map((ticket) => ticket.ticketKey)).toEqual(['WB:A', 'WB:B']);
    expect(result.every((ticket) => ticket.items.length === 1)).toBe(true);
  });

  it('来源变化导致覆盖对不上时保持解析结果，不猜也不写空票', () => {
    const tickets = [parsedTicket('WB:A', 2, [item('产品A', 10, 2)])];
    const result = applyGroupingOverrides(tickets, [override('merge', {
      kind: 'merge', targetKey: 'WB:X', absorbedKeys: ['WB:Y'],
    })]);
    expect(result).toEqual(tickets);
  });
});

describe('第十二轮：拆票 / 合票识别', () => {
  const lipMuds = Array.from({ length: 9 }, (_, index) => item(`唇泥P0${index + 1}`, 3600, 2 + index));
  const blushes = [1080, 1080, 3240, 540, 270, 270, 270]
    .map((quantity, index) => item(`腮红M0${index}`, quantity, 11 + index));

  it('原来一票的商品分到两票 → 疑似拆票，并给出两侧单号与商品', () => {
    const previous = [stateTicket('WB:9258750', 2, [...lipMuds, ...blushes])];
    const current = [
      parsedTicket('WB:9258750', 2, lipMuds),
      parsedTicket('FB:泰国|腮红', 11, blushes),
    ];
    const reviews = detectGroupingChanges(previous, current, [previous[0]!.shipmentId, null]);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.kind).toBe('split');
    expect(reviews[0]!.evidence.previous.tickets).toHaveLength(1);
    expect(reviews[0]!.evidence.current.tickets.map((ticket) => ticket.ticketKey))
      .toEqual(['WB:9258750', 'FB:泰国|腮红']);
    expect(reviews[0]!.evidence.current.tickets[1]!.items).toHaveLength(7);
  });

  it('原来两票的商品集中到一票 → 疑似合票', () => {
    const previous = [
      stateTicket('WB:9059881', 2, lipMuds),
      stateTicket('WB:9059884', 11, blushes),
    ];
    const current = [parsedTicket('WB:9059881', 2, [...lipMuds, ...blushes])];
    const reviews = detectGroupingChanges(previous, current, [previous[0]!.shipmentId]);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.kind).toBe('merge');
    expect(reviews[0]!.evidence.previous.tickets).toHaveLength(2);
    expect(reviews[0]!.evidence.current.tickets).toHaveLength(1);
  });

  it('归属没变（只改物流进度/数量）→ 不提醒', () => {
    const previous = [stateTicket('WB:9258750', 2, [...lipMuds, ...blushes])];
    const current = [parsedTicket('WB:9258750', 2, [
      ...lipMuds.map((entry) => ({ ...entry, shippedQuantity: entry.shippedQuantity + 1 })),
      ...blushes,
    ])];
    expect(detectGroupingChanges(previous, current, [previous[0]!.shipmentId])).toEqual([]);
  });

  it('普通新增一票、移动行号 → 不提醒', () => {
    const previous = [stateTicket('WB:A', 2, lipMuds)];
    const current = [
      parsedTicket('WB:A', 30, lipMuds),
      parsedTicket('WB:B', 40, [item('新产品', 10, 40)]),
    ];
    expect(detectGroupingChanges(previous, current, [previous[0]!.shipmentId, null])).toEqual([]);
  });

  it('商品同时出现在两票（归属不唯一）→ 不猜，不提醒', () => {
    const previous = [stateTicket('WB:A', 2, lipMuds)];
    const current = [
      parsedTicket('WB:A', 2, lipMuds.slice(0, 5)),
      parsedTicket('WB:B', 3, lipMuds.slice(4)),
    ];
    expect(detectGroupingChanges(previous, current, [previous[0]!.shipmentId, null])).toEqual([]);
  });

  it('连续同步同一种分组只提醒一次（上次已经两票、本次还是两票）', () => {
    const previous = [
      stateTicket('WB:A', 2, lipMuds),
      stateTicket('WB:B', 11, blushes),
    ];
    const current = [
      parsedTicket('WB:A', 2, lipMuds),
      parsedTicket('WB:B', 11, blushes),
    ];
    const matched = [previous[0]!.shipmentId, previous[1]!.shipmentId];
    expect(detectGroupingChanges(previous, current, matched)).toEqual([]);
  });

  it('同样的拆法以前确认过、第二张票以前出现过，再次拆开仍提醒', () => {
    // 上次已合回一票；第二张票在更早读取里出现过（身份索引仍能匹配到它），本次再拆开。
    const previous = [stateTicket('WB:A', 2, [...lipMuds, ...blushes])];
    const current = [
      parsedTicket('WB:A', 2, lipMuds),
      parsedTicket('WB:B', 11, blushes),
    ];
    // B 匹配到上一轮不在来源里的历史票 UUID（不是新建票），仍应判定为拆票。
    const reviews = detectGroupingChanges(previous, current, [previous[0]!.shipmentId, 'old-shipment-B']);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.kind).toBe('split');
    expect(reviews[0]!.evidence.current.tickets.map((ticket) => ticket.ticketKey))
      .toEqual(['WB:A', 'WB:B']);
  });

  it('一票 → 拆两票 → 合回一票 → 再拆两票：三次归属变化都提醒', () => {
    const one = [stateTicket('WB:A', 2, [...lipMuds, ...blushes])];
    const two = [
      stateTicket('WB:A', 2, lipMuds),
      stateTicket('WB:B', 11, blushes),
    ];
    const split = detectGroupingChanges(one, two.map((ticket, index) => parsedTicket(
      ticket.ticketKey,
      ticket.sourceRowStart!,
      index === 0 ? lipMuds : blushes,
    )), [one[0]!.shipmentId, 'old-shipment-B']);
    expect(split.map((review) => review.kind)).toEqual(['split']);

    const merged = detectGroupingChanges(two, [
      parsedTicket('WB:A', 2, [...lipMuds, ...blushes]),
    ], [two[0]!.shipmentId]);
    expect(merged.map((review) => review.kind)).toEqual(['merge']);

    const splitAgain = detectGroupingChanges(one, [
      parsedTicket('WB:A', 2, lipMuds),
      parsedTicket('WB:B', 11, blushes),
    ], [one[0]!.shipmentId, 'old-shipment-B']);
    expect(splitAgain.map((review) => review.kind)).toEqual(['split']);
  });
});

describe('第十三轮：绑定沿用只认能明确对应的原明细', () => {
  const products = (count: number) => Array.from({ length: count }, (_, index) => (
    `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
  ));

  it('拆票：行范围重叠的原明细按品名+数量一一对应沿用', () => {
    const previous = [stateTicket('WB:A', 2, [
      item('产品A', 10, 2),
      item('产品B', 20, 3),
      item('产品C', 30, 4),
    ], products(3))];
    const current = [
      parsedTicket('WB:A', 2, [item('产品A', 10, 2), item('产品B', 20, 3)]),
      parsedTicket('WB:B', 4, [item('产品C', 30, 4)]),
    ];
    const plan = buildAssociationCarryoverPlan(previous, current);
    expect(plan).toEqual([
      { ticketKey: 'WB:A', itemKey: '产品a#0', productId: products(3)[0] },
      { ticketKey: 'WB:A', itemKey: '产品b#0', productId: products(3)[1] },
      { ticketKey: 'WB:B', itemKey: '产品c#0', productId: products(3)[2] },
    ]);
  });

  it('无关新票：即使同品名+同数量，也不继承另一张票的原绑定', () => {
    const previous = [stateTicket('WB:9258750', 2, [
      item('唇泥P01', 3600, 2),
      item('腮红M02', 1080, 3),
    ], products(2))];
    const current = [
      parsedTicket('WB:9258750', 2, [item('唇泥P01', 3600, 2), item('腮红M02', 1080, 3)]),
      // 另一张无关采购单：新行、同品名同数量，不得继承 WM0058 一类绑定。
      parsedTicket('PO:POKNZX-UNRELATED', 20, [item('腮红M02', 1080, 20)]),
    ];
    const plan = buildAssociationCarryoverPlan(previous, current);
    expect(plan.every((entry) => entry.ticketKey !== 'PO:POKNZX-UNRELATED')).toBe(true);
    expect(plan).toHaveLength(2);
  });

  it('重名同量或数量对不上：不猜，跳过', () => {
    const previous = [stateTicket('WB:A', 2, [
      item('产品A', 10, 2),
      item('产品A', 10, 3),
      item('产品B', 20, 4),
    ], products(3))];
    const current = [parsedTicket('WB:A', 2, [
      item('产品A', 10, 2),
      item('产品A', 10, 3),
      item('产品B', 21, 4),
    ])];
    const plan = buildAssociationCarryoverPlan(previous, current);
    expect(plan).toEqual([]);
  });
});

describe('第十二轮：人工决定与解释哈希', () => {
  function review(kind: 'split' | 'merge', previousKeys: string[], currentKeys: string[]): Pick<ShipmentGroupingReviewDto, 'kind' | 'evidence'> {
    return {
      kind,
      evidence: {
        kind,
        previous: {
          snapshotId: null,
          tickets: previousKeys.map((key, index) => ({
            ticketKey: key,
            ticketNo: key,
            market: '泰国',
            waybillsText: null,
            purchaseOrder: null,
            sourceRowStart: 2 + index * 10,
            sourceRowEnd: 2 + index * 10,
            items: [{ productNameRaw: `商品${index}`, productNameNorm: `商品${index}`, shippedQuantity: 10 }],
          })),
        },
        current: {
          snapshotId: null,
          tickets: currentKeys.map((key, index) => ({
            ticketKey: key,
            ticketNo: key,
            market: '泰国',
            waybillsText: null,
            purchaseOrder: null,
            sourceRowStart: 2 + index * 10,
            sourceRowEnd: 2 + index * 10,
            items: [{ productNameRaw: `商品${index}`, productNameNorm: `商品${index}`, shippedQuantity: 10 }],
          })),
        },
        affectedProducts: [],
      },
    };
  }

  it('疑似拆票选「仍是一票」→ 合并覆盖；选「确实拆开」→ 不覆盖', () => {
    const splitReview = review('split', ['WB:A'], ['WB:A', 'WB:B']);
    expect(buildGroupingOverrideForDecision(splitReview, 'keep_one')).toEqual({
      kind: 'merge',
      spec: { kind: 'merge', targetKey: 'WB:A', absorbedKeys: ['WB:B'] },
    });
    expect(buildGroupingOverrideForDecision(splitReview, 'split_confirmed')).toBeNull();
  });

  it('疑似合票选「仍然分开」→ 拆开覆盖（按上次两票的明细）；选「确实合成一票」→ 不覆盖', () => {
    const mergeReview = review('merge', ['WB:A', 'WB:B'], ['WB:A']);
    const decision = buildGroupingOverrideForDecision(mergeReview, 'keep_separate');
    expect(decision?.kind).toBe('split');
    expect(decision?.spec.kind === 'split' && decision.spec.groups.map((group) => group.ticketKey))
      .toEqual(['WB:A', 'WB:B']);
    expect(buildGroupingOverrideForDecision(mergeReview, 'merge_confirmed')).toBeNull();
  });

  it('解释哈希：没有覆盖时稳定；覆盖新增/撤销会改变哈希，让同内容重新入库', () => {
    const base = 'a'.repeat(64);
    const none = groupingInterpretationSignature([]);
    expect(none).toBe('base');
    const merged = override('merge', { kind: 'merge', targetKey: 'WB:A', absorbedKeys: ['WB:B'] });
    const withOverride = groupingInterpretationSignature([merged]);
    expect(withOverride).toMatch(/^[a-f0-9]{64}$/);
    expect(applyGroupingInterpretationHash(base, [])).not.toBe(applyGroupingInterpretationHash(base, [merged]));
    expect(applyGroupingInterpretationHash(base, [merged]))
      .toBe(applyGroupingInterpretationHash(base, [{ ...merged, id: 'other', createdAt: null }]));
    expect(applyGroupingInterpretationHash(base, [{ ...merged, active: false }]))
      .toBe(applyGroupingInterpretationHash(base, []));
  });
});

describe('第十四轮：原始分组检测与复核范围内的绑定沿用', () => {
  it('上一侧分组来自原始网格解析：按票键找回 shipmentId，找不到的票保守跳过', () => {
    const previousParsed = [
      parsedTicket('WB:A', 2, [item('产品A', 10, 2), item('产品B', 20, 3)]),
      parsedTicket('WB:未知', 9, [item('产品C', 30, 9)]),
    ];
    const identityRows = [
      identity('WB:A', 'sid-a'),
    ];
    const state = buildRawGroupingState(previousParsed, identityRows);
    expect(state).toHaveLength(1);
    expect(state[0]).toMatchObject({
      shipmentId: 'sid-a',
      ticketKey: 'WB:A',
      sourceRowStart: 2,
      sourceRowEnd: 3,
    });
    // 原始分组不携带当前绑定（只用于「商品在哪张票上」对比）。
    expect(state[0]!.items.every((entry) => entry.productId === null && entry.itemId === '')).toBe(true);
    expect(state[0]!.items.map((entry) => entry.shippedQuantity)).toEqual([10, 20]);
  });

  it('复核票键 = evidence 前后两侧的票键并集', () => {
    const keys = groupingReviewTicketKeys({
      evidence: {
        kind: 'split',
        previous: { snapshotId: null, tickets: [reviewSide('WB:A'), reviewSide('WB:B')] },
        current: { snapshotId: null, tickets: [reviewSide('PO:C')] },
        affectedProducts: [],
      },
    });
    expect([...keys].sort()).toEqual(['PO:C', 'WB:A', 'WB:B']);
  });

  it('绑定沿用限定在本次复核范围内：范围外的原票即使能对应也不写进计划', () => {
    const products = [
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
    ];
    const previous = [
      stateTicket('WB:A', 2, [item('产品A', 10, 2), item('产品B', 20, 3)], products),
      stateTicket('WB:B', 4, [item('产品C', 30, 4)], [products[1]!]),
    ];
    const current = [
      parsedTicket('WB:A', 2, [item('产品A', 10, 2), item('产品B', 20, 3)]),
      parsedTicket('WB:B', 4, [item('产品C', 30, 4)]),
    ];
    const scoped = buildAssociationCarryoverPlan(previous, current, new Set(['WB:A']));
    expect(scoped.map((entry) => entry.ticketKey)).toEqual(['WB:A', 'WB:A']);
    expect(scoped.map((entry) => entry.productId)).toEqual([products[0], products[1]]);
    const unscoped = buildAssociationCarryoverPlan(previous, current);
    expect(unscoped.map((entry) => entry.ticketKey)).toEqual(['WB:A', 'WB:A', 'WB:B']);
  });

  function identity(ticketKey: string, shipmentId: string) {
    return {
      shipmentId,
      ticketKey,
      purchaseOrder: null,
      waybillsText: null,
      market: '泰国',
      customsMethod: null,
      productNameNorms: [],
      identityStatus: 'confirmed' as const,
      identityNote: null,
    };
  }

  function reviewSide(ticketKey: string) {
    return {
      ticketKey,
      ticketNo: ticketKey,
      market: '泰国',
      waybillsText: null,
      purchaseOrder: null,
      sourceRowStart: 2,
      sourceRowEnd: 2,
      items: [{ productNameRaw: '商品', productNameNorm: '商品', shippedQuantity: 10 }],
    };
  }
});

describe('第十四轮：拆开前绑定补进 evidence + 两层沿用', () => {
  it('evidence 上次一侧补上读取前分组的绑定（按行范围 + 品名数量对应）', () => {
    const review = {
      kind: 'split' as const,
      signature: 's',
      evidence: {
        kind: 'split' as const,
        previous: {
          snapshotId: 's0',
          tickets: [{
            ticketKey: 'WB:A',
            ticketNo: 'A',
            market: '泰国',
            waybillsText: 'A',
            purchaseOrder: null,
            sourceRowStart: 2,
            sourceRowEnd: 3,
            items: [
              { productNameRaw: '产品A', productNameNorm: '产品a', shippedQuantity: 10, productId: null },
              { productNameRaw: '产品B', productNameNorm: '产品b', shippedQuantity: 20, productId: null },
            ],
          }],
        },
        current: { snapshotId: 's1', tickets: [] },
        affectedProducts: ['产品a'],
      },
    };
    const state = [stateTicket('WB:A', 2, [item('产品A', 10, 2), item('产品B', 20, 3)],
      ['00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000b'])];
    const enriched = attachEvidenceBindings(review, state);
    expect(enriched.evidence.previous.tickets[0]!.items.map((entry) => entry.productId))
      .toEqual(['00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000b']);
    expect(buildEvidenceGroupingState(enriched)[0]!.items.map((entry) => entry.productId))
      .toEqual(['00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000b']);
  });

  it('两层沿用：当前分组先对应，剩下的用拆开前 evidence 绑定补（不重复、不越界）', () => {
    const first = '00000000-0000-4000-8000-000000000001';
    const second = '00000000-0000-4000-8000-000000000002';
    const currentState = [
      stateTicket('WB:A', 2, [item('产品A', 10, 2)], [first]),
      stateTicket('WB:B', 4, [item('产品B', 20, 4)], [null]),
    ];
    const evidenceState = [stateTicket('WB:A', 2, [item('产品A', 10, 2), item('产品B', 20, 3)],
      [first, second])];
    const current = [
      parsedTicket('WB:A', 2, [item('产品A', 10, 2)]),
      parsedTicket('WB:B', 3, [item('产品B', 20, 3)]),
    ];
    const plan = buildAssociationCarryoverPlan(currentState, current, undefined, evidenceState);
    expect(plan).toEqual([
      { ticketKey: 'WB:A', itemKey: '产品a#0', productId: first },
      { ticketKey: 'WB:B', itemKey: '产品b#0', productId: second },
    ]);
  });
});
