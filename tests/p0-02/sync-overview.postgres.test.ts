import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import { callAppRpc } from '@/lib/database/app-db';

import { appPoolFromEnv, bootstrapPoolFromInstance, loadP002InstanceEnv } from './helpers';

describe('P0-02 sync warehouse overview RPC', () => {
  let pool: Pool;
  let adminProfileId: string;

  beforeAll(async () => {
    const { envJson } = loadP002InstanceEnv();
    process.env.P0_02_ENABLED = 'true';
    for (const [key, value] of Object.entries(envJson)) {
      process.env[key] = value;
    }
    pool = appPoolFromEnv();
    const bootstrap = bootstrapPoolFromInstance();
    const client = await bootstrap.connect();
    try {
      const map = await client.query<{ ice_user_id: string }>(
        `SELECT m.ice_user_id::text
         FROM p0_02_meta.ice_auth_user_map m
         JOIN profiles p ON p.id = m.ice_user_id
         JOIN role r ON r.id = p.role_id AND r.name = 'admin'
         LIMIT 1`,
      );
      if (!map.rowCount) {
        throw new Error('fixture 缺少 admin identity map');
      }
      adminProfileId = map.rows[0]!.ice_user_id;
    } finally {
      client.release();
      await bootstrap.end();
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  it('mapped admin can call get_sync_warehouse_overview', async () => {
    const raw = await callAppRpc<unknown>(
      { profileUserId: adminProfileId },
      'public.get_sync_warehouse_overview',
      [],
    );
    expect(raw === null || Array.isArray(raw) || typeof raw === 'object').toBe(true);
  });
});
