import 'server-only';

import { Pool } from 'pg';

import { requireP002Config } from './p0-02-config';

let appPool: Pool | null = null;
let syncPool: Pool | null = null;

export function getP002AppPool(): Pool {
  const config = requireP002Config();
  if (!appPool) {
    appPool = new Pool({
      connectionString: config.appDatabaseUrl,
      max: config.poolMax,
      idleTimeoutMillis: 5_000,
      connectionTimeoutMillis: 5_000,
    });
  }
  return appPool;
}

export function getP002SyncPool(): Pool {
  const config = requireP002Config();
  if (!syncPool) {
    syncPool = new Pool({
      connectionString: config.syncDatabaseUrl,
      max: Math.min(config.poolMax, 5),
      idleTimeoutMillis: 5_000,
      connectionTimeoutMillis: 5_000,
    });
  }
  return syncPool;
}

export async function closeP002Pools(): Promise<void> {
  if (appPool) {
    await appPool.end();
    appPool = null;
  }
  if (syncPool) {
    await syncPool.end();
    syncPool = null;
  }
}
