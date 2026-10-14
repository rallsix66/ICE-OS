import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import { goluckyImportResultSchema } from '@/features/in-transit/schema';

import { appPoolFromEnv, bootstrapPoolFromInstance, loadP002InstanceEnv } from './helpers';

describe('P0-02 import_golucky_refs jsonb parameter', () => {
  let bootstrap: Pool;
  let appPool: Pool;
  let adminProfileId: string;
  let thWarehouseId: string;

  beforeAll(async () => {
    const { envJson } = loadP002InstanceEnv();
    process.env.P0_02_ENABLED = 'true';
    for (const [key, value] of Object.entries(envJson)) {
      process.env[key] = value;
    }
    bootstrap = bootstrapPoolFromInstance();
    appPool = appPoolFromEnv();
    const client = await bootstrap.connect();
    try {
      const map = await client.query<{ ice_user_id: string }>(
        `SELECT m.ice_user_id::text
         FROM p0_02_meta.ice_auth_user_map m
         JOIN profiles p ON p.id = m.ice_user_id
         JOIN role r ON r.id = p.role_id AND r.name = 'admin'
         LIMIT 1`,
      );
      adminProfileId = map.rows[0]?.ice_user_id ?? '';
      const wh = await client.query<{ id: string }>(
        `SELECT id::text FROM public.warehouse WHERE country = 'TH' AND type = 'overseas' LIMIT 1`,
      );
      thWarehouseId = wh.rows[0]?.id ?? '';
      if (!adminProfileId || !thWarehouseId) {
        throw new Error('fixture 缺少 admin 或 TH 仓库');
      }
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await bootstrap.end();
    await appPool.end();
  });

  it('admin bulk import succeeds when p_items is JSON text (transaction rolled back)', async () => {
    const waybill = `WB-P0-02-JSONB-${Date.now()}`;
    const pItems = [
      {
        waybill_no: waybill,
        warehouse_id: thWarehouseId,
        country: 'TH',
        external_order_no: 'PO-JSONB-TEST',
      },
    ];
    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [adminProfileId]);
      const raw = await client.query<{ result: unknown }>(
        `SELECT public.import_golucky_refs($1::jsonb) AS result`,
        [JSON.stringify(pItems)],
      );
      const parsed = goluckyImportResultSchema.safeParse(raw.rows[0]?.result);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.succeeded).toBe(1);
        expect(parsed.data.failed).toHaveLength(0);
      }
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});
