import 'server-only';

import type { PoolClient, QueryResultRow } from 'pg';

import { getP002AppPool, getP002SyncPool } from '@/lib/independent-platform/p0-02-pools';

export type DbIdentity = { profileUserId: string };

async function withTransactionOnPool<T>(
  pool: ReturnType<typeof getP002AppPool>,
  identity: DbIdentity | null,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
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

export async function withAppDb<T>(
  identity: DbIdentity | null,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withTransactionOnPool(getP002AppPool(), identity, fn);
}

export type SyncDbScope =
  | { mode: 'golucky' }
  | { mode: 'warehouse'; warehouseId: string }
  | { mode: 'discover' };

async function applySyncScope(client: PoolClient, scope?: SyncDbScope): Promise<void> {
  const mode = scope?.mode ?? '';
  await client.query(`SELECT set_config('p0_02.sync.mode', $1, true)`, [mode]);
  const warehouseId = scope?.mode === 'warehouse' ? scope.warehouseId : '';
  await client.query(`SELECT set_config('p0_02.sync.warehouse_id', $1, true)`, [warehouseId]);
}

export async function withSyncDb<T>(
  fn: (client: PoolClient) => Promise<T>,
  scope?: SyncDbScope,
): Promise<T> {
  return withTransactionOnPool(getP002SyncPool(), null, async (client) => {
    await applySyncScope(client, scope);
    return fn(client);
  });
}

export async function queryAppRows<T extends QueryResultRow>(
  identity: DbIdentity | null,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return withAppDb(identity, async (client) => {
    const result = await client.query<T>(sql, params);
    return result.rows;
  });
}

export async function callAppRpc<T>(
  identity: DbIdentity,
  functionSpec: string,
  params: unknown[],
): Promise<T> {
  const placeholders = params.map((_, i) => `$${i + 1}`).join(', ');
  const sql =
    params.length > 0
      ? `SELECT ${functionSpec}(${placeholders}) AS result`
      : `SELECT ${functionSpec}() AS result`;
  const rows = await queryAppRows<{ result: T }>(identity, sql, params);
  return rows[0]?.result as T;
}

export async function querySyncRows<T extends QueryResultRow>(
  sql: string,
  params: unknown[] = [],
  scope?: SyncDbScope,
): Promise<T[]> {
  return withSyncDb(async (client) => {
    const result = await client.query<T>(sql, params);
    return result.rows;
  }, scope);
}

export async function callSyncRpc<T>(
  functionSpec: string,
  params: unknown[],
  scope?: SyncDbScope,
): Promise<T> {
  const placeholders = params.map((_, i) => `$${i + 1}`).join(', ');
  const sql =
    params.length > 0
      ? `SELECT ${functionSpec}(${placeholders}) AS result`
      : `SELECT ${functionSpec}() AS result`;
  const rows = await querySyncRows<{ result: T }>(sql, params, scope);
  return rows[0]?.result as T;
}
