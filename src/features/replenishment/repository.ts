import 'server-only';
import { callAppRpc } from '@/lib/database/app-db';
import { isIndependentPlatformRuntime } from '@/lib/database/runtime';
import { createClient } from '@/lib/supabase/server';
import {
  replenishmentFiltersSchema,
  replenishmentRpcResultSchema,
} from './schema';
import type {
  ReplenishmentFilters,
  ReplenishmentResult,
  ReplenishmentSuggestion,
} from './types';

export class ReplenishmentError extends Error {
  constructor(
    message: string,
    public code: 'VALIDATION' | 'DB_ERROR',
  ) {
    super(message);
    this.name = 'ReplenishmentError';
  }
}

function mapSuggestion(
  row: ReturnType<typeof replenishmentRpcResultSchema.parse>['data'][number],
): ReplenishmentSuggestion {
  return {
    variantId: row.variant_id,
    warehouseId: row.warehouse_id,
    sku: row.sku,
    productName: row.product_name,
    productCode: row.product_code,
    variantName: row.variant_name,
    country: row.country,
    warehouseName: row.warehouse_name,
    avgDailySales: row.avg_daily_sales,
    leadTime: row.lead_time,
    bufferRatio: row.buffer_ratio,
    coverMult: row.cover_mult,
    safetyStock: row.safety_stock,
    onHand: row.on_hand,
    effectiveInbound: row.effective_inbound,
    targetStock: row.target_stock,
    netDemand: row.net_demand,
    suggestQty: row.suggest_qty,
    estStockoutDate: row.est_stockout_date,
    latestOrderDate: row.latest_order_date,
    urgency: row.urgency,
  };
}

export const replenishmentRepository = {
  async getSuggestions(
    userId: string,
    filters: ReplenishmentFilters = {},
  ): Promise<ReplenishmentResult> {
    const parsedFilters = replenishmentFiltersSchema.safeParse(filters);
    if (!parsedFilters.success) {
      throw new ReplenishmentError(
        parsedFilters.error.issues[0]?.message ?? '补货筛选参数无效',
        'VALIDATION',
      );
    }

    const values = parsedFilters.data;
    let data: unknown;
    if (isIndependentPlatformRuntime()) {
      data = await callAppRpc<unknown>(
        { profileUserId: userId },
        'public.get_replenishment_suggestions',
        [
          userId,
          values.variantId ?? null,
          values.warehouseId ?? null,
          values.country ?? null,
          values.urgency ?? null,
          values.search || null,
          values.includeZero,
          values.page,
          values.pageSize,
        ],
      );
    } else {
      const supabase = await createClient();
      const { data: rpcData, error } = await supabase.rpc('get_replenishment_suggestions', {
        p_user_id: userId,
        p_variant_id: values.variantId ?? null,
        p_warehouse_id: values.warehouseId ?? null,
        p_country: values.country ?? null,
        p_urgency: values.urgency ?? null,
        p_search: values.search || null,
        p_include_zero: values.includeZero,
        p_page: values.page,
        p_page_size: values.pageSize,
      });

      if (error) {
        throw new ReplenishmentError(`查询补货建议失败: ${error.message}`, 'DB_ERROR');
      }
      data = rpcData;
    }

    const parsed = replenishmentRpcResultSchema.safeParse(data);
    if (!parsed.success) {
      throw new ReplenishmentError('补货建议返回结构校验失败', 'DB_ERROR');
    }

    return {
      data: parsed.data.data.map(mapSuggestion),
      total: parsed.data.total,
      page: values.page,
      pageSize: values.pageSize,
    };
  },

  async getSuggestionsForVariants(
    userId: string,
    variantIds: string[],
  ): Promise<ReplenishmentSuggestion[]> {
    const uniqueIds = [...new Set(variantIds)];
    const results = await Promise.all(
      uniqueIds.map((variantId) =>
        this.getSuggestions(userId, {
          variantId,
          includeZero: true,
          page: 1,
          pageSize: 100,
        }),
      ),
    );
    return results.flatMap((result) => result.data);
  },

};
