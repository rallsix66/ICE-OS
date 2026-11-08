import { describe, expect, it } from 'vitest';

import {
  buildProductTransit,
  countWaybills,
  type ProductTransitItemRow,
  type ProductTransitSource,
  type ProductTransitTicketRow,
} from './product-transit';

function item(overrides: Partial<ProductTransitItemRow> = {}): ProductTransitItemRow {
  return {
    itemId: 'item-1',
    shippedQuantity: 1000,
    receivedQuantity: 0,
    manualConflict: false,
    manualCorrected: false,
    ...overrides,
  };
}

function ticket(overrides: Partial<ProductTransitTicketRow> = {}): ProductTransitTicketRow {
  return {
    shipmentId: 'shipment-1',
    ticketNo: 'POKNZX000001',
    purchaseOrder: 'POKNZX000001',
    market: '越南',
    waybillsText: null,
    statusClass: 'in_transit',
    effectiveStatusClass: 'in_transit',
    transportText: null,
    arrivalText: null,
    ticketItemCount: 1,
    items: [item()],
    ...overrides,
  };
}

function source(tickets: ProductTransitTicketRow[]): ProductTransitSource {
  return { productId: 'product-1', latestReadAt: '2026-11-05T09:21:56.354Z', snapshotId: 'snap-1', tickets };
}

describe('countWaybills', () => {
  it('按换行/斜杠等分隔符数运单，不把空文本当 0 之外的数', () => {
    expect(countWaybills('VN000000078820\nVN000000078837\nVN000000078842')).toBe(3);
    expect(countWaybills('88035691/88035692/88035693/')).toBe(3);
    expect(countWaybills('A、B；C')).toBe(3);
    expect(countWaybills('')).toBe(0);
    expect(countWaybills(null)).toBe(0);
  });
});

describe('buildProductTransit：逐条明细后再按票合成（R11）', () => {
  it('同票同商品两行：第一行剩余 100、第二行待核 → 已知 100 + 1 条待核（受控数据）', () => {
    const view = buildProductTransit(source([
      ticket({
        shipmentId: 's-multi',
        ticketNo: 'POKNZX099999',
        purchaseOrder: 'POKNZX099999',
        market: '越南',
        ticketItemCount: 2,
        items: [
          item({ itemId: 'item-known', shippedQuantity: 100, receivedQuantity: 0 }),
          item({ itemId: 'item-pending', shippedQuantity: 50, receivedQuantity: null }),
        ],
      }),
    ]));

    expect(view.ticketCount).toBe(1);
    expect(view.knownRemaining).toBe(100);
    expect(view.pendingItemCount).toBe(1);
    expect(view.conflictItemCount).toBe(0);
    expect(view.allPending).toBe(false);

    const row = view.tickets[0];
    expect(row).toMatchObject({
      shippedQuantity: 150,
      // 已知累计只加数量明确的明细（0），不是 150 也不是整票待核。
      receivedQuantity: 0,
      remainingQuantity: 100,
      remainingState: 'known',
      pendingItemCount: 1,
      conflictItemCount: 0,
      itemCount: 2,
      ticketItemCount: 2,
    });

    // 卡片与市场小计：已知 100、1 条待核；采购单只列一次。
    expect(view.markets).toHaveLength(1);
    expect(view.markets[0]).toMatchObject({
      market: '越南',
      ticketCount: 1,
      knownRemaining: 100,
      pendingItemCount: 1,
      purchaseOrders: ['POKNZX099999'],
    });
  });

  it('同票同商品两行：第二行数量冲突只排除第二行，已知 100 照常计入', () => {
    const view = buildProductTransit(source([
      ticket({
        ticketNo: 'POKNZX099999',
        purchaseOrder: 'POKNZX099999',
        ticketItemCount: 2,
        items: [
          item({ itemId: 'item-known', shippedQuantity: 100, receivedQuantity: 0 }),
          item({
            itemId: 'item-conflict',
            shippedQuantity: 80,
            receivedQuantity: 999,
            manualConflict: true,
            manualCorrected: true,
          }),
        ],
      }),
    ]));

    expect(view.knownRemaining).toBe(100);
    expect(view.pendingItemCount).toBe(1);
    expect(view.conflictItemCount).toBe(1);
    expect(view.tickets[0]).toMatchObject({
      shippedQuantity: 180,
      receivedQuantity: 0,
      remainingQuantity: 100,
      remainingState: 'known',
      pendingItemCount: 1,
      conflictItemCount: 1,
      manualConflict: true,
      manualCorrected: true,
    });
    expect(view.markets[0]).toMatchObject({
      knownRemaining: 100,
      pendingItemCount: 1,
      conflictItemCount: 1,
    });
    expect(view.allPending).toBe(false);
  });

  it('同票同商品两行都待核 → 才是「待核」；待核条数按条计', () => {
    const view = buildProductTransit(source([
      ticket({
        ticketNo: 'POKNZX099999',
        ticketItemCount: 2,
        items: [
          item({ itemId: 'item-a', shippedQuantity: 50, receivedQuantity: null }),
          item({ itemId: 'item-b', shippedQuantity: 30, receivedQuantity: null }),
        ],
      }),
    ]));

    expect(view.tickets[0]).toMatchObject({
      shippedQuantity: 80,
      receivedQuantity: null,
      remainingQuantity: null,
      remainingState: 'pending',
      pendingItemCount: 2,
    });
    expect(view.knownRemaining).toBe(0);
    expect(view.pendingItemCount).toBe(2);
    expect(view.allPending).toBe(true);
    expect(view.markets[0]).toMatchObject({ knownRemaining: 0, pendingItemCount: 2 });
  });

  it('同票同商品两行都明确已全部上架 → 已知剩余 0（不是「待核」）', () => {
    const view = buildProductTransit(source([
      ticket({
        ticketNo: 'POKNZX099999',
        ticketItemCount: 2,
        items: [
          item({ itemId: 'item-a', shippedQuantity: 60, receivedQuantity: 60 }),
          item({ itemId: 'item-b', shippedQuantity: 40, receivedQuantity: 40 }),
        ],
      }),
    ]));

    expect(view.tickets[0]).toMatchObject({
      shippedQuantity: 100,
      receivedQuantity: 100,
      remainingQuantity: 0,
      remainingState: 'known',
      pendingItemCount: 0,
    });
    expect(view.knownRemaining).toBe(0);
    expect(view.allPending).toBe(false);
    expect(view.markets[0]).toMatchObject({ knownRemaining: 0, pendingItemCount: 0 });
  });

  it('已上架一条剩余 0 + 另一条待核：已知 0（不是待核），并标 1 条待核', () => {
    const view = buildProductTransit(source([
      ticket({
        ticketItemCount: 2,
        items: [
          item({ itemId: 'item-a', shippedQuantity: 60, receivedQuantity: 60 }),
          item({ itemId: 'item-b', shippedQuantity: 40, receivedQuantity: null }),
        ],
      }),
    ]));

    expect(view.tickets[0]).toMatchObject({
      receivedQuantity: 60,
      remainingQuantity: 0,
      remainingState: 'known',
      pendingItemCount: 1,
    });
    expect(view.knownRemaining).toBe(0);
    expect(view.allPending).toBe(false);
    expect(view.markets[0]).toMatchObject({ knownRemaining: 0, pendingItemCount: 1 });
  });

  it('LS101274：027388 的三万已知在途，027084 的八万待核不计入（验收口径）', () => {
    const view = buildProductTransit(source([
      ticket({
        shipmentId: 's-027388',
        ticketNo: 'POKNZX027388',
        purchaseOrder: 'POKNZX027388',
        waybillsText: 'VN000000078820\nVN000000078837\nVN000000078842',
        statusClass: 'arrived_pending_shelving',
        effectiveStatusClass: 'arrived_pending_shelving',
        items: [item({ shippedQuantity: 30000, receivedQuantity: 0 })],
      }),
      ticket({
        shipmentId: 's-027084',
        ticketNo: 'POKNZX027084',
        purchaseOrder: 'POKNZX027084',
        statusClass: 'partial',
        effectiveStatusClass: 'partial',
        items: [item({ shippedQuantity: 80000, receivedQuantity: null })],
      }),
    ]));

    expect(view.ticketCount).toBe(2);
    expect(view.knownRemaining).toBe(30000);
    expect(view.pendingItemCount).toBe(1);
    expect(view.conflictItemCount).toBe(0);
    expect(view.allPending).toBe(false);

    const first = view.tickets.find((entry) => entry.ticketNo === 'POKNZX027388');
    expect(first).toMatchObject({
      shippedQuantity: 30000,
      receivedQuantity: 0,
      remainingQuantity: 30000,
      remainingState: 'known',
      waybillCount: 3,
      itemCount: 1,
    });
    const pending = view.tickets.find((entry) => entry.ticketNo === 'POKNZX027084');
    expect(pending).toMatchObject({
      shippedQuantity: 80000,
      receivedQuantity: null,
      remainingQuantity: null,
      remainingState: 'pending',
    });

    expect(view.markets).toHaveLength(1);
    expect(view.markets[0]).toMatchObject({
      market: '越南',
      ticketCount: 2,
      knownRemaining: 30000,
      pendingItemCount: 1,
      conflictItemCount: 0,
      purchaseOrders: ['POKNZX027388', 'POKNZX027084'],
    });
  });

  it('WM0098：本品已全部上架时已知剩余为 0，不因同票其它商品变成待核', () => {
    const view = buildProductTransit(source([
      ticket({
        shipmentId: 's-026710',
        ticketNo: 'POKNZX026710',
        purchaseOrder: 'POKNZX026710',
        market: '泰国',
        statusClass: 'partial',
        ticketItemCount: 2,
        items: [item({ shippedQuantity: 14000, receivedQuantity: 14000 })],
      }),
    ]));

    expect(view.knownRemaining).toBe(0);
    expect(view.pendingItemCount).toBe(0);
    expect(view.allPending).toBe(false);
    expect(view.tickets[0]).toMatchObject({
      receivedQuantity: 14000,
      remainingQuantity: 0,
      remainingState: 'known',
      itemCount: 1,
      ticketItemCount: 2,
    });
  });

  it('只有待核票时全部待核（卡片显示「待核」而不是 0）', () => {
    const view = buildProductTransit(source([
      ticket({ ticketNo: 'POKNZX027084', items: [item({ shippedQuantity: 80000, receivedQuantity: null })] }),
    ]));
    expect(view.knownRemaining).toBe(0);
    expect(view.pendingItemCount).toBe(1);
    expect(view.allPending).toBe(true);
    expect(view.markets[0]).toMatchObject({ knownRemaining: 0, pendingItemCount: 1 });
  });

  it('发货量冲突（待复核）不按已全部上架计入在途，也不伪装成 0 条待核', () => {
    const view = buildProductTransit(source([
      ticket({
        ticketNo: 'POKNZX027084',
        items: [item({ shippedQuantity: 60000, receivedQuantity: 80000, manualConflict: true, manualCorrected: true })],
      }),
    ]));
    expect(view.tickets[0]).toMatchObject({
      remainingQuantity: null,
      remainingState: 'pending',
      manualConflict: true,
    });
    expect(view.knownRemaining).toBe(0);
    expect(view.pendingItemCount).toBe(1);
    expect(view.conflictItemCount).toBe(1);
    expect(view.allPending).toBe(true);
  });

  it('已到货但累计大于发货量属于数量不成立，按待核不写负数', () => {
    const view = buildProductTransit(source([
      ticket({ items: [item({ shippedQuantity: 100, receivedQuantity: 120 })] }),
    ]));
    expect(view.tickets[0]).toMatchObject({ remainingQuantity: null, remainingState: 'pending' });
    expect(view.knownRemaining).toBe(0);
    expect(view.pendingItemCount).toBe(1);
  });

  it('多市场分组、采购单去重、无采购单号的票仍保留行', () => {
    const view = buildProductTransit(source([
      ticket({ shipmentId: 's-1', ticketNo: 'T-1', purchaseOrder: 'PO-1', market: '泰国', items: [item({ shippedQuantity: 1000, receivedQuantity: 200 })] }),
      ticket({ shipmentId: 's-2', ticketNo: 'T-2', purchaseOrder: 'PO-1', market: '泰国', items: [item({ shippedQuantity: 500, receivedQuantity: 0 })] }),
      ticket({ shipmentId: 's-3', ticketNo: 'T-3', purchaseOrder: null, market: '越南', items: [item({ shippedQuantity: 300, receivedQuantity: 300 })] }),
      ticket({ shipmentId: 's-4', ticketNo: 'T-4', purchaseOrder: null, market: null, items: [item({ shippedQuantity: 10, receivedQuantity: null })] }),
    ]));

    expect(view.markets.map((entry) => entry.market)).toEqual(['泰国', '越南', null]);
    expect(view.markets[0]).toMatchObject({
      ticketCount: 2,
      knownRemaining: 1300,
      purchaseOrders: ['PO-1'],
    });
    expect(view.markets[1]).toMatchObject({ ticketCount: 1, knownRemaining: 0, purchaseOrders: [] });
    expect(view.markets[2]).toMatchObject({ ticketCount: 1, pendingItemCount: 1, purchaseOrders: [] });
    expect(view.tickets.find((entry) => entry.shipmentId === 's-3')?.purchaseOrder).toBeNull();
    expect(view.knownRemaining).toBe(1300);
    expect(view.allPending).toBe(false);
  });

  it('没有在途票时合计为 0 且不是「全部待核」', () => {
    const view = buildProductTransit(source([]));
    expect(view).toMatchObject({
      ticketCount: 0,
      knownRemaining: 0,
      pendingItemCount: 0,
      allPending: false,
      tickets: [],
      markets: [],
    });
  });
});
