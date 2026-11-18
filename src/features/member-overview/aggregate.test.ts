import { describe, expect, it } from 'vitest';
import type { InventoryWarehouseRowDto, InventoryWarehouseRowsDto } from '@/features/inventory/types';
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

function inventoryRows(rows: InventoryWarehouseRowDto[]): InventoryWarehouseRowsDto {
  return {
    total: rows.length,
    offset: 0,
    limit: rows.length,
    rows,
    scope: { warehouseCount: 2, lastAllSuccessAt: '2026-11-18T16:22:18+08:00' },
    marketOptions: [],
    warehouses: [
      {
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
      },
      {
        warehouseId: 'wh-th',
        externalId: '56673',
        name: 'DEE-龙仔厝（ICE专属）',
        market: null,
        warehouseStatus: 'confirmed',
        lastSuccessAt: '2026-11-18T16:22:18+08:00',
        lastBatchId: 'batch-th',
        batchRows: 1,
        adoptedRows: 1,
        unmappedRows: 0,
        observationAt: '2026-11-18T16:22:18+08:00',
        publishedAt: null,
        failed: false,
        stale: false,
        lastErrorCode: null,
        latestRunStatus: 'success',
        pendingMappingRows: 0,
      },
    ],
    counts: { adopted: 3, unmapped: 1, pendingAdoption: 0, inactive: 0 },
  };
}

describe('成员经营总览 · 库存汇总', () => {
  it('只计已采用行，实物/可售分别求和，缺价只计数不计金额', () => {
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
      warehouses: [
        { id: 'wh-vn', externalId: '50455', name: '越南青林湾仓库', market: 'VN' },
        { id: 'wh-th', externalId: '56673', name: 'DEE-龙仔厝（ICE专属）', market: null },
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
    expect(result.dataTime).toBe('2026-11-18T16:22:18+08:00');
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

  it('无金额权限时不计算货值，也不把缺价写成 0', () => {
    const result = summarizeMemberInventory({
      rows: inventoryRows([row({})]),
      warehouses: [{ id: 'wh-vn', externalId: '50455', name: '越南青林湾仓库', market: 'VN' }],
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
    const vn = result.markets.find((row) => row.market === '越南');
    expect(vn).toMatchObject({ ticketCount: 2, itemCount: 3, knownRemaining: 10, pendingItemCount: 2 });
    const th = result.markets.find((row) => row.market === '泰国');
    expect(th).toMatchObject({ ticketCount: 1, itemCount: 1, knownRemaining: 7, pendingItemCount: 0 });
    const my = result.markets.find((row) => row.market === '马来西亚');
    expect(my).toMatchObject({ ticketCount: 0, itemCount: 0, knownRemaining: 0, pendingItemCount: 0 });
    expect(result.markets.some((row) => row.market === '菲律宾')).toBe(false);
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
