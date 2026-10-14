import 'server-only';

import type { Pool, PoolClient } from 'pg';

import { getP002AppPool, getP002SyncPool } from './p0-02-pools';

export type IceDbIdentity = {
  /** Business profile UUID used by auth.uid() in legacy RPC/RLS. */
  profileUserId: string;
};

export class ProfileMappingNotFoundError extends Error {
  constructor(authUserId: string) {
    super(`身份映射缺失: ${authUserId}`);
    this.name = 'ProfileMappingNotFoundError';
  }
}

async function withIdentityOnClient<T>(
  client: PoolClient,
  identity: IceDbIdentity | null,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  let broken = false;
  try {
    await client.query('BEGIN');
    if (identity?.profileUserId) {
      await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [identity.profileUserId]);
    } else {
      await client.query(`SELECT set_config('request.jwt.claim.sub', '', true)`);
    }
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      broken = true;
    }
    throw error;
  } finally {
    if (broken) {
      client.release(true);
    } else {
      client.release();
    }
  }
}

export async function withP002AppTransaction<T>(
  identity: IceDbIdentity | null,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const pool = getP002AppPool();
  const client = await pool.connect();
  return withIdentityOnClient(client, identity, fn);
}

export async function withP002SyncTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const pool = getP002SyncPool();
  const client = await pool.connect();
  return withIdentityOnClient(client, null, fn);
}

export async function resolveProfileUserId(authUserId: string, client?: PoolClient): Promise<string> {
  const sql = `SELECT p0_02_meta.resolve_profile_user_id($1) AS ice_user_id`;
  const runQuery = async (c: PoolClient) => {
    const result = await c.query<{ ice_user_id: string | null }>(sql, [authUserId]);
    const mapped = result.rows[0]?.ice_user_id;
    if (!mapped) {
      throw new ProfileMappingNotFoundError(authUserId);
    }
    return mapped;
  };

  if (client) {
    return runQuery(client);
  }
  return withP002AppTransaction(null, runQuery);
}

export function poolForMode(mode: 'app' | 'sync'): Pool {
  return mode === 'sync' ? getP002SyncPool() : getP002AppPool();
}
