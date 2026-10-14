import 'server-only';

import type { PoolClient } from 'pg';

import { getP001AppPool } from './p0-01-app-pool';

export type IceTransactionIdentity = {
  iceUserId: string;
};

export async function withIceTransaction<T>(
  identity: IceTransactionIdentity,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const pool = getP001AppPool();
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('ice.user_id', $1, true)`, [identity.iceUserId]);
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
