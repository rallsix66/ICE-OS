import type { PoolClient } from 'pg';

import type { InventoryListDto, InventoryQueryInput } from './types';

type InventoryRowRecord = {
  inventory_id: string;
  product_variant_id: string;
  warehouse_id: string;
  warehouse_code: string;
  market_id: string;
  market_code: string;
  ice_code: string;
  sku_label: string;
  available_quantity: number;
  unit_cost_excl_freight: string | null;
  cost_currency: string | null;
};

export async function listInventoryInTransaction(
  client: PoolClient,
  query: InventoryQueryInput,
): Promise<InventoryListDto> {
  const params: unknown[] = [];
  const filters: string[] = [];

  if (query.marketCode) {
    params.push(query.marketCode);
    filters.push(`m.code = $${params.length}`);
  }
  if (query.warehouseCode) {
    params.push(query.warehouseCode);
    filters.push(`w.code = $${params.length}`);
  }

  const whereClause = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';

  if (query.includeAmount) {
    const sql = `
      SELECT
        i.id AS inventory_id,
        i.product_variant_id,
        i.warehouse_id,
        w.code AS warehouse_code,
        m.id AS market_id,
        m.code AS market_code,
        p.ice_code,
        pv.sku_label,
        i.available_quantity,
        c.unit_cost_excl_freight::text AS unit_cost_excl_freight,
        c.currency AS cost_currency
      FROM p0_01_biz.inventory i
      INNER JOIN p0_01_biz.warehouses w ON w.id = i.warehouse_id
      INNER JOIN p0_01_biz.markets m ON m.id = w.market_id
      INNER JOIN p0_01_biz.product_variants pv ON pv.id = i.product_variant_id
      INNER JOIN p0_01_biz.products p ON p.id = pv.product_id
      INNER JOIN p0_01_biz.inventory_unit_costs c
        ON c.product_variant_id = i.product_variant_id
       AND c.warehouse_id = i.warehouse_id
      ${whereClause}
      ORDER BY m.code, w.code, p.ice_code, pv.sku_label
    `;
    const result = await client.query<InventoryRowRecord>(sql, params);
    return {
      items: result.rows.map((row) => ({
        inventoryId: row.inventory_id,
        productVariantId: row.product_variant_id,
        warehouseId: row.warehouse_id,
        warehouseCode: row.warehouse_code,
        marketId: row.market_id,
        marketCode: row.market_code,
        iceCode: row.ice_code,
        skuLabel: row.sku_label,
        availableQuantity: row.available_quantity,
        unitCostExclFreight: row.unit_cost_excl_freight ?? undefined,
        costCurrency: row.cost_currency ?? undefined,
      })),
    };
  }

  const sql = `
    SELECT
      i.id AS inventory_id,
      i.product_variant_id,
      i.warehouse_id,
      w.code AS warehouse_code,
      m.id AS market_id,
      m.code AS market_code,
      p.ice_code,
      pv.sku_label,
      i.available_quantity,
      NULL::text AS unit_cost_excl_freight,
      NULL::text AS cost_currency
    FROM p0_01_biz.inventory i
    INNER JOIN p0_01_biz.warehouses w ON w.id = i.warehouse_id
    INNER JOIN p0_01_biz.markets m ON m.id = w.market_id
    INNER JOIN p0_01_biz.product_variants pv ON pv.id = i.product_variant_id
    INNER JOIN p0_01_biz.products p ON p.id = pv.product_id
    ${whereClause}
    ORDER BY m.code, w.code, p.ice_code, pv.sku_label
  `;
  const result = await client.query<InventoryRowRecord>(sql, params);
  return {
    items: result.rows.map((row) => ({
      inventoryId: row.inventory_id,
      productVariantId: row.product_variant_id,
      warehouseId: row.warehouse_id,
      warehouseCode: row.warehouse_code,
      marketId: row.market_id,
      marketCode: row.market_code,
      iceCode: row.ice_code,
      skuLabel: row.sku_label,
      availableQuantity: row.available_quantity,
    })),
  };
}

export async function loadActiveUserByIceId(
  client: PoolClient,
  iceUserId: string,
): Promise<{ id: string; email: string; display_name: string; role: string; is_enabled: boolean } | null> {
  const result = await client.query<{
    id: string;
    email: string;
    display_name: string;
    role: string;
    is_enabled: boolean;
  }>(
    `SELECT id, email, display_name, role, is_enabled
     FROM p0_01_biz.load_ice_user_for_session($1::uuid)`,
    [iceUserId],
  );
  return result.rows[0] ?? null;
}

export async function loadIceUserIdByAuthUserId(
  client: PoolClient,
  authUserId: string,
): Promise<string | null> {
  const result = await client.query<{ ice_user_id: string | null }>(
    `SELECT p0_01_biz.resolve_ice_user_id($1) AS ice_user_id`,
    [authUserId],
  );
  return result.rows[0]?.ice_user_id ?? null;
}

export async function userHasMarketGrant(
  client: PoolClient,
  iceUserId: string,
  marketCode: string,
): Promise<boolean> {
  const result = await client.query<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM p0_01_biz.user_market_grants mg
       INNER JOIN p0_01_biz.markets m ON m.id = mg.market_id
       WHERE mg.user_id = $1 AND m.code = $2
     ) AS ok`,
    [iceUserId, marketCode],
  );
  return result.rows[0]?.ok === true;
}

export async function userHasWarehouseGrant(
  client: PoolClient,
  iceUserId: string,
  warehouseCode: string,
): Promise<boolean> {
  const result = await client.query<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM p0_01_biz.user_warehouse_grants wg
       INNER JOIN p0_01_biz.warehouses w ON w.id = wg.warehouse_id
       WHERE wg.user_id = $1 AND w.code = $2
     ) AS ok`,
    [iceUserId, warehouseCode],
  );
  return result.rows[0]?.ok === true;
}

export async function marketCodeExists(client: PoolClient, marketCode: string): Promise<boolean> {
  const result = await client.query<{ ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM p0_01_biz.markets WHERE code = $1) AS ok`,
    [marketCode],
  );
  return result.rows[0]?.ok === true;
}

export async function warehouseCodeExists(client: PoolClient, warehouseCode: string): Promise<boolean> {
  const result = await client.query<{ ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM p0_01_biz.warehouses WHERE code = $1) AS ok`,
    [warehouseCode],
  );
  return result.rows[0]?.ok === true;
}

export async function userHasEffectiveInventoryScope(
  client: PoolClient,
  iceUserId: string,
  marketCode?: string,
  warehouseCode?: string,
): Promise<boolean> {
  const params: unknown[] = [iceUserId];
  const filters = ['mg.user_id = $1', 'wg.user_id = $1', 'w.market_id = mg.market_id', 'w.id = wg.warehouse_id'];
  if (marketCode) {
    params.push(marketCode);
    filters.push(`m.code = $${params.length}`);
  }
  if (warehouseCode) {
    params.push(warehouseCode);
    filters.push(`w.code = $${params.length}`);
  }
  const result = await client.query<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM p0_01_biz.user_market_grants mg
       INNER JOIN p0_01_biz.markets m ON m.id = mg.market_id
       INNER JOIN p0_01_biz.user_warehouse_grants wg ON wg.user_id = mg.user_id
       INNER JOIN p0_01_biz.warehouses w ON w.id = wg.warehouse_id AND w.market_id = mg.market_id
       WHERE ${filters.join(' AND ')}
     ) AS ok`,
    params,
  );
  return result.rows[0]?.ok === true;
}

export async function userHasAmountGrantForMarket(
  client: PoolClient,
  iceUserId: string,
  marketCode: string,
): Promise<boolean> {
  const result = await client.query<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM p0_01_biz.user_amount_grants ag
       INNER JOIN p0_01_biz.markets m ON m.id = ag.market_id
       WHERE ag.user_id = $1 AND m.code = $2
     ) AS ok`,
    [iceUserId, marketCode],
  );
  return result.rows[0]?.ok === true;
}
