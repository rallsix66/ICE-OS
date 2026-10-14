import 'server-only';
import { queryAppRows } from '@/lib/database/app-db';
import { requireAppDbIdentity } from '@/lib/database/app-identity';
import { isIndependentPlatformRuntime } from '@/lib/database/runtime';
import { createClient } from '@/lib/supabase/server';
import {
  parseReplenishmentDecimal,
  replenishmentDecimalsEqual,
  WarehouseNumericError,
} from './replenishment-numeric';
import type { WarehouseReplenishmentParams } from './types';
import type { DbIdentity } from '@/lib/database/app-db';

export class WarehouseError extends Error {
  constructor(
    message: string,
    public code: 'NOT_FOUND' | 'VALIDATION' | 'DB_ERROR',
  ) {
    super(message);
    this.name = 'WarehouseError';
  }
}

type WarehouseReplenishmentRow = {
  id: string;
  name: string;
  country: string;
  lead_time_days: number | null;
  buffer_ratio: unknown;
  target_cover_multiplier: unknown;
  updated_at: string;
};

function mapWarehouse(row: WarehouseReplenishmentRow): WarehouseReplenishmentParams {
  try {
    return mapWarehouseRow(row);
  } catch (error) {
    if (error instanceof WarehouseNumericError) {
      throw new WarehouseError(error.message, 'DB_ERROR');
    }
    throw error;
  }
}

function mapWarehouseRow(row: WarehouseReplenishmentRow): WarehouseReplenishmentParams {
  return {
    id: row.id,
    name: row.name,
    country: row.country,
    leadTimeDays: row.lead_time_days,
    bufferRatio: parseReplenishmentDecimal(row.buffer_ratio, 'buffer_ratio'),
    targetCoverMultiplier: parseReplenishmentDecimal(
      row.target_cover_multiplier,
      'target_cover_multiplier',
    ),
    updatedAt: row.updated_at,
  };
}

export const warehouseRepository = {
  async listReplenishmentParams(identityOverride?: DbIdentity): Promise<WarehouseReplenishmentParams[]> {
    if (isIndependentPlatformRuntime()) {
      const identity = identityOverride ?? (await requireAppDbIdentity());
      const rows = await queryAppRows<WarehouseReplenishmentRow>(
        identity,
        `SELECT id::text AS id, name, country, lead_time_days, buffer_ratio, target_cover_multiplier, updated_at
         FROM public.warehouse
         WHERE type = 'overseas' AND is_active = true
         ORDER BY country ASC, name ASC`,
      );
      return rows.map(mapWarehouse);
    }

    const supabase = await createClient();
    const { data, error } = await supabase
      .from('warehouse')
      .select(
        'id, name, country, lead_time_days, buffer_ratio, target_cover_multiplier, updated_at',
      )
      .eq('type', 'overseas')
      .eq('is_active', true)
      .order('country')
      .order('name');

    if (error) {
      throw new WarehouseError('查询仓库补货参数失败', 'DB_ERROR');
    }
    return (data ?? []).map(mapWarehouse);
  },

  async updateReplenishmentParams(
    warehouseId: string,
    bufferRatio: number,
    targetCoverMultiplier: number,
    identityOverride?: DbIdentity,
  ): Promise<WarehouseReplenishmentParams> {
    if (isIndependentPlatformRuntime()) {
      const identity = identityOverride ?? (await requireAppDbIdentity());
      const existing = await queryAppRows<{ id: string; type: string; is_active: boolean }>(
        identity,
        `SELECT id::text AS id, type, is_active FROM public.warehouse WHERE id = $1::uuid LIMIT 1`,
        [warehouseId],
      );
      const row = existing[0];
      if (!row) {
        throw new WarehouseError('仓库不存在或无权访问', 'NOT_FOUND');
      }
      if (!row.is_active || row.type !== 'overseas') {
        throw new WarehouseError('只能修改启用中的海外仓参数', 'VALIDATION');
      }

      const updated = await queryAppRows<WarehouseReplenishmentRow>(
        identity,
        `UPDATE public.warehouse
         SET buffer_ratio = $2, target_cover_multiplier = $3, updated_at = now()
         WHERE id = $1::uuid AND is_active = true AND type = 'overseas'
         RETURNING id::text AS id, name, country, lead_time_days, buffer_ratio, target_cover_multiplier, updated_at`,
        [warehouseId, bufferRatio, targetCoverMultiplier],
      );
      const data = updated[0];
      if (!data) {
        throw new WarehouseError('更新仓库补货参数失败', 'DB_ERROR');
      }
      const mapped = mapWarehouse(data);
      if (
        !replenishmentDecimalsEqual(bufferRatio, mapped.bufferRatio)
        || !replenishmentDecimalsEqual(targetCoverMultiplier, mapped.targetCoverMultiplier)
      ) {
        throw new WarehouseError('仓库补货参数写后校验失败', 'DB_ERROR');
      }
      return mapped;
    }

    const supabase = await createClient();
    const { data: existing, error: existingError } = await supabase
      .from('warehouse')
      .select('id, type, is_active')
      .eq('id', warehouseId)
      .single();

    if (existingError || !existing) {
      throw new WarehouseError('仓库不存在或无权访问', 'NOT_FOUND');
    }
    if (!existing.is_active || existing.type !== 'overseas') {
      throw new WarehouseError('只能修改启用中的海外仓参数', 'VALIDATION');
    }

    const { data, error } = await supabase
      .from('warehouse')
      .update({
        buffer_ratio: bufferRatio,
        target_cover_multiplier: targetCoverMultiplier,
      })
      .eq('id', warehouseId)
      .eq('is_active', true)
      .eq('type', 'overseas')
      .select(
        'id, name, country, lead_time_days, buffer_ratio, target_cover_multiplier, updated_at',
      )
      .single();

    if (error || !data) {
      throw new WarehouseError('更新仓库补货参数失败', 'DB_ERROR');
    }
    const mapped = mapWarehouse(data as WarehouseReplenishmentRow);
    if (
      !replenishmentDecimalsEqual(bufferRatio, mapped.bufferRatio)
      || !replenishmentDecimalsEqual(targetCoverMultiplier, mapped.targetCoverMultiplier)
    ) {
      throw new WarehouseError('仓库补货参数写后校验失败', 'DB_ERROR');
    }
    return mapped;
  },
};

