import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';

import { externalTrackingRepository, P002_SYNC_RUNNER } from '@/features/in-transit/repository';

import { bootstrapPoolFromInstance, loadP002InstanceEnv, syncPoolFromEnv } from './helpers';

async function withSyncClient<T>(
  scope: { mode: string; warehouseId?: string },
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const pool = syncPoolFromEnv();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('p0_02.sync.mode', $1, true)`, [scope.mode]);
    await client.query(`SELECT set_config('p0_02.sync.warehouse_id', $1, true)`, [
      scope.warehouseId ?? '',
    ]);
    const result = await fn(client);
    await client.query('ROLLBACK');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw error;
  } finally {
    client.release();
  }
}

describe('P0-02 sync runner effective authorization', () => {
  let bootstrap: Pool;
  let thWarehouseId: string;
  let otherWarehouseId: string;
  let goluckyRefId: string;

  beforeAll(async () => {
    const { envJson } = loadP002InstanceEnv();
    process.env.P0_02_ENABLED = 'true';
    for (const [key, value] of Object.entries(envJson)) {
      process.env[key] = value;
    }
    bootstrap = bootstrapPoolFromInstance();
    const client = await bootstrap.connect();
    try {
      const wh = await client.query<{ id: string }>(
        `SELECT w.id::text
         FROM public.warehouse w
         JOIN public.inventory i ON i.warehouse_id = w.id
         WHERE w.country = 'TH' AND w.type = 'overseas' AND w.is_active = true
         ORDER BY w.name
         LIMIT 1`,
      );
      thWarehouseId = wh.rows[0]?.id ?? '';
      const otherWh = await client.query<{ id: string }>(
        `SELECT id::text FROM public.warehouse WHERE id <> $1::uuid LIMIT 1`,
        [thWarehouseId],
      );
      otherWarehouseId = otherWh.rows[0]?.id ?? '';
      const ref = await client.query<{ id: string }>(
        `SELECT id::text FROM public.shipment_external_ref WHERE provider = 'golucky' LIMIT 1`,
      );
      goluckyRefId = ref.rows[0]?.id ?? '';
      if (!thWarehouseId || !otherWarehouseId || !goluckyRefId) {
        throw new Error('fixture 缺少 TH 仓库、外仓或 golucky 外部引用');
      }
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await bootstrap.end();
  });

  it('sync runner without scope cannot read inventory rows', async () => {
    const count = await withSyncClient({ mode: '' }, async (client) => {
      const result = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM public.inventory`,
      );
      return Number.parseInt(result.rows[0]?.n ?? '0', 10);
    });
    expect(count).toBe(0);
  });

  it('sync runner with golucky scope reads active external refs', async () => {
    const refs = await externalTrackingRepository.getExternalRefsByProvider('golucky', P002_SYNC_RUNNER);
    expect(refs.some((row) => row.id === goluckyRefId)).toBe(true);
  });

  it('sync runner with warehouse scope reads inventory for that warehouse only', async () => {
    const scoped = await withSyncClient({ mode: 'warehouse', warehouseId: thWarehouseId }, async (client) => {
      const result = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM public.inventory WHERE warehouse_id = $1`,
        [thWarehouseId],
      );
      return Number.parseInt(result.rows[0]?.n ?? '0', 10);
    });
    expect(scoped).toBeGreaterThan(0);

    const otherWarehouse = await withSyncClient({ mode: 'warehouse', warehouseId: thWarehouseId }, async (client) => {
      const inv = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM public.inventory WHERE warehouse_id = $1::uuid`,
        [otherWarehouseId],
      );
      return Number.parseInt(inv.rows[0]?.n ?? '0', 10);
    });
    expect(otherWarehouse).toBe(0);
  });

  it('sync runner cannot read golucky refs without golucky scope', async () => {
    const count = await withSyncClient({ mode: 'warehouse', warehouseId: thWarehouseId }, async (client) => {
      const result = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM public.shipment_external_ref WHERE provider = 'golucky'`,
      );
      return Number.parseInt(result.rows[0]?.n ?? '0', 10);
    });
    expect(count).toBe(0);
  });
});
