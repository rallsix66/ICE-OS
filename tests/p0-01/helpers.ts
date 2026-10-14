import fs from 'node:fs';
import path from 'node:path';

import { Pool, type PoolClient } from 'pg';

export function loadInstanceEnv(): {
  runId: string;
  appUrl: string;
  authUrl: string;
  dbName: string;
  port: number;
  host: string;
  appRunnerPassword: string;
  authRunnerPassword: string;
  bootstrapPassword: string;
  appRunnerUser: string;
  authRunnerUser: string;
} {
  const runId = process.env.P0_01_RUN_ID ?? 'run-20261013-r1';
  const instancePath = path.join(process.cwd(), '.local', 'p0-01', runId, 'instance.json');
  if (!fs.existsSync(instancePath)) {
    throw new Error(`缺少实例: ${instancePath}`);
  }
  const instance = JSON.parse(fs.readFileSync(instancePath, 'utf8')) as {
    runId: string;
    host: string;
    port: number;
    dbName: string;
    appRunnerPassword: string;
    authRunnerPassword: string;
    bootstrapPassword: string;
    appRunnerUser: string;
    authRunnerUser: string;
  };
  if (instance.runId !== runId) {
    throw new Error('P0_01_RUN_ID 与实例记录不一致');
  }
  return {
    runId,
    host: instance.host,
    port: instance.port,
    dbName: instance.dbName,
    appRunnerPassword: instance.appRunnerPassword,
    authRunnerPassword: instance.authRunnerPassword,
    bootstrapPassword: instance.bootstrapPassword,
    appRunnerUser: instance.appRunnerUser ?? 'ice_p0_01_app_runner',
    authRunnerUser: instance.authRunnerUser ?? 'ice_p0_01_auth_runner',
    appUrl: process.env.P0_01_APP_DATABASE_URL!,
    authUrl: process.env.P0_01_AUTH_DATABASE_URL!,
  };
}

export async function assertInstanceMarker(client: PoolClient, runId: string): Promise<void> {
  const result = await client.query<{ run_id: string }>(
    `SELECT run_id FROM p0_01_meta.platform_instance WHERE run_id = $1`,
    [runId],
  );
  if (result.rowCount !== 1) {
    throw new Error('platform_instance 标记不匹配');
  }
}

export function createAppPool(max = 1): Pool {
  const url = process.env.P0_01_APP_DATABASE_URL;
  if (!url) {
    throw new Error('缺少 P0_01_APP_DATABASE_URL');
  }
  return new Pool({ connectionString: url, max });
}

export async function withIdentity<T>(
  client: PoolClient,
  iceUserId: string,
  fn: () => Promise<T>,
): Promise<T> {
  await client.query('BEGIN');
  await client.query(`SELECT set_config('ice.user_id', $1, true)`, [iceUserId]);
  try {
    const value = await fn();
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export const FIXTURE = {
  admin: '11111111-1111-4111-8111-111111111101',
  manager: '11111111-1111-4111-8111-111111111102',
  managerNoAmount: '11111111-1111-4111-8111-111111111103',
  operator: '11111111-1111-4111-8111-111111111104',
};

