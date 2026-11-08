/**
 * 经营总览首页纯计算（BUSINESS_OVERVIEW_V1）。
 *
 * 只做「已读取 DTO → 页面模型」的确定性汇总，无 DB / 无环境变量 / 无 React：
 * - 三阶段（国内冻结快照 / 物流在途 / 海外 BigSeller）各自独立合计，不跨来源相加；
 * - 未知一律 null，不写 0 冒充；金额按金额权限（amountsVisible）统一置空；
 * - 金额走商品库同一套定标十进制函数（parseMoney / multiplyMoneyByQuantity / formatMoney），
 *   不用浮点累加；非法价格按缺价处理；
 * - 市场行把库存市场代码与飞书来源中文市场名合并，用「中文名 → 代码」反查，
 *   查不到就保留原名，两处都没有市场证据的单列为「市场待确认」。
 *
 * 口径来源见 docs/tasks/current-task.md 与首页服务端读取 `server/reads.ts`；
 * 页面只消费本文件结果，不重新累加来源行。
 */

import { formatMoney, multiplyMoneyByQuantity, parseMoney } from '@/features/catalog/local-display/decimal';
import type { InventoryDomesticSnapshotDto, InventoryProductSummaryRowDto } from '@/features/inventory/types';
import type { ShipmentMarketSummarySourceItem } from '@/features/shipment/summary';
import type {
  ShipmentMarketSummaryDto,
  ShipmentSummaryProductDto,
  ShipmentValueOverviewDto,
} from '@/features/shipment/types';

/** 市场代码 → 中文显示名（TH → 泰国）；服务端传入商品库同一份映射。 */
export type MarketLabelMap = Record<string, string>;

/** 单个阶段的合计。数量 null = 来源未读取/整段不可用；金额 null = 无权限或没有已计价数量。 */
export interface HomeStage {
  quantity: number | null;
  pricedQuantity: number;
  unpricedQuantity: number;
  unknownItems: number;
  /** 已知小计但合计不完整（同仓同单位多 SKU 待核对）：数量仍显示，但不能当完整合计。 */
  pendingTotalProducts: number;
  excludedItems: number;
  valueCny: string | null;
}

/** 海外市场行：库存口径（各仓实物）与在途口径（来源国家）分列，不混加。 */
export interface HomeMarketRow {
  market: string | null;
  label: string;
  onHand: number | null;
  onHandValueCny: string | null;
  unknownProducts: number;
  transitRemaining: number | null;
  transitValueCny: string | null;
  transitTickets: number;
}

/** 商品库存概览一行：国内/海外/在途三列各自独立，未知为 null。 */
export interface HomeProductRow {
  itemId: string;
  iceCode: string | null;
  nameCn: string | null;
  gtin: string | null;
  unit: string | null;
  domesticOnHand: number | null;
  overseasOnHand: number | null;
  transitRemaining: number | null;
  transitPending: boolean;
  /** 海外已知小计但合计待核对（hasPendingTotal / knownSubtotalComplete=false）。 */
  pendingTotal: boolean;
  costCny: string | null;
  inventoryValueCny: string | null;
  valueIncomplete: boolean;
}

/** 缺价商品（按已知数量降序）。 */
export interface HomeGapItem {
  itemId: string;
  iceCode: string | null;
  nameCn: string | null;
  quantity: number;
}

/** 估值口径与未计入说明。 */
export interface HomeValuation {
  missingCostProducts: HomeGapItem[];
  missingCostQuantity: number;
  /** 已知小计但合计待核对的商品（可进现有详情核对）。 */
  pendingTotalProducts: number;
  pendingTotalItems: HomeGapItem[];
  unknownQuantityProducts: number;
  unmappedSourceRows: number;
  unknownMarketProducts: number;
  /** 进货价读取失败：本次金额与缺价情况不可判断（不生成补价待办、不当 0 缺价）。 */
  costUnavailable: boolean;
  transitExclusions: {
    unbound: number;
    quantityPending: number;
    priceMissing: number;
    reviewPending: number;
  };
}

export interface HomeAggregateInput {
  amountsVisible: boolean;
  /** 成本读取失败：保留数量，本次金额/缺价不可判断。 */
  costUnavailable?: boolean;
  domestic: InventoryDomesticSnapshotDto | null;
  products: InventoryProductSummaryRowDto[];
  costMap: Record<string, string>;
  transit: ShipmentMarketSummaryDto;
  transitMarkets: ShipmentValueOverviewDto;
  transitItems: ShipmentMarketSummarySourceItem[];
  mappingQueueTotal: number;
  marketLabels: MarketLabelMap;
  domesticFileDate: string | null;
  overseasTime: string | null;
  transitTime: string | null;
}

export interface HomeAggregateResult {
  stages: { domestic: HomeStage; transit: HomeStage; overseas: HomeStage };
  markets: HomeMarketRow[];
  products: HomeProductRow[];
  valuation: HomeValuation;
  times: { domestic: string | null; overseas: string | null; transit: string | null };
  productCount: number;
}

const UNKNOWN_MARKET_LABEL = '市场待确认';
/** 内部合并键：null 市场用不可能与真实代码/名称冲突的键。 */
const UNKNOWN_MARKET_KEY = '\u0000unknown';
const ZERO = BigInt(0);
const PAGE_SIZE_MIN = 1;
const PAGE_SIZE_MAX = 50;

function truncateFinite(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.trunc(value);
}

/** 数量：有限且非负才计入，否则视为未知（null，不写 0）。 */
function knownQuantity(value: number | null | undefined): number | null {
  const truncated = truncateFinite(value);
  return truncated === null || truncated < 0 ? null : truncated;
}

function safeCount(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Math.trunc(value);
}

/** 价格字符串 → 定标金额；非法格式按缺价处理（不抛给页面）。 */
function scaledPrice(raw: string | null | undefined): bigint | null {
  if (raw === null || raw === undefined) return null;
  try {
    return parseMoney(raw);
  } catch {
    return null;
  }
}

function addValue(total: bigint | null, price: bigint, quantity: number): bigint {
  return (total ?? ZERO) + multiplyMoneyByQuantity(price, BigInt(quantity));
}

function buildCostByItem(costMap: Record<string, string> | null | undefined): Map<string, bigint> {
  const byItem = new Map<string, bigint>();
  if (!costMap) return byItem;
  for (const [itemId, raw] of Object.entries(costMap)) {
    if (!itemId) continue;
    const scaled = scaledPrice(raw);
    if (scaled !== null) byItem.set(itemId, scaled);
  }
  return byItem;
}

function buildLabelToCode(labels: MarketLabelMap | null | undefined): Map<string, string> {
  const byLabel = new Map<string, string>();
  if (!labels) return byLabel;
  for (const [code, label] of Object.entries(labels)) {
    const text = typeof label === 'string' ? label.trim() : '';
    if (!text) continue;
    if (!byLabel.has(text)) byLabel.set(text, code);
  }
  return byLabel;
}

/** 市场值归一：空白等同于未提供（null = 待确认）。 */
function normalizeMarket(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** 飞书来源中文市场名 → 库存市场代码；未收录时保留原名（不猜归属）。 */
function resolveSourceMarket(
  sourceName: string | null | undefined,
  labelToCode: Map<string, string>,
): string | null {
  const name = normalizeMarket(sourceName);
  if (name === null) return null;
  return labelToCode.get(name) ?? name;
}

function marketKey(market: string | null): string {
  return market === null ? UNKNOWN_MARKET_KEY : market;
}

function labelFor(market: string | null, labels: MarketLabelMap | null | undefined): string {
  if (market === null) return UNKNOWN_MARKET_LABEL;
  const mapped = labels ? labels[market] : undefined;
  return typeof mapped === 'string' && mapped.trim() ? mapped : market;
}

/**
 * 商品行单位：只有单一单位组时才是明确单位；多单位组/无单位一律 null
 * （不同商品单位不换算、不混加）。
 */
function resolveUnit(product: InventoryProductSummaryRowDto): string | null {
  const groups = product.unitGroups ?? [];
  if (groups.length !== 1) return null;
  const unit = groups[0]?.unit;
  return typeof unit === 'string' && unit.trim() ? unit : null;
}

/**
 * 在途商品剩余：来自在途汇总的该商品记录；没有记录 = null（没有在途）。
 * 记录里有数量明确的明细才采用 remainingQuantity；全部数量待核/待复核时保持 null，
 * 避免把「没有已知数量」写成 0。
 */
function transitRemainingOf(record: ShipmentSummaryProductDto | null): number | null {
  if (!record) return null;
  const known = knownQuantity(record.remainingQuantity);
  if (safeCount(record.quantityKnownItemCount) > 0) return known;
  if (safeCount(record.quantityPendingCount) + safeCount(record.reviewPendingCount) > 0) return null;
  return known;
}

interface MarketAccumulator {
  market: string | null;
  knownOnHand: number;
  knownCellCount: number;
  valueScaled: bigint | null;
  pricedCellCount: number;
  unknownProducts: number;
  transitTickets: number;
  transitValueScaled: bigint | null;
}

function emptyMarket(market: string | null): MarketAccumulator {
  return {
    market,
    knownOnHand: 0,
    knownCellCount: 0,
    valueScaled: null,
    pricedCellCount: 0,
    unknownProducts: 0,
    transitTickets: 0,
    transitValueScaled: null,
  };
}

/**
 * 首页汇总入口。
 *
 * 三阶段分开计算：国内（冻结快照，按 itemId 汇总）、海外（商品汇总的市场格 + 实物合计）、
 * 在途（当前读取的已知剩余）。市场行只合并「库存市场代码」与「在途来源中文市场名」，
 * 数量与金额仍分列，不把国内数量摊到任何市场。
 */
export function aggregateHome(input: HomeAggregateInput): HomeAggregateResult {
  const amountsVisible = input.amountsVisible === true;
  const costUnavailable = input.costUnavailable === true;
  const labels = input.marketLabels ?? {};
  const labelToCode = buildLabelToCode(labels);
  const costByItem = buildCostByItem(input.costMap);

  /* ---------------- 国内：冻结表格快照 ---------------- */

  const domesticByItem = new Map<string, number>();
  const domesticIdentity = new Map<string, { iceCode: string | null; nameCn: string | null }>();
  let domesticValueScaled: bigint | null = null;
  let domesticPricedQuantity = 0;
  let domesticUnpricedQuantity = 0;
  let domesticPricedRowCount = 0;
  let domesticStage: HomeStage;

  const snapshot = input.domestic;
  if (!snapshot || snapshot.available !== true) {
    const unavailable = safeCount(snapshot?.unlinkedSelectedCount);
    domesticStage = {
      quantity: null,
      pricedQuantity: 0,
      unpricedQuantity: 0,
      unknownItems: unavailable,
      pendingTotalProducts: 0,
      excludedItems: unavailable,
      valueCny: null,
    };
  } else {
    let quantity = 0;
    let unknownItems = 0;
    let nonOkSelectedRows = 0;
    for (const row of snapshot.rows ?? []) {
      if (row.reviewState !== 'manual_selected') continue;
      if (row.quantityState !== 'ok') nonOkSelectedRows += 1;
      // 未关联到标准商品的冻结选择不进入国内合计（只计入 excludedItems 的未关联数）。
      const itemId = row.itemId;
      if (!itemId) continue;
      const rowQuantity = row.quantityState === 'ok' ? knownQuantity(row.actualQty) : null;
      if (rowQuantity === null) {
        unknownItems += 1;
        continue;
      }
      quantity += rowQuantity;
      domesticByItem.set(itemId, (domesticByItem.get(itemId) ?? 0) + rowQuantity);
      if (!domesticIdentity.has(itemId)) {
        domesticIdentity.set(itemId, {
          iceCode: row.iceCode ?? null,
          nameCn: row.itemNameCn ?? null,
        });
      }
      const price = costUnavailable ? null : (costByItem.get(itemId) ?? null);
      if (costUnavailable) continue;
      if (price === null) {
        domesticUnpricedQuantity += rowQuantity;
      } else {
        domesticPricedQuantity += rowQuantity;
        domesticPricedRowCount += 1;
        domesticValueScaled = addValue(domesticValueScaled, price, rowQuantity);
      }
    }
    domesticStage = {
      quantity,
      pricedQuantity: domesticPricedQuantity,
      unpricedQuantity: domesticUnpricedQuantity,
      unknownItems,
      pendingTotalProducts: 0,
      // 口径：非 ok 的 selected 行数（含未关联行）+ 未关联的冻结选择数。两个字段按定义独立计数。
      excludedItems: nonOkSelectedRows + safeCount(snapshot.unlinkedSelectedCount),
      valueCny:
        !costUnavailable && amountsVisible && domesticPricedRowCount > 0 && domesticValueScaled !== null
          ? formatMoney(domesticValueScaled)
          : null,
    };
  }

  /* ---------------- 市场行容器（在途/海外共用） ---------------- */

  const markets = new Map<string, MarketAccumulator>();
  const ensureMarket = (market: string | null): MarketAccumulator => {
    const key = marketKey(market);
    let accumulator = markets.get(key);
    if (!accumulator) {
      accumulator = emptyMarket(market);
      markets.set(key, accumulator);
    }
    return accumulator;
  };

  /* ---------------- 在途：当前读取的已知剩余 ---------------- */

  const transitProductById = new Map<string, ShipmentSummaryProductDto>();
  for (const product of input.transit?.products ?? []) {
    transitProductById.set(product.productId, product);
  }

  const transitByMarket = new Map<string, number>();
  let transitQuantity = 0;
  for (const item of input.transitItems ?? []) {
    const market = resolveSourceMarket(item.market, labelToCode);
    // 该来源市场只要有明细就出现在市场表（即使数量待核），保证市场行不丢行。
    ensureMarket(market);
    // 原表发货量与人工作业矛盾（待复核）或数量未定时，数量与金额都不计入。
    if (item.manualConflict) continue;
    if (item.remainingState !== 'known') continue;
    const remaining = knownQuantity(item.remainingQuantity);
    if (remaining === null) continue;
    transitQuantity += remaining;
    const key = marketKey(market);
    transitByMarket.set(key, (transitByMarket.get(key) ?? 0) + remaining);
  }

  // 缺单价：数量已知但该商品没有采用进货价，金额不计入。
  let transitUnpricedQuantity = 0;
  let transitUnboundQuantity = 0;
  if (!costUnavailable) {
    for (const excluded of input.transit?.excludedItems ?? []) {
      const remaining = knownQuantity(excluded.remainingQuantity);
      if (remaining === null) continue;
      if (excluded.exclusion === 'price_missing') transitUnpricedQuantity += remaining;
      else if (excluded.exclusion === 'unbound') transitUnboundQuantity += remaining;
    }
  }
  // 已计价 = 数量已知且真正参与金额的剩余（未关联商品缺商品与价格，不算已计价）。
  const transitPricedQuantity = costUnavailable
    ? 0
    : Math.max(0, transitQuantity - transitUnpricedQuantity - transitUnboundQuantity);

  const transitExclusions = {
    unbound: safeCount(input.transit?.excludedByReason?.unbound),
    quantityPending: safeCount(input.transit?.excludedByReason?.quantityPending),
    priceMissing: safeCount(input.transit?.excludedByReason?.priceMissing),
    reviewPending: safeCount(input.transit?.excludedByReason?.reviewPending),
  };

  const transitStage: HomeStage = {
    quantity: transitQuantity,
    pricedQuantity: transitPricedQuantity,
    unpricedQuantity: transitUnpricedQuantity,
    unknownItems: safeCount(input.transit?.quantityPendingCount) + safeCount(input.transit?.reviewPendingCount),
    pendingTotalProducts: 0,
    excludedItems: safeCount(input.transit?.excludedItemCount),
    valueCny: !costUnavailable && amountsVisible ? (input.transit?.totalValueCny ?? null) : null,
  };

  /* ---------------- 在途市场货值：按市场补票数与金额 ---------------- */

  for (const row of input.transitMarkets?.markets ?? []) {
    const market = resolveSourceMarket(row.market, labelToCode);
    const accumulator = ensureMarket(market);
    accumulator.transitTickets = safeCount(row.ticketCount);
    accumulator.transitValueScaled = costUnavailable ? null : scaledPrice(row.totalValueCny);
  }

  /* ---------------- 海外：商品汇总的市场格 + 实物合计 ---------------- */

  let overseasQuantity = 0;
  let overseasUnknownItems = 0;
  let overseasPendingTotalProducts = 0;
  let overseasPricedQuantity = 0;
  let overseasUnpricedQuantity = 0;
  let overseasValueScaled: bigint | null = null;
  let overseasPricedProductCount = 0;
  const pendingTotalItems: HomeGapItem[] = [];
  const unknownMarketItemIds = new Set<string>();
  const productRows: HomeProductRow[] = [];
  const seenItemIds = new Set<string>();

  for (const product of input.products ?? []) {
    const itemId = product.itemId;
    const isFirstOccurrence = !seenItemIds.has(itemId);
    seenItemIds.add(itemId);

    const overseasOnHand = truncateFinite(product.overseasOnHand);
    const domesticOnHand = domesticByItem.get(itemId) ?? null;
    const transitProduct = transitProductById.get(itemId) ?? null;
    const transitRemaining = transitRemainingOf(transitProduct);
    const transitPending = transitProduct !== null && safeCount(transitProduct.quantityPendingCount) > 0;
    const cost = costUnavailable ? null : (costByItem.get(itemId) ?? null);
    const cells = product.marketCells ?? [];
    // 022 的完整口径：同仓同单位多 SKU 时 knownSubtotal 仍给出已知小计，但整商品合计待核对。
    const pendingTotal = product.hasPendingTotal === true || product.knownSubtotalComplete === false;

    if (isFirstOccurrence) {
      if (overseasOnHand !== null) overseasQuantity += overseasOnHand;
      if (cells.length > 0 && overseasOnHand === null) overseasUnknownItems += 1;
      if (pendingTotal) {
        overseasPendingTotalProducts += 1;
        if (overseasOnHand !== null) {
          pendingTotalItems.push({
            itemId,
            iceCode: product.iceCode ?? null,
            nameCn: product.nameCn ?? null,
            quantity: overseasOnHand,
          });
        }
      }
      if (overseasOnHand !== null && !costUnavailable) {
        if (cost === null) {
          overseasUnpricedQuantity += overseasOnHand;
        } else {
          overseasPricedQuantity += overseasOnHand;
          overseasPricedProductCount += 1;
          overseasValueScaled = addValue(overseasValueScaled, cost, overseasOnHand);
        }
      }
    }

    for (const cell of cells) {
      const market = normalizeMarket(cell.market);
      if (market === null) unknownMarketItemIds.add(itemId);
      const accumulator = ensureMarket(market);
      const cellOnHand = knownQuantity(cell.onHand);
      if (cellOnHand === null) {
        accumulator.unknownProducts += 1;
        continue;
      }
      accumulator.knownOnHand += cellOnHand;
      accumulator.knownCellCount += 1;
      if (cost !== null) {
        accumulator.valueScaled = addValue(accumulator.valueScaled, cost, cellOnHand);
        accumulator.pricedCellCount += 1;
      }
    }

    const inventoryValueScaled =
      cost !== null && domesticOnHand !== null && overseasOnHand !== null
        ? multiplyMoneyByQuantity(cost, BigInt(domesticOnHand + overseasOnHand))
        : null;
    const anyQuantityKnown = domesticOnHand !== null || overseasOnHand !== null || transitRemaining !== null;
    // 商品行货值只由「库存」组成：在途不并入。缺口标记同样只针对库存口径，
    // 不因在途无记录而把每行都标成不完整；成本读取失败时不在行上冒充缺价。
    const valueIncomplete = costUnavailable
      ? false
      : anyQuantityKnown && (domesticOnHand === null || overseasOnHand === null || cost === null);

    if (isFirstOccurrence) {
      productRows.push({
        itemId,
        iceCode: product.iceCode ?? null,
        nameCn: product.nameCn ?? null,
        gtin: product.gtin ?? null,
        unit: resolveUnit(product),
        domesticOnHand,
        overseasOnHand,
        transitRemaining,
        transitPending,
        pendingTotal,
        costCny: amountsVisible && !costUnavailable && cost !== null ? formatMoney(cost) : null,
        inventoryValueCny:
          amountsVisible && !costUnavailable && inventoryValueScaled !== null ? formatMoney(inventoryValueScaled) : null,
        valueIncomplete,
      });
    }
  }

  /**
   * 只在国内冻结快照出现、商品汇总里没有的标准商品也进入概览：
   * 海外为 null（没有当前海外记录，不是 0），国内数量与在途各自按已知值展示。
   */
  for (const [itemId, domesticQuantity] of domesticByItem) {
    if (seenItemIds.has(itemId)) continue;
    const identity = domesticIdentity.get(itemId);
    const transitProduct = transitProductById.get(itemId) ?? null;
    const transitRemaining = transitRemainingOf(transitProduct);
    const cost = costByItem.get(itemId) ?? null;
    productRows.push({
      itemId,
      iceCode: identity?.iceCode ?? null,
      nameCn: identity?.nameCn ?? null,
      gtin: null,
      unit: null,
      domesticOnHand: domesticQuantity,
      overseasOnHand: null,
      transitRemaining,
      transitPending: transitProduct !== null && safeCount(transitProduct.quantityPendingCount) > 0,
      pendingTotal: false,
      costCny: amountsVisible && !costUnavailable && cost !== null ? formatMoney(cost) : null,
      inventoryValueCny: null,
      valueIncomplete: true,
    });
  }

  /**
   * 只有在途出现、库存汇总/国内快照都没有的已绑定商品也进入概览：
   * 国内/海外保持未知（null，不是 0），在途沿用 028 已知剩余；
   * 商品入口可再核对商品与关联货票（首页行提供「货票」入口）。
   */
  for (const [itemId, transitProduct] of transitProductById) {
    if (seenItemIds.has(itemId) || domesticByItem.has(itemId)) continue;
    const transitRemaining = transitRemainingOf(transitProduct);
    const cost = costUnavailable ? null : (costByItem.get(itemId) ?? null);
    productRows.push({
      itemId,
      iceCode: transitProduct.iceCode ?? null,
      nameCn: transitProduct.nameCn ?? null,
      gtin: null,
      unit: null,
      domesticOnHand: null,
      overseasOnHand: null,
      transitRemaining,
      transitPending: safeCount(transitProduct.quantityPendingCount) > 0,
      pendingTotal: false,
      costCny: amountsVisible && !costUnavailable && cost !== null ? formatMoney(cost) : null,
      inventoryValueCny: null,
      valueIncomplete: true,
    });
  }

  const overseasStage: HomeStage = {
    quantity: overseasQuantity,
    pricedQuantity: overseasPricedQuantity,
    unpricedQuantity: overseasUnpricedQuantity,
    unknownItems: overseasUnknownItems,
    pendingTotalProducts: overseasPendingTotalProducts,
    // 海外没有「来源未关联行」进入商品汇总：未关联来源行在库存待对应里单独统计。
    excludedItems: 0,
    valueCny:
      !costUnavailable && amountsVisible && overseasPricedProductCount > 0 && overseasValueScaled !== null
        ? formatMoney(overseasValueScaled)
        : null,
  };

  /* ---------------- 市场行：库存实物与在途分列 ---------------- */

  const marketRows: HomeMarketRow[] = [];
  for (const [key, accumulator] of markets) {
    marketRows.push({
      market: accumulator.market,
      label: labelFor(accumulator.market, labels),
      onHand: accumulator.knownCellCount > 0 ? accumulator.knownOnHand : null,
      onHandValueCny:
        !costUnavailable && amountsVisible && accumulator.pricedCellCount > 0 && accumulator.valueScaled !== null
          ? formatMoney(accumulator.valueScaled)
          : null,
      unknownProducts: accumulator.unknownProducts,
      transitRemaining: transitByMarket.get(key) ?? null,
      transitValueCny:
        !costUnavailable && amountsVisible && accumulator.transitValueScaled !== null
          ? formatMoney(accumulator.transitValueScaled)
          : null,
      transitTickets: accumulator.transitTickets,
    });
  }

  marketRows.sort((a, b) => {
    // 「市场待确认」永远排最后。
    const aUnknown = a.market === null ? 1 : 0;
    const bUnknown = b.market === null ? 1 : 0;
    if (aUnknown !== bUnknown) return aUnknown - bUnknown;
    // 有库存数量的市场在前，按实物数量降序。
    if (a.onHand !== null && b.onHand !== null) {
      if (a.onHand !== b.onHand) return b.onHand - a.onHand;
    } else if (a.onHand !== null) {
      return -1;
    } else if (b.onHand !== null) {
      return 1;
    }
    const byLabel = a.label.localeCompare(b.label, 'zh-Hans-CN');
    if (byLabel !== 0) return byLabel;
    return (a.market ?? '').localeCompare(b.market ?? '', 'zh-Hans-CN');
  });

  /* ---------------- 估值缺口 ---------------- */

  const missingCostProducts: HomeGapItem[] = [];
  let missingCostQuantity = 0;
  const gapSeenItemIds = new Set<string>();
  const pushGap = (itemId: string, iceCode: string | null, nameCn: string | null, quantity: number): void => {
    if (quantity <= 0 || gapSeenItemIds.has(itemId)) return;
    gapSeenItemIds.add(itemId);
    missingCostProducts.push({ itemId, iceCode, nameCn, quantity });
    missingCostQuantity += quantity;
  };
  // 成本读取失败：本次缺价情况不可判断，不生成补价清单（也不写成 0 缺价）。
  if (!costUnavailable) {
    for (const product of input.products ?? []) {
      if (costByItem.has(product.itemId)) continue;
      const domesticQuantity = domesticByItem.get(product.itemId) ?? 0;
      const overseasQuantityByProduct = truncateFinite(product.overseasOnHand) ?? 0;
      const transitQuantity = transitRemainingOf(transitProductById.get(product.itemId) ?? null) ?? 0;
      pushGap(
        product.itemId,
        product.iceCode ?? null,
        product.nameCn ?? null,
        domesticQuantity + overseasQuantityByProduct + transitQuantity,
      );
    }
    // 只在国内快照出现、商品汇总里没有的商品也要列出（自定义商品范围时会出现）。
    for (const [itemId, domesticQuantity] of domesticByItem) {
      if (seenItemIds.has(itemId)) continue;
      if (costByItem.has(itemId)) continue;
      const identity = domesticIdentity.get(itemId);
      const transitQuantity = transitRemainingOf(transitProductById.get(itemId) ?? null) ?? 0;
      pushGap(itemId, identity?.iceCode ?? null, identity?.nameCn ?? null, domesticQuantity + transitQuantity);
    }
    // 只在在途出现、库存汇总/国内快照都没有的商品：数量已知但缺价时也要能定位。
    for (const [itemId, transitProduct] of transitProductById) {
      if (costByItem.has(itemId) || seenItemIds.has(itemId) || domesticByItem.has(itemId)) continue;
      const transitQuantity = transitRemainingOf(transitProduct) ?? 0;
      pushGap(itemId, transitProduct.iceCode ?? null, transitProduct.nameCn ?? null, transitQuantity);
    }
  }
  missingCostProducts.sort((a, b) => {
    if (b.quantity !== a.quantity) return b.quantity - a.quantity;
    const byCode = (a.iceCode ?? '').localeCompare(b.iceCode ?? '', 'zh-Hans-CN');
    if (byCode !== 0) return byCode;
    return a.itemId.localeCompare(b.itemId);
  });
  pendingTotalItems.sort((a, b) => b.quantity - a.quantity || a.itemId.localeCompare(b.itemId));

  const valuation: HomeValuation = {
    missingCostProducts,
    missingCostQuantity,
    pendingTotalProducts: overseasPendingTotalProducts,
    pendingTotalItems,
    unknownQuantityProducts: overseasUnknownItems,
    unmappedSourceRows: safeCount(input.mappingQueueTotal),
    unknownMarketProducts: unknownMarketItemIds.size,
    costUnavailable,
    transitExclusions,
  };

  return {
    stages: { domestic: domesticStage, transit: transitStage, overseas: overseasStage },
    markets: marketRows,
    products: productRows,
    valuation,
    times: {
      domestic: input.domesticFileDate ?? null,
      overseas: input.overseasTime ?? null,
      transit: input.transitTime ?? null,
    },
    productCount: productRows.length,
  };
}

/**
 * 商品概览搜索：去首尾空白、大小写不敏感，命中货号/中文名/69 编码任一即返回；
 * 空查询返回全部（保持服务端已定的顺序）。
 */
export function searchHomeProducts(rows: readonly HomeProductRow[], q: string): HomeProductRow[] {
  const needle = (q ?? '').trim().toLowerCase();
  if (!needle) return rows.slice();
  return rows.filter((row) => {
    const fields = [row.iceCode, row.nameCn, row.gtin];
    return fields.some(
      (field) => typeof field === 'string' && field.toLowerCase().includes(needle),
    );
  });
}

function clampInteger(value: number, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/**
 * 商品概览分页：pageSize 夹到 1..50，page 夹到 1..pageCount（total=0 时 pageCount=1）。
 * 不修改入参数组，返回切片。
 */
export function paginateHomeProducts<T>(
  rows: readonly T[],
  page: number,
  pageSize: number,
): { rows: T[]; page: number; pageCount: number; total: number } {
  const total = rows.length;
  const size = clampInteger(pageSize, PAGE_SIZE_MIN, PAGE_SIZE_MAX, PAGE_SIZE_MIN);
  const pageCount = total === 0 ? 1 : Math.ceil(total / size);
  const currentPage = clampInteger(page, 1, pageCount, 1);
  const start = (currentPage - 1) * size;
  return {
    rows: rows.slice(start, start + size),
    page: currentPage,
    pageCount,
    total,
  };
}
