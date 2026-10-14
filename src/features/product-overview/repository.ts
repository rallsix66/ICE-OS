import 'server-only';
import { callAppRpc } from '@/lib/database/app-db';
import { isIndependentPlatformRuntime } from '@/lib/database/runtime';
import { createClient } from '@/lib/supabase/server';
import {
  productOverviewParamsSchema,
  productOverviewRpcSchema,
  productVariantDetailInputSchema,
  productVariantDetailRpcSchema,
} from './schema';
import type {
  AssignedWarehouseDetail,
  ProductOverviewRepository,
  ProductOverviewResult,
  ProductOverviewRow,
  ProductVariantDetail,
} from './types';

export class ProductOverviewError extends Error {
  constructor(
    message: string,
    public code: 'VALIDATION' | 'DB_ERROR' | 'NOT_FOUND',
  ) {
    super(message);
    this.name = 'ProductOverviewError';
  }
}

function mapOverviewRow(
  row: ReturnType<typeof productOverviewRpcSchema.parse>['items'][number],
): ProductOverviewRow {
  return {
    variantId: row.variant_id,
    productId: row.product_id,
    sku: row.sku,
    variantCountry: row.variant_country,
    productName: row.product_name,
    variantName: row.variant_name,
    perWarehouse: row.per_warehouse.map((warehouse) => ({
      warehouseId: warehouse.warehouse_id,
      warehouseName: warehouse.warehouse_name,
      country: warehouse.country,
      onHand: warehouse.q,
      dailySales: warehouse.daily_sales,
      inbound: warehouse.inb.map((item) => ({ eta: item.eta, quantity: item.qty })),
      baseStockStatus: warehouse.base_stock_status,
    })),
    visibleOnHand: row.visible_on_hand,
    visibleInboundQuantity: row.visible_inbound_quantity,
    effectiveInbound: row.effective_inbound,
    etaMissingQuantity: row.eta_missing_quantity,
    visibleTotalQuantity: row.visible_total_quantity,
    baseStockStatus: row.base_stock_status,
    earliestStockout: row.earliest_stockout,
    stockoutUrgency: row.stockout_urgency,
    partialData: row.partial_data,
    domesticStatus: row.domestic_status,
  };
}

function mapAssignedWarehouse(
  warehouse: ReturnType<
    typeof productVariantDetailRpcSchema.parse
  >['assigned_warehouse_detail'][number],
): AssignedWarehouseDetail {
  return {
    warehouseId: warehouse.warehouse_id,
    warehouseName: warehouse.warehouse_name,
    country: warehouse.country,
    onHand: warehouse.on_hand,
    dailySales: warehouse.daily_sales,
    inbound: warehouse.inbound.map((item) => ({
      eta: item.eta,
      quantity: item.remaining,
    })),
    visibleInboundQuantity: warehouse.visible_inbound_quantity,
    etaMissingQuantity: warehouse.eta_missing_quantity,
    estStockoutDate: warehouse.est_stockout_date,
    effectiveInbound: warehouse.effective_inbound,
    baseStockStatus: warehouse.base_stock_status,
    safetyStock: warehouse.safety_stock,
    targetStock: warehouse.target_stock,
    netDemand: warehouse.net_demand,
    suggestQty: warehouse.suggest_qty,
    latestOrderDate: warehouse.latest_order_date,
    replenishmentUrgency: warehouse.replenishment_urgency,
  };
}

export const productOverviewRepository: ProductOverviewRepository = {
  async getProductOverview(userId, params): Promise<ProductOverviewResult> {
    const parsedParams = productOverviewParamsSchema.safeParse(params);
    if (!parsedParams.success) {
      throw new ProductOverviewError(
        parsedParams.error.issues[0]?.message ?? '全球库存筛选参数无效',
        'VALIDATION',
      );
    }

    const values = parsedParams.data;
    let data: unknown;
    if (isIndependentPlatformRuntime()) {
      data = await callAppRpc<unknown>(
        { profileUserId: userId },
        'public.get_product_overview',
        [
          userId,
          values.page,
          values.pageSize,
          values.search || null,
          values.stockoutUrgency ?? null,
          values.country ?? null,
        ],
      );
    } else {
      const supabase = await createClient();
      const { data: rpcData, error } = await supabase.rpc('get_product_overview', {
        p_user_id: userId,
        p_page: values.page,
        p_page_size: values.pageSize,
        p_search: values.search || null,
        p_stockout_urgency: values.stockoutUrgency ?? null,
        p_country: values.country ?? null,
      });

      if (error) {
        throw new ProductOverviewError('查询全球库存总览失败，请稍后重试', 'DB_ERROR');
      }
      data = rpcData;
    }

    const parsed = productOverviewRpcSchema.safeParse(data);
    if (!parsed.success) {
      throw new ProductOverviewError('全球库存总览返回结构校验失败', 'DB_ERROR');
    }

    return {
      items: parsed.data.items.map(mapOverviewRow),
      totalCount: parsed.data.total_count,
      queueCounts: {
        critical: parsed.data.queue_counts.critical,
        warning: parsed.data.queue_counts.warning,
        ok: parsed.data.queue_counts.ok,
        dataIncomplete: parsed.data.queue_counts.data_incomplete,
      },
      page: values.page,
      pageSize: values.pageSize,
    };
  },

  async getProductVariantDetail(userId, variantId): Promise<ProductVariantDetail> {
    const parsedInput = productVariantDetailInputSchema.safeParse({ variantId });
    if (!parsedInput.success) {
      throw new ProductOverviewError(
        parsedInput.error.issues[0]?.message ?? '产品 SKU 参数无效',
        'VALIDATION',
      );
    }

    let data: unknown;
    if (isIndependentPlatformRuntime()) {
      data = await callAppRpc<unknown>(
        { profileUserId: userId },
        'public.get_war_room_variant_detail',
        [userId, parsedInput.data.variantId],
      );
    } else {
      const supabase = await createClient();
      const { data: rpcData, error } = await supabase.rpc('get_war_room_variant_detail', {
        p_user_id: userId,
        p_variant_id: parsedInput.data.variantId,
      });

      if (error) {
        throw new ProductOverviewError('产品详情加载失败，请稍后重试', 'DB_ERROR');
      }
      data = rpcData;
    }

    const parsed = productVariantDetailRpcSchema.safeParse(data);
    if (!parsed.success) {
      throw new ProductOverviewError('产品详情返回结构校验失败', 'DB_ERROR');
    }

    const row = parsed.data;
    return {
      variantId: row.variant_id,
      productId: row.product_id,
      sku: row.sku,
      variantCountry: row.variant_country,
      productName: row.product_name,
      variantName: row.variant_name,
      visibleOnHand: row.visible_on_hand,
      visibleInboundQuantity: row.visible_inbound_quantity,
      effectiveInbound: row.effective_inbound,
      etaMissingQuantity: row.eta_missing_quantity,
      visibleTotalQuantity: row.visible_total_quantity,
      earliestStockout: row.earliest_stockout,
      stockoutUrgency: row.stockout_urgency,
      partialData: row.partial_data,
      domesticStatus: row.domestic_status,
      assignedWarehouseDetail: row.assigned_warehouse_detail.map(mapAssignedWarehouse),
      countryAgg: row.country_agg.map((country) => ({
        country: country.country,
        onHand: country.on_hand,
        dailySales: country.daily_sales,
        visibleInboundQuantity: country.visible_inbound_quantity,
        etaMissingQuantity: country.eta_missing_quantity,
        earliestStockout: country.earliest_stockout,
      })),
    };
  },
};
