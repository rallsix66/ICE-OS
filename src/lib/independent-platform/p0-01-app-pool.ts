import 'server-only';

import { Pool } from 'pg';

import { requireP001Config } from './p0-01-config';

let pool: Pool | null = null;

export function getP001AppPool(): Pool {
  const config = requireP001Config();
  if (!pool) {
    pool = new Pool({
      connectionString: config.appDatabaseUrl,
      max: config.poolMax,
      idleTimeoutMillis: 5_000,
      connectionTimeoutMillis: 5_000,
    });
  }
  return pool;
}

export async function closeP001AppPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
