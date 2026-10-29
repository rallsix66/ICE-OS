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
  pick,
  pickString,
  pickStringOrNull,
  asIntOrNull,
} from '../normalize';
import type { InventoryQueryState } from '../model';
import { pendingBlocksWrites } from '../model';
import type {
  InventoryBindingViewerDto,
  InventoryItemDetailDto,
  InventoryItemIdentityDto,
  InventoryListDto,
  InventoryMappingQueueDto,
  InventoryMappingWarehouseOptionDto,
  InventoryOverviewDto,
  InventoryPendingActionDto,
  InventoryProductSummaryDto,
  InventoryRunDetailDto,
  InventoryTargetItemDto,
  InventoryWarehouseReadStateV2Dto,
  InventoryWarehouseRowsDto,
  ItemBindingRowDto,
  ItemBindingsDto,
  SourceBindingDto,
  WarehouseSourceItemDto,
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
  const raw = await callReadRpc<unknown>(identity, 'catalog.search_inventory_items_v2', [
    search || null,
    Math.max(1, Math.min(Math.trunc(limit), 20)),
  ]);
  const rows = Array.isArray(raw) ? raw : asArray((raw as Record<string, unknown> | null)?.items);
  const items: InventoryTargetItemDto[] = [];
  for (const entry of rows) {
    const record = (entry ?? {}) as Record<string, unknown>;
    const itemId = pickString(record, 'itemId', 'item_id', 'id');
    if (!itemId) continue;
    items.push({
      itemId,
      iceCode: pickStringOrNull(record, 'iceCode', 'ice_code'),
      nameCn: pickStringOrNull(record, 'nameCn', 'name_cn', 'name'),
      gtin: pickStringOrNull(record, 'gtin'),
      specification: pickStringOrNull(record, 'specification', 'spec'),
      unit: pickStringOrNull(record, 'unit'),
    });
  }
  return items.slice(0, asIntOrNull(limit) ?? 10);
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

/* ------------------------------------------------------------------ *
 * 详情内绑定编辑 v1（UI-1 / UI-2）
 *
 * 读取只走 024 的只读函数；写动作仍走既有 confirm / replace RPC 与 pending 平台。
 * 账号/仓库/SKU 身份由服务端给出，页面只做展示与选择。
 * ------------------------------------------------------------------ */

function bindingViewerOf(
  identity: DbIdentity,
  overview: InventoryOverviewDto,
): InventoryBindingViewerDto {
  return {
    actorId: identity.profileUserId,
    accountId: overview.account.accountId ?? null,
    accountLabel: overview.account.label || null,
  };
}

/** 商品库详情“仓库绑定”：固定商品，返回参与仓清单与当前逐条 BS 绑定。 */
export async function getItemBindings(identity: DbIdentity, itemId: string): Promise<ItemBindingsDto> {
  const [raw, overview] = await Promise.all([
    callReadRpc<unknown>(identity, 'catalog.read_item_binding_rows', [itemId]),
    getInventorySyncOverview(identity),
  ]);
  const root = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const itemRaw = (root.item ?? {}) as Record<string, unknown>;
  const item: InventoryItemIdentityDto = {
    id: pickString(itemRaw, 'itemId', 'id'),
    iceCode: pickStringOrNull(itemRaw, 'iceCode', 'ice_code'),
    nameCn: pickStringOrNull(itemRaw, 'nameCn', 'name_cn'),
  };
  const warehouses = asArray(root.warehouses)
    .map((entry) => {
      const record = (entry ?? {}) as Record<string, unknown>;
      return {
        warehouseId: pickString(record, 'warehouseId', 'warehouse_id', 'id'),
        externalId: pickString(record, 'externalId', 'external_warehouse_id'),
        name: pickString(record, 'name', 'external_name'),
        market: pickStringOrNull(record, 'market'),
        rowCount: asIntOrNull(record.rowCount) ?? 0,
        lastSeenAt: pickStringOrNull(record, 'lastSeenAt', 'lastSuccessAt'),
      } satisfies InventoryMappingWarehouseOptionDto;
    })
    .filter((warehouse) => Boolean(warehouse.warehouseId));
  const bindings = asArray(root.bindings)
    .map((entry) => {
      const record = (entry ?? {}) as Record<string, unknown>;
      const adoption = pickString(record, 'adoption');
      const mappingId = pickString(record, 'mappingId', 'mapping_id');
      const warehouseId = pickString(record, 'warehouseId', 'warehouse_id');
      const externalSku = pickString(record, 'externalSku', 'external_sku');
      if (!mappingId || !warehouseId || !externalSku) return null;
      const row: ItemBindingRowDto = {
        warehouseId,
        warehouseExternalId: pickString(record, 'warehouseExternalId', 'external_warehouse_id'),
        warehouseName: pickString(record, 'warehouseName', 'name', 'external_name'),
        market: pickStringOrNull(record, 'market'),
        externalSku,
        sourceName: pickStringOrNull(record, 'sourceName', 'source_name'),
        gtin: pickStringOrNull(record, 'gtin'),
        unit: pickStringOrNull(record, 'unit'),
        mappingId,
        mappingVersion: asIntOrNull(pick(record, 'mappingVersion', 'mapping_version', 'version')) ?? 0,
        mappingStatus: pickString(record, 'mappingStatus', 'mapping_status') || 'confirmed',
        onHand: asIntOrNull(pick(record, 'onHand', 'on_hand')),
        observedAt: pickStringOrNull(record, 'observedAt', 'observed_at'),
        adoption: adoption === 'adopted' || adoption === 'pending_adoption'
          || adoption === 'inactive' || adoption === 'unseen' ? adoption : 'unseen',
      };
      return row;
    })
    .filter((row): row is ItemBindingRowDto => row !== null);
  return {
    item,
    warehouses,
    bindings,
    viewer: bindingViewerOf(identity, overview),
    pendingLocked: pendingBlocksWrites(overview.pendingAction),
  };
}

/** 指定仓内可选的 BS 来源单品（空 search = 列出该仓最后完整成功批次的全部来源行）。 */
export async function searchWarehouseSourceItems(
  identity: DbIdentity,
  warehouseId: string,
  search: string,
  limit = 50,
): Promise<WarehouseSourceItemDto[]> {
  const raw = await callReadRpc<unknown>(identity, 'catalog.search_inventory_source_items', [
    warehouseId,
    search || null,
    Math.max(1, Math.min(Math.trunc(limit) || 20, 50)),
  ]);
  return asArray(raw)
    .map((entry) => {
      const record = (entry ?? {}) as Record<string, unknown>;
      const externalSku = pickString(record, 'externalSku', 'external_sku');
      if (!externalSku) return null;
      return {
        externalSku,
        sourceName: pickStringOrNull(record, 'sourceName', 'source_name'),
        onHand: asIntOrNull(pick(record, 'onHand', 'on_hand')),
        unit: pickStringOrNull(record, 'unit'),
        gtin: pickStringOrNull(record, 'gtin'),
        excelRow: asIntOrNull(pick(record, 'excelRow', 'excel_row')),
        observedAt: pickStringOrNull(record, 'observedAt', 'observed_at'),
        mappingId: pickStringOrNull(record, 'mappingId', 'mapping_id'),
        mappingVersion: asIntOrNull(pick(record, 'mappingVersion', 'mapping_version', 'version')),
        mappingStatus: pickStringOrNull(record, 'mappingStatus', 'mapping_status'),
        boundItemId: pickStringOrNull(record, 'boundItemId', 'bound_item_id'),
        boundIceCode: pickStringOrNull(record, 'boundIceCode', 'bound_ice_code'),
        boundNameCn: pickStringOrNull(record, 'boundNameCn', 'bound_name_cn'),
      } satisfies WarehouseSourceItemDto;
    })
    .filter((item): item is WarehouseSourceItemDto => item !== null);
}

/** 固定来源（仓 + SKU）的当前对应与最新来源行。 */
export async function getSourceBinding(
  identity: DbIdentity,
  warehouseId: string,
  externalSku: string,
): Promise<SourceBindingDto | null> {
  const [raw, overview] = await Promise.all([
    callReadRpc<unknown>(identity, 'catalog.read_inventory_source_binding', [warehouseId, externalSku]),
    getInventorySyncOverview(identity),
  ]);
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const mappingRaw = record.mapping && typeof record.mapping === 'object'
    ? record.mapping as Record<string, unknown>
    : null;
  const mapping = mappingRaw
    ? {
      mappingId: pickString(mappingRaw, 'mappingId', 'mapping_id', 'id'),
      version: asIntOrNull(pick(mappingRaw, 'version', 'mappingVersion')) ?? 0,
      status: pickString(mappingRaw, 'status') || 'confirmed',
      itemId: pickString(mappingRaw, 'itemId', 'item_id'),
      iceCode: pickStringOrNull(mappingRaw, 'iceCode', 'ice_code'),
      nameCn: pickStringOrNull(mappingRaw, 'nameCn', 'name_cn'),
    }
    : null;
  // R4：采用事实按服务端回执原样解释；缺失/未知值不臆断为 adopted。
  const adoptionRaw = pickString(record, 'adoption').toLowerCase();
  const adoption = adoptionRaw === 'adopted' || adoptionRaw === 'pending_adoption'
    || adoptionRaw === 'inactive' || adoptionRaw === 'unseen'
    ? adoptionRaw
    : null;
  return {
    warehouseId: pickString(record, 'warehouseId', 'warehouse_id'),
    warehouseExternalId: pickStringOrNull(record, 'warehouseExternalId', 'external_warehouse_id'),
    warehouseName: pickString(record, 'warehouseName', 'name', 'external_name'),
    market: pickStringOrNull(record, 'market'),
    externalSku: pickString(record, 'externalSku', 'external_sku'),
    unit: pickStringOrNull(record, 'unit'),
    onHand: asIntOrNull(pick(record, 'onHand', 'on_hand')),
    gtin: pickStringOrNull(record, 'gtin'),
    observedAt: pickStringOrNull(record, 'observedAt', 'observed_at'),
    mapping: mapping && mapping.mappingId && mapping.itemId ? mapping : null,
    adoption,
    viewer: bindingViewerOf(identity, overview),
    pendingLocked: pendingBlocksWrites(overview.pendingAction),
  };
}
