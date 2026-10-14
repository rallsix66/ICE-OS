// 物流模块数据访问层 — 封装 shipment / shipment_item / tracking_event 查询
import { cache } from 'react';
import { callAppRpc, queryAppRows, type DbIdentity } from '@/lib/database/app-db';
import { requireAppDbIdentity } from '@/lib/database/app-identity';
import { isIndependentPlatformRuntime } from '@/lib/database/runtime';
import { createClient } from '@/lib/supabase/server';
import { unwrapJoin } from '@/lib/supabase/helpers';
import { warehouseAccessRepository } from '@/features/warehouse-access/repository';
import { variantRepository } from '@/features/variants/repository';
import { isValidStatusTransition } from './schema';
import type {
  ShipmentListItem,
  ShipmentDetail,
  ShipmentFilters,
  CreateShipmentData,
  ShipmentRow,
  UpdateShipmentData,
  VariantSelectorItem,
  WarehouseSelectorItem,
  InTransitDetailItem,
  TrackingEventDetail,
  PartialWarehouseItem,
  PartialWarehouseResult,
  EligibleShipmentFilters,
  EligibleShipmentItem,
  ConfirmedWarehousedAggregation,
  PlannedShipmentContext,
  PlannedShipmentReadBack,
  CancelPlannedShipmentResult,
  InTransitDetail,
  InTransitDetailFilters,
  UpcomingArrival,
} from './types';
import type { PaginatedResult } from '@/types/common';

const PAGE_SIZE = 20;

async function resolveShipmentDbIdentity(userId?: string): Promise<DbIdentity> {
  if (userId) return { profileUserId: userId };
  return requireAppDbIdentity();
}

function escapeShipmentIlike(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

export interface ShipmentDbErrorMeta {
  dbCode?: string;
  constraint?: string;
  dbMessage?: string;
  dbDetails?: string;
  dbHint?: string;
}

export function extractShipmentDbErrorMeta(error: unknown): ShipmentDbErrorMeta {
  const raw = (error ?? {}) as Record<string, unknown>;
  const dbMessage = typeof raw.message === 'string' ? raw.message : undefined;
  const structuredConstraint =
    typeof raw.constraint === 'string' ? raw.constraint : undefined;
  const exactConstraint = dbMessage?.match(
    /duplicate key value violates unique constraint "shipment_no_unique"/,
  )
    ? 'shipment_no_unique'
    : undefined;

  return {
    dbCode: typeof raw.code === 'string' ? raw.code : undefined,
    constraint: structuredConstraint ?? exactConstraint,
    dbMessage,
    dbDetails: typeof raw.details === 'string' ? raw.details : undefined,
    dbHint: typeof raw.hint === 'string' ? raw.hint : undefined,
  };
}

export class ShipmentError extends Error {
  constructor(
    message: string,
    public code: 'VALIDATION' | 'NOT_FOUND' | 'DB_ERROR' | 'FORBIDDEN',
    public meta?: ShipmentDbErrorMeta,
  ) {
    super(message);
    this.name = 'ShipmentError';
  }
}

const getUserRole = cache(
  async (userId: string): Promise<'admin' | 'operator' | 'unknown'> => {
    if (isIndependentPlatformRuntime()) {
      const rows = await queryAppRows<{ name: string }>(
        { profileUserId: userId },
        `SELECT r.name FROM public.profiles p
         JOIN public.role r ON r.id = p.role_id
         WHERE p.id = $1 LIMIT 1`,
        [userId],
      );
      const roleName = rows[0]?.name;
      if (roleName === 'admin') return 'admin';
      if (roleName === 'operator') return 'operator';
      return rows.length === 0 ? 'unknown' : 'unknown';
    }

    const supabase = await createClient();
    const { data: profile, error } = await supabase
      .from('profiles')
      .select('role:role_id(name)')
      .eq('id', userId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return 'unknown';
      throw new ShipmentError('查询用户角色失败', 'DB_ERROR');
    }

    const roleName = (profile as unknown as { role: { name: string } } | null)?.role?.name;
    if (roleName === 'admin') return 'admin';
    if (roleName === 'operator') return 'operator';
    return 'unknown';
  },
);

export const shipmentRepository = {
  /** P1: 复用 get_in_transit_detail RPC；可选筛选未提供时映射为 RPC null。 */
  async getInTransitDetail(
    userId: string,
    filters: InTransitDetailFilters = {},
  ): Promise<InTransitDetail[]> {
    let data: unknown;
    if (isIndependentPlatformRuntime()) {
      const raw = await callAppRpc<unknown>(
        { profileUserId: userId },
        'public.get_in_transit_detail',
        [userId, filters.warehouseId ?? null, filters.variantId ?? null],
      );
      if (Array.isArray(raw)) {
        data = raw;
      } else if (raw == null) {
        data = [];
      } else if (typeof raw === 'string') {
        data = JSON.parse(raw) as unknown;
      } else {
        data = raw;
      }
    } else {
      const supabase = await createClient();
      const { data: rpcData, error } = await supabase.rpc('get_in_transit_detail', {
        p_user_id: userId,
        p_warehouse_id: filters.warehouseId ?? null,
        p_variant_id: filters.variantId ?? null,
      });

      if (error) {
        throw new ShipmentError('查询 ETA 已知的计划及在途失败', 'DB_ERROR');
      }
      data = rpcData;
    }

    if (!Array.isArray(data)) {
      throw new ShipmentError('计划及在途返回结构校验失败', 'DB_ERROR');
    }

    return data.map((value) => {
      const row = value as Record<string, unknown>;
      if (
        typeof row.shipment_id !== 'string'
        || typeof row.variant_id !== 'string'
        || typeof row.warehouse_id !== 'string'
        || typeof row.status !== 'string'
        || typeof row.estimated_arrival !== 'string'
        || typeof row.remaining_quantity !== 'number'
        || typeof row.is_planned !== 'boolean'
      ) {
        throw new ShipmentError('计划及在途返回结构校验失败', 'DB_ERROR');
      }
      return {
        shipmentId: row.shipment_id,
        variantId: row.variant_id,
        warehouseId: row.warehouse_id,
        status: row.status,
        estimatedArrival: row.estimated_arrival,
        remainingQuantity: row.remaining_quantity,
        isPlanned: row.is_planned,
      };
    });
  },

  /** 首页：未来 days 日内已发货且仍有剩余数量的 Top4 到港单。 */
  async getUpcomingArrivals(userId: string, days = 7): Promise<UpcomingArrival[]> {
    if (!Number.isInteger(days) || days < 1 || days > 30) {
      throw new ShipmentError('到港查询天数必须是 1 到 30 的整数', 'VALIDATION');
    }

    const accessibleIds = await warehouseAccessRepository.getAccessibleWarehouseIds(userId);
    if (accessibleIds.size === 0) return [];

    const today = new Date();
    const startDate = today.toISOString().slice(0, 10);
    const end = new Date(`${startDate}T00:00:00.000Z`);
    end.setUTCDate(end.getUTCDate() + days);
    const endDate = end.toISOString().slice(0, 10);

    type UpcomingRow = {
      id: string;
      shipment_no: string;
      warehouse_id: string;
      country: string;
      estimated_arrival: string;
      status: 'departed' | 'arrived' | 'customs';
      warehouse: { name: string } | null;
      items: Array<{
        quantity: number;
        warehoused_quantity: number;
        variant: { name: string; sku: string } | null;
      }>;
    };

    let rows: UpcomingRow[];

    if (isIndependentPlatformRuntime()) {
      const identity = { profileUserId: userId };
      const whIds = [...accessibleIds];
      const headerRows = await queryAppRows<{
        id: string;
        shipment_no: string;
        warehouse_id: string;
        country: string;
        estimated_arrival: string;
        status: 'departed' | 'arrived' | 'customs';
        warehouse_name: string | null;
      }>(
        identity,
        `SELECT s.id, s.shipment_no, s.warehouse_id, s.country, s.estimated_arrival, s.status,
                w.name AS warehouse_name
         FROM public.shipment s
         LEFT JOIN public.warehouse w ON w.id = s.warehouse_id
         WHERE s.warehouse_id = ANY($1::uuid[])
           AND s.status = ANY(ARRAY['departed', 'arrived', 'customs']::text[])
           AND s.cancelled_at IS NULL
           AND s.bigseller_absorbed_at IS NULL
           AND s.estimated_arrival IS NOT NULL
           AND s.estimated_arrival >= $2::date
           AND s.estimated_arrival <= $3::date`,
        [whIds, startDate, endDate],
      );

      if (headerRows.length === 0) {
        return [];
      }

      const shipmentIds = headerRows.map((r) => r.id);
      const itemRows = await queryAppRows<{
        shipment_id: string;
        quantity: number;
        warehoused_quantity: number;
        variant_name: string | null;
        variant_sku: string | null;
      }>(
        identity,
        `SELECT si.shipment_id, si.quantity, si.warehoused_quantity,
                pv.name AS variant_name, pv.sku AS variant_sku
         FROM public.shipment_item si
         LEFT JOIN public.product_variant pv ON pv.id = si.variant_id
         WHERE si.shipment_id = ANY($1::uuid[])`,
        [shipmentIds],
      );

      const itemsByShipment = new Map<string, UpcomingRow['items']>();
      for (const item of itemRows) {
        const list = itemsByShipment.get(item.shipment_id) ?? [];
        list.push({
          quantity: item.quantity,
          warehoused_quantity: item.warehoused_quantity,
          variant:
            item.variant_name || item.variant_sku
              ? { name: item.variant_name ?? '', sku: item.variant_sku ?? '' }
              : null,
        });
        itemsByShipment.set(item.shipment_id, list);
      }

      rows = headerRows.map((h) => ({
        id: h.id,
        shipment_no: h.shipment_no,
        warehouse_id: h.warehouse_id,
        country: h.country,
        estimated_arrival: h.estimated_arrival,
        status: h.status,
        warehouse: h.warehouse_name ? { name: h.warehouse_name } : null,
        items: itemsByShipment.get(h.id) ?? [],
      }));
    } else {
      const supabase = await createClient();
      const { data, error } = await supabase
        .from('shipment')
        .select(
          `id, shipment_no, warehouse_id, country, estimated_arrival, status,
         warehouse:warehouse_id(name),
         items:shipment_item(
           quantity, warehoused_quantity,
           variant:variant_id(name, sku)
         )`,
        )
        .in('warehouse_id', [...accessibleIds])
        .in('status', ['departed', 'arrived', 'customs'])
        .is('cancelled_at', null)
        .is('bigseller_absorbed_at', null)
        .not('estimated_arrival', 'is', null)
        .gte('estimated_arrival', startDate)
        .lte('estimated_arrival', endDate);

      if (error) {
        throw new ShipmentError('查询近期到港失败，请稍后重试', 'DB_ERROR');
      }

      rows = (data ?? []) as unknown as UpcomingRow[];
    }

    const arrivals: UpcomingArrival[] = [];
    for (const row of rows) {
      const validItems = (row.items ?? []).filter(
        (item) => item.quantity - item.warehoused_quantity > 0,
      );
      const remainingQuantity = validItems.reduce(
        (sum, item) => sum + item.quantity - item.warehoused_quantity,
        0,
      );
      if (remainingQuantity <= 0) continue;

      arrivals.push({
        shipmentId: row.id,
        shipmentNo: row.shipment_no,
        warehouseId: row.warehouse_id,
        warehouseName: row.warehouse?.name ?? '未命名仓库',
        country: row.country,
        estimatedArrival: row.estimated_arrival,
        status: row.status,
        remainingQuantity,
        itemCount: validItems.length,
        itemNames: validItems.map((item) => item.variant?.name || item.variant?.sku || '未命名 SKU'),
      });
    }

    arrivals.sort(
      (a, b) =>
        a.estimatedArrival.localeCompare(b.estimatedArrival)
        || a.shipmentNo.localeCompare(b.shipmentNo),
    );
    return arrivals.slice(0, 4);
  },

  /** P3-S2A/P3-S2B: 在途列表（不含 warehoused），含仓库隔离 */
  async list(
    filters: ShipmentFilters = {},
    userId?: string,
  ): Promise<PaginatedResult<ShipmentListItem>> {
    const { country, status, page = 1, pageSize = PAGE_SIZE } = filters;

    let accessibleWhIds: string[] | null = null;
    if (userId) {
      const role = await getUserRole(userId);
      if (role === 'operator') {
        const accessibleIds = await warehouseAccessRepository.getAccessibleWarehouseIds(userId);
        if (accessibleIds.size === 0) {
          return { data: [], total: 0, page, pageSize };
        }
        accessibleWhIds = [...accessibleIds];
      }
    }

    type ListSourceRow = {
      id: string;
      shipment_no: string;
      purchase_order_no: string | null;
      vessel_name: string | null;
      voyage_number: string | null;
      country: string;
      warehouse_id: string | null;
      status: string;
      estimated_arrival: string | null;
      created_by: string;
      created_at: string;
      warehouse: { name: string } | null;
      items: Array<{
        quantity: number;
        warehoused_quantity: number;
        variant: { product: { name: string } | null } | null;
      }>;
    };

    let rows: ListSourceRow[];
    let total: number;

    if (isIndependentPlatformRuntime()) {
      const identity = await resolveShipmentDbIdentity(userId);
      const conditions = [`s.status != 'warehoused'`];
      const params: unknown[] = [];
      let paramIndex = 1;
      if (accessibleWhIds) {
        conditions.push(`s.warehouse_id = ANY($${paramIndex++}::uuid[])`);
        params.push(accessibleWhIds);
      }
      if (country) {
        conditions.push(`s.country = $${paramIndex++}`);
        params.push(country);
      }
      if (status) {
        conditions.push(`s.status = $${paramIndex++}`);
        params.push(status);
      }
      const whereSql = conditions.join(' AND ');
      const countRows = await queryAppRows<{ count: string }>(
        identity,
        `SELECT COUNT(*)::text AS count FROM public.shipment s WHERE ${whereSql}`,
        params,
      );
      total = Number(countRows[0]?.count ?? 0);
      if (total === 0) {
        return { data: [], total: 0, page, pageSize };
      }
      const offset = (page - 1) * pageSize;
      const listParams = [...params, pageSize, offset];
      const headerRows = await queryAppRows<{
        id: string;
        shipment_no: string;
        purchase_order_no: string | null;
        vessel_name: string | null;
        voyage_number: string | null;
        country: string;
        warehouse_id: string | null;
        status: string;
        estimated_arrival: string | null;
        created_by: string;
        created_at: string;
        warehouse_name: string | null;
      }>(
        identity,
        `SELECT s.id, s.shipment_no, s.purchase_order_no, s.vessel_name, s.voyage_number, s.country,
                s.warehouse_id, s.status, s.estimated_arrival, s.created_by, s.created_at,
                w.name AS warehouse_name
         FROM public.shipment s
         LEFT JOIN public.warehouse w ON w.id = s.warehouse_id
         WHERE ${whereSql}
         ORDER BY s.created_at DESC
         LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
        listParams,
      );
      const shipmentIds = headerRows.map((r) => r.id);
      const itemRows = await queryAppRows<{
        shipment_id: string;
        quantity: number;
        warehoused_quantity: number;
        product_name: string | null;
      }>(
        identity,
        `SELECT si.shipment_id, si.quantity, si.warehoused_quantity, p.name AS product_name
         FROM public.shipment_item si
         LEFT JOIN public.product_variant pv ON pv.id = si.variant_id
         LEFT JOIN public.product p ON p.id = pv.product_id
         WHERE si.shipment_id = ANY($1::uuid[])`,
        [shipmentIds],
      );
      const itemsByShipment = new Map<string, ListSourceRow['items']>();
      for (const item of itemRows) {
        const list = itemsByShipment.get(item.shipment_id) ?? [];
        list.push({
          quantity: item.quantity,
          warehoused_quantity: item.warehoused_quantity,
          variant: item.product_name ? { product: { name: item.product_name } } : null,
        });
        itemsByShipment.set(item.shipment_id, list);
      }
      rows = headerRows.map((h) => ({
        id: h.id,
        shipment_no: h.shipment_no,
        purchase_order_no: h.purchase_order_no,
        vessel_name: h.vessel_name,
        voyage_number: h.voyage_number,
        country: h.country,
        warehouse_id: h.warehouse_id,
        status: h.status,
        estimated_arrival: h.estimated_arrival,
        created_by: h.created_by,
        created_at: h.created_at,
        warehouse: h.warehouse_name ? { name: h.warehouse_name } : null,
        items: itemsByShipment.get(h.id) ?? [],
      }));
    } else {
      const supabase = await createClient();
      let query = supabase
        .from('shipment')
        .select(
          `id, shipment_no, purchase_order_no, vessel_name, voyage_number, country, warehouse_id, status,
         estimated_arrival, created_by, created_at,
         warehouse:warehouse_id(name),
         items:shipment_item (
           quantity, warehoused_quantity,
           variant:variant_id (product:product_id (name))
         )`,
          { count: 'exact' },
        )
        .neq('status', 'warehoused');

      if (accessibleWhIds) {
        query = query.in('warehouse_id', accessibleWhIds);
      }
      if (country) query = query.eq('country', country);
      if (status) query = query.eq('status', status);

      const from = (page - 1) * pageSize;
      const { data, error, count } = await query
        .order('created_at', { ascending: false })
        .range(from, from + pageSize - 1);

      if (error) {
        throw new ShipmentError('查询在途列表失败', 'DB_ERROR');
      }
      if (!data) {
        return { data: [], total: 0, page, pageSize };
      }
      total = count ?? 0;
      rows = data as unknown as ListSourceRow[];
    }

    return {
      data: rows.map((row) => {
        const items = row.items ?? [];
        const wh = row.warehouse;

        // P3-S2B: 聚合品名（最多 3 个，逗号分隔）
        const productNames: string[] = [];
        for (const item of items) {
          const name = item.variant?.product?.name;
          if (name && !productNames.includes(name)) {
            productNames.push(name);
            if (productNames.length >= 3) break;
          }
        }

        return {
          id: row.id,
          shipmentNo: row.shipment_no,
          purchaseOrderNo: row.purchase_order_no,
          vesselName: row.vessel_name,
          voyageNumber: row.voyage_number,
          country: row.country,
          warehouseName: wh?.name ?? null,
          status: row.status,
          estimatedArrival: row.estimated_arrival,
          productCount: items.length,
          totalQuantity: items.reduce((sum, i) => sum + i.quantity, 0),
          inTransitQuantity: items.reduce((sum, i) => sum + (i.quantity - i.warehoused_quantity), 0),
          productNames: productNames.length > 0 ? productNames.join('、') : null,
          createdBy: row.created_by,
          createdAt: row.created_at,
        };
      }),
      total,
      page,
      pageSize,
    };
  },

  /** P3-S2C: 按 variant_id 聚合在途数量（只读，不写 inventory）
   *  在途 = shipment_item.quantity - shipment_item.warehoused_quantity
   *  排除 shipment.status = 'warehoused'
   *  Operator 仅统计已分配仓库；Admin 统计全部 */
  async getInTransitByVariant(userId?: string): Promise<Map<string, number>> {
    let accessibleWhIds: Set<string> | null = null;
    if (userId) {
      const role = await getUserRole(userId);
      if (role === 'operator') {
        const ids = await warehouseAccessRepository.getAccessibleWarehouseIds(userId);
        if (ids.size === 0) return new Map();
        accessibleWhIds = ids;
      }
    }

    let shipmentIds: string[];
    if (isIndependentPlatformRuntime()) {
      const identity = await resolveShipmentDbIdentity(userId);
      const params: unknown[] = [];
      let sql = `SELECT id FROM public.shipment WHERE status != 'warehoused'`;
      if (accessibleWhIds) {
        params.push([...accessibleWhIds]);
        sql += ` AND warehouse_id = ANY($1::uuid[])`;
      }
      const shipments = await queryAppRows<{ id: string }>(identity, sql, params);
      if (shipments.length === 0) return new Map();
      shipmentIds = shipments.map((s) => s.id);
      const items = await queryAppRows<{
        variant_id: string;
        quantity: number;
        warehoused_quantity: number;
      }>(
        identity,
        `SELECT variant_id, quantity, warehoused_quantity FROM public.shipment_item
         WHERE shipment_id = ANY($1::uuid[])`,
        [shipmentIds],
      );
      const map = new Map<string, number>();
      for (const item of items) {
        const inTransit = item.quantity - item.warehoused_quantity;
        map.set(item.variant_id, (map.get(item.variant_id) ?? 0) + inTransit);
      }
      return map;
    }

    const supabase = await createClient();
    let query = supabase.from('shipment').select('id').neq('status', 'warehoused');
    if (accessibleWhIds) {
      query = query.in('warehouse_id', [...accessibleWhIds]);
    }
    const { data: shipments, error } = await query;
    if (error) {
      throw new ShipmentError('查询在途数据失败', 'DB_ERROR');
    }
    if (!shipments || shipments.length === 0) return new Map();
    shipmentIds = shipments.map((s) => s.id);
    const { data: items, error: itemsErr } = await supabase
      .from('shipment_item')
      .select('variant_id, quantity, warehoused_quantity')
      .in('shipment_id', shipmentIds);
    if (itemsErr) {
      throw new ShipmentError('查询在途数据失败', 'DB_ERROR');
    }
    const map = new Map<string, number>();
    for (const item of items ?? []) {
      const inTransit = item.quantity - item.warehoused_quantity;
      map.set(item.variant_id, (map.get(item.variant_id) ?? 0) + inTransit);
    }
    return map;
  },

  /** P3-S2D: 按 (variant_id, warehouse_id) 聚合在途数量（只读，不写 inventory）
   *  在途 = shipment_item.quantity - shipment_item.warehoused_quantity
   *  排除 shipment.status = 'warehoused'
   *  Operator 仅统计已分配仓库；Admin 统计全部
   *  返回 Map<variantId, Map<warehouseId, inTransitQty>> */
  async getInTransitByVariantAndWarehouse(
    userId?: string,
  ): Promise<Map<string, Map<string, number>>> {
    let accessibleWhIds: Set<string> | null = null;
    if (userId) {
      const role = await getUserRole(userId);
      if (role === 'operator') {
        const ids = await warehouseAccessRepository.getAccessibleWarehouseIds(userId);
        if (ids.size === 0) return new Map();
        accessibleWhIds = ids;
      }
    }

    const buildMap = (
      shipments: Array<{ id: string; warehouse_id: string | null }>,
      items: Array<{
        variant_id: string;
        quantity: number;
        warehoused_quantity: number;
        shipment_id: string;
      }>,
    ) => {
      const shipmentWarehouseMap = new Map<string, string>();
      for (const s of shipments) {
        if (s.warehouse_id) {
          shipmentWarehouseMap.set(s.id, s.warehouse_id);
        }
      }
      const map = new Map<string, Map<string, number>>();
      for (const item of items) {
        const whId = shipmentWarehouseMap.get(item.shipment_id);
        if (!whId) continue;
        const inTransit = item.quantity - item.warehoused_quantity;
        let innerMap = map.get(item.variant_id);
        if (!innerMap) {
          innerMap = new Map();
          map.set(item.variant_id, innerMap);
        }
        innerMap.set(whId, (innerMap.get(whId) ?? 0) + inTransit);
      }
      return map;
    };

    if (isIndependentPlatformRuntime()) {
      const identity = await resolveShipmentDbIdentity(userId);
      const params: unknown[] = [];
      let sql = `SELECT id, warehouse_id FROM public.shipment WHERE status != 'warehoused'`;
      if (accessibleWhIds) {
        params.push([...accessibleWhIds]);
        sql += ` AND warehouse_id = ANY($1::uuid[])`;
      }
      const shipments = await queryAppRows<{ id: string; warehouse_id: string | null }>(
        identity,
        sql,
        params,
      );
      if (shipments.length === 0) return new Map();
      const shipmentIds = shipments.map((s) => s.id);
      const items = await queryAppRows<{
        variant_id: string;
        quantity: number;
        warehoused_quantity: number;
        shipment_id: string;
      }>(
        identity,
        `SELECT variant_id, quantity, warehoused_quantity, shipment_id FROM public.shipment_item
         WHERE shipment_id = ANY($1::uuid[])`,
        [shipmentIds],
      );
      return buildMap(shipments, items);
    }

    const supabase = await createClient();
    let query = supabase.from('shipment').select('id, warehouse_id').neq('status', 'warehoused');
    if (accessibleWhIds) {
      query = query.in('warehouse_id', [...accessibleWhIds]);
    }
    const { data: shipments, error } = await query;
    if (error) {
      throw new ShipmentError('查询在途数据失败', 'DB_ERROR');
    }
    if (!shipments || shipments.length === 0) return new Map();
    const shipmentIds = shipments.map((s) => s.id);
    const { data: items, error: itemsErr } = await supabase
      .from('shipment_item')
      .select('variant_id, quantity, warehoused_quantity, shipment_id')
      .in('shipment_id', shipmentIds);
    if (itemsErr) {
      throw new ShipmentError('查询在途数据失败', 'DB_ERROR');
    }
    return buildMap(shipments, items ?? []);
  },

  /** P3-S2E: 按 (variant_id, warehouse_id) 查询内部在途明细（只读，不写 inventory）
   *  返回指定 variant + warehouse 的每条在途明细：
   *    - shipment_no / purchase_order_no
   *    - 数量（quantity - warehoused_quantity）
   *    - 预计到货时间 estimated_arrival
   *    - shipment_id 供跳转详情
   *  排除 shipment.status = 'warehoused'
   *  Operator 仅查看已分配仓库；Admin 全部可见
   *  不读 external 三表，不接 Best，不做入库联动 */
  async getInTransitDetailsByVariantAndWarehouse(
    variantId: string,
    warehouseId: string,
    userId?: string,
  ): Promise<InTransitDetailItem[]> {
    if (userId) {
      const role = await getUserRole(userId);
      if (role === 'operator') {
        const ids = await warehouseAccessRepository.getAccessibleWarehouseIds(userId);
        if (!ids.has(warehouseId)) return [];
      }
    }

    type ShipmentBrief = {
      id: string;
      shipment_no: string;
      purchase_order_no: string | null;
      status: string;
      estimated_arrival: string | null;
      updated_at: string | null;
    };

    let shipments: ShipmentBrief[];
    let trackingMap: Map<string, string>;
    let items: Array<{ shipment_id: string; quantity: number; warehoused_quantity: number }>;

    if (isIndependentPlatformRuntime()) {
      const identity = await resolveShipmentDbIdentity(userId);
      shipments = await queryAppRows<ShipmentBrief>(
        identity,
        `SELECT id, shipment_no, purchase_order_no, status, estimated_arrival, updated_at
         FROM public.shipment
         WHERE warehouse_id = $1::uuid AND status != 'warehoused'`,
        [warehouseId],
      );
      if (shipments.length === 0) return [];
      const shipmentIds = shipments.map((s) => s.id);
      const trackingRows = await queryAppRows<{ shipment_id: string; occurred_at: string }>(
        identity,
        `SELECT shipment_id, occurred_at FROM public.tracking_event
         WHERE shipment_id = ANY($1::uuid[])
         ORDER BY occurred_at DESC`,
        [shipmentIds],
      );
      trackingMap = new Map<string, string>();
      for (const t of trackingRows) {
        if (!trackingMap.has(t.shipment_id)) {
          trackingMap.set(t.shipment_id, t.occurred_at);
        }
      }
      items = await queryAppRows<{
        shipment_id: string;
        quantity: number;
        warehoused_quantity: number;
      }>(
        identity,
        `SELECT shipment_id, quantity, warehoused_quantity FROM public.shipment_item
         WHERE shipment_id = ANY($1::uuid[]) AND variant_id = $2::uuid`,
        [shipmentIds, variantId],
      );
      if (items.length === 0) return [];
    } else {
      const supabase = await createClient();
      const { data: shipData, error: shipErr } = await supabase
        .from('shipment')
        .select('id, shipment_no, purchase_order_no, status, estimated_arrival, updated_at')
        .eq('warehouse_id', warehouseId)
        .neq('status', 'warehoused');
      if (shipErr) {
        throw new ShipmentError('查询在途明细失败', 'DB_ERROR');
      }
      if (!shipData || shipData.length === 0) return [];
      shipments = shipData;
      const shipmentIds = shipments.map((s) => s.id);
      const { data: trackingRows, error: trackingErr } = await supabase
        .from('tracking_event')
        .select('shipment_id, occurred_at')
        .in('shipment_id', shipmentIds)
        .order('occurred_at', { ascending: false });
      if (trackingErr) {
        throw new ShipmentError('查询在途明细失败', 'DB_ERROR');
      }
      trackingMap = new Map<string, string>();
      if (trackingRows) {
        for (const t of trackingRows) {
          if (!trackingMap.has(t.shipment_id)) {
            trackingMap.set(t.shipment_id, t.occurred_at);
          }
        }
      }
      const { data: itemData, error: itemsErr } = await supabase
        .from('shipment_item')
        .select('shipment_id, quantity, warehoused_quantity')
        .in('shipment_id', shipmentIds)
        .eq('variant_id', variantId);
      if (itemsErr) {
        throw new ShipmentError('查询在途明细失败', 'DB_ERROR');
      }
      if (!itemData || itemData.length === 0) return [];
      items = itemData;
    }

    const shipMap = new Map<string, ShipmentBrief>();
    for (const s of shipments) {
      shipMap.set(s.id, s);
    }

    const results: InTransitDetailItem[] = [];
    for (const item of items) {
      const ship = shipMap.get(item.shipment_id);
      if (!ship) continue;
      const inTransit = item.quantity - item.warehoused_quantity;
      if (inTransit <= 0) continue;
      results.push({
        shipmentId: ship.id,
        shipmentNo: ship.shipment_no,
        purchaseOrderNo: ship.purchase_order_no,
        quantity: inTransit,
        status: ship.status,
        estimatedArrival: ship.estimated_arrival,
        latestTrackingAt: trackingMap.get(ship.id) ?? ship.updated_at ?? null,
      });
    }

    results.sort((a, b) => {
      if (!a.estimatedArrival && !b.estimatedArrival) return a.shipmentNo.localeCompare(b.shipmentNo);
      if (!a.estimatedArrival) return 1;
      if (!b.estimatedArrival) return -1;
      const cmp = a.estimatedArrival.localeCompare(b.estimatedArrival);
      return cmp !== 0 ? cmp : a.shipmentNo.localeCompare(b.shipmentNo);
    });

    return results;
  },

  /** P3-S2A: 物流单详情，含仓库隔离 */
  async getById(id: string, userId?: string): Promise<ShipmentDetail | null> {
    let shipment: ShipmentRow | null = null;

    if (isIndependentPlatformRuntime()) {
      const identity = await resolveShipmentDbIdentity(userId);
      const rows = await queryAppRows<ShipmentRow>(
        identity,
        `SELECT * FROM public.shipment WHERE id = $1::uuid LIMIT 1`,
        [id],
      );
      shipment = rows[0] ?? null;
    } else {
      const supabase = await createClient();
      const { data, error } = await supabase.from('shipment').select('*').eq('id', id).single();
      if (error) {
        if (error.code === 'PGRST116') return null;
        throw new ShipmentError('查询在途详情失败', 'DB_ERROR');
      }
      shipment = data;
    }

    if (!shipment) return null;

    if (userId) {
      const role = await getUserRole(userId);
      if (role === 'operator') {
        if (!shipment.warehouse_id) return null;
        const canAccess = await warehouseAccessRepository.canAccessWarehouse(
          userId,
          shipment.warehouse_id,
        );
        if (!canAccess) return null;
      }
    }

    if (isIndependentPlatformRuntime()) {
      const identity = await resolveShipmentDbIdentity(userId);
      const [itemRows, eventRows, creatorRows, warehouseRows] = await Promise.all([
        queryAppRows<{
          id: string;
          quantity: number;
          warehoused_quantity: number;
          variant_id: string;
          sku: string | null;
          product_name: string | null;
        }>(
          identity,
          `SELECT si.id, si.quantity, si.warehoused_quantity, si.variant_id, pv.sku, p.name AS product_name
           FROM public.shipment_item si
           LEFT JOIN public.product_variant pv ON pv.id = si.variant_id
           LEFT JOIN public.product p ON p.id = pv.product_id
           WHERE si.shipment_id = $1::uuid`,
          [id],
        ),
        queryAppRows<{
          id: string;
          shipment_id: string;
          status: string;
          description: string | null;
          occurred_at: string;
          created_by: string;
          created_at: string;
          creator_name: string | null;
        }>(
          identity,
          `SELECT te.id, te.shipment_id, te.status, te.description, te.occurred_at, te.created_by,
                  te.created_at, pr.display_name AS creator_name
           FROM public.tracking_event te
           LEFT JOIN public.profiles pr ON pr.id = te.created_by
           WHERE te.shipment_id = $1::uuid
           ORDER BY te.occurred_at ASC`,
          [id],
        ),
        queryAppRows<{ display_name: string | null }>(
          identity,
          `SELECT display_name FROM public.profiles WHERE id = $1::uuid LIMIT 1`,
          [shipment.created_by],
        ),
        shipment.warehouse_id
          ? queryAppRows<{ name: string }>(
              identity,
              `SELECT name FROM public.warehouse WHERE id = $1::uuid LIMIT 1`,
              [shipment.warehouse_id],
            )
          : Promise.resolve([]),
      ]);

      return {
        ...shipment,
        items: itemRows.map((item) => ({
          id: item.id,
          quantity: item.quantity,
          warehousedQuantity: item.warehoused_quantity,
          productName: item.product_name,
          sku: item.sku ?? '',
          variantId: item.variant_id,
        })),
        events: eventRows.map((event) => ({
          id: event.id,
          shipmentId: event.shipment_id,
          status: event.status,
          description: event.description,
          occurredAt: event.occurred_at,
          createdBy: event.created_by,
          createdAt: event.created_at,
          creatorName: event.creator_name,
        } satisfies TrackingEventDetail)),
        creatorName: creatorRows[0]?.display_name ?? null,
        warehouseName: warehouseRows[0]?.name ?? null,
      };
    }

    const supabase = await createClient();
    const [itemsRes, eventsRes, profileRes] = await Promise.all([
      supabase
        .from('shipment_item')
        .select(
          `id, quantity, warehoused_quantity, variant_id,
           variant:variant_id (sku, product:product_id (name))`,
        )
        .eq('shipment_id', id),
      supabase
        .from('tracking_event')
        .select(
          `id, shipment_id, status, description, occurred_at, created_by, created_at,
           profile:created_by (display_name)`,
        )
        .eq('shipment_id', id)
        .order('occurred_at', { ascending: true }),
      supabase
        .from('profiles')
        .select('display_name')
        .eq('id', shipment.created_by)
        .single(),
    ]);

    if (itemsRes.error || eventsRes.error) {
      throw new ShipmentError('查询在途详情失败', 'DB_ERROR');
    }

    let warehouseName: string | null = null;
    if (shipment.warehouse_id) {
      const { data: wh, error: whErr } = await supabase
        .from('warehouse')
        .select('name')
        .eq('id', shipment.warehouse_id)
        .single();
      if (whErr) {
        throw new ShipmentError('查询在途详情失败', 'DB_ERROR');
      }
      warehouseName = wh?.name ?? null;
    }

    return {
      ...shipment,
      items: (itemsRes.data ?? []).map((item) => {
        const variant = unwrapJoin<{ sku: string; product: unknown }>(item.variant);
        const product = unwrapJoin<{ name: string }>(variant?.product);
        return {
          id: item.id,
          quantity: item.quantity,
          warehousedQuantity: item.warehoused_quantity,
          productName: product?.name ?? null,
          sku: variant?.sku ?? '',
          variantId: item.variant_id,
        };
      }),
      events: (eventsRes.data ?? []).map((event) => {
        const profile = event.profile as unknown as { display_name: string | null } | null;
        return {
          id: event.id,
          shipmentId: event.shipment_id,
          status: event.status,
          description: event.description,
          occurredAt: event.occurred_at,
          createdBy: event.created_by,
          createdAt: event.created_at,
          creatorName: profile?.display_name ?? null,
        } satisfies TrackingEventDetail;
      }),
      creatorName: profileRes.data?.display_name ?? null,
      warehouseName,
    };
  },

  /** 创建在途记录（数据库事务，三步原子写入，created_by 由 auth.uid() 确定） */
  async create(data: CreateShipmentData): Promise<string> {
    const itemsJson = data.items.map((item) => ({
      variant_id: item.variantId,
      quantity: item.quantity,
    }));

    let shipmentId: string | null;
    if (isIndependentPlatformRuntime()) {
      const identity = await requireAppDbIdentity();
      try {
        shipmentId = await callAppRpc<string | null>(
          identity,
          'public.create_shipment_transactional',
          [
            data.shipmentNo,
            data.vesselName ?? null,
            data.voyageNumber ?? null,
            data.originPort ?? null,
            data.destinationPort ?? null,
            data.country,
            data.warehouseId ?? null,
            data.estimatedArrival ?? null,
            data.note ?? null,
            data.purchaseOrderNo ?? null,
            JSON.stringify(itemsJson),
          ],
        );
      } catch (error) {
        throw new ShipmentError(
          '创建在途记录失败，请稍后重试',
          'DB_ERROR',
          extractShipmentDbErrorMeta(error),
        );
      }
    } else {
      const supabase = await createClient();
      const { data: rpcId, error } = await supabase.rpc('create_shipment_transactional', {
        p_shipment_no: data.shipmentNo,
        p_vessel_name: data.vesselName ?? null,
        p_voyage_number: data.voyageNumber ?? null,
        p_origin_port: data.originPort ?? null,
        p_destination_port: data.destinationPort ?? null,
        p_country: data.country,
        p_warehouse_id: data.warehouseId ?? null,
        p_estimated_arrival: data.estimatedArrival ?? null,
        p_note: data.note ?? null,
        p_purchase_order_no: data.purchaseOrderNo ?? null,
        p_items: itemsJson,
      });

      if (error) {
        throw new ShipmentError(
          '创建在途记录失败，请稍后重试',
          'DB_ERROR',
          extractShipmentDbErrorMeta(error),
        );
      }
      shipmentId = rpcId;
    }

    if (!shipmentId) {
      throw new ShipmentError('创建在途记录失败，请稍后重试', 'DB_ERROR');
    }
    return shipmentId;
  },

  /** P1: 读取创建计划所需的仓库/SKU 事实，供 Server Action 做一致性校验。 */
  async getPlannedShipmentContext(
    warehouseId: string,
    variantId: string,
  ): Promise<PlannedShipmentContext> {
    if (isIndependentPlatformRuntime()) {
      const identity = await requireAppDbIdentity();
      const [warehouseRows, variantRows] = await Promise.all([
        queryAppRows<{
          id: string;
          name: string;
          country: string;
          type: string;
          is_active: boolean;
          lead_time_days: number;
        }>(
          identity,
          `SELECT id, name, country, type, is_active, lead_time_days FROM public.warehouse
           WHERE id = $1::uuid LIMIT 1`,
          [warehouseId],
        ),
        queryAppRows<{ id: string; country: string }>(
          identity,
          `SELECT id, country FROM public.product_variant WHERE id = $1::uuid LIMIT 1`,
          [variantId],
        ),
      ]);
      const warehouse = warehouseRows[0];
      const variant = variantRows[0];
      if (!warehouse) {
        throw new ShipmentError('仓库不存在或无权访问', 'NOT_FOUND');
      }
      if (!warehouse.is_active || warehouse.type !== 'overseas') {
        throw new ShipmentError('只能为启用中的海外仓创建计划发货', 'VALIDATION');
      }
      if (!variant) {
        throw new ShipmentError('SKU 不存在或无权访问', 'NOT_FOUND');
      }
      return {
        warehouseId: warehouse.id,
        warehouseCountry: warehouse.country,
        warehouseName: warehouse.name,
        leadTimeDays: warehouse.lead_time_days,
        variantId: variant.id,
        variantCountry: variant.country,
      };
    }

    const supabase = await createClient();
    const [warehouseResult, variantResult] = await Promise.all([
      supabase
        .from('warehouse')
        .select('id, name, country, type, is_active, lead_time_days')
        .eq('id', warehouseId)
        .single(),
      supabase
        .from('product_variant')
        .select('id, country')
        .eq('id', variantId)
        .single(),
    ]);

    if (warehouseResult.error || !warehouseResult.data) {
      throw new ShipmentError('仓库不存在或无权访问', 'NOT_FOUND');
    }
    if (!warehouseResult.data.is_active || warehouseResult.data.type !== 'overseas') {
      throw new ShipmentError('只能为启用中的海外仓创建计划发货', 'VALIDATION');
    }
    if (variantResult.error || !variantResult.data) {
      throw new ShipmentError('SKU 不存在或无权访问', 'NOT_FOUND');
    }

    return {
      warehouseId: warehouseResult.data.id,
      warehouseCountry: warehouseResult.data.country,
      warehouseName: warehouseResult.data.name,
      leadTimeDays: warehouseResult.data.lead_time_days,
      variantId: variantResult.data.id,
      variantCountry: variantResult.data.country,
    };
  },

  async getPlannedShipmentReadBack(shipmentId: string): Promise<PlannedShipmentReadBack | null> {
    if (isIndependentPlatformRuntime()) {
      const identity = await requireAppDbIdentity();
      const rows = await queryAppRows<{ id: string; status: string; cancelled_at: string | null }>(
        identity,
        `SELECT id, status, cancelled_at FROM public.shipment WHERE id = $1::uuid LIMIT 1`,
        [shipmentId],
      );
      const data = rows[0];
      if (!data) return null;
      return { id: data.id, status: data.status, cancelledAt: data.cancelled_at };
    }

    const supabase = await createClient();
    const { data, error } = await supabase
      .from('shipment')
      .select('id, status, cancelled_at')
      .eq('id', shipmentId)
      .maybeSingle();

    if (error) {
      throw new ShipmentError('计划发货写后校验失败', 'DB_ERROR');
    }
    if (!data) return null;
    return { id: data.id, status: data.status, cancelledAt: data.cancelled_at };
  },

  /** P1: 软取消 booking。UPDATE 只修改 cancelled_at，0 行时回查原因。 */
  async cancelPlannedShipment(shipmentId: string): Promise<CancelPlannedShipmentResult> {
    if (isIndependentPlatformRuntime()) {
      const identity = await requireAppDbIdentity();
      const updated = await queryAppRows<{ id: string; status: string; cancelled_at: string | null }>(
        identity,
        `UPDATE public.shipment SET cancelled_at = now()
         WHERE id = $1::uuid AND status = 'booking' AND cancelled_at IS NULL
         RETURNING id, status, cancelled_at`,
        [shipmentId],
      );
      const row = updated[0];
      if (row) {
        if (!row.cancelled_at) {
          throw new ShipmentError('计划发货取消写后校验失败', 'DB_ERROR');
        }
        return { id: row.id, status: row.status, cancelledAt: row.cancelled_at };
      }
      const currentRows = await queryAppRows<{
        id: string;
        status: string;
        cancelled_at: string | null;
      }>(
        identity,
        `SELECT id, status, cancelled_at FROM public.shipment WHERE id = $1::uuid LIMIT 1`,
        [shipmentId],
      );
      const current = currentRows[0];
      if (!current) {
        throw new ShipmentError('计划不存在或无权限', 'NOT_FOUND');
      }
      if (current.cancelled_at) {
        throw new ShipmentError('该计划已取消', 'VALIDATION');
      }
      if (current.status !== 'booking') {
        throw new ShipmentError('仅计划发货（booking）可取消', 'VALIDATION');
      }
      throw new ShipmentError('取消计划发货失败，请稍后重试', 'DB_ERROR');
    }

    const supabase = await createClient();
    const { data: updated, error } = await supabase
      .from('shipment')
      .update({ cancelled_at: new Date().toISOString() })
      .eq('id', shipmentId)
      .eq('status', 'booking')
      .is('cancelled_at', null)
      .select('id, status, cancelled_at')
      .maybeSingle();

    if (error) {
      throw new ShipmentError('取消计划发货失败，请稍后重试', 'DB_ERROR');
    }

    if (updated) {
      if (!updated.cancelled_at) {
        throw new ShipmentError('计划发货取消写后校验失败', 'DB_ERROR');
      }
      return {
        id: updated.id,
        status: updated.status,
        cancelledAt: updated.cancelled_at,
      };
    }

    const { data: current, error: currentError } = await supabase
      .from('shipment')
      .select('id, status, cancelled_at')
      .eq('id', shipmentId)
      .maybeSingle();

    if (currentError || !current) {
      throw new ShipmentError('计划不存在或无权限', 'NOT_FOUND');
    }
    if (current.cancelled_at) {
      throw new ShipmentError('该计划已取消', 'VALIDATION');
    }
    if (current.status !== 'booking') {
      throw new ShipmentError('仅计划发货（booking）可取消', 'VALIDATION');
    }
    throw new ShipmentError('取消计划发货失败，请稍后重试', 'DB_ERROR');
  },

  /** P3-S2B: 编辑在途基本信息 */
  async update(data: UpdateShipmentData, userId?: string): Promise<boolean> {
    if (userId) {
      const role = await getUserRole(userId);
      if (role === 'operator') {
        let existingWarehouseId: string | null = null;
        if (isIndependentPlatformRuntime()) {
          const identity = await resolveShipmentDbIdentity(userId);
          const rows = await queryAppRows<{ warehouse_id: string | null }>(
            identity,
            `SELECT warehouse_id FROM public.shipment WHERE id = $1::uuid LIMIT 1`,
            [data.id],
          );
          existingWarehouseId = rows[0]?.warehouse_id ?? null;
          if (rows.length === 0) {
            throw new ShipmentError('在途记录不存在或无权访问', 'NOT_FOUND');
          }
        } else {
          const supabase = await createClient();
          const { data: existing, error: fetchErr } = await supabase
            .from('shipment')
            .select('warehouse_id')
            .eq('id', data.id)
            .single();
          if (fetchErr || !existing) {
            throw new ShipmentError('在途记录不存在或无权访问', 'NOT_FOUND');
          }
          existingWarehouseId = existing.warehouse_id;
        }
        if (!existingWarehouseId) {
          throw new ShipmentError('您没有该记录的操作权限', 'FORBIDDEN');
        }
        const canAccess = await warehouseAccessRepository.canAccessWarehouse(
          userId,
          existingWarehouseId,
        );
        if (!canAccess) {
          throw new ShipmentError('您没有该记录的操作权限', 'FORBIDDEN');
        }
      }
    }

    if (isIndependentPlatformRuntime()) {
      const identity = await resolveShipmentDbIdentity(userId);
      const updated = await queryAppRows<{ id: string }>(
        identity,
        `UPDATE public.shipment SET
           shipment_no = $2,
           purchase_order_no = $3,
           vessel_name = $4,
           voyage_number = $5,
           origin_port = $6,
           destination_port = $7,
           country = $8,
           warehouse_id = $9,
           estimated_arrival = $10,
           note = $11,
           updated_at = now()
         WHERE id = $1::uuid
         RETURNING id`,
        [
          data.id,
          data.shipmentNo,
          data.purchaseOrderNo?.trim() || null,
          data.vesselName ?? null,
          data.voyageNumber ?? null,
          data.originPort ?? null,
          data.destinationPort ?? null,
          data.country,
          data.warehouseId ?? null,
          data.estimatedArrival ?? null,
          data.note ?? null,
        ],
      );
      if (updated.length === 0) {
        throw new ShipmentError('在途记录不存在或无权访问', 'NOT_FOUND');
      }
      return true;
    }

    const supabase = await createClient();
    const { data: updated, error } = await supabase
      .from('shipment')
      .update({
        shipment_no: data.shipmentNo,
        purchase_order_no: data.purchaseOrderNo?.trim() || null,
        vessel_name: data.vesselName ?? null,
        voyage_number: data.voyageNumber ?? null,
        origin_port: data.originPort ?? null,
        destination_port: data.destinationPort ?? null,
        country: data.country,
        warehouse_id: data.warehouseId ?? null,
        estimated_arrival: data.estimatedArrival ?? null,
        note: data.note ?? null,
      })
      .eq('id', data.id)
      .select('id')
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        throw new ShipmentError('在途记录不存在或无权访问', 'NOT_FOUND');
      }
      throw new ShipmentError('更新在途记录失败', 'DB_ERROR');
    }
    if (!updated) {
      throw new ShipmentError('在途记录不存在或无权访问', 'NOT_FOUND');
    }
    return true;
  },

  /** P3-S2B/P3-S4A: 手动变更物流状态（不触发库存联动，禁用 warehoused）
   *  使用 change_shipment_status_transactional RPC（Migration 00022）
   *  P3-S4A: 应用层预校验当前状态 → 流转规则 → 再调用 RPC
   *  同一事务内完成 shipment.status 更新 + tracking_event 插入
   *  RLS 保障仓库隔离；RPC 内 GET DIAGNOSTICS 确认命中目标行 */
  async changeStatus(
    shipmentId: string,
    status: string,
    _userId: string,
    description?: string,
  ): Promise<boolean> {
    const statusLabel: Record<string, string> = {
      booking: '订舱',
      loading: '装柜',
      departed: '离港',
      arrived: '到港',
      customs: '清关',
    };
    const rpcDescription = description ?? statusLabel[status] ?? status;

    let currentStatus: string | undefined;
    if (isIndependentPlatformRuntime()) {
      const identity = { profileUserId: _userId };
      const rows = await queryAppRows<{ status: string }>(
        identity,
        `SELECT status FROM public.shipment WHERE id = $1::uuid LIMIT 1`,
        [shipmentId],
      );
      currentStatus = rows[0]?.status;
      if (!currentStatus) {
        throw new ShipmentError('在途记录不存在或无权访问', 'NOT_FOUND');
      }
    } else {
      const supabase = await createClient();
      const { data: current, error: fetchErr } = await supabase
        .from('shipment')
        .select('status')
        .eq('id', shipmentId)
        .single();

      if (fetchErr) {
        if (fetchErr.code === 'PGRST116') {
          throw new ShipmentError('在途记录不存在或无权访问', 'NOT_FOUND');
        }
        throw new ShipmentError('查询在途记录失败', 'DB_ERROR');
      }
      if (!current) {
        throw new ShipmentError('在途记录不存在或无权访问', 'NOT_FOUND');
      }
      currentStatus = current.status;
    }

    if (!isValidStatusTransition(currentStatus, status)) {
      throw new ShipmentError(
        `状态不可从「${currentStatus}」变更为「${status}」：仅允许按顺序推进`,
        'VALIDATION',
      );
    }

    if (isIndependentPlatformRuntime()) {
      try {
        await callAppRpc(
          { profileUserId: _userId },
          'public.change_shipment_status_transactional',
          [shipmentId, status, rpcDescription],
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : '状态变更失败';
        throw new ShipmentError(message, 'DB_ERROR');
      }
      return true;
    }

    const supabase = await createClient();
    const { error } = await supabase.rpc('change_shipment_status_transactional', {
      p_shipment_id: shipmentId,
      p_status: status,
      p_description: rpcDescription,
    });

    if (error) {
      throw new ShipmentError(
        error.message || '状态变更失败',
        'DB_ERROR',
      );
    }
    return true;
  },

  /** 推进物流状态（旧版兼容路径—P3-S4A 返工：统一委托 changeStatus → RPC）
   *  禁止直接 update shipment + insert tracking_event；
   *  所有手动状态推进入口必须通过 change_shipment_status_transactional RPC 完成。 */
  async advanceStatus(
    shipmentId: string,
    nextStatus: string,
    userId: string,
    description?: string,
  ): Promise<boolean> {
    // P3-S4A: 禁用 warehoused（显式守卫，给出明确错误消息）
    if (nextStatus === 'warehoused') {
      throw new ShipmentError('当前不支持手动推进到入仓状态', 'VALIDATION');
    }

    // P3-S4A REWORK: 统一委托 changeStatus → RPC，不在本方法内直接写表
    return this.changeStatus(shipmentId, nextStatus, userId, description);
  },

  // ─── P3-S3: 表单选择器数据 ──────────────────────────────────────────

  /** 服务端搜索 Variant（按 country + 关键词，供 shipment 表单选择器调用）
   *  不读取 product_variant.is_archived；改用 user_variant_preference 按当前用户过滤 */
  async searchVariants(
    country: string,
    search?: string,
    userId?: string,
  ): Promise<VariantSelectorItem[]> {
    const archivedIds = userId
      ? await variantRepository.getUserArchivedVariantIds(userId)
      : new Set<string>();

    const SELECT = 'id, sku, name, country, product:product_id (name)';
    const LIMIT = 100;

    const mapRow = (row: Record<string, unknown>): VariantSelectorItem => {
      const product = unwrapJoin<{ name: string }>(row.product);
      return {
        id: row.id as string,
        sku: row.sku as string,
        name: row.name as string,
        productName: product?.name ?? null,
        country: row.country as string,
      };
    };

    if (isIndependentPlatformRuntime()) {
      type SqlVariantRow = {
        id: string;
        sku: string;
        name: string;
        country: string;
        product_name: string | null;
      };
      const identity = await resolveShipmentDbIdentity(userId);
      const mapSqlRow = (row: SqlVariantRow): VariantSelectorItem => ({
        id: row.id,
        sku: row.sku,
        name: row.name,
        productName: row.product_name,
        country: row.country,
      });
      const appendArchivedFilter = (params: unknown[]): string => {
        if (archivedIds.size === 0) return '';
        params.push([...archivedIds]);
        return ` AND NOT (pv.id = ANY($${params.length}::uuid[]))`;
      };
      const variantFrom = `FROM public.product_variant pv LEFT JOIN public.product p ON p.id = pv.product_id`;

      if (!search) {
        const params: unknown[] = [country];
        const archivedFilter = appendArchivedFilter(params);
        params.push(LIMIT);
        const rows = await queryAppRows<SqlVariantRow>(
          identity,
          `SELECT pv.id, pv.sku, pv.name, pv.country, p.name AS product_name
           ${variantFrom}
           WHERE pv.country = $1${archivedFilter}
           ORDER BY pv.sku ASC
           LIMIT $${params.length}`,
          params,
        );
        return rows.map(mapSqlRow);
      }

      const pattern = `%${escapeShipmentIlike(search)}%`;
      const mergeDedup = (groups: SqlVariantRow[][]): VariantSelectorItem[] => {
        const seen = new Set<string>();
        const results: VariantSelectorItem[] = [];
        for (const group of groups) {
          for (const row of group) {
            if (seen.has(row.id)) continue;
            seen.add(row.id);
            results.push(mapSqlRow(row));
            if (results.length >= LIMIT) return results;
          }
        }
        return results;
      };

      const skuParams: unknown[] = [country, pattern];
      const skuArchived = appendArchivedFilter(skuParams);
      skuParams.push(LIMIT);
      const bySku = await queryAppRows<SqlVariantRow>(
        identity,
        `SELECT pv.id, pv.sku, pv.name, pv.country, p.name AS product_name
         ${variantFrom}
         WHERE pv.country = $1 AND pv.sku ILIKE $2 ESCAPE E'\\\\'${skuArchived}
         ORDER BY pv.sku ASC LIMIT $${skuParams.length}`,
        skuParams,
      );

      const nameParams: unknown[] = [country, pattern];
      const nameArchived = appendArchivedFilter(nameParams);
      nameParams.push(LIMIT);
      const byName = await queryAppRows<SqlVariantRow>(
        identity,
        `SELECT pv.id, pv.sku, pv.name, pv.country, p.name AS product_name
         ${variantFrom}
         WHERE pv.country = $1 AND pv.name ILIKE $2 ESCAPE E'\\\\'${nameArchived}
         ORDER BY pv.sku ASC LIMIT $${nameParams.length}`,
        nameParams,
      );

      const productRows = await queryAppRows<{ id: string }>(
        identity,
        `SELECT id FROM public.product WHERE name ILIKE $1 ESCAPE E'\\\\' LIMIT $2`,
        [pattern, LIMIT],
      );
      let byProduct: SqlVariantRow[] = [];
      if (productRows.length > 0) {
        const productIds = productRows.map((p) => p.id);
        const productParams: unknown[] = [country, productIds];
        const productArchived = appendArchivedFilter(productParams);
        productParams.push(LIMIT);
        byProduct = await queryAppRows<SqlVariantRow>(
          identity,
          `SELECT pv.id, pv.sku, pv.name, pv.country, p.name AS product_name
           ${variantFrom}
           WHERE pv.country = $1 AND pv.product_id = ANY($2::uuid[])${productArchived}
           ORDER BY pv.sku ASC LIMIT $${productParams.length}`,
          productParams,
        );
      }

      return mergeDedup([bySku, byName, byProduct]);
    }

    const supabase = await createClient();

    if (!search) {
      let q = supabase
        .from('product_variant')
        .select(SELECT)
        .eq('country', country)
        .order('sku', { ascending: true });
      if (archivedIds.size > 0) q = q.notIn('id', [...archivedIds]);
      const { data, error } = await q.limit(LIMIT);

      if (error) throw new ShipmentError('查询 SKU 列表失败', 'DB_ERROR');

      return ((data ?? []) as Record<string, unknown>[]).map(mapRow);
    }

    // Escape LIKE wildcards so user input doesn't change filter semantics
    // Must escape backslash first, then % and _; order matters.
    const escaped = search.replace(/\\/g, '\\\\').replace(/[%_]/g, '\\$&');
    const pattern = `%${escaped}%`;

    // Query by SKU
    let skuQ = supabase
      .from('product_variant')
      .select(SELECT)
      .eq('country', country)
      .ilike('sku', pattern)
      .order('sku', { ascending: true });
    if (archivedIds.size > 0) skuQ = skuQ.notIn('id', [...archivedIds]);
    const { data: bySkuRaw, error: skuErr } = await skuQ.limit(LIMIT);

    if (skuErr) throw new ShipmentError('查询 SKU 列表失败', 'DB_ERROR');

    // Query by variant name
    let nameQ = supabase
      .from('product_variant')
      .select(SELECT)
      .eq('country', country)
      .ilike('name', pattern)
      .order('sku', { ascending: true });
    if (archivedIds.size > 0) nameQ = nameQ.notIn('id', [...archivedIds]);
    const { data: byNameRaw, error: nameErr } = await nameQ.limit(LIMIT);

    if (nameErr) throw new ShipmentError('查询 SKU 列表失败', 'DB_ERROR');

    // Query products by name, then find matching variants
    const { data: products, error: productErr } = await supabase
      .from('product')
      .select('id')
      .ilike('name', pattern)
      .limit(LIMIT);

    if (productErr) throw new ShipmentError('查询 SKU 列表失败', 'DB_ERROR');

    let byProductRaw: Record<string, unknown>[] = [];
    if (products && products.length > 0) {
      const productIds = products.map((p) => p.id);
      let vQ = supabase
        .from('product_variant')
        .select(SELECT)
        .eq('country', country)
        .in('product_id', productIds)
        .order('sku', { ascending: true });
      if (archivedIds.size > 0) vQ = vQ.notIn('id', [...archivedIds]);
      const { data: vData, error: vErr } = await vQ.limit(LIMIT);

      if (vErr) throw new ShipmentError('查询 SKU 列表失败', 'DB_ERROR');

      byProductRaw = (vData ?? []) as Record<string, unknown>[];
    }

    // Merge and dedup by variant id (archived filtering done at DB level via notIn)
    const seen = new Set<string>();
    const results: VariantSelectorItem[] = [];
    const allRows = [
      ...(bySkuRaw ?? []) as Record<string, unknown>[],
      ...(byNameRaw ?? []) as Record<string, unknown>[],
      ...byProductRaw,
    ];

    for (const row of allRows) {
      const id = row.id as string;
      if (seen.has(id)) continue;
      seen.add(id);
      results.push(mapRow(row));
      if (results.length >= LIMIT) break;
    }

    return results;
  },

  /** 获取仓库列表供 shipment 表单选择
   *  Admin → 所有 active overseas 仓库（可选 country 过滤）
   *  Operator → 已分配仓库中的 active overseas（可选 country 过滤） */
  async getWarehousesForSelector(
    userId: string,
    country?: string,
  ): Promise<WarehouseSelectorItem[]> {
    const accessibleIds = await warehouseAccessRepository.getAccessibleWarehouseIds(userId);
    if (accessibleIds.size === 0) return [];

    if (isIndependentPlatformRuntime()) {
      const params: unknown[] = [[...accessibleIds]];
      let sql = `SELECT id, name, country FROM public.warehouse
                 WHERE id = ANY($1::uuid[]) AND type = 'overseas' AND is_active = true`;
      if (country) {
        params.push(country);
        sql += ` AND country = $2`;
      }
      sql += ` ORDER BY name ASC`;
      const rows = await queryAppRows<{ id: string; name: string; country: string }>(
        { profileUserId: userId },
        sql,
        params,
      );
      return rows;
    }

    const supabase = await createClient();
    let query = supabase
      .from('warehouse')
      .select('id, name, country')
      .in('id', [...accessibleIds])
      .eq('type', 'overseas')
      .eq('is_active', true)
      .order('name', { ascending: true });

    if (country) {
      query = query.eq('country', country);
    }

    const { data, error } = await query;

    if (error) {
      throw new ShipmentError('查询仓库列表失败', 'DB_ERROR');
    }

    return (data ?? []).map((w) => ({
      id: w.id,
      name: w.name,
      country: w.country,
    }));
  },

  /** 验证仓库对 shipment 的合法性：存在、启用、海外仓、国家一致
   *  校验失败抛出 ShipmentError；成功则无返回值 */
  async validateWarehouseForShipment(warehouseId: string, country: string): Promise<void> {
    let wh: { type: string; is_active: boolean; country: string } | null = null;
    if (isIndependentPlatformRuntime()) {
      const identity = await requireAppDbIdentity();
      const rows = await queryAppRows<{ type: string; is_active: boolean; country: string }>(
        identity,
        `SELECT type, is_active, country FROM public.warehouse WHERE id = $1::uuid LIMIT 1`,
        [warehouseId],
      );
      wh = rows[0] ?? null;
    } else {
      const supabase = await createClient();
      const { data, error } = await supabase
        .from('warehouse')
        .select('id, name, type, is_active, country')
        .eq('id', warehouseId)
        .single();
      if (error || !data) {
        throw new ShipmentError('仓库不存在或已停用', 'VALIDATION');
      }
      wh = data;
    }

    if (!wh) {
      throw new ShipmentError('仓库不存在或已停用', 'VALIDATION');
    }
    if (!wh.is_active) {
      throw new ShipmentError('仓库不存在或已停用', 'VALIDATION');
    }
    if (wh.type !== 'overseas') {
      throw new ShipmentError('只能选择海外仓库', 'VALIDATION');
    }
    if (wh.country !== country) {
      throw new ShipmentError('国家与仓库不一致', 'VALIDATION');
    }
  },

  /** P3-S5A: 确认入仓 — 事务性完成：
   *  1. shipment.status → 'warehoused'
   *  2. shipment_item.warehoused_quantity → quantity
   *  3. inventory.quantity 增加对应数量
   *  4. tracking_event 插入 warehoused 轨迹
   *  调用 warehouse_shipment_transactional RPC（Migration 00023）
   *  仅 Admin 可调用；仅 customs 状态允许入仓；禁止重复入仓；
   *  必须有 warehouse_id；并发安全（FOR UPDATE 行锁） */
  async warehouseShipment(
    shipmentId: string,
    _userId: string,
    description?: string,
  ): Promise<boolean> {
    if (isIndependentPlatformRuntime()) {
      try {
        await callAppRpc(
          { profileUserId: _userId },
          'public.warehouse_shipment_transactional',
          [shipmentId, description ?? null],
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : '确认入仓失败';
        throw new ShipmentError(message, 'DB_ERROR');
      }
      return true;
    }

    const supabase = await createClient();
    const { error } = await supabase.rpc('warehouse_shipment_transactional', {
      p_shipment_id: shipmentId,
      p_description: description ?? null,
    });

    if (error) {
      throw new ShipmentError(
        error.message || '确认入仓失败',
        'DB_ERROR',
      );
    }
    return true;
  },

  /** 批量验证 variant 对 shipment 的合法性：存在（RLS 可见）、国家一致
   *  不读取 product_variant.is_archived；归档是用户个人偏好，不阻止创建 */
  async validateVariantsForShipment(
    variantIds: string[],
    country: string,
  ): Promise<void> {
    let variants: Array<{ id: string; country: string }>;
    if (isIndependentPlatformRuntime()) {
      const identity = await requireAppDbIdentity();
      variants = await queryAppRows<{ id: string; country: string }>(
        identity,
        `SELECT id, country FROM public.product_variant WHERE id = ANY($1::uuid[])`,
        [variantIds],
      );
    } else {
      const supabase = await createClient();
      const { data, error } = await supabase
        .from('product_variant')
        .select('id, country')
        .in('id', variantIds);
      if (error || !data) {
        throw new ShipmentError('查询 SKU 信息失败', 'DB_ERROR');
      }
      variants = data;
    }

    if (variants.length !== variantIds.length) {
      const found = new Set(variants.map((v) => v.id));
      const missing = variantIds.find((id) => !found.has(id));
      throw new ShipmentError(
        missing ? `SKU 不存在：${missing}` : '部分 SKU 不存在',
        'VALIDATION',
      );
    }

    for (const v of variants) {
      if (v.country !== country) {
        throw new ShipmentError('产品国家与目的国不一致', 'VALIDATION');
      }
    }
  },

  // ─── P3-S5B2: 部分入仓 ─────────────────────────────────────────────────

  /** P3-S5B2: 部分/批量确认入仓 — 调用 partial_warehouse_shipment RPC（Migration 00026）
   *  items 映射为 [{ variant_id, quantity }] JSONB 传给 RPC
   *  RPC 返回 { success, all_warehoused, items_updated } snake_case → camelCase
   *  不写 inventory.quantity — inventory 唯一事实来源是 BigSeller */
  async partialWarehouse(
    shipmentId: string,
    items: PartialWarehouseItem[],
    description?: string,
  ): Promise<PartialWarehouseResult> {
    const rpcItems = items.map((item) => ({
      variant_id: item.variantId,
      quantity: item.quantity,
    }));

    let result: Record<string, unknown> | null;
    if (isIndependentPlatformRuntime()) {
      const identity = await requireAppDbIdentity();
      try {
        result = await callAppRpc<Record<string, unknown>>(
          identity,
          'public.partial_warehouse_shipment',
          [shipmentId, JSON.stringify(rpcItems), description ?? null],
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : '确认入仓失败，请稍后重试';
        throw new ShipmentError(message, 'DB_ERROR');
      }
    } else {
      const supabase = await createClient();
      const { data: rpcResult, error } = await supabase.rpc(
        'partial_warehouse_shipment',
        {
          p_shipment_id: shipmentId,
          p_items: rpcItems,
          p_description: description ?? null,
        },
      );
      if (error) {
        throw new ShipmentError(
          error.message || '确认入仓失败，请稍后重试',
          'DB_ERROR',
        );
      }
      result = rpcResult as Record<string, unknown> | null;
    }

    if (!result) {
      throw new ShipmentError('确认入仓失败，请稍后重试', 'DB_ERROR');
    }

    return {
      success: result.success === true,
      allWarehoused: result.all_warehoused === true,
      itemsUpdated: typeof result.items_updated === 'number' ? result.items_updated : 0,
    };
  },

  /** P3-S5B2: 查询可批量入仓的 shipments（status='customs' + warehouse_id IS NOT NULL）
   *  Admin 全量，Operator 按已分配仓库隔离 */
  async listEligibleForBatchWarehousing(
    filters: EligibleShipmentFilters = {},
    userId?: string,
  ): Promise<PaginatedResult<EligibleShipmentItem>> {
    const { country, warehouseId, page = 1, pageSize = PAGE_SIZE } = filters;

    let accessibleWhIds: string[] | null = null;
    if (userId) {
      const role = await getUserRole(userId);
      if (role === 'operator') {
        const accessibleIds = await warehouseAccessRepository.getAccessibleWarehouseIds(userId);
        if (accessibleIds.size === 0) {
          return { data: [], total: 0, page, pageSize };
        }
        accessibleWhIds = [...accessibleIds];
      }
    }

    type EligibleSourceRow = {
      id: string;
      shipment_no: string;
      purchase_order_no: string | null;
      vessel_name: string | null;
      voyage_number: string | null;
      country: string;
      warehouse_id: string;
      status: string;
      estimated_arrival: string | null;
      created_at: string;
      warehouse: { name: string } | null;
      items: Array<{
        quantity: number;
        warehoused_quantity: number;
        variant: { product: { name: string } | null } | null;
      }>;
    };

    let rows: EligibleSourceRow[];
    let total: number;

    if (isIndependentPlatformRuntime()) {
      const identity = await resolveShipmentDbIdentity(userId);
      const conditions = [`s.status = 'customs'`, `s.warehouse_id IS NOT NULL`];
      const params: unknown[] = [];
      let paramIndex = 1;
      if (accessibleWhIds) {
        conditions.push(`s.warehouse_id = ANY($${paramIndex++}::uuid[])`);
        params.push(accessibleWhIds);
      }
      if (country) {
        conditions.push(`s.country = $${paramIndex++}`);
        params.push(country);
      }
      if (warehouseId) {
        conditions.push(`s.warehouse_id = $${paramIndex++}::uuid`);
        params.push(warehouseId);
      }
      const whereSql = conditions.join(' AND ');
      const countRows = await queryAppRows<{ count: string }>(
        identity,
        `SELECT COUNT(*)::text AS count FROM public.shipment s WHERE ${whereSql}`,
        params,
      );
      total = Number(countRows[0]?.count ?? 0);
      if (total === 0) {
        return { data: [], total: 0, page, pageSize };
      }
      const offset = (page - 1) * pageSize;
      const listParams = [...params, pageSize, offset];
      const headerRows = await queryAppRows<{
        id: string;
        shipment_no: string;
        purchase_order_no: string | null;
        vessel_name: string | null;
        voyage_number: string | null;
        country: string;
        warehouse_id: string;
        status: string;
        estimated_arrival: string | null;
        created_at: string;
        warehouse_name: string | null;
      }>(
        identity,
        `SELECT s.id, s.shipment_no, s.purchase_order_no, s.vessel_name, s.voyage_number, s.country,
                s.warehouse_id, s.status, s.estimated_arrival, s.created_at, w.name AS warehouse_name
         FROM public.shipment s
         LEFT JOIN public.warehouse w ON w.id = s.warehouse_id
         WHERE ${whereSql}
         ORDER BY s.created_at DESC
         LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
        listParams,
      );
      const shipmentIds = headerRows.map((r) => r.id);
      const itemRows = await queryAppRows<{
        shipment_id: string;
        quantity: number;
        warehoused_quantity: number;
        product_name: string | null;
      }>(
        identity,
        `SELECT si.shipment_id, si.quantity, si.warehoused_quantity, p.name AS product_name
         FROM public.shipment_item si
         LEFT JOIN public.product_variant pv ON pv.id = si.variant_id
         LEFT JOIN public.product p ON p.id = pv.product_id
         WHERE si.shipment_id = ANY($1::uuid[])`,
        [shipmentIds],
      );
      const itemsByShipment = new Map<string, EligibleSourceRow['items']>();
      for (const item of itemRows) {
        const list = itemsByShipment.get(item.shipment_id) ?? [];
        list.push({
          quantity: item.quantity,
          warehoused_quantity: item.warehoused_quantity,
          variant: item.product_name ? { product: { name: item.product_name } } : null,
        });
        itemsByShipment.set(item.shipment_id, list);
      }
      rows = headerRows.map((h) => ({
        id: h.id,
        shipment_no: h.shipment_no,
        purchase_order_no: h.purchase_order_no,
        vessel_name: h.vessel_name,
        voyage_number: h.voyage_number,
        country: h.country,
        warehouse_id: h.warehouse_id,
        status: h.status,
        estimated_arrival: h.estimated_arrival,
        created_at: h.created_at,
        warehouse: h.warehouse_name ? { name: h.warehouse_name } : null,
        items: itemsByShipment.get(h.id) ?? [],
      }));
    } else {
      const supabase = await createClient();
      let query = supabase
        .from('shipment')
        .select(
          `id, shipment_no, purchase_order_no, vessel_name, voyage_number, country, warehouse_id, status,
         estimated_arrival, created_at,
         warehouse:warehouse_id(name),
         items:shipment_item (
           quantity, warehoused_quantity,
           variant:variant_id (product:product_id (name))
         )`,
          { count: 'exact' },
        )
        .eq('status', 'customs')
        .not('warehouse_id', 'is', null);

      if (accessibleWhIds) {
        query = query.in('warehouse_id', accessibleWhIds);
      }
      if (country) query = query.eq('country', country);
      if (warehouseId) query = query.eq('warehouse_id', warehouseId);

      const from = (page - 1) * pageSize;
      const { data, error, count } = await query
        .order('created_at', { ascending: false })
        .range(from, from + pageSize - 1);

      if (error) {
        throw new ShipmentError('查询可入仓在途列表失败', 'DB_ERROR');
      }
      if (!data) {
        return { data: [], total: 0, page, pageSize };
      }
      total = count ?? 0;
      rows = data as unknown as EligibleSourceRow[];
    }

    return {
      data: rows.map((row) => {
        const items = row.items ?? [];
        const wh = row.warehouse;

        const productNames: string[] = [];
        for (const item of items) {
          const name = item.variant?.product?.name;
          if (name && !productNames.includes(name)) {
            productNames.push(name);
            if (productNames.length >= 3) break;
          }
        }

        return {
          id: row.id,
          shipmentNo: row.shipment_no,
          purchaseOrderNo: row.purchase_order_no,
          vesselName: row.vessel_name,
          voyageNumber: row.voyage_number,
          country: row.country,
          warehouseId: row.warehouse_id,
          warehouseName: wh?.name ?? null,
          status: row.status,
          estimatedArrival: row.estimated_arrival,
          itemCount: items.length,
          totalQuantity: items.reduce((sum, i) => sum + i.quantity, 0),
          remainingQuantity: items.reduce(
            (sum, i) => sum + (i.quantity - i.warehoused_quantity),
            0,
          ),
          productNames: productNames.length > 0 ? productNames.join('、') : null,
        };
      }),
      total,
      page,
      pageSize,
    };
  },

  /** P3-S5B2: 查询某 variant 在某仓库的已确认入仓总量
   *  仅统计 status='customs' 或 (status='warehoused' 且 bigseller_absorbed_at IS NULL) 的 shipment
   *  排除已 warehoused 且 bigseller_absorbed_at IS NOT NULL 的 shipment
   *  聚合 shipment_item.warehoused_quantity，不读取或写入 inventory.quantity */
  async getConfirmedWarehousedQuantity(
    variantId: string,
    warehouseId: string,
  ): Promise<number> {
    const shipmentStatusSql = `(status = 'customs' OR (status = 'warehoused' AND bigseller_absorbed_at IS NULL))`;
    let shipmentIds: string[];

    if (isIndependentPlatformRuntime()) {
      const identity = await requireAppDbIdentity();
      const shipments = await queryAppRows<{ id: string }>(
        identity,
        `SELECT id FROM public.shipment
         WHERE warehouse_id = $1::uuid AND ${shipmentStatusSql}`,
        [warehouseId],
      );
      if (shipments.length === 0) return 0;
      shipmentIds = shipments.map((s) => s.id);
      const items = await queryAppRows<{ warehoused_quantity: number }>(
        identity,
        `SELECT warehoused_quantity FROM public.shipment_item
         WHERE variant_id = $1::uuid AND shipment_id = ANY($2::uuid[])`,
        [variantId, shipmentIds],
      );
      return items.reduce((sum, row) => sum + row.warehoused_quantity, 0);
    }

    const supabase = await createClient();
    const { data: shipments, error: shipErr } = await supabase
      .from('shipment')
      .select('id')
      .eq('warehouse_id', warehouseId)
      .or(
        'status.eq.customs,and(status.eq.warehoused,bigseller_absorbed_at.is.null)',
      );

    if (shipErr) {
      throw new ShipmentError('查询已确认入仓数量失败', 'DB_ERROR');
    }
    if (!shipments || shipments.length === 0) return 0;

    shipmentIds = shipments.map((s) => s.id);

    const { data: items, error: itemErr } = await supabase
      .from('shipment_item')
      .select('warehoused_quantity')
      .eq('variant_id', variantId)
      .in('shipment_id', shipmentIds);

    if (itemErr) {
      throw new ShipmentError('查询已确认入仓数量失败', 'DB_ERROR');
    }

    let total = 0;
    for (const row of items ?? []) {
      total += row.warehoused_quantity;
    }
    return total;
  },

  /** P3-S5B2: 按 variant 聚合某仓库的已确认入仓数量
   *  仅统计 status='customs' 或 (status='warehoused' 且 bigseller_absorbed_at IS NULL) 的 shipment
   *  排除已 warehoused 且 bigseller_absorbed_at IS NOT NULL 的 shipment
   *  不读取或写入 inventory.quantity */
  async getConfirmedWarehousedByWarehouse(
    warehouseId: string,
  ): Promise<ConfirmedWarehousedAggregation[]> {
    const shipmentStatusSql = `(status = 'customs' OR (status = 'warehoused' AND bigseller_absorbed_at IS NULL))`;
    let items: Array<{ variant_id: string; warehoused_quantity: number }>;

    if (isIndependentPlatformRuntime()) {
      const identity = await requireAppDbIdentity();
      const shipments = await queryAppRows<{ id: string }>(
        identity,
        `SELECT id FROM public.shipment
         WHERE warehouse_id = $1::uuid AND ${shipmentStatusSql}`,
        [warehouseId],
      );
      if (shipments.length === 0) return [];
      const shipmentIds = shipments.map((s) => s.id);
      items = await queryAppRows<{ variant_id: string; warehoused_quantity: number }>(
        identity,
        `SELECT variant_id, warehoused_quantity FROM public.shipment_item
         WHERE shipment_id = ANY($1::uuid[])`,
        [shipmentIds],
      );
    } else {
      const supabase = await createClient();
      const { data: shipments, error: shipErr } = await supabase
        .from('shipment')
        .select('id')
        .eq('warehouse_id', warehouseId)
        .or(
          'status.eq.customs,and(status.eq.warehoused,bigseller_absorbed_at.is.null)',
        );

      if (shipErr) {
        throw new ShipmentError('查询仓库已确认入仓聚合失败', 'DB_ERROR');
      }
      if (!shipments || shipments.length === 0) return [];

      const shipmentIds = shipments.map((s) => s.id);
      const { data: itemData, error: itemErr } = await supabase
        .from('shipment_item')
        .select('variant_id, warehoused_quantity')
        .in('shipment_id', shipmentIds);

      if (itemErr) {
        throw new ShipmentError('查询仓库已确认入仓聚合失败', 'DB_ERROR');
      }
      items = itemData ?? [];
    }

    const map = new Map<string, number>();
    for (const row of items) {
      map.set(
        row.variant_id,
        (map.get(row.variant_id) ?? 0) + row.warehoused_quantity,
      );
    }

    return [...map.entries()].map(([variantId, confirmedQuantity]) => ({
      variantId,
      confirmedQuantity,
    }));
  },

  /** P3-S5B2: 确认 BigSeller 已吸收在途记录
   *  UPDATE shipment SET bigseller_absorbed_at = now()
   *  仅允许 status='warehoused' 且 bigseller_absorbed_at IS NULL
   *  受 RLS + Admin-only action 双层保护 */
  async confirmBigsellerAbsorption(
    shipmentId: string,
  ): Promise<boolean> {
    let current: { status: string; bigseller_absorbed_at: string | null } | null;

    if (isIndependentPlatformRuntime()) {
      const identity = await requireAppDbIdentity();
      const rows = await queryAppRows<{ status: string; bigseller_absorbed_at: string | null }>(
        identity,
        `SELECT status, bigseller_absorbed_at FROM public.shipment WHERE id = $1::uuid LIMIT 1`,
        [shipmentId],
      );
      current = rows[0] ?? null;
      if (!current) {
        throw new ShipmentError('在途记录不存在或无权访问', 'NOT_FOUND');
      }
      if (current.status !== 'warehoused') {
        throw new ShipmentError('仅已入仓的在途记录可确认 BigSeller 吸收', 'VALIDATION');
      }
      if (current.bigseller_absorbed_at) {
        throw new ShipmentError('该在途记录已确认 BigSeller 吸收，不可重复操作', 'VALIDATION');
      }
      await queryAppRows(
        identity,
        `UPDATE public.shipment SET bigseller_absorbed_at = now()
         WHERE id = $1::uuid AND status = 'warehoused' AND bigseller_absorbed_at IS NULL`,
        [shipmentId],
      );
      return true;
    }

    const supabase = await createClient();
    const { data: currentData, error: fetchErr } = await supabase
      .from('shipment')
      .select('status, bigseller_absorbed_at')
      .eq('id', shipmentId)
      .single();

    if (fetchErr) {
      if (fetchErr.code === 'PGRST116') {
        throw new ShipmentError('在途记录不存在或无权访问', 'NOT_FOUND');
      }
      throw new ShipmentError('查询在途记录失败', 'DB_ERROR');
    }

    current = currentData;
    if (!current) {
      throw new ShipmentError('在途记录不存在或无权访问', 'NOT_FOUND');
    }

    if (current.status !== 'warehoused') {
      throw new ShipmentError('仅已入仓的在途记录可确认 BigSeller 吸收', 'VALIDATION');
    }

    if (current.bigseller_absorbed_at) {
      throw new ShipmentError('该在途记录已确认 BigSeller 吸收，不可重复操作', 'VALIDATION');
    }

    const { error: updateErr } = await supabase
      .from('shipment')
      .update({ bigseller_absorbed_at: new Date().toISOString() })
      .eq('id', shipmentId)
      .eq('status', 'warehoused')
      .is('bigseller_absorbed_at', null);

    if (updateErr) {
      throw new ShipmentError('确认 BigSeller 吸收失败，请稍后重试', 'DB_ERROR');
    }

    return true;
  },

  /** P0: 检查 Shipment 是否已绑定外部物流记录（换仓保护预校验） */
  async existsBoundExternalRef(shipmentId: string): Promise<boolean> {
    if (isIndependentPlatformRuntime()) {
      const identity = await requireAppDbIdentity();
      const rows = await queryAppRows<{ count: string }>(
        identity,
        `SELECT COUNT(*)::text AS count FROM public.shipment_external_ref
         WHERE shipment_id = $1::uuid`,
        [shipmentId],
      );
      return Number(rows[0]?.count ?? 0) > 0;
    }

    const supabase = await createClient();
    const { count, error } = await supabase
      .from('shipment_external_ref')
      .select('id', { count: 'exact', head: true })
      .eq('shipment_id', shipmentId);

    if (error) {
      throw new ShipmentError('查询外部物流绑定失败，请稍后重试', 'DB_ERROR');
    }

    return (count ?? 0) > 0;
  },
};
