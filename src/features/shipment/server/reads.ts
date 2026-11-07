import 'server-only';

import { requireActiveAdmin } from '@/lib/auth';
import { catalogRepository } from '@/features/catalog/repository';
import { withReadOnlyAppDb, type DbIdentity } from '@/lib/database/app-db';
import type {
  ProductSearchRowDto,
  ProductShipmentLinksDto,
  ProductShipmentTransitDto,
  ShipmentAutoReaderStatusDto,
  ShipmentDetailDto,
  ShipmentGroupingContextDto,
  ShipmentGroupingReviewDto,
  ShipmentGroupingReviewsDto,
  ShipmentIdentityIndexRow,
  ShipmentLinkedProductDto,
  ShipmentListDto,
  ShipmentManualRevisionDto,
  ShipmentMarketSummaryDto,
  ShipmentSourceStatusDto,
  ShipmentStatusClass,
  ShipmentValueOverviewDto,
} from '../types';
import {
  mergeManualDetail,
  mergeManualListRows,
  normalizeAutoReaderStatus,
  normalizeDetail,
  normalizeGroupingContext,
  normalizeGroupingReviewDetail,
  normalizeGroupingReviews,
  normalizeIdentityIndex,
  normalizeList,
  normalizeManualHistory,
  normalizeManualIndex,
  normalizeMarketSummary,
  normalizeProductLinks,
  normalizeProductSearch,
  normalizeProductTransit,
  normalizeSnapshotRaw,
  normalizeSourceStatus,
  type ShipmentManualIndex,
  type ShipmentSnapshotRawDto,
} from './normalize';
import { buildShipmentProductCard } from './product-card';
import type { ShipmentMarketSummarySource } from '../summary';
import { buildShipmentMarketSummary, buildShipmentTicketValue, buildShipmentValueOverview } from '../summary';
import { buildProductTransit } from '../product-transit';

/**
 * 货票与在途的服务端读取层（026 只读 RPC）。
 *
 * - 一律先做服务端鉴权（启用中的管理员），再走 app 角色的只读事务（withReadOnlyAppDb）；
 * - 只调用 026 的只读函数，返回值归一化为 types.ts 的 DTO；只读，不写任何表；
 * - 失败直接抛错（不吞错、不返回伪造空数据），由页面按读取失败分类展示。
 */

/** 市场筛选用“市场未提供”哨兵：来源国家列为空时按 market IS NULL 过滤。 */
export const SHIPMENT_UNKNOWN_MARKET = '__unknown__';

export type ShipmentListStatusFilter = 'all' | ShipmentStatusClass;

export interface ShipmentListQuery {
  /** 'all' 表示不筛；具体市场用 markets[].market 原值（null 用 SHIPMENT_UNKNOWN_MARKET）。 */
  market: string;
  /** 'all' 表示不筛。 */
  status: ShipmentListStatusFilter;
  /** 关键词：票号/运单号/采购单号/来源品名。 */
  q: string;
  /** 商品 itemId（空串=不筛）。 */
  product: string;
  /** 是否把「本次来源未见」的历史行也包含进列表与计数（默认 false）。 */
  includeAbsent: boolean;
  limit: number;
  offset: number;
}

/** 服务端鉴权：启用中的管理员 → 数据库身份（失败抛中文原因，由页面分类展示）。 */
export async function requireShipmentAdmin(): Promise<DbIdentity> {
  const actor = await requireActiveAdmin();
  return { profileUserId: actor.id };
}

async function callReadRpc<T>(identity: DbIdentity, functionSpec: string, params: unknown[]): Promise<T> {
  const placeholders = params.map((_, index) => `$${index + 1}`).join(', ');
  const sql = params.length > 0
    ? `SELECT ${functionSpec}(${placeholders}) AS result`
    : `SELECT ${functionSpec}() AS result`;
  return withReadOnlyAppDb(identity, async (client) => {
    const result = await client.query<{ result: T }>(sql, params);
    const rows = result.rows as Array<{ result: T }>;
    return rows[0]?.result as T;
  });
}

/**
 * 定时读取状态（027）：只读，读取失败时返回 null（状态条显示“状态读取失败”），
 * 不让自动读取状态读取失败把整个在途列表变成错误页。
 */
async function readAutoReaderStatus(identity: DbIdentity): Promise<ShipmentAutoReaderStatusDto | null> {
  try {
    const raw = await callReadRpc<unknown>(identity, 'catalog.read_shipment_auto_reader_status', []);
    return normalizeAutoReaderStatus(raw);
  } catch {
    return null;
  }
}

function marketParam(market: string): string | null {
  const value = market.trim();
  if (value === '' || value === 'all') return null;
  return value;
}

/**
 * 人工修正索引（029）：读取失败返回 null，只降级「有效状态/人工条数/明细人工字段」，
 * 不让列表或详情整页失败（与自动读取状态同一种降级口径）。
 */
async function readManualIndex(identity: DbIdentity): Promise<ShipmentManualIndex | null> {
  try {
    const raw = await callReadRpc<unknown>(identity, 'catalog.read_shipment_manual_index', []);
    return normalizeManualIndex(raw);
  } catch {
    return null;
  }
}

/** 单票人工修正历史（029）：读取失败返回 null，详情保留主数据。 */
async function readManualHistory(
  identity: DbIdentity,
  shipmentId: string,
): Promise<ShipmentManualRevisionDto[] | null> {
  try {
    const raw = await callReadRpc<unknown>(identity, 'catalog.read_shipment_manual_history', [shipmentId]);
    return normalizeManualHistory(raw);
  } catch {
    return null;
  }
}

/** 顶部来源状态：最近成功读取 + 最近一次尝试（失败不覆盖成功数据）。 */
export async function getShipmentSourceStatus(): Promise<ShipmentSourceStatusDto> {
  const identity = await requireShipmentAdmin();
  const raw = await callReadRpc<unknown>(identity, 'catalog.read_shipment_source_status', []);
  const status = normalizeSourceStatus(raw);
  return { ...status, autoReader: await readAutoReaderStatus(identity) };
}

export async function getShipmentList(query: ShipmentListQuery): Promise<ShipmentListDto> {
  const identity = await requireShipmentAdmin();
  const limit = Math.max(1, Math.min(Math.trunc(query.limit) || 20, 100));
  const offset = Math.max(0, Math.trunc(query.offset) || 0);
  const [raw, manualIndex] = await Promise.all([
    callReadRpc<unknown>(identity, 'catalog.read_shipment_list', [
      marketParam(query.market),
      query.status === 'all' ? null : query.status,
      query.q.trim() || null,
      query.product.trim() || null,
      query.includeAbsent === true,
      limit,
      offset,
    ]),
    readManualIndex(identity),
  ]);
  const list = normalizeList(raw);
  // 状态条同时显示后台自动读取状态（与列表同一签名/session，多一次只读查询）。
  const autoReader = await readAutoReaderStatus(identity);
  return {
    ...list,
    rows: mergeManualListRows(list.rows, manualIndex),
    offset: list.offset || offset,
    limit: list.limit || limit,
    sourceStatus: { ...list.sourceStatus, autoReader },
  };
}

/**
 * 详情商品卡片补全（第四轮）：在途明细绑定商品后，按商品 ID 复用商品库现有读取链
 * （catalogRepository.get 主档 + catalogRepository.amounts = read_item_amounts）拿到
 * 规格/单位/采用进货价，拼成与商品库列表一致的单位成本文本；**不新增 SQL、不改 026**。
 *
 * - 只处理 items + missingItems 里真实出现过的 product.itemId（去重）；
 * - 逐个并行读取，单个商品读取失败只降级该明细的卡片（fallback 身份 + 缺价原因），
 *   不让详情整页失败；
 * - 主档读取失败 → 「商品资料读取失败」；主档正常但价格读取失败 → 「成本读取失败」；
 *   两者都只在对应明细显示，不写 0、不冒充已确认货值。
 */
async function attachProductCards(identity: DbIdentity, detail: ShipmentDetailDto): Promise<ShipmentDetailDto> {
  const fallbackById = new Map<string, { iceCode: string | null; nameCn: string | null }>();
  for (const row of [...detail.items, ...detail.missingItems]) {
    if (row.product && !fallbackById.has(row.product.itemId)) {
      fallbackById.set(row.product.itemId, { iceCode: row.product.iceCode, nameCn: row.product.nameCn });
    }
  }
  if (fallbackById.size === 0) return detail;

  const cards = new Map<string, ShipmentLinkedProductDto>();
  await Promise.all([...fallbackById].map(async ([itemId, fallback]) => {
    const [itemResult, financialResult] = await Promise.allSettled([
      catalogRepository.get(identity, itemId),
      catalogRepository.amounts(identity, itemId),
    ]);
    const item = itemResult.status === 'fulfilled' ? itemResult.value : null;
    const financial = financialResult.status === 'fulfilled' ? financialResult.value : null;
    const card = buildShipmentProductCard(item, financial, { itemId, ...fallback });
    if (item && financialResult.status === 'rejected') {
      card.unitCost = { state: 'missing', amountCny: null, label: '成本待补充', reason: '成本读取失败' };
    }
    cards.set(itemId, card);
  }));

  const withCard = <T extends { product: ShipmentLinkedProductDto | null }>(row: T): T => {
    const card = row.product ? cards.get(row.product.itemId) : null;
    return card ? { ...row, product: card } : row;
  };

  return {
    ...detail,
    items: detail.items.map(withCard),
    missingItems: detail.missingItems.map(withCard),
  };
}

/** 单票详情；票不存在（例如 URL 里的 ticket 已失效）返回 null，由页面按空态处理。 */
export async function getShipmentDetail(shipmentId: string): Promise<ShipmentDetailDto | null> {
  const identity = await requireShipmentAdmin();
  // 026 详情主数据与 029 的人工索引/历史并行读；人工两路失败只降级人工字段。
  const [raw, manualIndex, manualHistory] = await Promise.all([
    callReadRpc<unknown>(identity, 'catalog.read_shipment_detail', [shipmentId]),
    readManualIndex(identity),
    readManualHistory(identity, shipmentId),
  ]);
  const detail = normalizeDetail(raw);
  if (!detail) return null;
  const withCards = await attachProductCards(identity, mergeManualDetail(detail, manualIndex, manualHistory));
  return { ...withCards, ticketValue: buildShipmentTicketValue(withCards.items) };
}

/**
 * 在途市场汇总（第七轮）：028 只读 RPC 返回所选市场全部当前明细；
 * 价格沿用商品库现有批量读取（catalogRepository.list + baselineAmountsMap，与商品库列表同一
 * 采用进货价口径），组装商品卡片后按 026 的剩余在途口径汇总。任一读取失败都抛错，
 * 由页面显示「汇总没读到」，不伪造 0 或空货值。
 */
export async function getShipmentMarketSummary(market: string): Promise<ShipmentMarketSummaryDto> {
  const identity = await requireShipmentAdmin();
  const raw = await callReadRpc<unknown>(identity, 'catalog.read_shipment_market_summary', [market]);
  const source = normalizeMarketSummary(raw);
  return buildShipmentMarketSummary(source, await loadSummaryCards(identity, source));
}

/** 汇总用商品卡片：按商品库现有「采用进货价」口径组装（与商品库列表一致）。 */
async function loadSummaryCards(
  identity: DbIdentity,
  source: ShipmentMarketSummarySource,
): Promise<Map<string, ShipmentLinkedProductDto>> {
  const [catalogItems, financial] = await Promise.all([
    catalogRepository.list(identity),
    catalogRepository.baselineAmountsMap(identity),
  ]);
  const productsById = new Map(catalogItems.map((item) => [item.itemId, item]));
  const cards = new Map<string, ShipmentLinkedProductDto>();
  for (const item of source.items) {
    if (item.productId === null || cards.has(item.productId)) continue;
    cards.set(item.productId, buildShipmentProductCard(
      productsById.get(item.productId) ?? null,
      financial.get(item.productId) ?? null,
      { itemId: item.productId, iceCode: null, nameCn: null },
    ));
  }
  return cards;
}

/**
 * 货值汇总「全部市场」：一次取该来源全部当前明细（028 不过滤市场），
 * 服务端按市场分组后用同一套口径各自合计；价格读取失败直接抛错，不伪造 0。
 */
export async function getShipmentValueOverview(): Promise<ShipmentValueOverviewDto> {
  const identity = await requireShipmentAdmin();
  const raw = await callReadRpc<unknown>(identity, 'catalog.read_shipment_market_summary', ['all']);
  const source = normalizeMarketSummary(raw);
  return buildShipmentValueOverview(source, await loadSummaryCards(identity, source));
}

/**
 * 页面自动更新探测：只读最近成功快照与自动读取状态的时间戳，供已打开页面判断
 * 「后台是否已保存新结果」；只读系统已有结果，**不触发**飞书读取。
 */
export async function getShipmentLiveStamp(): Promise<string> {
  const status = await getShipmentSourceStatus();
  return [
    status.lastSuccess?.snapshotId ?? '',
    status.lastSuccess?.readAt ?? '',
    status.autoReader?.lastReadAt ?? '',
    status.autoReader?.lastResult ?? '',
  ].join('|');
}

/** 商品详情「相关货票」：按商品查在途货票（只读，不新增异步读取链）。 */
export async function getProductShipmentLinks(itemId: string, limit = 20): Promise<ProductShipmentLinksDto> {  const identity = await requireShipmentAdmin();
  const raw = await callReadRpc<unknown>(identity, 'catalog.read_product_shipment_links', [
    itemId,
    Math.max(1, Math.min(Math.trunc(limit) || 20, 50)),
  ]);
  return normalizeProductLinks(raw);
}

/**
 * 商品详情「关联货票」/「在途库存」卡片（第十轮）：031 只读 RPC 返回该商品在当前成功读取里的
 * 逐票明细（已按票聚合、只算当前商品）；剩余、市场小计与待核条数由 product-transit.ts 计算，
 * 数量口径与物流在途页一致（人工修正后的 received_quantity；冲突待复核不计入）。
 */
export async function getProductShipmentInTransit(itemId: string): Promise<ProductShipmentTransitDto> {
  const identity = await requireShipmentAdmin();
  const raw = await callReadRpc<unknown>(identity, 'catalog.read_product_shipment_in_transit', [itemId]);
  return buildProductTransit(normalizeProductTransit(raw));
}

/** 关联编辑用的商品搜索（货号/名称/条码），返回商品主档行，不返回库存/价格。 */
export async function searchProductsForShipment(q: string, limit = 10): Promise<ProductSearchRowDto[]> {
  const identity = await requireShipmentAdmin();
  const raw = await callReadRpc<unknown>(identity, 'catalog.search_products_for_shipment', [
    q.trim() || null,
    Math.max(1, Math.min(Math.trunc(limit) || 10, 20)),
  ]);
  return normalizeProductSearch(raw);
}

/**
 * 身份匹配索引：现有票（含本次来源未见的历史行）的采购单号/运单号/市场/规范品名集合。
 * 只给刷新动作做 §1.3 匹配用，不直接发布给页面。
 */
export async function getShipmentIdentityIndex(): Promise<ShipmentIdentityIndexRow[]> {
  const identity = await requireShipmentAdmin();
  const raw = await callReadRpc<unknown>(identity, 'catalog.read_shipment_identity_index', []);
  return normalizeIdentityIndex(raw);
}

/**
 * 第十二轮：拆票/合票复核上下文（上次成功读取的当前分组 + 生效中的人工覆盖 + 已提醒签名）。
 * 读取失败直接抛错：检测不能建立在猜测的上次分组上。
 */
export async function getShipmentGroupingContext(): Promise<ShipmentGroupingContextDto> {
  const identity = await requireShipmentAdmin();
  const raw = await callReadRpc<unknown>(identity, 'catalog.read_shipment_grouping_state', []);
  return normalizeGroupingContext(raw);
}

/** 第十二轮：页面「待复核」与生效中人工分组（恢复按飞书判断的入口）。 */
export async function getShipmentGroupingReviews(): Promise<ShipmentGroupingReviewsDto> {
  const identity = await requireShipmentAdmin();
  const raw = await callReadRpc<unknown>(identity, 'catalog.read_shipment_grouping_reviews', []);
  return normalizeGroupingReviews(raw);
}

/**
 * 单条拆合票复核（含 evidence，任意状态）：保存决定/恢复时用于限定「本次复核涉及的票」。
 * 不存在时返回 null，由动作返回结构化错误，不伪造复核。
 */
export async function getShipmentGroupingReview(reviewId: string): Promise<ShipmentGroupingReviewDto | null> {
  const identity = await requireShipmentAdmin();
  const raw = await callReadRpc<unknown>(identity, 'catalog.read_shipment_grouping_review', [reviewId]);
  return normalizeGroupingReviewDetail(raw);
}

/** 第十二轮：最新成功快照的原始网格（人工决定后按当前覆盖重新解释一次）。 */
export async function getLatestShipmentSnapshotRaw(): Promise<ShipmentSnapshotRawDto | null> {
  const identity = await requireShipmentAdmin();
  const raw = await callReadRpc<unknown>(identity, 'catalog.read_shipment_latest_snapshot_raw', []);
  return normalizeSnapshotRaw(raw);
}
