import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';

import { appPoolFromEnv, bootstrapPoolFromInstance, loadP002InstanceEnv } from './helpers';

async function withAppIdentity<T>(
  client: PoolClient,
  profileUserId: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [
      profileUserId ?? '',
    ]);
    return await fn();
  } finally {
    await client.query('ROLLBACK');
  }
}

describe('P0-02 auth.users directory boundary', () => {
  let appPool: Pool;
  let adminProfileId: string;
  let operatorProfileId: string;

  beforeAll(() => {
    const { envJson } = loadP002InstanceEnv();
    process.env.P0_02_ENABLED = 'true';
    for (const [key, value] of Object.entries(envJson)) {
      process.env[key] = value;
    }
    appPool = appPoolFromEnv();
  });

  afterAll(async () => {
    await appPool.end();
  });

  beforeAll(async () => {
    const bootstrap = bootstrapPoolFromInstance();
    const client = await bootstrap.connect();
    try {
      const rows = await client.query<{ ice_user_id: string; role_name: string }>(
        `SELECT m.ice_user_id::text, r.name AS role_name
         FROM p0_02_meta.ice_auth_user_map m
         JOIN profiles p ON p.id = m.ice_user_id
         JOIN role r ON r.id = p.role_id
         WHERE r.name IN ('admin', 'operator')`,
      );
      for (const row of rows.rows) {
        if (row.role_name === 'admin') adminProfileId = row.ice_user_id;
        if (row.role_name === 'operator') operatorProfileId = row.ice_user_id;
      }
    } finally {
      client.release();
      await bootstrap.end();
    }
  });

  it('app runner cannot SELECT auth.users directly', async () => {
    const client = await appPool.connect();
    try {
      await withAppIdentity(client, adminProfileId, async () => {
        await expect(client.query(`SELECT id, email FROM auth.users LIMIT 1`)).rejects.toThrow(
          /permission denied|42501/i,
        );
      });
    } finally {
      client.release();
    }
  });

  it('operator runtime role cannot list directory via audited function', async () => {
    const client = await appPool.connect();
    try {
      await withAppIdentity(client, operatorProfileId, async () => {
        await expect(
          client.query(`SELECT public.get_profile_emails_for_active_admin($1::uuid[])`, [
            [adminProfileId],
          ]),
        ).rejects.toThrow(/无权限|42501|permission denied/i);
      });
    } finally {
      client.release();
    }
  });

  it('active admin can read emails via audited RPC', async () => {
    const client = await appPool.connect();
    try {
      await withAppIdentity(client, adminProfileId, async () => {
        const res = await client.query<{ j: unknown }>(
          `SELECT public.get_profile_emails_for_active_admin($1::uuid[]) AS j`,
          [[adminProfileId, operatorProfileId]],
        );
        const payload = res.rows[0]?.j;
        const rows = Array.isArray(payload) ? payload : JSON.parse(String(payload));
        expect(rows.length).toBeGreaterThanOrEqual(2);
      });
    } finally {
      client.release();
    }
  });

  it('missing identity cannot read directory', async () => {
    const client = await appPool.connect();
    try {
      await withAppIdentity(client, null, async () => {
        await expect(
          client.query(`SELECT public.get_profile_emails_for_active_admin($1::uuid[])`, [
            [adminProfileId],
          ]),
        ).rejects.toThrow(/未登录|42501|permission denied/i);
      });
    } finally {
      client.release();
    }
  });
});
