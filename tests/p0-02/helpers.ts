import fs from 'node:fs';
import path from 'node:path';

import { Pool, type PoolClient } from 'pg';

export function loadP002InstanceEnv() {
  const runId = process.env.P0_02_RUN_ID ?? 'run-20261014-r2';
  const instancePath = path.join(process.cwd(), '.local', 'p0-02', runId, 'instance.json');
  if (!fs.existsSync(instancePath)) {
    throw new Error(`缺少实例: ${instancePath}`);
  }
  const instance = JSON.parse(fs.readFileSync(instancePath, 'utf8')) as {
    runId: string;
    host: string;
    port: number;
    dbName: string;
    appRunnerPassword: string;
    syncRunnerPassword: string;
    bootstrapPassword: string;
    appRunnerUser: string;
    syncRunnerUser: string;
    authRunnerUser: string;
  };
  if (instance.runId !== runId) {
    throw new Error('P0_02_RUN_ID 与实例记录不一致');
  }
  const envPath = path.join(process.cwd(), '.local', 'p0-02', runId, 'env.p0-02.json');
  const envJson = JSON.parse(fs.readFileSync(envPath, 'utf8')) as Record<string, string>;
  return { runId, instance, envJson };
}

export function appPoolFromEnv(): Pool {
  const { envJson } = loadP002InstanceEnv();
  return new Pool({
    connectionString: envJson.P0_02_APP_DATABASE_URL,
    max: 2,
  });
}

export function syncPoolFromEnv(): Pool {
  const { envJson } = loadP002InstanceEnv();
  return new Pool({
    connectionString: envJson.P0_02_SYNC_DATABASE_URL,
    max: 2,
  });
}

export function bootstrapPoolFromInstance(): Pool {
  const { instance } = loadP002InstanceEnv();
  return new Pool({
    host: instance.host,
    port: instance.port,
    database: instance.dbName,
    user: instance.bootstrapUser,
    password: instance.bootstrapPassword,
    max: 1,
  });
}

export async function hasFunctionPrivilege(
  client: PoolClient,
  role: string,
  signature: string,
): Promise<boolean> {
  const result = await client.query<{ ok: boolean }>(
    `SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`,
    [role, signature],
  );
  return result.rows[0]?.ok === true;
}
