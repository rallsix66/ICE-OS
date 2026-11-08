import { describe, expect, it } from 'vitest';
import {
  aggregateHome,
  paginateHomeProducts,
  searchHomeProducts,
  type HomeAggregateInput,
  type HomeProductRow,
} from './aggregate';
import type {
  InventoryDomesticRowDto,
  InventoryDomesticSnapshotDto,
  InventoryProductMarketCellDto,
  InventoryProductSummaryRowDto,
} from '@/features/inventory/types';
import type { ShipmentMarketSummarySourceItem } from '@/features/shipment/summary';
import type {
  ShipmentMarketSummaryDto,
  ShipmentSummaryItemDto,
  ShipmentSummaryProductDto,
  ShipmentValueMarketRowDto,
  ShipmentValueOverviewDto,
} from '@/features/shipment/types';

/* ------------------------------------------------------------------ *
 * 测试数据构造（只造纯 DTO，不读库/不读文件）
 * ------------------------------------------------------------------ */

function product(
  overrides: Partial<InventoryProductSummaryRowDto> & Pick<InventoryProductSummaryRowDto, 'itemId'>,
): InventoryProductSummaryRowDto {
  return {
    iceCode: null,
    nameCn: null,
    gtin: null,
    market: null,
    knownSubtotal: null,
    unitConflict: false,
    unitGroups: [{ unit: '件', knownSubtotal: null, rowCount: 1 }],
    coveredWarehouseCount: 1,
    scopeWarehouseCount: 1,
    notMappedWarehouses: [],
    unseenWarehouses: [],
    failedWarehouses: [],
    lastObservedAt: '2026-11-06T10:00:00.000Z',
    mapped: true,
    marketCells: [],
    overseasOnHand: null,
    overseasSkuCount: 0,
    domestic: null,
    ...overrides,
  };
}

function cell(market: string | null, onHand: number | null): InventoryProductMarketCellDto {
  return { market, onHand, skuCount: 1, warehouseCount: 1, hasPendingTotal: false };
}

let domesticRowSeq = 0;

function domesticRow(overrides: Partial<InventoryDomesticRowDto>): InventoryDomesticRowDto {
  domesticRowSeq += 1;
  const seq = domesticRowSeq;
  return {
    source: 'domestic',
    legacyCandidateId: `candidate-${seq}`,
    itemId: null,
    iceCode: null,
    itemNameCn: null,
    externalSku: `SKU-${seq}`,
    sourceName: null,
    actualQty: null,
    availableQty: null,
    cloudAvailableText: null,
    rawActualText: null,
    rawAvailableText: null,
    unit: null,
    warehouseLabel: '国内 · 原表未注明仓库',
    sheet: null,
    excelRow: seq,
    fileDate: '2026-11-01',
    fileName: 'domestic-20261101.xlsx',
    frozenFileSha256: 'sha256-domestic',
    reviewState: 'manual_selected',
    quantityState: 'ok',
    note: null,
    ...overrides,
  };
}

function domesticSnapshot(
  rows: InventoryDomesticRowDto[],
  overrides: Partial<InventoryDomesticSnapshotDto> = {},
): InventoryDomesticSnapshotDto {
  const selected = rows.filter((row) => row.reviewState === 'manual_selected');
  const linked = selected.filter((row) => row.itemId !== null);
  return {
    available: true,
    reason: null,
    releaseKey: 'release-1',
    sourceRecordsSha256: 'sha256-domestic',
    recordCount: rows.length,
    selectedCount: selected.length,
    linkedSelectedCount: linked.length,
    linkedItemCount: new Set(linked.map((row) => row.itemId)).size,
    unlinkedSelectedCount: selected.length - linked.length,
    fileDates: [
      { fileDate: '2026-11-01', fileName: 'domestic-20261101.xlsx', frozenFileSha256: 'sha256-domestic', recordCount: rows.length },
    ],
    rows,
    cached: true,
    ...overrides,
  };
}

function transitItem(overrides: Partial<ShipmentMarketSummarySourceItem> = {}): ShipmentMarketSummarySourceItem {
  return {
    itemId: 'transit-item-1',
    shipmentId: 'shipment-1',
    ticketNo: 'PO-1',
    purchaseOrder: 'PO-1',
    waybillsText: null,
    market: '泰国',
    statusClass: 'in_transit',
    productId: 'P1',
    productNameRaw: '商品一',
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

function transitSummaryItem(overrides: Partial<ShipmentSummaryItemDto> = {}): ShipmentSummaryItemDto {
  return {
    itemId: 'excluded-1',
    shipmentId: 'shipment-1',
    ticketNo: 'PO-1',
    purchaseOrder: 'PO-1',
    waybillsText: null,
    productNameRaw: '未计入商品',
    product: null,
    shippedQuantity: 10,
    receivedQuantity: 0,
    receiptBasis: 'status_in_transit_zero',
    manualShippedQuantity: null,
    manualConflict: false,
    remainingQuantity: null,
    remainingState: 'pending',
    quantityIncluded: false,
    valueCny: null,
    exclusion: 'unbound',
    exclusionReason: '未关联商品',
    ...overrides,
  };
}

function transitProduct(
  overrides: Partial<ShipmentSummaryProductDto> & Pick<ShipmentSummaryProductDto, 'productId'>,
): ShipmentSummaryProductDto {
  return {
    iceCode: null,
    nameCn: null,
    specificationText: '',
    specificationSource: 'none',
    unitText: null,
    unitCost: { state: 'missing', amountCny: null, label: '成本待补充', reason: null },
    remainingQuantity: 0,
    quantityKnownItemCount: 0,
    quantityPendingCount: 0,
    reviewPendingCount: 0,
    pricedItemCount: 0,
    unpricedItemCount: 0,
    itemCount: 0,
    ticketCount: 0,
    valueCny: null,
    items: [],
    ...overrides,
  };
}

function transitSummary(overrides: Partial<ShipmentMarketSummaryDto> = {}): ShipmentMarketSummaryDto {
  return {
    market: null,
    unknownMarket: false,
    latestReadAt: null,
    snapshotId: 'snapshot-1',
    ticketCount: 0,
    itemCount: 0,
    products: [],
    totalValueCny: null,
    pricedItemCount: 0,
    unpricedItemCount: 0,
    quantityPendingCount: 0,
    reviewPendingCount: 0,
    unboundItemCount: 0,
    excludedItemCount: 0,
    excludedByReason: { unbound: 0, quantityPending: 0, priceMissing: 0, reviewPending: 0 },
    excludedItems: [],
    ...overrides,
  };
}

function valueMarket(
  overrides: Partial<ShipmentValueMarketRowDto> & Pick<ShipmentValueMarketRowDto, 'market'>,
): ShipmentValueMarketRowDto {
  return {
    unknownMarket: overrides.market === null,
    ticketCount: 0,
    itemCount: 0,
    totalValueCny: null,
    pricedItemCount: 0,
    excludedItemCount: 0,
    unboundItemCount: 0,
    quantityPendingCount: 0,
    reviewPendingCount: 0,
    priceMissingItemCount: 0,
    ...overrides,
  };
}

function valueOverview(markets: ShipmentValueMarketRowDto[]): ShipmentValueOverviewDto {
  return {
    latestReadAt: null,
    snapshotId: 'snapshot-1',
    marketCount: markets.length,
    ticketCount: markets.reduce((sum, row) => sum + row.ticketCount, 0),
    itemCount: markets.reduce((sum, row) => sum + row.itemCount, 0),
    totalValueCny: null,
    pricedItemCount: 0,
    excludedItemCount: 0,
    markets,
  };
}

function baseInput(overrides: Partial<HomeAggregateInput> = {}): HomeAggregateInput {
  return {
    amountsVisible: true,
    domestic: null,
    products: [],
    costMap: {},
    transit: transitSummary(),
    transitMarkets: valueOverview([]),
    transitItems: [],
    mappingQueueTotal: 0,
    marketLabels: { TH: '泰国', VN: '越南' },
    domesticFileDate: null,
    overseasTime: null,
    transitTime: null,
    ...overrides,
  };
}

function homeRow(
  overrides: Partial<HomeProductRow> & Pick<HomeProductRow, 'itemId'>,
): HomeProductRow {
  return {
    iceCode: null,
    nameCn: null,
    gtin: null,
    unit: null,
    domesticOnHand: null,
    overseasOnHand: null,
    transitRemaining: null,
    transitPending: false,
    pendingTotal: false,
    costCny: null,
    inventoryValueCny: null,
    valueIncomplete: false,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ *
 * 国内阶段
 * ------------------------------------------------------------------ */

describe('国内阶段：冻结快照的数量口径', () => {
  it('数量异常/未关联不计入合计，unknownItems 与 excludedItems 分开计数', () => {
    const domestic = domesticSnapshot([
      domesticRow({ itemId: 'A', actualQty: 10.9 }),
      domesticRow({ itemId: 'A', actualQty: 5 }),
      domesticRow({ itemId: 'B', quantityState: 'missing', actualQty: null }),
      domesticRow({ itemId: 'C', quantityState: 'invalid', actualQty: -3 }),
      domesticRow({ itemId: null, quantityState: 'ok', actualQty: 8 }),
      domesticRow({ itemId: 'A', reviewState: 'pending', actualQty: 100 }),
    ]);

    const result = aggregateHome(baseInput({
      domestic,
      costMap: { A: '4.4' },
      products: [product({ itemId: 'A' })],
    }));

    // 10.9 → 10 截断；pending 行不是冻结有效选择，不计。
    expect(result.stages.domestic.quantity).toBe(15);
    expect(result.stages.domestic.unknownItems).toBe(2);
    // 非 ok 的 selected 行 2 条 + 未关联的冻结选择 1 条。
    expect(result.stages.domestic.excludedItems).toBe(3);
    expect(result.stages.domestic.pricedQuantity).toBe(15);
    expect(result.stages.domestic.unpricedQuantity).toBe(0);
    expect(result.stages.domestic.valueCny).toBe('66');
    expect(result.products[0]?.domesticOnHand).toBe(15);
  });

  it('快照不可用：数量与货值为 null，未关联选择单独提示', () => {
    const result = aggregateHome(baseInput({
      domestic: {
        ...domesticSnapshot([]),
        available: false,
        reason: '国内冻结快照未读取',
        unlinkedSelectedCount: 2,
      },
      costMap: { A: '1' },
      products: [product({ itemId: 'A', overseasOnHand: 4, marketCells: [cell('TH', 4)] })],
    }));

    expect(result.stages.domestic.quantity).toBeNull();
    expect(result.stages.domestic.valueCny).toBeNull();
    expect(result.stages.domestic.unknownItems).toBe(2);
    expect(result.stages.domestic.excludedItems).toBe(2);
    expect(result.products[0]?.domesticOnHand).toBeNull();
    // 海外阶段不受国内不可用影响。
    expect(result.stages.overseas.quantity).toBe(4);
  });

  it('没有国内快照时数量为 null（不是 0）', () => {
    const result = aggregateHome(baseInput({ domestic: null }));
    expect(result.stages.domestic.quantity).toBeNull();
    expect(result.stages.domestic.valueCny).toBeNull();
    expect(result.stages.domestic.unknownItems).toBe(0);
    expect(result.stages.domestic.excludedItems).toBe(0);
  });

  it('只在国内快照出现的商品也进入商品概览，海外数量保持未知', () => {
    const domestic = domesticSnapshot([domesticRow({ itemId: 'D1', actualQty: 7 })]);
    const result = aggregateHome(baseInput({
      domestic,
      products: [product({ itemId: 'A' })],
      costMap: { D1: '2' },
    }));

    const row = result.products.find((item) => item.itemId === 'D1');
    expect(row?.domesticOnHand).toBe(7);
    expect(row?.overseasOnHand).toBeNull();
    expect(row?.inventoryValueCny).toBeNull();
    expect(row?.valueIncomplete).toBe(true);
    expect(result.productCount).toBe(result.products.length);
  });
});

/* ------------------------------------------------------------------ *
 * 海外阶段
 * ------------------------------------------------------------------ */

describe('海外阶段：null 不当 0、缺价单独计数', () => {
  it('数量未知保持 null，缺价数量进 unpricedQuantity、金额不计', () => {
    const products = [
      product({ itemId: 'P1', overseasOnHand: 12, marketCells: [cell('TH', 12)] }),
      product({ itemId: 'P2', overseasOnHand: null, marketCells: [cell('TH', null)] }),
      product({ itemId: 'P3', overseasOnHand: 5, marketCells: [cell('VN', 5)] }),
      product({ itemId: 'P4', overseasOnHand: null }),
    ];

    const result = aggregateHome(baseInput({ products, costMap: { P1: '4.4', P2: '2' } }));

    expect(result.stages.overseas.quantity).toBe(17);
    expect(result.stages.overseas.unknownItems).toBe(1);
    expect(result.stages.overseas.pricedQuantity).toBe(12);
    expect(result.stages.overseas.unpricedQuantity).toBe(5);
    expect(result.stages.overseas.valueCny).toBe('52.8');
    expect(result.valuation.unknownQuantityProducts).toBe(1);
    expect(result.valuation.missingCostProducts).toEqual([
      { itemId: 'P3', iceCode: null, nameCn: null, quantity: 5 },
    ]);
    expect(result.valuation.missingCostQuantity).toBe(5);
  });
});

/* ------------------------------------------------------------------ *
 * 在途阶段
 * ------------------------------------------------------------------ */

describe('在途阶段：只计入数量明确的已知剩余', () => {
  it('数量待核/待复核不计数量，未关联与缺价进入 excludedByReason', () => {
    const items = [
      transitItem({ itemId: 'a', productId: 'P1', market: '泰国', remainingQuantity: 100 }),
      transitItem({ itemId: 'b', productId: 'P1', market: '泰国', remainingQuantity: 0 }),
      transitItem({
        itemId: 'c', productId: 'P2', market: '泰国',
        shippedQuantity: 20, remainingQuantity: null, remainingState: 'pending', receiptBasis: 'pending',
      }),
      transitItem({ itemId: 'd', productId: 'P2', market: '泰国', manualConflict: true, remainingQuantity: 50 }),
      transitItem({ itemId: 'e', productId: null, market: null, remainingQuantity: 30 }),
    ];
    const transit = transitSummary({
      ticketCount: 4,
      itemCount: items.length,
      totalValueCny: '440',
      quantityPendingCount: 1,
      reviewPendingCount: 1,
      unboundItemCount: 1,
      excludedItemCount: 3,
      excludedByReason: { unbound: 1, quantityPending: 1, priceMissing: 1, reviewPending: 1 },
      excludedItems: [
        transitSummaryItem({ itemId: 'ex-1', exclusion: 'unbound', remainingQuantity: 30 }),
        transitSummaryItem({ itemId: 'ex-2', exclusion: 'quantity_pending', remainingQuantity: null }),
        transitSummaryItem({ itemId: 'ex-3', exclusion: 'price_missing', remainingQuantity: 30 }),
      ],
    });

    const result = aggregateHome(baseInput({ transit, transitItems: items }));

    expect(result.stages.transit.quantity).toBe(130);
    expect(result.stages.transit.unknownItems).toBe(2);
    expect(result.stages.transit.excludedItems).toBe(3);
    expect(result.stages.transit.unpricedQuantity).toBe(30);
    // 130 已知剩余 - 缺价 30 - 未关联 30 = 70 真正参与金额。
    expect(result.stages.transit.pricedQuantity).toBe(70);
    expect(result.stages.transit.valueCny).toBe('440');
    expect(result.valuation.transitExclusions).toEqual({
      unbound: 1,
      quantityPending: 1,
      priceMissing: 1,
      reviewPending: 1,
    });
  });
});

/* ------------------------------------------------------------------ *
 * 市场合并
 * ------------------------------------------------------------------ */

describe('市场行：库存代码 + 在途中文名 + 未知市场', () => {
  it('按中文名反查代码合并，查不到保留原名，待确认放最后', () => {
    const products = [
      product({ itemId: 'P1', overseasOnHand: 10, marketCells: [cell('TH', 10)] }),
      product({ itemId: 'P2', overseasOnHand: 4, marketCells: [cell('VN', 4)] }),
      product({ itemId: 'P3', overseasOnHand: 7, marketCells: [cell('TH', 7), cell(null, null)] }),
    ];
    const items = [
      transitItem({ itemId: 't1', market: '泰国', remainingQuantity: 5 }),
      transitItem({ itemId: 't2', market: '美国', remainingQuantity: 3 }),
      transitItem({ itemId: 't3', market: null, remainingQuantity: 2 }),
    ];
    const transitMarkets = valueOverview([
      valueMarket({ market: '泰国', ticketCount: 2, totalValueCny: '20' }),
      valueMarket({ market: '美国', ticketCount: 1, totalValueCny: '5' }),
      valueMarket({ market: null, ticketCount: 1, totalValueCny: null }),
    ]);

    const result = aggregateHome(baseInput({
      products,
      costMap: { P1: '2', P2: '1', P3: '2' },
      transit: transitSummary({ ticketCount: 4, itemCount: items.length }),
      transitItems: items,
      transitMarkets,
    }));

    expect(result.markets.map((row) => [row.market, row.label])).toEqual([
      ['TH', '泰国'],
      ['VN', '越南'],
      ['美国', '美国'],
      [null, '市场待确认'],
    ]);

    const th = result.markets[0]!;
    expect(th.onHand).toBe(17);
    expect(th.onHandValueCny).toBe('34');
    expect(th.transitRemaining).toBe(5);
    expect(th.transitTickets).toBe(2);
    expect(th.transitValueCny).toBe('20');

    const vn = result.markets[1]!;
    expect(vn.onHand).toBe(4);
    expect(vn.onHandValueCny).toBe('4');
    expect(vn.transitRemaining).toBeNull();
    expect(vn.transitTickets).toBe(0);
    expect(vn.transitValueCny).toBeNull();

    const us = result.markets[2]!;
    expect(us.onHand).toBeNull();
    expect(us.transitRemaining).toBe(3);
    expect(us.transitTickets).toBe(1);
    expect(us.transitValueCny).toBe('5');

    const unknown = result.markets[3]!;
    expect(unknown.onHand).toBeNull();
    expect(unknown.unknownProducts).toBe(1);
    expect(unknown.transitRemaining).toBe(2);
    expect(result.valuation.unknownMarketProducts).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * 商品行
 * ------------------------------------------------------------------ */

describe('商品行：三列数量与估值完整性', () => {
  it('库存货值只在成本与国内外数量都已知时计算，缺口用 valueIncomplete 标记', () => {
    const products = [
      product({
        itemId: 'P1', iceCode: 'A1', nameCn: '商品一', gtin: '6901',
        overseasOnHand: 2, marketCells: [cell('TH', 2)],
      }),
      product({ itemId: 'P2', overseasOnHand: null, marketCells: [cell('TH', null)] }),
      product({ itemId: 'P3', overseasOnHand: 3 }),
      product({ itemId: 'P4', overseasOnHand: 4 }),
    ];
    const domestic = domesticSnapshot([
      domesticRow({ itemId: 'P1', actualQty: 3 }),
      domesticRow({ itemId: 'P2', quantityState: 'missing', actualQty: null }),
    ]);
    const transit = transitSummary({
      products: [
        transitProduct({ productId: 'P1', remainingQuantity: 5, quantityKnownItemCount: 2 }),
        transitProduct({
          productId: 'P3', remainingQuantity: 0, quantityKnownItemCount: 0, quantityPendingCount: 1,
        }),
      ],
    });

    const result = aggregateHome(baseInput({
      products,
      domestic,
      costMap: { P1: '10', P3: '2' },
      transit,
    }));

    const p1 = result.products[0]!;
    expect(p1.domesticOnHand).toBe(3);
    expect(p1.overseasOnHand).toBe(2);
    expect(p1.transitRemaining).toBe(5);
    expect(p1.transitPending).toBe(false);
    expect(p1.costCny).toBe('10');
    expect(p1.inventoryValueCny).toBe('50');
    expect(p1.valueIncomplete).toBe(false);
    expect(p1.unit).toBe('件');

    // 三列数量都未知：没有可计入数量，不算「部分未计入」。
    const p2 = result.products[1]!;
    expect(p2.domesticOnHand).toBeNull();
    expect(p2.overseasOnHand).toBeNull();
    expect(p2.transitRemaining).toBeNull();
    expect(p2.inventoryValueCny).toBeNull();
    expect(p2.valueIncomplete).toBe(false);

    // 海外有数量、国内未知、在途全部待核：估值不完整，在途剩余保持 null。
    const p3 = result.products[2]!;
    expect(p3.overseasOnHand).toBe(3);
    expect(p3.domesticOnHand).toBeNull();
    expect(p3.transitRemaining).toBeNull();
    expect(p3.transitPending).toBe(true);
    expect(p3.inventoryValueCny).toBeNull();
    expect(p3.valueIncomplete).toBe(true);

    // 有数量但缺成本：估值不完整，不写 0。
    const p4 = result.products[3]!;
    expect(p4.overseasOnHand).toBe(4);
    expect(p4.costCny).toBeNull();
    expect(p4.inventoryValueCny).toBeNull();
    expect(p4.valueIncomplete).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 金额权限
 * ------------------------------------------------------------------ */

describe('金额权限', () => {
  it('amountsVisible=false 时所有阶段与市场金额为 null，数量口径不变', () => {
    const products = [
      product({ itemId: 'P1', overseasOnHand: 10, marketCells: [cell('TH', 10)] }),
    ];
    const domestic = domesticSnapshot([domesticRow({ itemId: 'P1', actualQty: 2 })]);
    const transit = transitSummary({
      totalValueCny: '100',
      excludedItems: [
        transitSummaryItem({ exclusion: 'price_missing', remainingQuantity: 1 }),
      ],
    });
    const items = [transitItem({ itemId: 'a', market: '泰国', remainingQuantity: 5 })];
    const transitMarkets = valueOverview([
      valueMarket({ market: '泰国', ticketCount: 1, totalValueCny: '100' }),
    ]);

    const result = aggregateHome(baseInput({
      amountsVisible: false,
      products,
      domestic,
      costMap: { P1: '3' },
      transit,
      transitItems: items,
      transitMarkets,
    }));

    expect(result.stages.domestic.valueCny).toBeNull();
    expect(result.stages.overseas.valueCny).toBeNull();
    expect(result.stages.transit.valueCny).toBeNull();
    expect(result.markets[0]?.onHandValueCny).toBeNull();
    expect(result.markets[0]?.transitValueCny).toBeNull();
    expect(result.products[0]?.costCny).toBeNull();
    expect(result.products[0]?.inventoryValueCny).toBeNull();

    // 数量与缺口统计不受金额权限影响。
    expect(result.stages.domestic.quantity).toBe(2);
    expect(result.stages.domestic.pricedQuantity).toBe(2);
    expect(result.stages.overseas.quantity).toBe(10);
    expect(result.stages.transit.quantity).toBe(5);
    expect(result.stages.transit.unpricedQuantity).toBe(1);
    expect(result.markets[0]?.onHand).toBe(10);
    expect(result.markets[0]?.transitRemaining).toBe(5);
  });
});

/* ------------------------------------------------------------------ *
 * 估值缺口与时点
 * ------------------------------------------------------------------ */

describe('估值缺口与时点', () => {
  it('缺价商品取国内+海外已知数量，按数量降序；国内独有商品也列出', () => {
    const domestic = domesticSnapshot([
      domesticRow({ itemId: 'D1', actualQty: 6, iceCode: 'D-1', itemNameCn: '国内独有品' }),
      domesticRow({ itemId: 'P1', actualQty: 3 }),
    ]);

    const result = aggregateHome(baseInput({
      domestic,
      products: [
        product({
          itemId: 'P1', iceCode: 'P-1', overseasOnHand: 2, marketCells: [cell('TH', 2)],
        }),
      ],
      mappingQueueTotal: 7,
    }));

    expect(result.valuation.missingCostProducts).toEqual([
      { itemId: 'D1', iceCode: 'D-1', nameCn: '国内独有品', quantity: 6 },
      { itemId: 'P1', iceCode: 'P-1', nameCn: null, quantity: 5 },
    ]);
    expect(result.valuation.missingCostQuantity).toBe(11);
    expect(result.valuation.unmappedSourceRows).toBe(7);
    expect(result.stages.domestic.unpricedQuantity).toBe(9);
    expect(result.stages.overseas.unpricedQuantity).toBe(2);
  });

  it('时点原样回传，productCount 为商品汇总行数', () => {
    const result = aggregateHome(baseInput({
      products: [product({ itemId: 'A' }), product({ itemId: 'B' })],
      domesticFileDate: '2026-11-01',
      overseasTime: '2026-11-06T10:00:00.000Z',
      transitTime: '2026-11-07T09:00:00.000Z',
    }));

    expect(result.times).toEqual({
      domestic: '2026-11-01',
      overseas: '2026-11-06T10:00:00.000Z',
      transit: '2026-11-07T09:00:00.000Z',
    });
    expect(result.productCount).toBe(2);
  });
});

/* ------------------------------------------------------------------ *
 * 补修：合计待核对 / 仅在途商品 / 成本读取失败
 * ------------------------------------------------------------------ */

describe('海外已知小计与合计待核对', () => {
  it('已知小计保留数量，阶段卡、商品行与缺口统一标记待核对', () => {
    const products = [
      product({
        itemId: 'A',
        overseasOnHand: 100,
        hasPendingTotal: true,
        knownSubtotalComplete: false,
        marketCells: [cell('PH', null)],
      }),
    ];

    const result = aggregateHome(baseInput({ products, costMap: { A: '2' } }));

    expect(result.stages.overseas.quantity).toBe(100);
    expect(result.stages.overseas.pendingTotalProducts).toBe(1);
    // 数量未知与「已知小计但合计待核对」分开计数：本行数量已知，故 unknownItems 为 0。
    expect(result.stages.overseas.unknownItems).toBe(0);
    expect(result.products[0]?.pendingTotal).toBe(true);
    expect(result.valuation.pendingTotalProducts).toBe(1);
    expect(result.valuation.pendingTotalItems).toEqual([
      { itemId: 'A', iceCode: null, nameCn: null, quantity: 100 },
    ]);
  });
});

describe('仅在途出现的已绑定商品进入商品概览', () => {
  it('补齐并集、可搜索，国内/海外保持未知', () => {
    const products = [product({ itemId: 'A', overseasOnHand: 1 })];
    const transit = transitSummary({
      products: [
        transitProduct({
          productId: 'T1',
          iceCode: 'TEST-PG-NEW122-0',
          nameCn: '仅在途商品',
          remainingQuantity: 3840,
          quantityKnownItemCount: 1,
        }),
      ],
    });
    const transitItems = [transitItem({ productId: 'T1', market: '菲律宾', remainingQuantity: 3840 })];

    const result = aggregateHome(baseInput({ products, transit, transitItems }));

    const row = result.products.find((item) => item.itemId === 'T1');
    expect(row).toBeTruthy();
    expect(row?.domesticOnHand).toBeNull();
    expect(row?.overseasOnHand).toBeNull();
    expect(row?.transitRemaining).toBe(3840);
    expect(row?.valueIncomplete).toBe(true);
    expect(result.productCount).toBe(result.products.length);
    expect(result.productCount).toBe(2);
    expect(searchHomeProducts(result.products, 'TEST-PG-NEW122-0')).toHaveLength(1);
  });
});

describe('进货价读取失败与缺价区分', () => {
  it('成本不可用时金额为空、缺价不可判断、不生成补价清单', () => {
    const domestic = domesticSnapshot([domesticRow({ itemId: 'A', actualQty: 5 })]);
    const products = [
      product({ itemId: 'A', overseasOnHand: 10, marketCells: [cell('TH', 10)] }),
    ];

    const result = aggregateHome(baseInput({
      products,
      domestic,
      costMap: { A: '2' },
      costUnavailable: true,
    }));

    expect(result.stages.domestic.valueCny).toBeNull();
    expect(result.stages.domestic.pricedQuantity).toBe(0);
    expect(result.stages.domestic.unpricedQuantity).toBe(0);
    expect(result.stages.overseas.valueCny).toBeNull();
    expect(result.stages.overseas.pricedQuantity).toBe(0);
    expect(result.stages.overseas.unpricedQuantity).toBe(0);
    expect(result.products[0]?.costCny).toBeNull();
    expect(result.products[0]?.inventoryValueCny).toBeNull();
    expect(result.products[0]?.valueIncomplete).toBe(false);
    expect(result.valuation.costUnavailable).toBe(true);
    expect(result.valuation.missingCostProducts).toEqual([]);
    expect(result.valuation.missingCostQuantity).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * 搜索与分页
 * ------------------------------------------------------------------ */

describe('商品概览搜索', () => {
  const rows = [
    homeRow({ itemId: '1', iceCode: 'ICE-001', nameCn: '玫瑰面霜', gtin: '690123' }),
    homeRow({ itemId: '2', iceCode: 'ice-002', nameCn: 'Blemish Gel', gtin: null }),
    homeRow({ itemId: '3', iceCode: null, nameCn: null, gtin: '690999' }),
  ];

  it('空查询返回全部，去首尾空白', () => {
    expect(searchHomeProducts(rows, '')).toHaveLength(3);
    expect(searchHomeProducts(rows, '   ')).toHaveLength(3);
  });

  it('大小写不敏感，货号/名称/69 编码任一命中', () => {
    expect(searchHomeProducts(rows, 'ice-0').map((row) => row.itemId)).toEqual(['1', '2']);
    expect(searchHomeProducts(rows, '面霜').map((row) => row.itemId)).toEqual(['1']);
    expect(searchHomeProducts(rows, 'GEL').map((row) => row.itemId)).toEqual(['2']);
    expect(searchHomeProducts(rows, ' 6909 ').map((row) => row.itemId)).toEqual(['3']);
    expect(searchHomeProducts(rows, '不存在的商品')).toEqual([]);
  });

  it('不修改入参数组', () => {
    const source = rows.slice();
    searchHomeProducts(source, 'gel');
    expect(source).toEqual(rows);
  });
});

describe('商品概览分页', () => {
  const rows = Array.from({ length: 12 }, (_unused, index) => homeRow({ itemId: String(index + 1) }));

  it('按 pageSize 切片并返回当前页/总页数/总数', () => {
    const page = paginateHomeProducts(rows, 2, 5);
    expect(page.total).toBe(12);
    expect(page.pageCount).toBe(3);
    expect(page.page).toBe(2);
    expect(page.rows.map((row) => row.itemId)).toEqual(['6', '7', '8', '9', '10']);
  });

  it('页码夹到 1..pageCount', () => {
    expect(paginateHomeProducts(rows, 0, 5).page).toBe(1);
    expect(paginateHomeProducts(rows, -3, 5).page).toBe(1);
    expect(paginateHomeProducts(rows, 99, 5).page).toBe(3);
    expect(paginateHomeProducts(rows, Number.NaN, 5).page).toBe(1);
  });

  it('pageSize 夹到 1..50', () => {
    const huge = paginateHomeProducts(rows, 1, 999);
    expect(huge.pageCount).toBe(1);
    expect(huge.rows).toHaveLength(12);

    const tiny = paginateHomeProducts(rows, 1, 0);
    expect(tiny.pageCount).toBe(12);
    expect(tiny.rows).toHaveLength(1);
  });

  it('空列表：total=0、pageCount=1、page=1', () => {
    expect(paginateHomeProducts([], 5, 10)).toEqual({
      rows: [],
      page: 1,
      pageCount: 1,
      total: 0,
    });
  });
});
