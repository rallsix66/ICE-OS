import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import { ProfileMappingNotFoundError, resolveProfileUserId } from '@/lib/independent-platform/p0-02-tx-context';
import { callAppRpc } from '@/lib/database/app-db';

import { appPoolFromEnv, bootstrapPoolFromInstance, loadP002InstanceEnv } from './helpers';

describe('P0-02 identity resolution chain', () => {
  let pool: Pool;
  let adminProfileId: string;
  let adminAuthId: string;

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
      const map = await client.query<{ auth_user_id: string; ice_user_id: string }>(
        `SELECT m.auth_user_id, m.ice_user_id::text
         FROM p0_02_meta.ice_auth_user_map m
         JOIN profiles p ON p.id = m.ice_user_id
         JOIN role r ON r.id = p.role_id AND r.name = 'admin'
         LIMIT 1`,
      );
      if (!map.rowCount) {
        throw new Error('fixture 缺少 admin identity map');
      }
      adminAuthId = map.rows[0]!.auth_user_id;
      adminProfileId = map.rows[0]!.ice_user_id;
    } finally {
      client.release();
      await bootstrap.end();
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  it('resolveProfileUserId maps auth id to business UUID', async () => {
    const profileId = await resolveProfileUserId(adminAuthId);
    expect(profileId).toBe(adminProfileId);
  });

  it('missing mapping rejects (no auth id fallback)', async () => {
    await expect(resolveProfileUserId('nonexistent-auth-user-id')).rejects.toBeInstanceOf(ProfileMappingNotFoundError);
  });

  it('app runner cannot insert into identity map', async () => {
    const client = await pool.connect();
    try {
      await expect(
        client.query(
          `INSERT INTO p0_02_meta.ice_auth_user_map (auth_user_id, ice_user_id) VALUES ('evil', '11111111-1111-4111-8111-111111111199')`,
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      client.release();
    }
  });

  it('mapped admin can call get_warehouse_health_overview RPC', async () => {
    const overview = await callAppRpc<{ summary?: { total_quantity?: number } }>(
      { profileUserId: adminProfileId },
      'public.get_warehouse_health_overview',
      [adminProfileId],
    );
    expect(overview?.summary).toBeDefined();
  });
});
