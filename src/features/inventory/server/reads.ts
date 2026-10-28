import 'server-only';

import { requireActiveAdmin } from '@/lib/auth';
import { withReadOnlyAppDb, type DbIdentity } from '@/lib/database/app-db';
import {
  normalizeItemDetail,
  normalizeList,
  normalizeMappingQueue,
  normalizeOverview,
  normalizePendingActions,
  normalizeProductSummary,
  normalizeRunDetail,
  normalizeWarehouseRows,
  normalizeWarehouseStates,
  asArray,
  pickString,
  pickStringOrNull,
  asIntOrNull,
} from '../normalize';
import type { InventoryQueryState } from '../model';
import type {
  InventoryItemDetailDto,
  InventoryListDto,
  InventoryMappingQueueDto,
  InventoryOverviewDto,
  InventoryPendingActionDto,
  InventoryProductSummaryDto,
  InventoryRunDetailDto,
  InventoryTargetItemDto,
  InventoryWarehouseReadStateV2Dto,
  InventoryWarehouseRowsDto,
} from '../types';

/**
 * 商品库存 / BigSeller 同步的服务端读取层（修复包 v2）。
 *
 * - 一律先做服务端鉴权（启用中的管理员），再走 app 角色的只读事务（withReadOnlyAppDb）；
 * - 只调用契约 §1.4 的 app RPC；返回结构经 `normalize.ts` 归一化为页面 DTO；
 * - 列表与详情共用服务端 effective rows 口径：页面不自己另算数量；
 * - 只返回 DTO，不导出数据库行、连接信息或金额。
 */

/** 服务端鉴权：启用中的管理员 → 数据库身份（失败时抛中文原因，由页面分类展示）。 */
export async function requireInventoryAdmin(): Promise<DbIdentity> {
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

export async function getInventorySyncOverview(identity: DbIdentity): Promise<InventoryOverviewDto> {
  const raw = await callReadRpc<unknown>(identity, 'catalog.read_inventory_sync_overview', []);
  return normalizeOverview(raw);
}

/** 任务详情；任务不存在/不在授权范围时返回 null，不伪造空任务。 */
export async function getInventorySyncRun(identity: DbIdentity, runId: string): Promise<InventoryRunDetailDto | null> {
  const raw = await callReadRpc<unknown>(identity, 'catalog.read_inventory_sync_run', [runId]);
  if (!raw || typeof raw !== 'object') return null;
  return normalizeRunDetail(raw);
}

export interface MappingQueueRequest {
  search: string;
  offset: number;
  limit: number;
}

export async function getInventoryMappingQueue(
  identity: DbIdentity,
  request: MappingQueueRequest,
): Promise<InventoryMappingQueueDto> {
  const raw = await callReadRpc<unknown>(identity, 'catalog.read_inventory_mapping_queue', [
    request.search || null,
    request.limit,
    request.offset,
  ]);
  return normalizeMappingQueue(raw);
}

export async function getInventoryList(identity: DbIdentity, query: InventoryQueryState): Promise<InventoryListDto> {
  const offset = (query.page - 1) * query.limit;
  const raw = await callReadRpc<unknown>(identity, 'catalog.read_inventory_list', [
    query.q || null,
    query.warehouse === 'all' ? null : query.warehouse,
    query.market === 'all' ? null : query.market,
    query.limit,
    offset,
  ]);
  const list = normalizeList(raw);
  const scopeWarehouseCount = list.scope.warehouseCount;
  return {
    ...list,
    items: list.items.map((item) => ({
      ...item,
      scopeWarehouseCount: item.scopeWarehouseCount || scopeWarehouseCount,
    })),
    offset: list.offset || offset,
    limit: list.limit || query.limit,
  };
}

/** 详情：默认沿用列表筛选；只有显式 allWarehouses 才看全仓（契约 §1.4）。 */
export async function getInventoryItem(
  identity: DbIdentity,
  itemId: string,
  query: Pick<InventoryQueryState, 'warehouse' | 'market' | 'allWarehouses'>,
): Promise<InventoryItemDetailDto | null> {
  // 市场待确认哨兵（__unknown__）由 016 详情读取识别为“market IS NULL 的仓”，保持同一真实仓范围；
  // 不能退化成不限市场（会把未知仓详情扩大成全部海外仓）。
  const marketParam = query.market === 'all' ? null : query.market;
  const raw = await callReadRpc<unknown>(identity, 'catalog.read_inventory_item', [
    itemId,
    query.warehouse === 'all' ? null : query.warehouse,
    marketParam,
    query.allWarehouses,
  ]);
  if (!raw || typeof raw !== 'object') return null;
  const detail = normalizeItemDetail(raw);
  return {
    ...detail,
    scopeMode: query.allWarehouses ? 'all' : (detail.scopeMode === 'all' ? 'all' : 'filtered'),
  };
}

/** 刷新后的 pending 恢复入口（最近 24h 未完成原请求，payload 原样返回）。 */
export async function getInventoryPendingActions(identity: DbIdentity): Promise<InventoryPendingActionDto[]> {
  const raw = await callReadRpc<unknown>(identity, 'catalog.read_inventory_pending_actions', []);
  return normalizePendingActions(raw);
}

/**
 * 目标商品搜索（R2）：管理员按货号/名称搜索商品主档，不要求有当前库存。
 * DB 侧 RPC：catalog.search_inventory_items(p_search text, p_limit integer)。
 */
export async function searchInventoryTargetItems(
  identity: DbIdentity,
  search: string,
  limit = 10,
): Promise<InventoryTargetItemDto[]> {
  const raw = await callReadRpc<unknown>(identity, 'catalog.search_inventory_items', [
    search || null,
    Math.max(1, Math.min(Math.trunc(limit), 20)),
  ]);
  const rows = Array.isArray(raw) ? raw : asArray((raw as Record<string, unknown> | null)?.items);
  return rows
    .map((entry) => {
      const record = (entry ?? {}) as Record<string, unknown>;
      const itemId = pickString(record, 'itemId', 'item_id', 'id');
      if (!itemId) return null;
      return {
        itemId,
        iceCode: pickStringOrNull(record, 'iceCode', 'ice_code'),
        nameCn: pickStringOrNull(record, 'nameCn', 'name_cn', 'name'),
        gtin: pickStringOrNull(record, 'gtin'),
      };
    })
    .filter((entry): entry is InventoryTargetItemDto => Boolean(entry))
    .slice(0, asIntOrNull(limit) ?? 10);
}

/* ------------------------------------------------------------------ *
 * 商品库存双视图 v1（仓库明细 / 商品汇总 / 逐仓读取状态）
 *
 * DB 侧只读函数（db/catalog/022_inventory_dual_view.sql）：
 * - read_inventory_warehouse_states()：每仓最后完整成功批次的读取状态；
 * - read_inventory_warehouse_rows(q, warehouse, market)：不分页返回全部匹配来源行；
 * - read_inventory_product_summary(q, warehouse, market, limit, offset)：复用 016 的
 *   inventory_read_context + inventory_item_summary_core，与 read_inventory_list 同口径。
 * 国内表格快照不在本读模型内：summary 的 domestic 占位为 null / 0 / available=false，
 * 由页面层用国内冻结快照（task-2 的 getInventoryDomesticSnapshot）合并，不伪造 0。
 * ------------------------------------------------------------------ */

/** 双视图共用的筛选条件；warehouse/market 用 `'all'` 表示不筛选。 */
export interface InventoryDualViewFilter {
  q: string;
  warehouse: string;
  market: string;
}

export interface InventoryProductSummaryRequest extends InventoryDualViewFilter {
  limit: number;
  offset: number;
}

/** 参与仓逐仓读取状态（同步页 / 仓库明细 / 商品汇总共用；以 last_batch_id 为准，不拿最近登记 run 冒充）。 */
export async function getInventoryWarehouseStates(
  identity: DbIdentity,
): Promise<InventoryWarehouseReadStateV2Dto[]> {
  const raw = await callReadRpc<unknown>(identity, 'catalog.read_inventory_warehouse_states', []);
  return normalizeWarehouseStates(raw);
}

/** 仓库明细：服务端返回全部匹配行（不裁剪），页面合并国内快照后自行切页。 */
export async function getInventoryWarehouseRows(
  identity: DbIdentity,
  request: InventoryDualViewFilter,
): Promise<InventoryWarehouseRowsDto> {
  const raw = await callReadRpc<unknown>(identity, 'catalog.read_inventory_warehouse_rows', [
    request.q || null,
    request.warehouse === 'all' ? null : request.warehouse,
    request.market === 'all' ? null : request.market,
  ]);
  const dto = normalizeWarehouseRows(raw);
  return { ...dto, total: dto.rows.length, offset: 0, limit: dto.rows.length };
}

/** 商品汇总：每行 = 标准商品 × 各市场格；合计/缺口全部采信服务端 summary 字段。 */
export async function getInventoryProductSummary(
  identity: DbIdentity,
  request: InventoryProductSummaryRequest,
): Promise<InventoryProductSummaryDto> {
  const limit = Math.max(1, Math.min(Math.trunc(request.limit) || 50, 200));
  const offset = Math.max(0, Math.trunc(request.offset) || 0);
  const raw = await callReadRpc<unknown>(identity, 'catalog.read_inventory_product_summary', [
    request.q || null,
    request.warehouse === 'all' ? null : request.warehouse,
    request.market === 'all' ? null : request.market,
    limit,
    offset,
  ]);
  const dto = normalizeProductSummary(raw);
  return { ...dto, offset: dto.offset || offset, limit: dto.limit || limit };
}

