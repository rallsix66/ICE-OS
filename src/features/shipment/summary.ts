/**
 * 物流在途「市场汇总」纯计算（第七轮，无 DB / 无环境变量 / 无 React）。
 *
 * 口径（用户 2026-11-04 第七轮确认，见 docs/tasks/shipment-in-transit-v1.md §13）：
 * - 范围 = 028 返回的所选市场当前明细（最近一次成功读取；来源已移除的不进入）；
 * - 数量 = 026 已算好的剩余在途：只有「剩余数量明确」的明细计入商品数量；
 *   已到货上架（剩余 0）仍计入（显示 0，不当作未知）；
 * - 数量待核（分批到货但来源没有逐商品累计到货量）不计入数量，也不计入金额；
 * - 货值 = 剩余在途数量 × 商品库已采用的进货价（不含运费口径；采用金额权限沿用商品库现有读取）；
 * - 缺单价：数量保留、金额不计入；未关联商品：商品与单价都确定不了；
 * - 未知值一律 null（页面显示「未计入/待核」），绝不写 0 冒充。
 */

import { formatMoney, multiplyMoneyByQuantity, parseMoney } from '@/features/catalog/local-display/decimal';
import type {
  ShipmentAssociationStatus,
  ShipmentDetailItemDto,
  ShipmentLinkedProductDto,
  ShipmentMarketSummaryDto,
  ShipmentReceiptBasis,
  ShipmentRemainingState,
  ShipmentStatusClass,
  ShipmentSummaryExclusion,
  ShipmentSummaryItemDto,
  ShipmentSummaryProductDto,
  ShipmentTicketValueDto,
  ShipmentValueMarketRowDto,
  ShipmentValueOverviewDto,
} from './types';

/** 028 返回的一条当前明细（已归一化）。 */
export interface ShipmentMarketSummarySourceItem {
  itemId: string;
  shipmentId: string;
  ticketNo: string;
  purchaseOrder: string | null;
  waybillsText: string | null;
  market: string | null;
  statusClass: ShipmentStatusClass;
  productId: string | null;
  productNameRaw: string;
  associationStatus: ShipmentAssociationStatus;
  shippedQuantity: number;
  receivedQuantity: number | null;
  receiptBasis: ShipmentReceiptBasis;
  /** 保存人工修正时的发货量；没有人工修正为 null。 */
  manualShippedQuantity: number | null;
  /** 原表发货量与人工确认矛盾（待复核，不计货值）。 */
  manualConflict: boolean;
  remainingQuantity: number | null;
  remainingState: ShipmentRemainingState;
}

export interface ShipmentMarketSummarySource {
  market: string | null;
  unknownMarket: boolean;
  latestReadAt: string | null;
  snapshotId: string | null;
  ticketCount: number;
  itemCount: number;
  items: ShipmentMarketSummarySourceItem[];
}

export const SHIPMENT_SUMMARY_EXCLUSION_TEXT: Record<ShipmentSummaryExclusion, string> = {
  unbound: '未关联商品',
  quantity_pending: '数量待核',
  price_missing: '缺单价',
  review_pending: '待复核',
};

/** 价格字符串 → 定标金额；卡片已校验过格式，非法值按缺价处理（不抛给页面）。 */
function priceScaled(amountCny: string | null): bigint | null {
  if (amountCny === null) return null;
  try {
    return parseMoney(amountCny);
  } catch {
    return null;
  }
}

function knownRemaining(item: ShipmentMarketSummarySourceItem): number | null {
  if (item.remainingState !== 'known') return null;
  const value = item.remainingQuantity;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value);
}

function exclusionOf(
  item: ShipmentMarketSummarySourceItem,
  remaining: number | null,
  valueScaled: bigint | null,
): ShipmentSummaryExclusion | null {
  // 原表发货量与原人工数量矛盾：优先标「待复核」，数量与金额都不计入。
  if (item.manualConflict) return 'review_pending';
  if (item.productId === null) return 'unbound';
  if (remaining === null) return 'quantity_pending';
  if (valueScaled === null) return 'price_missing';
  return null;
}

function summaryItem(
  item: ShipmentMarketSummarySourceItem,
  card: ShipmentLinkedProductDto | null,
): { dto: ShipmentSummaryItemDto; valueScaled: bigint | null } {
  // 冲突未解决前不计入数量/货值；数字保留在详情页的旧→新发货量说明里。
  const remaining = item.manualConflict ? null : knownRemaining(item);
  const price = card ? priceScaled(card.unitCost.amountCny) : null;
  const valueScaled = remaining !== null && price !== null
    ? multiplyMoneyByQuantity(price, BigInt(remaining))
    : null;
  const exclusion = exclusionOf(item, remaining, valueScaled);
  return {
    valueScaled,
    dto: {
      itemId: item.itemId,
      shipmentId: item.shipmentId,
      ticketNo: item.ticketNo,
      purchaseOrder: item.purchaseOrder,
      waybillsText: item.waybillsText,
      productNameRaw: item.productNameRaw,
      product: card,
      shippedQuantity: item.shippedQuantity,
      receivedQuantity: item.receivedQuantity,
      receiptBasis: item.receiptBasis,
      manualShippedQuantity: item.manualShippedQuantity,
      manualConflict: item.manualConflict,
      remainingQuantity: remaining,
      remainingState: item.manualConflict ? 'pending' : item.remainingState,
      quantityIncluded: remaining !== null,
      valueCny: valueScaled === null ? null : formatMoney(valueScaled),
      exclusion,
      exclusionReason: exclusion === null ? null : SHIPMENT_SUMMARY_EXCLUSION_TEXT[exclusion],
    },
  };
}

interface ProductAccumulator {
  card: ShipmentLinkedProductDto;
  remainingQuantity: number;
  quantityKnownItemCount: number;
  quantityPendingCount: number;
  reviewPendingCount: number;
  pricedItemCount: number;
  unpricedItemCount: number;
  valueScaled: bigint | null;
  items: ShipmentSummaryItemDto[];
  ticketIds: Set<string>;
}

function emptyProduct(card: ShipmentLinkedProductDto): ProductAccumulator {
  return {
    card,
    remainingQuantity: 0,
    quantityKnownItemCount: 0,
    quantityPendingCount: 0,
    reviewPendingCount: 0,
    pricedItemCount: 0,
    unpricedItemCount: 0,
    valueScaled: null,
    items: [],
    ticketIds: new Set<string>(),
  };
}

function productSortKey(product: ShipmentSummaryProductDto): string {
  return `${product.iceCode ?? ''}\u0000${product.nameCn ?? ''}\u0000${product.productId}`;
}

function tradeThenTicket(a: ShipmentSummaryItemDto, b: ShipmentSummaryItemDto): number {
  return a.ticketNo.localeCompare(b.ticketNo, 'zh-Hans-CN')
    || a.productNameRaw.localeCompare(b.productNameRaw, 'zh-Hans-CN')
    || a.itemId.localeCompare(b.itemId);
}

const EXCLUSION_ORDER: Record<ShipmentSummaryExclusion, number> = {
  review_pending: 0,
  quantity_pending: 1,
  price_missing: 2,
  unbound: 3,
};

/**
 * 把 028 的当前明细 + 已组装好的商品卡片（含采用进货价）汇总成市场 DTO。
 * `cards` 必须为范围内每个非空 productId 提供卡片（缺失时调用方用 fallback 卡片兜底）。
 */
export function buildShipmentMarketSummary(
  source: ShipmentMarketSummarySource,
  cards: ReadonlyMap<string, ShipmentLinkedProductDto>,
): ShipmentMarketSummaryDto {
  const products = new Map<string, ProductAccumulator>();
  const excludedItems: ShipmentSummaryItemDto[] = [];
  let pricedItemCount = 0;
  let totalValueScaled: bigint | null = null;
  const excludedByReason = {
    unbound: 0, quantityPending: 0, priceMissing: 0, reviewPending: 0,
  };

  for (const item of source.items) {
    const card = item.productId === null ? null : cards.get(item.productId) ?? null;
    const { dto, valueScaled } = summaryItem(item, card);

    if (dto.exclusion !== null) {
      excludedItems.push(dto);
      if (dto.exclusion === 'unbound') excludedByReason.unbound += 1;
      else if (dto.exclusion === 'quantity_pending') excludedByReason.quantityPending += 1;
      else if (dto.exclusion === 'review_pending') excludedByReason.reviewPending += 1;
      else excludedByReason.priceMissing += 1;
    }
    if (valueScaled !== null) {
      pricedItemCount += 1;
      totalValueScaled = (totalValueScaled ?? BigInt(0)) + valueScaled;
    }

    if (item.productId === null || card === null) continue;
    let group = products.get(item.productId);
    if (!group) {
      group = emptyProduct(card);
      products.set(item.productId, group);
    }
    group.items.push(dto);
    group.ticketIds.add(item.shipmentId);
    if (dto.quantityIncluded) {
      group.quantityKnownItemCount += 1;
      group.remainingQuantity += dto.remainingQuantity ?? 0;
    } else if (dto.exclusion === 'review_pending') {
      group.reviewPendingCount += 1;
    } else {
      group.quantityPendingCount += 1;
    }
    if (valueScaled !== null) {
      group.pricedItemCount += 1;
      group.valueScaled = (group.valueScaled ?? BigInt(0)) + valueScaled;
    } else if (dto.quantityIncluded) {
      group.unpricedItemCount += 1;
    }
  }

  const productList: ShipmentSummaryProductDto[] = [...products.values()]
    .map((group) => ({
      productId: group.card.itemId,
      iceCode: group.card.iceCode,
      nameCn: group.card.nameCn,
      specificationText: group.card.specificationText,
      specificationSource: group.card.specificationSource,
      unitText: group.card.unitText,
      unitCost: group.card.unitCost,
      remainingQuantity: group.remainingQuantity,
      quantityKnownItemCount: group.quantityKnownItemCount,
      quantityPendingCount: group.quantityPendingCount,
      reviewPendingCount: group.reviewPendingCount,
      pricedItemCount: group.pricedItemCount,
      unpricedItemCount: group.unpricedItemCount,
      itemCount: group.items.length,
      ticketCount: group.ticketIds.size,
      valueCny: group.valueScaled === null ? null : formatMoney(group.valueScaled),
      items: group.items.slice().sort(tradeThenTicket),
    }))
    .sort((a, b) => {
      // 已能算出的货值大的在前；无货值的商品随后，按货号/名称。
      const aValue = a.valueCny === null ? null : parseMoney(a.valueCny);
      const bValue = b.valueCny === null ? null : parseMoney(b.valueCny);
      if (aValue !== null && bValue !== null && aValue !== bValue) return aValue > bValue ? -1 : 1;
      if (aValue === null && bValue !== null) return 1;
      if (aValue !== null && bValue === null) return -1;
      return productSortKey(a).localeCompare(productSortKey(b), 'zh-Hans-CN');
    });

  excludedItems.sort((a, b) => {
    const aOrder = a.exclusion === null ? 9 : EXCLUSION_ORDER[a.exclusion];
    const bOrder = b.exclusion === null ? 9 : EXCLUSION_ORDER[b.exclusion];
    return aOrder - bOrder || tradeThenTicket(a, b);
  });

  return {
    market: source.market,
    unknownMarket: source.unknownMarket,
    latestReadAt: source.latestReadAt,
    snapshotId: source.snapshotId,
    ticketCount: source.ticketCount,
    itemCount: source.itemCount,
    products: productList,
    totalValueCny: totalValueScaled === null ? null : formatMoney(totalValueScaled),
    pricedItemCount,
    unpricedItemCount: excludedByReason.priceMissing,
    quantityPendingCount: excludedByReason.quantityPending,
    reviewPendingCount: excludedByReason.reviewPending,
    unboundItemCount: excludedByReason.unbound,
    excludedItemCount: excludedItems.length,
    excludedByReason,
    excludedItems,
  };
}

/**
 * 货值汇总「全部市场」：028 返回的全部当前明细按市场分组，每个市场各自套用同一套
 * 剩余在途 × 采用进货价口径（不把不同市场的商品数量混加；金额是 CNY 才相加）。
 */
export function buildShipmentValueOverview(
  source: ShipmentMarketSummarySource,
  cards: ReadonlyMap<string, ShipmentLinkedProductDto>,
): ShipmentValueOverviewDto {
  const groups = new Map<string, ShipmentMarketSummarySourceItem[]>();
  for (const item of source.items) {
    const key = item.market === null ? '\u0000unknown' : `m:${item.market}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(item);
    groups.set(key, bucket);
  }
  const rows: Array<ShipmentValueMarketRowDto & { scaled: bigint | null }> = [];
  let totalScaled: bigint | null = null;
  let totalPriced = 0;
  let totalExcluded = 0;
  for (const items of groups.values()) {
    const market = items[0]!.market;
    const summary = buildShipmentMarketSummary({
      market,
      unknownMarket: market === null,
      latestReadAt: source.latestReadAt,
      snapshotId: source.snapshotId,
      ticketCount: new Set(items.map((item) => item.shipmentId)).size,
      itemCount: items.length,
      items,
    }, cards);
    const scaled = summary.totalValueCny === null ? null : parseMoney(summary.totalValueCny);
    if (scaled !== null) totalScaled = (totalScaled ?? BigInt(0)) + scaled;
    totalPriced += summary.pricedItemCount;
    totalExcluded += summary.excludedItemCount;
    rows.push({
      market,
      unknownMarket: market === null,
      ticketCount: summary.ticketCount,
      itemCount: summary.itemCount,
      totalValueCny: summary.totalValueCny,
      pricedItemCount: summary.pricedItemCount,
      excludedItemCount: summary.excludedItemCount,
      unboundItemCount: summary.unboundItemCount,
      quantityPendingCount: summary.quantityPendingCount,
      reviewPendingCount: summary.reviewPendingCount,
      priceMissingItemCount: summary.excludedByReason.priceMissing,
      scaled,
    });
  }
  rows.sort((a, b) => {
    if (a.scaled !== null && b.scaled !== null && a.scaled !== b.scaled) return a.scaled > b.scaled ? -1 : 1;
    if (a.scaled === null && b.scaled !== null) return 1;
    if (a.scaled !== null && b.scaled === null) return -1;
    return (a.market ?? '未提供').localeCompare(b.market ?? '未提供', 'zh-Hans-CN');
  });
  return {
    latestReadAt: source.latestReadAt,
    snapshotId: source.snapshotId,
    marketCount: rows.length,
    ticketCount: source.ticketCount,
    itemCount: source.itemCount,
    totalValueCny: totalScaled === null ? null : formatMoney(totalScaled),
    pricedItemCount: totalPriced,
    excludedItemCount: totalExcluded,
    markets: rows.map((row) => ({
      market: row.market,
      unknownMarket: row.unknownMarket,
      ticketCount: row.ticketCount,
      itemCount: row.itemCount,
      totalValueCny: row.totalValueCny,
      pricedItemCount: row.pricedItemCount,
      excludedItemCount: row.excludedItemCount,
      unboundItemCount: row.unboundItemCount,
      quantityPendingCount: row.quantityPendingCount,
      reviewPendingCount: row.reviewPendingCount,
      priceMissingItemCount: row.priceMissingItemCount,
    })),
  };
}

/**
 * 单票在途货值（第十三轮，详情头部）：与市场汇总同一口径逐条计算。
 * - 当前有效剩余数量（人工修正后的 remaining；conflict 待复核不计）；
 * - 商品库采用进货价（不含运费；沿用同一份商品卡片/金额权限）；
 * - 明确全部上架（剩余 0）计入并显示 ¥0.00；一条都算不出时 totalValueCny=null，
 *   页面写「暂无法计算」，不写 0。
 */
export function buildShipmentTicketValue(
  items: readonly ShipmentDetailItemDto[],
): ShipmentTicketValueDto {
  let totalScaled: bigint | null = null;
  let pricedItemCount = 0;
  for (const item of items) {
    if (item.manualConflict) continue;
    const remaining = item.remainingState === 'known'
      && typeof item.remainingQuantity === 'number'
      && Number.isFinite(item.remainingQuantity)
      && item.remainingQuantity >= 0
      ? Math.trunc(item.remainingQuantity)
      : null;
    if (remaining === null) continue;
    const price = item.product ? priceScaled(item.product.unitCost.amountCny) : null;
    if (price === null) continue;
    pricedItemCount += 1;
    totalScaled = (totalScaled ?? BigInt(0)) + multiplyMoneyByQuantity(price, BigInt(remaining));
  }
  return {
    totalValueCny: totalScaled === null ? null : formatMoney(totalScaled),
    pricedItemCount,
    excludedItemCount: items.length - pricedItemCount,
    itemCount: items.length,
  };
}

