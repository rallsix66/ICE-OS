import { describe, expect, it } from 'vitest';
import {
  buildShipmentAssociationSuggestions,
  buildShipmentMarketSummary,
  buildShipmentMarketSummaryFor,
  buildShipmentTicketValue,
  buildShipmentValueMarketDetails,
  buildShipmentValueOverview,
  type ShipmentMarketSummarySource,
  type ShipmentMarketSummarySourceItem,
} from './summary';
import type { ShipmentLinkedProductDto } from './types';

function card(itemId: string, iceCode: string, amountCny: string | null, nameCn = `${iceCode} 商品`): ShipmentLinkedProductDto {
  return {
    itemId,
    iceCode,
    nameCn,
    specificationText: '4.8g',
    specificationSource: 'name',
    unitText: null,
    cartonQuantity: null,
    unitCost: amountCny === null
      ? { state: 'missing', amountCny: null, label: '成本待补充', reason: '当前资料无可用数值进货价' }
      : { state: 'priced', amountCny, label: `¥${amountCny}`, reason: null },
  };
}

function item(overrides: Partial<ShipmentMarketSummarySourceItem>): ShipmentMarketSummarySourceItem {
  return {
    itemId: 'item-1',
    shipmentId: 'shipment-1',
    ticketNo: '无单号·泰国·行74',
    purchaseOrder: null,
    waybillsText: null,
    market: '泰国',
    statusClass: 'in_transit',
    productId: 'p-1',
    productNameRaw: 'WM0057 CHIC PEAK 腮红4.8g-M01',
    associationStatus: 'manual',
    shippedQuantity: 100,
    receivedQuantity: 0,
    receiptBasis: 'status_in_transit_zero',
    manualShippedQuantity: null,
    manualConflict: false,
    remainingQuantity: 100,
    remainingState: 'known',
    ...overrides,
  };
}

function source(items: ShipmentMarketSummarySourceItem[]): ShipmentMarketSummarySource {
  return {
    market: '泰国',
    unknownMarket: false,
    latestReadAt: '2026-11-04T01:39:56.863Z',
    snapshotId: 'snap-1',
    ticketCount: new Set(items.map((row) => row.shipmentId)).size,
    itemCount: items.length,
    items,
  };
}

describe('在途汇总：数量/货值口径', () => {
  it('同商品多明细按剩余在途合计数量与货值（精确十进制）', () => {
    const cards = new Map([['p-1', card('p-1', 'WM0057', '4.4')]]);
    const summary = buildShipmentMarketSummary(source([
      item({ itemId: 'a', shippedQuantity: 1080, remainingQuantity: 1080 }),
      item({ itemId: 'b', shippedQuantity: 3240, remainingQuantity: 3240 }),
      item({ itemId: 'c', shippedQuantity: 540, remainingQuantity: 540, shipmentId: 'shipment-2', ticketNo: 'P-2', purchaseOrder: 'PO-2' }),
    ]), cards);
    expect(summary.ticketCount).toBe(2);
    expect(summary.itemCount).toBe(3);
    expect(summary.products).toHaveLength(1);
    const product = summary.products[0];
    expect(product.remainingQuantity).toBe(4860);
    expect(product.quantityKnownItemCount).toBe(3);
    expect(product.ticketCount).toBe(2);
    expect(product.itemCount).toBe(3);
    // 4860 × 4.4 = 21384
    expect(product.valueCny).toBe('21384');
    expect(summary.totalValueCny).toBe('21384');
    expect(summary.pricedItemCount).toBe(3);
    expect(summary.excludedItemCount).toBe(0);
  });

  it('整票已上架（剩余 0）计入但货值为 0，不是未知', () => {
    const cards = new Map([['p-1', card('p-1', 'WM0057', '4.4')]]);
    const summary = buildShipmentMarketSummary(source([
      item({ itemId: 'a', shippedQuantity: 100, receivedQuantity: 100, receiptBasis: 'status_arrived_full', remainingQuantity: 0, statusClass: 'arrived' }),
    ]), cards);
    expect(summary.products[0].remainingQuantity).toBe(0);
    expect(summary.products[0].quantityKnownItemCount).toBe(1);
    expect(summary.products[0].valueCny).toBe('0');
    expect(summary.totalValueCny).toBe('0');
    expect(summary.excludedItemCount).toBe(0);
  });

  it('数量待核：不计数量、不计金额、单独列出（不写 0）', () => {
    const cards = new Map([['p-1', card('p-1', 'WM0052', '3.48')]]);
    const summary = buildShipmentMarketSummary(source([
      item({
        itemId: 'a', productNameRaw: 'CHICPEAK 按压唇冻 #02', shippedQuantity: 3042,
        receivedQuantity: null, receiptBasis: 'pending', remainingQuantity: null, remainingState: 'pending',
        statusClass: 'unknown', productId: 'p-1',
      }),
    ]), cards);
    expect(summary.products[0].remainingQuantity).toBe(0);
    expect(summary.products[0].quantityKnownItemCount).toBe(0);
    expect(summary.products[0].quantityPendingCount).toBe(1);
    expect(summary.products[0].valueCny).toBeNull();
    expect(summary.totalValueCny).toBeNull();
    expect(summary.quantityPendingCount).toBe(1);
    expect(summary.excludedItemCount).toBe(1);
    expect(summary.excludedItems[0].exclusion).toBe('quantity_pending');
    expect(summary.excludedItems[0].exclusionReason).toBe('数量待核');
    expect(summary.excludedItems[0].remainingQuantity).toBeNull();
    expect(summary.excludedItems[0].quantityIncluded).toBe(false);
  });

  it('缺单价：数量保留计入商品，金额不计入并说明条数', () => {
    const cards = new Map([['p-1', card('p-1', 'WM0099', null)]]);
    const summary = buildShipmentMarketSummary(source([
      item({ itemId: 'a', productId: 'p-1', shippedQuantity: 500, remainingQuantity: 500 }),
    ]), cards);
    expect(summary.products[0].remainingQuantity).toBe(500);
    expect(summary.products[0].pricedItemCount).toBe(0);
    expect(summary.products[0].unpricedItemCount).toBe(1);
    expect(summary.products[0].valueCny).toBeNull();
    expect(summary.totalValueCny).toBeNull();
    expect(summary.pricedItemCount).toBe(0);
    expect(summary.excludedByReason.priceMissing).toBe(1);
    expect(summary.excludedItems[0].exclusion).toBe('price_missing');
    expect(summary.excludedItems[0].remainingQuantity).toBe(500);
  });

  it('未关联商品：不进入商品分组，单独列为未关联商品', () => {
    const cards = new Map<string, ShipmentLinkedProductDto>();
    const summary = buildShipmentMarketSummary(source([
      item({ itemId: 'a', productId: null, associationStatus: 'none', shippedQuantity: 100, remainingQuantity: 100 }),
    ]), cards);
    expect(summary.products).toHaveLength(0);
    expect(summary.unboundItemCount).toBe(1);
    expect(summary.excludedItems[0].exclusion).toBe('unbound');
    expect(summary.excludedItems[0].product).toBeNull();
    expect(summary.totalValueCny).toBeNull();
  });

  it('部分计价：已计价明细合计，缺单价/待核分别计数且与未计入总数一致', () => {
    const cards = new Map([
      ['p-1', card('p-1', 'WM0057', '4.4')],
      ['p-2', card('p-2', 'WM0052', '3.48')],
      ['p-3', card('p-3', 'WM0099', null)],
    ]);
    const summary = buildShipmentMarketSummary(source([
      item({ itemId: 'a', productId: 'p-1', remainingQuantity: 1080, shippedQuantity: 1080 }),
      item({ itemId: 'b', productId: 'p-2', remainingQuantity: 3042, shippedQuantity: 3042 }),
      item({ itemId: 'c', productId: 'p-3', remainingQuantity: 10, shippedQuantity: 10 }),
      item({ itemId: 'd', productId: 'p-1', remainingQuantity: null, remainingState: 'pending', receivedQuantity: null, receiptBasis: 'pending' }),
      item({ itemId: 'e', productId: null, associationStatus: 'none', remainingQuantity: 5, shippedQuantity: 5 }),
    ]), cards);
    // 1080×4.4=4752；3042×3.48=10586.16 → 15338.16
    expect(summary.totalValueCny).toBe('15338.16');
    expect(summary.pricedItemCount).toBe(2);
    expect(summary.excludedByReason).toEqual({
      unbound: 1, quantityPending: 1, priceMissing: 1, reviewPending: 0,
    });
    expect(summary.excludedItemCount).toBe(3);
    expect(summary.products.map((row) => row.productId).sort()).toEqual(['p-1', 'p-2', 'p-3']);
    expect(summary.products.find((row) => row.productId === 'p-1')?.remainingQuantity).toBe(1080);
  });

  it('商品按已算货值从大到小排序，无货值商品在后', () => {
    const cards = new Map([
      ['p-1', card('p-1', 'WM0057', '4.4')],
      ['p-2', card('p-2', 'WM0059', '4.4')],
    ]);
    const summary = buildShipmentMarketSummary(source([
      item({ itemId: 'a', productId: 'p-1', remainingQuantity: 270, shippedQuantity: 270 }),
      item({ itemId: 'b', productId: 'p-2', remainingQuantity: 3240, shippedQuantity: 3240 }),
    ]), cards);
    expect(summary.products.map((row) => row.iceCode)).toEqual(['WM0059', 'WM0057']);
  });

  it('原表改发货量冲突：待复核优先，不计数量与货值，商品行单独计数', () => {
    const cards = new Map([['p-1', card('p-1', 'WM0057', '4.4')]]);
    const summary = buildShipmentMarketSummary(source([
      item({
        itemId: 'a', shippedQuantity: 60, receivedQuantity: 66, manualShippedQuantity: 80,
        manualConflict: true, remainingQuantity: 6, remainingState: 'known',
      }),
    ]), cards);
    expect(summary.totalValueCny).toBeNull();
    expect(summary.pricedItemCount).toBe(0);
    expect(summary.reviewPendingCount).toBe(1);
    expect(summary.excludedByReason.reviewPending).toBe(1);
    expect(summary.excludedItems[0]).toMatchObject({
      exclusion: 'review_pending',
      exclusionReason: '待复核',
      quantityIncluded: false,
      remainingQuantity: null,
      manualShippedQuantity: 80,
      shippedQuantity: 60,
    });
    expect(summary.products[0].quantityKnownItemCount).toBe(0);
    expect(summary.products[0].reviewPendingCount).toBe(1);
  });

  it('未知市场按未提供返回，不臆造市场名', () => {
    const cards = new Map([['p-1', card('p-1', 'WM0057', '4.4')]]);
    const summary = buildShipmentMarketSummary({
      ...source([item({ itemId: 'a', remainingQuantity: 10 })]),
      market: null,
      unknownMarket: true,
    }, cards);
    expect(summary.market).toBeNull();
    expect(summary.unknownMarket).toBe(true);
  });
});

describe('第十二轮：货值汇总「全部市场」按市场分行', () => {
  it('各市场分别合计金额与未计入条数，不把不同商品数量混加', () => {
    const cards = new Map([
      ['p-1', card('p-1', 'WM0057', '4.4')],
      ['p-2', card('p-2', 'LS101274', '2.11')],
    ]);
    const overview = buildShipmentValueOverview({
      market: null,
      unknownMarket: false,
      latestReadAt: '2026-11-06T02:13:00.000Z',
      snapshotId: 'snap-1',
      ticketCount: 3,
      itemCount: 4,
      items: [
        item({ itemId: 'a', shipmentId: 's-1', shippedQuantity: 1080, remainingQuantity: 1080 }),
        item({ itemId: 'b', shipmentId: 's-1', shippedQuantity: 540, remainingQuantity: 540 }),
        item({
          itemId: 'c', shipmentId: 's-2', market: '越南', productId: 'p-2', productNameRaw: '爽肤水',
          shippedQuantity: 100, remainingQuantity: 100,
        }),
        item({ itemId: 'd', shipmentId: 's-3', market: null, productId: null, associationStatus: 'none' }),
      ],
    }, cards);
    expect(overview.marketCount).toBe(3);
    expect(overview.markets).toHaveLength(3);
    const thai = overview.markets.find((row) => row.market === '泰国')!;
    expect(thai.ticketCount).toBe(1);
    expect(thai.itemCount).toBe(2);
    expect(thai.totalValueCny).toBe('7128'); // (1080+540) × 4.4
    const vietnam = overview.markets.find((row) => row.market === '越南')!;
    expect(vietnam.totalValueCny).toBe('211'); // 100 × 2.11
    const unknown = overview.markets.find((row) => row.unknownMarket)!;
    expect(unknown.totalValueCny).toBeNull();
    expect(unknown.excludedItemCount).toBe(1);
    expect(unknown.unboundItemCount).toBe(1);
    expect(overview.totalValueCny).toBe('7339');
    expect(overview.excludedItemCount).toBe(1);
  });
});

describe('第十三轮：单票在途货值', () => {
  function detailItem(overrides: Partial<{
    remainingQuantity: number | null;
    remainingState: 'known' | 'pending' | 'conflict';
    manualConflict: boolean;
    amountCny: string | null;
    product: boolean;
  }> = {}) {
    const options = {
      remainingQuantity: 1080,
      remainingState: 'known' as const,
      manualConflict: false,
      amountCny: '4.4',
      product: true,
      ...overrides,
    };
    return {
      itemId: 'item-1',
      itemKey: 'item#0',
      productNameRaw: 'WM0057 CHIC PEAK 腮红4.8g-M02',
      productNameNorm: 'wm0057chicpeak腮红4.8g-m02',
      shippedQuantity: 1080,
      receivedQuantity: 0,
      receiptBasis: 'status_in_transit_zero',
      remainingQuantity: options.remainingQuantity,
      remainingState: options.remainingState,
      unitText: null,
      sourceSku: null,
      sourceNote: null,
      product: options.product ? card('p-1', 'WM0058', options.amountCny) : null,
      associationStatus: 'manual',
      associationMethod: 'manual_selected',
      associatedAt: null,
      revision: 2,
      manualStatus: null,
      manualShelvedQuantity: null,
      manualShippedQuantity: null,
      previousConfirmedShelvedQuantity: null,
      manualConflict: options.manualConflict,
      manualActorName: null,
      manualAt: null,
      manualRevision: 0,
      manualReviewNeeded: false,
      manualReviewNote: null,
      sourceReceivedQuantity: 0,
      sourceReceiptBasis: 'status_in_transit_zero',
    };
  }

  it('逐条剩余 × 采用进货价；全部上架显示 0，未知/冲突/缺价计为未计入', () => {
    const value = buildShipmentTicketValue([
      detailItem({ remainingQuantity: 1080 }),
      detailItem({ remainingQuantity: 3240 }),
      detailItem({ remainingQuantity: 0 }),
      detailItem({ remainingState: 'pending', remainingQuantity: null }),
      detailItem({ manualConflict: true }),
      detailItem({ amountCny: null }),
    ] as never);
    expect(value.pricedItemCount).toBe(3);
    expect(value.excludedItemCount).toBe(3);
    expect(value.itemCount).toBe(6);
    expect(value.totalValueCny).toBe('19008'); // (1080+3240+0) × 4.4
  });

  it('全部明细都算不出 → 总额 null（页面显示「暂无法计算」），不写 0', () => {
    const value = buildShipmentTicketValue([
      detailItem({ product: false }),
      detailItem({ remainingState: 'pending', remainingQuantity: null }),
    ] as never);
    expect(value.totalValueCny).toBeNull();
    expect(value.pricedItemCount).toBe(0);
    expect(value.excludedItemCount).toBe(2);
  });

  it('明确全部上架（每条剩余 0）→ 货值 ¥0.00，而不是「暂无法计算」', () => {
    const value = buildShipmentTicketValue([
      detailItem({ remainingQuantity: 0 }),
      detailItem({ remainingQuantity: 0 }),
    ] as never);
    expect(value.totalValueCny).toBe('0');
    expect(value.pricedItemCount).toBe(2);
  });
});

describe('货值汇总：按市场就地展开（第十七轮）', () => {
  const cards = new Map([
    ['p-1', card('p-1', 'WM0057', '4.4')],
    ['p-2', card('p-2', 'WM0052', '3.48')],
    ['p-3', card('p-3', 'WM0071', null)],
  ]);

  function multiMarketSource(): ShipmentMarketSummarySource {
    return source([
      item({ itemId: 'th-1', shipmentId: 's-th', market: '泰国', productId: 'p-1', remainingQuantity: 100 }),
      item({ itemId: 'th-2', shipmentId: 's-th', market: '泰国', productId: null, productNameRaw: '未关联品', remainingQuantity: 40 }),
      item({
        itemId: 'vn-1', shipmentId: 's-vn', market: '越南', productId: 'p-2',
        shippedQuantity: 10, receivedQuantity: null, receiptBasis: 'pending',
        remainingQuantity: null, remainingState: 'pending', statusClass: 'unknown',
      }),
      item({
        itemId: 'my-1', shipmentId: 's-my', market: '马来西亚', productId: 'p-3', remainingQuantity: 5,
      }),
      item({
        itemId: 'no-1', shipmentId: 's-no', market: null, productId: null,
        productNameRaw: '无市场未关联', remainingQuantity: 3,
      }),
    ]);
  }

  it('展开数据与全部市场汇总一一对应：数量、货值、未计入条数一致', () => {
    const src = multiMarketSource();
    const overview = buildShipmentValueOverview(src, cards);
    const details = buildShipmentValueMarketDetails(src, cards);
    expect(details).toHaveLength(overview.markets.length);
    for (const row of overview.markets) {
      const detail = details.find((entry) => entry.market === row.market && entry.unknownMarket === row.unknownMarket);
      expect(detail).toBeDefined();
      expect(detail!.ticketCount).toBe(row.ticketCount);
      expect(detail!.itemCount).toBe(row.itemCount);
      expect(detail!.totalValueCny).toBe(row.totalValueCny);
      expect(detail!.excludedItemCount).toBe(row.excludedItemCount);
      expect(detail!.excludedItems).toHaveLength(row.excludedItemCount);
    }
    // 「未计入 N 条」= 各市场展开明细之和（页面两处数字来自同一份数据）
    expect(details.flatMap((detail) => detail.excludedItems)).toHaveLength(overview.excludedItemCount);
    expect(overview.excludedItemCount).toBe(4);
  });

  it('展开区商品构成是聚合行（数量/票/货值），不重复搬运逐条明细', () => {
    const details = buildShipmentValueMarketDetails(multiMarketSource(), cards);
    const th = details.find((detail) => detail.market === '泰国')!;
    expect(th.products).toHaveLength(1);
    expect(th.products[0]).toMatchObject({
      productId: 'p-1',
      iceCode: 'WM0057',
      remainingQuantity: 100,
      itemCount: 1,
      ticketCount: 1,
      valueCny: '440',
    });
    expect('items' in th.products[0]).toBe(false);
    // 未计入明细分原因，可点开原票；未关联行的商品卡为 null
    expect(th.excludedItems[0]).toMatchObject({ itemId: 'th-2', exclusion: 'unbound', product: null });
    expect(th.excludedItems[0].market).toBe('泰国');
  });

  it('选中单个市场：只返回该市场；未知市场用 __unknown__ 哨兵', () => {
    const src = multiMarketSource();
    const vn = buildShipmentMarketSummaryFor(src, cards, '越南');
    expect(vn.market).toBe('越南');
    expect(vn.itemCount).toBe(1);
    expect(vn.excludedItems[0].exclusion).toBe('quantity_pending');
    const unknown = buildShipmentMarketSummaryFor(src, cards, '__unknown__');
    expect(unknown.unknownMarket).toBe(true);
    expect(unknown.market).toBeNull();
    expect(unknown.itemCount).toBe(1);
    // 没有该市场的数据时返回空汇总，不伪造其它市场数据
    expect(buildShipmentMarketSummaryFor(src, cards, '菲律宾').itemCount).toBe(0);
  });

  it('同市场同品名建议：只给未关联明细、按次数与货号排序、最多 3 个', () => {
    const src = source([
      // 同市场同品名（规范化后忽略空白/大小写）出现过 2 次 p-1、1 次 p-2、1 次 p-3、1 次 p-4
      item({ itemId: 'a', market: '泰国', productId: 'p-1', productNameRaw: 'WM0057 腮红' }),
      item({ itemId: 'b', market: '泰国', productId: 'p-1', productNameRaw: 'wm0057腮红 ' }),
      item({ itemId: 'c', market: '泰国', productId: 'p-2', productNameRaw: 'WM0057 腮红' }),
      item({ itemId: 'd', market: '泰国', productId: 'p-3', productNameRaw: 'WM0057 腮红' }),
      // 未关联：同市场同品名 → 有建议
      item({ itemId: 'x', market: '泰国', productId: null, productNameRaw: 'WM0057 腮红' }),
      // 未关联但不同市场 → 不给建议
      item({ itemId: 'y', market: '越南', productId: null, productNameRaw: 'WM0057 腮红' }),
      // 未关联且市场为空 → 不给建议（人工对应要求市场非空）
      item({ itemId: 'z', market: null, productId: null, productNameRaw: 'WM0057 腮红' }),
      // 已关联的明细本身不需要建议
      item({ itemId: 'w', market: '泰国', productId: 'p-1', productNameRaw: 'WM0057 腮红' }),
    ]);
    const suggestions = buildShipmentAssociationSuggestions(src, cards);
    expect(Object.keys(suggestions).sort()).toEqual(['x']);
    expect(suggestions.x).toHaveLength(3);
    expect(suggestions.x[0]).toMatchObject({ productId: 'p-1', iceCode: 'WM0057', count: 3 });
    expect(suggestions.x[1]?.count).toBe(1);
    expect(suggestions.x[2]?.count).toBe(1);
  });

  it('没有同市场同品名可参考时不给空建议', () => {
    const src = source([
      item({ itemId: 'only', market: '泰国', productId: null, productNameRaw: '全新品名', remainingQuantity: 9 }),
    ]);
    expect(buildShipmentAssociationSuggestions(src, cards)).toEqual({});
  });
});
