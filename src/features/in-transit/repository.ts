// 外部物流模块数据访问层
// P0: 新增 golucky (喜运达) provider 支持
//
// Supabase 路径：可选 db 为 service_role 客户端（cron）；否则 createClient + RLS。
// P0-02：会话走 app runner + RLS；cron 同步传入 P002_SYNC_RUNNER + sync runner。
import { callAppRpc, queryAppRows, querySyncRows } from '@/lib/database/app-db';
import { isIndependentPlatformRuntime } from '@/lib/database/runtime';
import { getP002ProfileUserId } from '@/lib/independent-platform/p0-02-session';
import { createClient } from '@/lib/supabase/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import type {
  GoluckyImportResult,
  ShipmentBindingCandidate,
  ShipmentExternalRefRow,
  TrackingEventExternalRow,
} from './types';
import type { PostgrestError } from '@supabase/supabase-js';
import { goluckyImportResultSchema } from './schema';

export type ExternalRefWithTracking = ShipmentExternalRefRow & {
  events: TrackingEventExternalRow[];
};

export class ExternalTrackingError extends Error {
  constructor(
    message: string,
    public code: 'NOT_FOUND' | 'DB_ERROR' | 'FORBIDDEN' | 'VALIDATION',
  ) {
    super(message);
    this.name = 'ExternalTrackingError';
  }
}

function handlePgError(error: PostgrestError | null, message: string): void {
  if (error) {
    throw new ExternalTrackingError(`${message}: ${error.message}`, 'DB_ERROR');
  }
}

type DbClient = SupabaseClient<Database>;

/** Cron / 服务端同步在 P0-02 下使用 sync runner（非 Supabase service_role）。 */
export const P002_SYNC_RUNNER = Symbol.for('ice.p0-02.sync-runner');
export type ExternalTrackingDbHandle = DbClient | typeof P002_SYNC_RUNNER;

function isSyncHandle(db?: ExternalTrackingDbHandle): boolean {
  return db === P002_SYNC_RUNNER;
}

async function requireAppIdentity() {
  const profileUserId = await getP002ProfileUserId();
  if (!profileUserId) {
    throw new ExternalTrackingError('未登录或会话无效', 'FORBIDDEN');
  }
  return { profileUserId };
}

export const externalTrackingRepository = {
  /** P0: 按 provider 查询 active 外部物流记录 */
  async getExternalRefsByProvider(
    provider: string,
    db?: ExternalTrackingDbHandle,
  ): Promise<ShipmentExternalRefRow[]> {
    if (isSyncHandle(db)) {
      return querySyncRows<ShipmentExternalRefRow>(
        `SELECT * FROM public.shipment_external_ref
         WHERE provider = $1 AND sync_status = 'active'`,
        [provider],
        { mode: 'golucky' },
      );
    }
    if (isIndependentPlatformRuntime() && !db) {
      const identity = await requireAppIdentity();
      return queryAppRows<ShipmentExternalRefRow>(
        identity,
        `SELECT * FROM public.shipment_external_ref
         WHERE provider = $1 AND sync_status = 'active'`,
        [provider],
      );
    }
    const supabase = (db as DbClient | undefined) ?? (await createClient());
    const { data, error } = await supabase
      .from('shipment_external_ref')
      .select('*')
      .eq('provider', provider)
      .eq('sync_status', 'active');

    handlePgError(error, '查询外部物流记录失败');
    return data ?? [];
  },

  /** P0: Upsert 喜运达轨迹事件（按 external_event_id 去重） */
  async upsertGoluckyEvents(
    externalRefId: string,
    provider: string,
    events: Array<{
      externalEventId: string;
      externalCategory: string;
      status: string;
      description: string;
      occurredAt: string;
      rawPayload: Record<string, unknown>;
    }>,
    db?: ExternalTrackingDbHandle,
  ): Promise<{ inserted: number; skipped: number }> {
    if (events.length === 0) {
      return { inserted: 0, skipped: 0 };
    }

    if (isSyncHandle(db)) {
      let inserted = 0;
      let skipped = 0;
      for (const event of events) {
        const rows = await querySyncRows<{ id: string }>(
          `INSERT INTO public.tracking_event_external (
             external_ref_id, provider, external_event_id, external_category,
             status, description, occurred_at, raw_payload
           ) VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::jsonb)
           ON CONFLICT (external_ref_id, external_event_id) DO NOTHING
           RETURNING id`,
          [
            externalRefId,
            provider,
            event.externalEventId,
            event.externalCategory,
            event.status,
            event.description,
            event.occurredAt,
            JSON.stringify(event.rawPayload),
          ],
          { mode: 'golucky' },
        );
        if (rows.length > 0) {
          inserted++;
        } else {
          skipped++;
        }
      }
      return { inserted, skipped };
    }

    const supabase = (db as DbClient | undefined) ?? (await createClient());
    let inserted = 0;
    let skipped = 0;

    for (const event of events) {
      const { error } = await supabase
        .from('tracking_event_external')
        .upsert(
          {
            external_ref_id: externalRefId,
            provider,
            external_event_id: event.externalEventId,
            external_category: event.externalCategory,
            status: event.status,
            description: event.description,
            occurred_at: event.occurredAt,
            raw_payload: event.rawPayload,
          },
          {
            onConflict: 'external_ref_id,external_event_id',
            ignoreDuplicates: true,
          },
        );

      if (error) {
        if (error.code === '23505') {
          skipped++;
          continue;
        }
        throw new ExternalTrackingError(`写入轨迹事件失败: ${error.message}`, 'DB_ERROR');
      }

      inserted++;
    }

    return { inserted, skipped };
  },

  /** P0: 更新外部物流记录的同步状态 */
  async updateExternalRefSync(
    refId: string,
    syncStatus: 'active' | 'stale' | 'error',
    lastSyncedAt?: string,
    rawPayload?: Record<string, unknown>,
    db?: ExternalTrackingDbHandle,
  ): Promise<void> {
    const syncedAt = lastSyncedAt ?? new Date().toISOString();

    if (isSyncHandle(db)) {
      await querySyncRows(
        `UPDATE public.shipment_external_ref
         SET sync_status = $2,
             last_synced_at = $3::timestamptz,
             raw_payload = CASE WHEN $4::jsonb IS NULL THEN raw_payload ELSE $4::jsonb END
         WHERE id = $1`,
        [
          refId,
          syncStatus,
          syncedAt,
          rawPayload ? JSON.stringify(rawPayload) : null,
        ],
        { mode: 'golucky' },
      );
      return;
    }

    const supabase = (db as DbClient | undefined) ?? (await createClient());

    const { error } = await supabase
      .from('shipment_external_ref')
      .update({
        sync_status: syncStatus,
        last_synced_at: syncedAt,
        ...(rawPayload ? { raw_payload: rawPayload } : {}),
      })
      .eq('id', refId);

    handlePgError(error, '更新外部物流记录同步状态失败');
  },

  /** P0: 按 shipment_id 查询绑定的外部轨迹（供详情页展示） */
  async getExternalTrackingByShipment(
    shipmentId: string,
  ): Promise<ExternalRefWithTracking[]> {
    if (isIndependentPlatformRuntime()) {
      const identity = await requireAppIdentity();
      const refs = await queryAppRows<ShipmentExternalRefRow>(
        identity,
        `SELECT * FROM public.shipment_external_ref WHERE shipment_id = $1`,
        [shipmentId],
      );
      if (refs.length === 0) {
        return [];
      }
      const result: ExternalRefWithTracking[] = [];
      for (const ref of refs) {
        const events = await queryAppRows<TrackingEventExternalRow>(
          identity,
          `SELECT * FROM public.tracking_event_external
           WHERE external_ref_id = $1
           ORDER BY occurred_at ASC`,
          [ref.id],
        );
        result.push({ ...ref, events });
      }
      return result;
    }

    const supabase = await createClient();

    const { data: refs, error: refError } = await supabase
      .from('shipment_external_ref')
      .select('*')
      .eq('shipment_id', shipmentId);

    handlePgError(refError, '查询外部物流记录失败');

    if (!refs || refs.length === 0) {
      return [];
    }

    const result: ExternalRefWithTracking[] = [];

    for (const ref of refs) {
      const { data: events, error: eventsError } = await supabase
        .from('tracking_event_external')
        .select('*')
        .eq('external_ref_id', ref.id)
        .order('occurred_at', { ascending: true });

      handlePgError(eventsError, '查询外部轨迹失败');

      result.push({
        ...ref,
        events: events ?? [],
      });
    }

    return result;
  },

  /** P0: 查询未绑定的外部物流记录列表 */
  async listUnboundExternalRefs(
    provider?: string,
  ): Promise<ShipmentExternalRefRow[]> {
    if (isIndependentPlatformRuntime()) {
      const identity = await requireAppIdentity();
      if (provider) {
        return queryAppRows<ShipmentExternalRefRow>(
          identity,
          `SELECT * FROM public.shipment_external_ref
           WHERE shipment_id IS NULL AND provider = $1
           ORDER BY created_at DESC`,
          [provider],
        );
      }
      return queryAppRows<ShipmentExternalRefRow>(
        identity,
        `SELECT * FROM public.shipment_external_ref
         WHERE shipment_id IS NULL
         ORDER BY created_at DESC`,
      );
    }

    const supabase = await createClient();

    let query = supabase
      .from('shipment_external_ref')
      .select('*')
      .is('shipment_id', null);

    if (provider) {
      query = query.eq('provider', provider);
    }

    const { data, error } = await query.order('created_at', { ascending: false });

    handlePgError(error, '查询未绑定外部物流记录失败');
    return data ?? [];
  },

  /** P0: 查询与未绑定喜运达记录仓库、国家一致的 Shipment 候选。 */
  async listShipmentBindingCandidates(
    refId: string,
  ): Promise<ShipmentBindingCandidate[]> {
    if (isIndependentPlatformRuntime()) {
      const identity = await requireAppIdentity();
      const refs = await queryAppRows<{
        id: string;
        provider: string;
        country: string;
        warehouse_id: string | null;
        shipment_id: string | null;
      }>(
        identity,
        `SELECT id, provider, country, warehouse_id, shipment_id
         FROM public.shipment_external_ref
         WHERE id = $1 AND provider = 'golucky'
         LIMIT 1`,
        [refId],
      );
      const ref = refs[0];
      if (!ref) {
        throw new ExternalTrackingError('喜运达外部物流记录不存在或无权访问', 'NOT_FOUND');
      }
      if (ref.shipment_id) {
        throw new ExternalTrackingError('该外部物流记录已绑定 Shipment', 'VALIDATION');
      }
      if (!ref.warehouse_id) {
        return [];
      }
      const shipments = await queryAppRows<{
        id: string;
        shipment_no: string;
        purchase_order_no: string | null;
        country: string;
        warehouse_id: string | null;
        status: string;
        estimated_arrival: string | null;
        created_at: string;
      }>(
        identity,
        `SELECT id, shipment_no, purchase_order_no, country, warehouse_id, status, estimated_arrival, created_at
         FROM public.shipment
         WHERE warehouse_id = $1 AND country = $2
         ORDER BY created_at DESC
         LIMIT 100`,
        [ref.warehouse_id, ref.country],
      );
      return shipments.map((shipment) => ({
        id: shipment.id,
        shipmentNo: shipment.shipment_no,
        purchaseOrderNo: shipment.purchase_order_no,
        country: shipment.country,
        warehouseId: shipment.warehouse_id,
        status: shipment.status,
        estimatedArrival: shipment.estimated_arrival,
        createdAt: shipment.created_at,
      }));
    }

    const supabase = await createClient();

    const { data: ref, error: refError } = await supabase
      .from('shipment_external_ref')
      .select('id, provider, country, warehouse_id, shipment_id')
      .eq('id', refId)
      .eq('provider', 'golucky')
      .single();

    if (refError) {
      if (refError.code === 'PGRST116') {
        throw new ExternalTrackingError('喜运达外部物流记录不存在或无权访问', 'NOT_FOUND');
      }
      throw new ExternalTrackingError(`查询喜运达外部物流记录失败: ${refError.message}`, 'DB_ERROR');
    }

    if (ref.shipment_id) {
      throw new ExternalTrackingError('该外部物流记录已绑定 Shipment', 'VALIDATION');
    }

    if (!ref.warehouse_id) {
      return [];
    }

    const { data, error } = await supabase
      .from('shipment')
      .select(
        'id, shipment_no, purchase_order_no, country, warehouse_id, status, estimated_arrival, created_at',
      )
      .eq('warehouse_id', ref.warehouse_id)
      .eq('country', ref.country)
      .order('created_at', { ascending: false })
      .limit(100);

    handlePgError(error, '查询可绑定 Shipment 失败');

    return (data ?? []).map((shipment) => ({
      id: shipment.id,
      shipmentNo: shipment.shipment_no,
      purchaseOrderNo: shipment.purchase_order_no,
      country: shipment.country,
      warehouseId: shipment.warehouse_id,
      status: shipment.status,
      estimatedArrival: shipment.estimated_arrival,
      createdAt: shipment.created_at,
    }));
  },

  /** P0: 查询同步失败的外部物流记录 */
  async listFailedExternalRefs(
    provider?: string,
  ): Promise<ShipmentExternalRefRow[]> {
    if (isIndependentPlatformRuntime()) {
      const identity = await requireAppIdentity();
      if (provider) {
        return queryAppRows<ShipmentExternalRefRow>(
          identity,
          `SELECT * FROM public.shipment_external_ref
           WHERE sync_status = 'error' AND provider = $1
           ORDER BY last_synced_at DESC NULLS LAST`,
          [provider],
        );
      }
      return queryAppRows<ShipmentExternalRefRow>(
        identity,
        `SELECT * FROM public.shipment_external_ref
         WHERE sync_status = 'error'
         ORDER BY last_synced_at DESC NULLS LAST`,
      );
    }

    const supabase = await createClient();

    let query = supabase
      .from('shipment_external_ref')
      .select('*')
      .eq('sync_status', 'error');

    if (provider) {
      query = query.eq('provider', provider);
    }

    const { data, error } = await query.order('last_synced_at', { ascending: false });

    handlePgError(error, '查询失败记录失败');
    return data ?? [];
  },

  /** P0: 按 ID 获取单条外部物流记录 */
  async getExternalRefById(refId: string): Promise<ShipmentExternalRefRow | null> {
    if (isIndependentPlatformRuntime()) {
      const identity = await requireAppIdentity();
      const rows = await queryAppRows<ShipmentExternalRefRow>(
        identity,
        `SELECT * FROM public.shipment_external_ref WHERE id = $1 LIMIT 1`,
        [refId],
      );
      return rows[0] ?? null;
    }

    const supabase = await createClient();
    const { data, error } = await supabase
      .from('shipment_external_ref')
      .select('*')
      .eq('id', refId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      throw new ExternalTrackingError(`查询外部物流记录失败: ${error.message}`, 'DB_ERROR');
    }

    return data;
  },

  /** P0: 批量导入喜运达运单 — 封装 RPC 调用、参数映射与返回值校验 */
  async importGoluckyRefs(
    items: Array<{
      waybillNo: string;
      warehouseId: string;
      country: string;
      externalOrderNo?: string;
    }>,
  ): Promise<GoluckyImportResult> {
    const pItems = items.map((item) => ({
      waybill_no: item.waybillNo,
      warehouse_id: item.warehouseId,
      country: item.country,
      external_order_no: item.externalOrderNo ?? null,
    }));

    let data: unknown;
    if (isIndependentPlatformRuntime()) {
      const identity = await requireAppIdentity();
      data = await callAppRpc<unknown>(identity, 'public.import_golucky_refs', [
        JSON.stringify(pItems),
      ]);
    } else {
      const supabase = await createClient();
      const { data: rpcData, error } = await supabase.rpc('import_golucky_refs', {
        p_items: pItems,
      });
      if (error) {
        throw new ExternalTrackingError(`导入失败: ${error.message}`, 'DB_ERROR');
      }
      data = rpcData;
    }

    const parsed = goluckyImportResultSchema.safeParse(data);
    if (!parsed.success) {
      throw new ExternalTrackingError('导入返回数据格式异常', 'DB_ERROR');
    }

    return parsed.data;
  },

  /** P0: 绑定外部物流记录到 Shipment — 封装 RPC 调用 */
  async bindExternalRefToShipment(
    refId: string,
    shipmentId: string,
  ): Promise<void> {
    if (isIndependentPlatformRuntime()) {
      const identity = await requireAppIdentity();
      await callAppRpc(identity, 'public.bind_external_ref_to_shipment', [refId, shipmentId]);
      return;
    }

    const supabase = await createClient();

    const { error } = await supabase.rpc('bind_external_ref_to_shipment', {
      p_ref_id: refId,
      p_shipment_id: shipmentId,
    });

    if (error) {
      throw new ExternalTrackingError(`绑定失败: ${error.message}`, 'DB_ERROR');
    }
  },

  /** P0: 重激活外部物流记录同步 — 封装 RPC 调用 */
  async reactivateExternalRef(refId: string): Promise<void> {
    if (isIndependentPlatformRuntime()) {
      const identity = await requireAppIdentity();
      await callAppRpc(identity, 'public.reactivate_external_ref', [refId]);
      return;
    }

    const supabase = await createClient();

    const { error } = await supabase.rpc('reactivate_external_ref', {
      p_ref_id: refId,
    });

    if (error) {
      throw new ExternalTrackingError(`重激活失败: ${error.message}`, 'DB_ERROR');
    }
  },
};
