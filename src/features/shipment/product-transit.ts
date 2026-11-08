import type {
  ProductShipmentTransitDto,
  ProductShipmentTransitMarketDto,
  ProductShipmentTransitTicketDto,
  ShipmentStatusClass,
} from './types';

/**
 * 商品详情「关联货票」/ 概览「在途库存」的纯计算层（第十轮，R11 收尾补修）。
 *
 * 数据库只负责按商品取当前票与逐条明细；这里先逐条计算，再按票合成一行：
 * - 每条明细：剩余在途 = 发货量 − 当前采用累计已上架；未知（NULL）、超收、发货量冲突（待复核）
 *   的这条为待核，**只排除这一条**，同票其它数量明确的明细照常计入；
 * - 一票一行：发货量 = 全部明细之和；已知累计/剩余 = 只加数量明确的明细（一条都没有才是待核）；
 *   待核/待复核条数按条计，不再把整票当成一条；
 * - 多个运单属于同一票 → 由数据库聚合为一行，这里只数运单条数用于说明；
 * - 市场小计与采购单组成：已知剩余只加数量明确的票，采购单按票去重。
 */

/** RPC 返回的逐条明细（items[]）；remaining 由本模块计算。 */
export interface ProductTransitItemRow {
  itemId: string;
  shippedQuantity: number;
  receivedQuantity: number | null;
  manualConflict: boolean;
  manualCorrected: boolean;
}

/** RPC 返回的逐票原始行（票级字段 + 同票同商品全部当前明细）。 */
export interface ProductTransitTicketRow {
  shipmentId: string;
  ticketNo: string;
  purchaseOrder: string | null;
  market: string | null;
  waybillsText: string | null;
  statusClass: ShipmentStatusClass;
  effectiveStatusClass: ShipmentStatusClass;
  transportText: string | null;
  arrivalText: string | null;
  ticketItemCount: number;
  items: ProductTransitItemRow[];
}

export interface ProductTransitSource {
  productId: string;
  latestReadAt: string | null;
  snapshotId: string | null;
  tickets: ProductTransitTicketRow[];
}

/** 运单号原文 → 条数：来源用换行或斜杠分隔；空文本为 0（不推断隐藏运单）。 */
export function countWaybills(text: string | null): number {
  if (!text) return 0;
  return text
    .split(/[\n\r/／、,，;；]+/)
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .length;
}

/** 单条明细是否数量明确：无冲突、有采用累计、未超收。 */
function itemKnown(item: ProductTransitItemRow): boolean {
  return !item.manualConflict
    && item.receivedQuantity !== null
    && item.receivedQuantity >= 0
    && item.receivedQuantity <= item.shippedQuantity;
}

function compareMarket(a: string, b: string): number {
  return a.localeCompare(b, 'zh-CN');
}

export function buildProductTransit(source: ProductTransitSource): ProductShipmentTransitDto {
  const tickets: ProductShipmentTransitTicketDto[] = source.tickets.map((row) => {
    let shippedQuantity = 0;
    let receivedQuantity = 0;
    let knownRemaining = 0;
    let knownItemCount = 0;
    let pendingItemCount = 0;
    let conflictItemCount = 0;
    let manualCorrected = false;

    for (const item of row.items) {
      shippedQuantity += item.shippedQuantity;
      manualCorrected = manualCorrected || item.manualCorrected;
      if (itemKnown(item)) {
        knownItemCount += 1;
        receivedQuantity += item.receivedQuantity as number;
        knownRemaining += item.shippedQuantity - (item.receivedQuantity as number);
      } else {
        pendingItemCount += 1;
        if (item.manualConflict) conflictItemCount += 1;
      }
    }

    const known = knownItemCount > 0;
    return {
      shipmentId: row.shipmentId,
      ticketNo: row.ticketNo,
      purchaseOrder: row.purchaseOrder,
      market: row.market,
      waybillsText: row.waybillsText,
      statusClass: row.statusClass,
      effectiveStatusClass: row.effectiveStatusClass,
      transportText: row.transportText,
      arrivalText: row.arrivalText,
      waybillCount: countWaybills(row.waybillsText),
      shippedQuantity,
      receivedQuantity: known ? receivedQuantity : null,
      remainingQuantity: known ? knownRemaining : null,
      remainingState: known ? 'known' : 'pending',
      pendingItemCount,
      conflictItemCount,
      manualConflict: conflictItemCount > 0,
      manualCorrected,
      itemCount: row.items.length,
      ticketItemCount: row.ticketItemCount,
    };
  });

  const marketsByKey = new Map<string, ProductShipmentTransitMarketDto>();
  let knownRemaining = 0;
  let pendingItemCount = 0;
  let conflictItemCount = 0;

  for (const ticket of tickets) {
    knownRemaining += ticket.remainingQuantity ?? 0;
    pendingItemCount += ticket.pendingItemCount;
    conflictItemCount += ticket.conflictItemCount;

    const key = ticket.market ?? '';
    const market = marketsByKey.get(key) ?? {
      market: ticket.market,
      ticketCount: 0,
      knownRemaining: 0,
      pendingItemCount: 0,
      conflictItemCount: 0,
      purchaseOrders: [] as string[],
    };
    market.ticketCount += 1;
    market.knownRemaining += ticket.remainingQuantity ?? 0;
    market.pendingItemCount += ticket.pendingItemCount;
    market.conflictItemCount += ticket.conflictItemCount;
    if (ticket.purchaseOrder && !market.purchaseOrders.includes(ticket.purchaseOrder)) {
      market.purchaseOrders.push(ticket.purchaseOrder);
    }
    marketsByKey.set(key, market);
  }

  const markets = [...marketsByKey.values()].sort((a, b) => {
    if (a.market === null && b.market === null) return 0;
    if (a.market === null) return 1;
    if (b.market === null) return -1;
    return compareMarket(a.market, b.market);
  });

  return {
    productId: source.productId,
    latestReadAt: source.latestReadAt,
    snapshotId: source.snapshotId,
    ticketCount: tickets.length,
    knownRemaining,
    pendingItemCount,
    conflictItemCount,
    allPending: tickets.length > 0 && tickets.every((ticket) => ticket.remainingState === 'pending'),
    tickets,
    markets,
  };
}
