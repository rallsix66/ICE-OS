import { describe, expect, it } from 'vitest';
import type {
  InventoryProductSummaryDto,
  InventoryProductSummaryRowDto,
  InventoryWarehouseRowDto,
  InventoryWarehouseRowsDto,
} from '@/features/inventory/types';
import type { ShipmentMarketSummarySource } from '@/features/shipment/summary';
import { summarizeMemberInventory, summarizeMemberShipment } from './aggregate';

function row(overrides: Partial<InventoryWarehouseRowDto>): InventoryWarehouseRowDto {
  return {
    source: 'bigseller',
    rowKey: overrides.rowKey ?? 'row',
    warehouseId: 'wh-vn',
    warehouseExternalId: '50455',
    warehouseName: '越南青林湾仓库',
    market: 'VN',
    status: 'adopted',
    itemId: 'item-a',
    iceCode: 'A',
    itemName: '商品 A',
    sourceName: '来源 A',
    externalSku: 'SKU-A',
    gtin: null,
    unit: '个',
    onHand: 10,
    orderLocked: null,
    warehouseAvailable: 8,
    activityReserved: null,
    inTransit: null,
    observationAt: '2026-11-18T16:22:18+08:00',
    batchId: null,
    excelRow: null,
    mappingStatus: 'confirmed',
    itemRevision: null,
    rawOnHand: '10',
    note: null,
    ...overrides,
  };
}

function warehouseState(overrides: Partial<InventoryWarehouseRowsDto['warehouses'][number]>) {
  return {
    warehouseId: 'wh-vn',
    externalId: '50455',
    name: '越南青林湾仓库',
    market: 'VN',
    warehouseStatus: 'confirmed',
    lastSuccessAt: '2026-11-18T16:22:18+08:00',
    lastBatchId: 'batch-vn',
    batchRows: 3,
    adoptedRows: 2,
    unmappedRows: 1,
    observationAt: '2026-11-18T16:22:18+08:00',
    publishedAt: null,
    failed: false,
    stale: false,
    lastErrorCode: null,
    latestRunStatus: 'success',
    pendingMappingRows: 1,
    ...overrides,
  };
}

function inventoryRows(rows: InventoryWarehouseRowDto[]): InventoryWarehouseRowsDto {
  return {
    total: rows.length,
    offset: 0,
    limit: rows.length,
    rows,
    scope: { warehouseCount: 2, lastAllSuccessAt: '2026-11-18T16:22:18+08:00' },
    marketOptions: [],
    warehouses: [
      warehouseState({}),
      warehouseState({
        warehouseId: 'wh-th',
        externalId: '56673',
        name: 'DEE-龙仔厝（ICE专属）',
        market: null,
        lastBatchId: 'batch-th',
        batchRows: 1,
        adoptedRows: 1,
        unmappedRows: 0,
        pendingMappingRows: 0,
      }),
    ],
    counts: { adopted: 3, unmapped: 1, pendingAdoption: 0, inactive: 0 },
  };
}

function summaryRow(overrides: Partial<InventoryProductSummaryRowDto>): InventoryProductSummaryRowDto {
  return {
    itemId: 'item-a',
    iceCode: 'A',
    nameCn: '商品 A',
    gtin: null,
    market: 'VN',
    knownSubtotal: 10,
    unitConflict: false,
    unitGroups: [],
    coveredWarehouseCount: 1,
    scopeWarehouseCount: 1,
    hasCurrentData: true,
    notMappedWarehouses: [],
    unseenWarehouses: [],
    failedWarehouses: [],
    lastObservedAt: '2026-11-18T16:22:18+08:00',
    mapped: true,
    hasPendingTotal: false,
    knownSubtotalComplete: true,
    pendingTotalWarehouses: [],
    marketCells: [{ market: 'VN', onHand: 10, skuCount: 1, warehouseCount: 1, hasPendingTotal: false }],
    overseasOnHand: 10,
    overseasSkuCount: 1,
    domestic: null,
    ...overrides,
  } as InventoryProductSummaryRowDto;
}

function productSummary(warehouseId: string, rows: InventoryProductSummaryRowDto[]): InventoryProductSummaryDto {
  return {
    total: rows.length,
    offset: 0,
    limit: 200,
    rows,
    scope: { warehouseCount: 1, lastAllSuccessAt: '2026-11-18T16:22:18+08:00', warehouseFilter: warehouseId },
    marketOptions: [],
    warehouses: [warehouseState({ warehouseId })],
    unmappedOverseasRows: 0,
    unmappedDomesticRows: 0,
    domesticAvailable: false,
    domesticReason: null,
  };
}

const warehouses = [
  { id: 'wh-vn', externalId: '50455', name: '越南青林湾仓库', market: 'VN' },
  { id: 'wh-th', externalId: '56673', name: 'DEE-龙仔厝（ICE专属）', market: null },
];

describe('成员经营总览 · 库存汇总', () => {
  it('只计商品汇总可明确计入的已采用行，实物/可售分别求和，缺价只计数不计金额', () => {
    const result = summarizeMemberInventory({
      rows: inventoryRows([
        row({ rowKey: 'vn-a', itemId: 'item-a', onHand: 10, warehouseAvailable: 8 }),
        row({ rowKey: 'vn-b', itemId: 'item-b', onHand: 5, warehouseAvailable: null, sourceName: '来源 B' }),
        row({ rowKey: 'vn-unmapped', itemId: null, status: 'unmapped', onHand: 99, warehouseAvailable: 99 }),
        row({
          rowKey: 'th-c',
          warehouseId: 'wh-th',
          warehouseExternalId: '56673',
          warehouseName: 'DEE-龙仔厝（ICE专属）',
          market: null,
          itemId: 'item-c',
          onHand: 100,
          warehouseAvailable: 90,
        }),
      ]),
      warehouses,
      productSummaries: [
        {
          warehouseId: 'wh-vn',
          summary: productSummary('wh-vn', [
            summaryRow({ itemId: 'item-a' }),
            summaryRow({ itemId: 'item-b', iceCode: 'B', nameCn: '商品 B', knownSubtotal: 5, overseasOnHand: 5 }),
          ]),
        },
        {
          warehouseId: 'wh-th',
          summary: productSummary('wh-th', [
            summaryRow({
              itemId: 'item-c',
              iceCode: 'C',
              nameCn: '商品 C',
              market: null,
              knownSubtotal: 100,
              overseasOnHand: 100,
              marketCells: [{ market: null, onHand: 100, skuCount: 1, warehouseCount: 1, hasPendingTotal: false }],
            }),
          ]),
        },
      ],
      costMap: { 'item-a': '2.5', 'item-c': '0.1' },
      canViewAmount: true,
      amountError: null,
    });

    expect(result.onHand).toBe(115);
    expect(result.available).toBe(98);
    expect(result.availableUnknownRows).toBe(1);
    expect(result.unmappedRows).toBe(1);
    expect(result.estimatedValueCny).toBe('¥35.00');
    expect(result.missingCostProducts).toBe(1);
    expect(result.pendingProductCount).toBe(0);
    expect(result.contributingWarehouseCount).toBe(2);
    const vn = result.warehouses.find((warehouse) => warehouse.warehouseId === 'wh-vn');
    expect(vn?.onHand).toBe(15);
    expect(vn?.available).toBe(8);
    expect(vn?.availableUnknownRows).toBe(1);
    expect(vn?.estimatedValueCny).toBe('¥25.00');
    expect(vn?.missingCostProducts).toBe(1);
    const th = result.warehouses.find((warehouse) => warehouse.warehouseId === 'wh-th');
    expect(th?.estimatedValueCny).toBe('¥10.00');
    expect(th?.missingCostProducts).toBe(0);
  });

  it('同仓多来源 SKU/单位冲突排除待核，同款商品其他仓的明确数量仍保留', () => {
    const result = summarizeMemberInventory({
      rows: inventoryRows([
        // 越南仓：同款商品两个来源 SKU，商品汇总判待核
        row({ rowKey: 'vn-p1', itemId: 'item-p', externalSku: 'SKU-P1', onHand: 10, warehouseAvailable: 4 }),
        row({ rowKey: 'vn-p2', itemId: 'item-p', externalSku: 'SKU-P2', onHand: 5, warehouseAvailable: 3 }),
        // 泰国仓：同款商品单 SKU，可明确计入
        row({
          rowKey: 'th-p1',
          warehouseId: 'wh-th',
          warehouseExternalId: '56673',
          warehouseName: 'DEE-龙仔厝（ICE专属）',
          market: null,
          itemId: 'item-p',
          externalSku: 'SKU-P3',
          onHand: 7,
          warehouseAvailable: 6,
        }),
        // 越南仓：单位冲突
        row({ rowKey: 'vn-q1', itemId: 'item-q', externalSku: 'SKU-Q1', unit: '个', onHand: 9, warehouseAvailable: 9 }),
        row({ rowKey: 'vn-q2', itemId: 'item-q', externalSku: 'SKU-Q2', unit: '箱', onHand: 2, warehouseAvailable: 2 }),
      ]),
      warehouses,
      productSummaries: [
        {
          warehouseId: 'wh-vn',
          summary: productSummary('wh-vn', [
            summaryRow({
              itemId: 'item-p',
              iceCode: 'WM0026',
              nameCn: '待核商品 P',
              knownSubtotal: null,
              knownSubtotalComplete: false,
              hasPendingTotal: true,
              overseasOnHand: null,
              pendingTotalWarehouses: [{
                warehouseId: 'wh-vn',
                externalId: '50455',
                name: '越南青林湾仓库',
                unit: '个',
                rowCount: 2,
                rows: [],
              }],
            }),
            summaryRow({
              itemId: 'item-q',
              iceCode: 'WM0030',
              nameCn: '单位冲突商品 Q',
              knownSubtotal: null,
              knownSubtotalComplete: false,
              unitConflict: true,
              overseasOnHand: null,
            }),
          ]),
        },
        {
          warehouseId: 'wh-th',
          summary: productSummary('wh-th', [
            summaryRow({
              itemId: 'item-p',
              iceCode: 'WM0026',
              nameCn: '待核商品 P',
              market: null,
              knownSubtotal: 7,
              overseasOnHand: 7,
              marketCells: [{ market: null, onHand: 7, skuCount: 1, warehouseCount: 1, hasPendingTotal: false }],
            }),
          ]),
        },
      ],
      costMap: { 'item-p': '2' },
      canViewAmount: true,
      amountError: null,
    });

    // 越南待核 15 件/7 可售；单位冲突 9 个 + 2 箱按单位拆分，不再合成 11。
    expect(result.onHand).toBe(7);
    expect(result.available).toBe(6);
    expect(result.estimatedValueCny).toBe('¥14.00');
    expect(result.pendingProductCount).toBe(2);
    expect(result.pendingUnitConflictProductCount).toBe(1);
    expect(result.pendingOnHand).toBe(15);
    expect(result.pendingAvailable).toBe(7);
    expect(result.contributingWarehouseCount).toBe(1);
    expect(result.dataTime).toBe('2026-11-18T16:22:18+08:00');
    expect(result.pendingProducts.map((product) => product.iceCode)).toEqual(['WM0026', 'WM0030']);
    expect(result.pendingProducts.find((product) => product.iceCode === 'WM0026')?.warehouseNames).toEqual(['越南青林湾仓库']);
    expect(result.pendingProducts.find((product) => product.iceCode === 'WM0026')?.reasons).toContain('同仓多来源 SKU');
    const unitConflictProduct = result.pendingProducts.find((product) => product.iceCode === 'WM0030');
    expect(unitConflictProduct?.unitConflict).toBe(true);
    expect(unitConflictProduct?.reasons).toContain('多单位，不合计');
    expect(unitConflictProduct?.pendingOnHand).toBeNull();
    expect(unitConflictProduct?.pendingAvailable).toBeNull();
    expect(unitConflictProduct?.unitGroups).toEqual([
      { unit: '个', warehouseNames: ['越南青林湾仓库'], pendingOnHand: 9, pendingAvailable: 9 },
      { unit: '箱', warehouseNames: ['越南青林湾仓库'], pendingOnHand: 2, pendingAvailable: 2 },
    ]);
    const vn = result.warehouses.find((warehouse) => warehouse.warehouseId === 'wh-vn');
    expect(vn?.onHand).toBeNull();
    expect(vn?.available).toBeNull();
    expect(vn?.pendingProductCount).toBe(2);
    expect(vn?.pendingUnitConflictCount).toBe(1);
    expect(vn?.pendingOnHand).toBeNull();
    expect(vn?.pendingAvailable).toBeNull();
    const th = result.warehouses.find((warehouse) => warehouse.warehouseId === 'wh-th');
    expect(th?.onHand).toBe(7);
    expect(th?.available).toBe(6);
  });

  it('跨授权仓同款商品单位不同：A 仓 10 个 / B 仓 2 箱整款不合计，各仓原始单位保留', () => {
    const vnMultiSummary = summaryRow({
      itemId: 'item-multi',
      iceCode: 'WM0100',
      nameCn: '跨仓多单位商品',
      knownSubtotal: 10,
      overseasOnHand: 10,
      unitGroups: [{ unit: '个', knownSubtotal: 10, rowCount: 1 }],
      marketCells: [{ market: 'VN', onHand: 10, skuCount: 1, warehouseCount: 1, hasPendingTotal: false }],
    });
    const thMultiSummary = summaryRow({
      itemId: 'item-multi',
      iceCode: 'WM0100',
      nameCn: '跨仓多单位商品',
      market: null,
      knownSubtotal: 2,
      overseasOnHand: 2,
      unitGroups: [{ unit: '箱', knownSubtotal: 2, rowCount: 1 }],
      marketCells: [{ market: null, onHand: 2, skuCount: 1, warehouseCount: 1, hasPendingTotal: false }],
    });
    const vnSameSummary = summaryRow({
      itemId: 'item-same',
      iceCode: 'WM0101',
      nameCn: '同单位正常商品',
      knownSubtotal: 5,
      overseasOnHand: 5,
      unitGroups: [{ unit: '个', knownSubtotal: 5, rowCount: 1 }],
      marketCells: [{ market: 'VN', onHand: 5, skuCount: 1, warehouseCount: 1, hasPendingTotal: false }],
    });
    const thSameSummary = summaryRow({
      itemId: 'item-same',
      iceCode: 'WM0101',
      nameCn: '同单位正常商品',
      market: null,
      knownSubtotal: 3,
      overseasOnHand: 3,
      unitGroups: [{ unit: '个', knownSubtotal: 3, rowCount: 1 }],
      marketCells: [{ market: null, onHand: 3, skuCount: 1, warehouseCount: 1, hasPendingTotal: false }],
    });
    // 正式商品汇总在完整授权范围内的单位集合：{个, 箱}，unitCount=2。
    expect(new Set([
      ...vnMultiSummary.unitGroups.map((group) => group.unit),
      ...thMultiSummary.unitGroups.map((group) => group.unit),
    ])).toEqual(new Set(['个', '箱']));

    const multiRows = [
      row({
        rowKey: 'vn-multi',
        itemId: 'item-multi',
        externalSku: 'SKU-M-UNIT',
        unit: '个',
        onHand: 10,
        warehouseAvailable: 8,
      }),
      row({
        rowKey: 'th-multi',
        warehouseId: 'wh-th',
        warehouseExternalId: '56673',
        warehouseName: 'DEE-龙仔厝（ICE专属）',
        market: null,
        itemId: 'item-multi',
        externalSku: 'SKU-M-BOX',
        unit: '箱',
        onHand: 2,
        warehouseAvailable: 2,
      }),
    ];
    const multiSummaries = [
      { warehouseId: 'wh-vn', summary: productSummary('wh-vn', [vnMultiSummary]) },
      { warehouseId: 'wh-th', summary: productSummary('wh-th', [thMultiSummary]) },
    ];

    // 只看 A 10 个 + B 2 箱：旧逻辑会得到 12 / ¥24.00，补修后首页没有已知合计。
    const onlyMulti = summarizeMemberInventory({
      rows: inventoryRows(multiRows),
      warehouses,
      productSummaries: multiSummaries,
      costMap: { 'item-multi': '2' },
      canViewAmount: true,
      amountError: null,
    });
    expect(onlyMulti.onHand).toBeNull();
    expect(onlyMulti.onHand).not.toBe(12);
    expect(onlyMulti.available).toBeNull();
    expect(onlyMulti.estimatedValueCny).toBeNull();
    expect(onlyMulti.estimatedValueCny).not.toBe('¥24.00');
    expect(onlyMulti.pendingProductCount).toBe(1);
    expect(onlyMulti.pendingUnitConflictProductCount).toBe(1);

    const result = summarizeMemberInventory({
      rows: inventoryRows([
        ...multiRows,
        row({ rowKey: 'vn-same', itemId: 'item-same', externalSku: 'SKU-S-VN', unit: '个', onHand: 5, warehouseAvailable: 5 }),
        row({
          rowKey: 'th-same',
          warehouseId: 'wh-th',
          warehouseExternalId: '56673',
          warehouseName: 'DEE-龙仔厝（ICE专属）',
          market: null,
          itemId: 'item-same',
          externalSku: 'SKU-S-TH',
          unit: '个',
          onHand: 3,
          warehouseAvailable: 3,
        }),
      ]),
      warehouses,
      productSummaries: [
        { warehouseId: 'wh-vn', summary: productSummary('wh-vn', [vnMultiSummary, vnSameSummary]) },
        { warehouseId: 'wh-th', summary: productSummary('wh-th', [thMultiSummary, thSameSummary]) },
      ],
      costMap: { 'item-multi': '2', 'item-same': '2' },
      canViewAmount: true,
      amountError: null,
    });

    // 首页合计只保留同单位正常商品 5+3；多单位商品的 10 个/2 箱不再得到 12 / ¥24.00。
    expect(result.onHand).toBe(8);
    expect(result.onHand).not.toBe(12);
    expect(result.available).toBe(8);
    expect(result.estimatedValueCny).toBe('¥16.00');
    expect(result.estimatedValueCny).not.toBe('¥24.00');
    expect(result.contributingWarehouseCount).toBe(2);
    expect(result.pendingProductCount).toBe(1);
    expect(result.pendingUnitConflictProductCount).toBe(1);
    expect(result.pendingOnHand).toBe(0);
    expect(result.pendingAvailable).toBe(0);

    const product = result.pendingProducts[0];
    expect(product?.unitConflict).toBe(true);
    expect(product?.pendingOnHand).toBeNull();
    expect(product?.pendingAvailable).toBeNull();
    expect(product?.reasons).toContain('多单位，不合计');
    expect(product?.warehouseNames).toEqual(['DEE-龙仔厝（ICE专属）', '越南青林湾仓库']);
    expect(product?.unitGroups).toHaveLength(2);
    expect(product?.unitGroups).toEqual(expect.arrayContaining([
      { unit: '个', warehouseNames: ['越南青林湾仓库'], pendingOnHand: 10, pendingAvailable: 8 },
      { unit: '箱', warehouseNames: ['DEE-龙仔厝（ICE专属）'], pendingOnHand: 2, pendingAvailable: 2 },
    ]));

    // 各仓保留本仓可核对数量：A 仓 = 多单位 10 + 正常 5，B 仓 = 多单位 2 + 正常 3；
    // 但它们不进入首页 8 / 8 / ¥16.00。
    const vn = result.warehouses.find((warehouse) => warehouse.warehouseId === 'wh-vn');
    expect(vn?.onHand).toBe(15);
    expect(vn?.available).toBe(13);
    expect(vn?.estimatedValueCny).toBe('¥30.00');
    expect(vn?.pendingUnitConflictCount).toBe(1);
    expect(vn?.pendingOnHand).toBeNull();
    expect(vn?.pendingAvailable).toBeNull();
    const th = result.warehouses.find((warehouse) => warehouse.warehouseId === 'wh-th');
    expect(th?.onHand).toBe(5);
    expect(th?.available).toBe(5);
    expect(th?.estimatedValueCny).toBe('¥10.00');
    expect(th?.pendingUnitConflictCount).toBe(1);
    expect(th?.pendingOnHand).toBeNull();
    expect(th?.pendingAvailable).toBeNull();
  });

  it('无金额权限时不计算货值，也不把缺价写成 0', () => {
    const result = summarizeMemberInventory({
      rows: inventoryRows([row({})]),
      warehouses: [warehouses[0]],
      productSummaries: [{
        warehouseId: 'wh-vn',
        summary: productSummary('wh-vn', [summaryRow({})]),
      }],
      costMap: null,
      canViewAmount: false,
      amountError: null,
    });
    expect(result.estimatedValueCny).toBeNull();
    expect(result.missingCostProducts).toBe(0);
    expect(result.canViewAmount).toBe(false);
  });
});

function shipmentSource(items: ShipmentMarketSummarySource['items']): ShipmentMarketSummarySource {
  return {
    market: null,
    unknownMarket: false,
    latestReadAt: '2026-11-18T17:08:20+08:00',
    snapshotId: 'snap-1',
    ticketCount: new Set(items.map((item) => item.shipmentId)).size,
    itemCount: items.length,
    items,
  };
}

function shipmentItem(overrides: Partial<ShipmentMarketSummarySource['items'][number]>) {
  return {
    itemId: 'item-1',
    shipmentId: 'ticket-1',
    ticketNo: 'T-1',
    purchaseOrder: null,
    waybillsText: null,
    market: '越南',
    statusClass: 'in_transit' as const,
    productId: null,
    productNameRaw: '商品',
    associationStatus: 'none' as const,
    shippedQuantity: 10,
    receivedQuantity: 0,
    receiptBasis: 'status_in_transit_zero' as const,
    manualShippedQuantity: null,
    manualConflict: false,
    remainingQuantity: 10,
    remainingState: 'known' as const,
    ...overrides,
  };
}

describe('成员经营总览 · 物流汇总', () => {
  it('只计获授市场，票数去重，未知数量与人工冲突归入待核', () => {
    const result = summarizeMemberShipment(shipmentSource([
      shipmentItem({ itemId: 'vn-1', shipmentId: 'ticket-1', market: '越南', remainingQuantity: 10 }),
      shipmentItem({
        itemId: 'vn-2',
        shipmentId: 'ticket-1',
        market: '越南',
        remainingQuantity: null,
        remainingState: 'pending',
      }),
      shipmentItem({
        itemId: 'vn-3',
        shipmentId: 'ticket-2',
        market: '越南',
        remainingQuantity: 5,
        manualConflict: true,
      }),
      shipmentItem({ itemId: 'th-1', shipmentId: 'ticket-3', market: '泰国', remainingQuantity: 7 }),
      shipmentItem({ itemId: 'ph-1', shipmentId: 'ticket-4', market: '菲律宾', remainingQuantity: 999 }),
    ]), ['越南', '泰国', '马来西亚']);

    expect(result.ticketCount).toBe(3);
    expect(result.itemCount).toBe(4);
    expect(result.knownRemaining).toBe(17);
    expect(result.pendingItemCount).toBe(2);
    expect(result.latestReadAt).toBe('2026-11-18T17:08:20+08:00');
    const vn = result.markets.find((market) => market.market === '越南');
    expect(vn).toMatchObject({ ticketCount: 2, itemCount: 3, knownRemaining: 10, pendingItemCount: 2 });
    const th = result.markets.find((market) => market.market === '泰国');
    expect(th).toMatchObject({ ticketCount: 1, itemCount: 1, knownRemaining: 7, pendingItemCount: 0 });
    const my = result.markets.find((market) => market.market === '马来西亚');
    expect(my).toMatchObject({ ticketCount: 0, itemCount: 0, knownRemaining: 0, pendingItemCount: 0 });
    expect(result.markets.some((market) => market.market === '菲律宾')).toBe(false);
  });

  it('有票但全部数量未知时已知剩余为 null，不写 0', () => {
    const result = summarizeMemberShipment(shipmentSource([
      shipmentItem({ itemId: 'vn-1', shipmentId: 'ticket-1', market: '越南', remainingQuantity: null, remainingState: 'pending' }),
    ]), ['越南']);
    expect(result.ticketCount).toBe(1);
    expect(result.knownRemaining).toBeNull();
    expect(result.markets[0]?.knownRemaining).toBeNull();
    expect(result.pendingItemCount).toBe(1);
  });
});
