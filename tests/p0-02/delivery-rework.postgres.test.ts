import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

import { preferencesRepository } from '@/features/preferences/repository';
import { inventoryRepository } from '@/features/inventory/repository';
import { shipmentRepository } from '@/features/shipments/repository';
import { queryAppRows } from '@/lib/database/app-db';
import { closeP002Pools } from '@/lib/independent-platform/p0-02-pools';
import { loadP002InstanceEnv } from './helpers';

const admin = '11111111-1111-4111-8111-111111111101';
const operator = '11111111-1111-4111-8111-111111111104';

vi.mock('@/lib/database/app-identity', () => ({
  requireAppDbIdentity: async () => ({ profileUserId: admin }),
}));

const wh = randomUUID();
const variant = randomUUID();
const variantEmpty = randomUUID();
const inventory = randomUUID();
const sku = `DEL-${variant.slice(0, 8)}`;
const skuEmpty = `DEL-EMPTY-${variantEmpty.slice(0, 8)}`;
const skuNew = `DEL-NEW-${randomUUID().slice(0, 8)}`;
const whName = 'P0-02 delivery rework fixture';

let owner: Pool;
let sync: Pool;
let app: Pool;

beforeAll(async () => {
  const { instance, envJson } = loadP002InstanceEnv();
  const base = {
    host: instance.host,
    port: instance.port,
    database: instance.dbName,
    max: 1,
    connectionTimeoutMillis: 5000,
    options: '-c statement_timeout=8000',
  };
  owner = new Pool({
    ...base,
    user: instance.bootstrapUser,
    password: instance.bootstrapPassword,
  });
  sync = new Pool({
    connectionString: envJson.P0_02_SYNC_DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 5000,
    options: base.options,
  });
  app = new Pool({
    ...base,
    user: instance.appRunnerUser,
    password: instance.appRunnerPassword,
  });

  const c = await owner.connect();
  try {
    await c.query('BEGIN');
    await c.query(
      `INSERT INTO public.warehouse (id, name, country, type, is_active)
       VALUES ($1, $2, 'TH', 'overseas', true)`,
      [wh, whName],
    );
    await c.query(
      `INSERT INTO public.product_variant (id, sku, country, name, match_status)
       VALUES ($1, $2, 'TH', 'Rework variant', 'unmatched'),
              ($3, $4, 'TH', 'Rework empty variant', 'unmatched')`,
      [variant, sku, variantEmpty, skuEmpty],
    );
    await c.query(
      `INSERT INTO public.inventory (id, variant_id, warehouse_id, quantity)
       VALUES ($1, $2, $3, 5)`,
      [inventory, variant, wh],
    );
    await c.query(
      `INSERT INTO public.user_warehouses (user_id, warehouse_id) VALUES ($1, $2)`,
      [operator, wh],
    );
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
});

afterAll(async () => {
  try {
    const c = await owner.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        `DELETE FROM public.user_variant_preference WHERE variant_id = ANY($1::uuid[])`,
        [[variant, variantEmpty]],
      );
      await c.query(`DELETE FROM public.user_warehouses WHERE warehouse_id = $1`, [wh]);
      await c.query(`DELETE FROM public.inventory WHERE warehouse_id = $1`, [wh]);
      await c.query(`DELETE FROM public.product_variant WHERE id = ANY($1::uuid[])`, [
        [variant, variantEmpty],
      ]);
      await c.query(`DELETE FROM public.sync_warehouse_lock WHERE warehouse_id = $1`, [wh]);
      await c.query(`DELETE FROM public.warehouse WHERE id = $1`, [wh]);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  } finally {
    await closeP002Pools();
    await app?.end();
    await sync?.end();
    await owner?.end();
  }
});

it('DELIVERY-01: toggleFavorite succeeds for visible SKU with identity', async () => {
  const visible = await queryAppRows<{ id: string }>(
    { profileUserId: admin },
    `SELECT id::text AS id FROM public.product_variant WHERE id = $1::uuid`,
    [variant],
  );
  expect(visible).toHaveLength(1);
  const result = await preferencesRepository.toggleFavorite(admin, variant);
  expect(result.success).toBe(true);
});

it('DELIVERY-02: manual updateQuantity is sealed on independent platform', async () => {
  await expect(
    inventoryRepository.updateQuantity(inventory, 42, { profileUserId: operator }),
  ).rejects.toThrow(/封存/);
  const persisted = (
    await owner.query(`SELECT quantity FROM public.inventory WHERE id = $1`, [inventory])
  ).rows[0].quantity;
  expect(Number(persisted)).toBe(5);
});

it('DELIVERY-03: app runner has partial_warehouse_shipment EXECUTE', async () => {
  const permission = (
    await owner.query(
      `SELECT has_function_privilege(
         'ice_p0_02_app_runner',
         'public.partial_warehouse_shipment(uuid,jsonb,text)',
         'EXECUTE'
       ) AS allowed`,
    )
  ).rows[0];
  expect(permission.allowed).toBe(true);
  let message = '';
  try {
    await shipmentRepository.partialWarehouse(randomUUID(), [{ variantId: variant, quantity: 1 }], 'probe');
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  }
  expect(message).not.toMatch(/permission denied/i);
});

async function syncRpc(variants: unknown[], skuValue: string) {
  const c = await sync.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('p0_02.sync.mode', 'warehouse', true)`);
    await c.query(`SELECT set_config('p0_02.sync.warehouse_id', $1, true)`, [wh]);
    const row = await c.query(
      `SELECT public.sync_warehouse_inventory($1::uuid, $2::jsonb, $3::jsonb, $4::text) AS result`,
      [
        wh,
        JSON.stringify(variants),
        JSON.stringify([
          {
            sku: skuValue,
            country: 'TH',
            quantity: 11,
            last_sync_at: new Date().toISOString(),
          },
        ]),
        whName,
      ],
    );
    await c.query('ROLLBACK');
    return row.rows[0]?.result;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

it('DELIVERY-04: sync runner can insert new SKU + inventory', async () => {
  const result = await syncRpc([{ sku: skuNew, country: 'TH', name: 'New from sync' }], skuNew);
  expect(result).toBeTruthy();
});

it('DELIVERY-04: sync runner can insert first inventory for existing SKU', async () => {
  const result = await syncRpc([], skuEmpty);
  expect(result).toBeTruthy();
});

it('DELIVERY-06: unauthenticated app pool product count is zero; admin sees data', async () => {
  const c = await app.connect();
  let noIdentity = 0;
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('request.jwt.claim.sub', '', true)`);
    noIdentity = (await c.query(`SELECT count(*)::int AS n FROM public.product`)).rows[0].n;
    await c.query('ROLLBACK');
  } finally {
    c.release();
  }
  const authorized = (
    await queryAppRows<{ n: number }>(
      { profileUserId: admin },
      `SELECT count(*)::int AS n FROM public.product`,
    )
  )[0].n;
  expect(authorized).toBeGreaterThan(0);
  expect(noIdentity).toBe(0);
});
