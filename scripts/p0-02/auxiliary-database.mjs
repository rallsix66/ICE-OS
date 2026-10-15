import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { pgExe, runRoot, withHiddenWindowsSpawnOptions } from './common.mjs';

const REGISTRY_NAME = 'auxiliary-databases.json';

function registryPath(runId) {
  return path.join(runRoot(runId), REGISTRY_NAME);
}

function readRegistry(runId) {
  const file = registryPath(runId);
  if (!fs.existsSync(file)) {
    return { entries: [] };
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeRegistry(runId, registry) {
  fs.mkdirSync(runRoot(runId), { recursive: true });
  fs.writeFileSync(registryPath(runId), `${JSON.stringify(registry, null, 2)}\n`);
}

function psqlAdmin(instance, runId, sqlText) {
  return spawnSync(
    pgExe('psql', runId),
    [
      '-h',
      instance.host,
      '-p',
      String(instance.port),
      '-U',
      instance.bootstrapUser,
      '-d',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
      '-tA',
      '-c',
      sqlText,
    ],
    withHiddenWindowsSpawnOptions({
      encoding: 'utf8',
      env: { PGPASSWORD: instance.bootstrapPassword },
    }),
  );
}

/** 登记并创建本次 run 独占辅助库；名称碰撞或未登记则拒绝。 */
export function allocateAuxiliaryDatabase(runId, purpose, instance) {
  const safePurpose = purpose.replace(/[^a-z0-9_]+/gi, '_').slice(0, 24);
  const token = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const dbName = `iceos_p0_02_${runId.replace(/-/g, '_')}_${safePurpose}_${token}`.slice(0, 63);

  const exists = psqlAdmin(
    instance,
    runId,
    `SELECT 1 FROM pg_database WHERE datname = '${dbName.replace(/'/g, "''")}'`,
  );
  if ((exists.stdout ?? '').trim() === '1') {
    throw new Error(`辅助库名称已存在，拒绝创建: ${dbName}`);
  }

  const registry = readRegistry(runId);
  if (registry.entries.some((e) => e.dbName === dbName)) {
    throw new Error(`辅助库登记碰撞: ${dbName}`);
  }

  const create = psqlAdmin(instance, runId, `CREATE DATABASE ${dbName};`);
  if (create.status !== 0) {
    throw new Error(create.stderr || create.stdout || `CREATE DATABASE failed: ${dbName}`);
  }

  const entry = {
    dbName,
    purpose: safePurpose,
    createdAt: new Date().toISOString(),
    sourceDb: instance.dbName,
  };
  registry.entries.push(entry);
  writeRegistry(runId, registry);
  return entry;
}

export function dropAuxiliaryDatabase(runId, instance, dbName, { mustBeRegistered = true } = {}) {
  const registry = readRegistry(runId);
  const entry = registry.entries.find((e) => e.dbName === dbName);
  if (mustBeRegistered && !entry) {
    throw new Error(`拒绝删除未登记的辅助库: ${dbName}`);
  }
  if (dbName === instance.dbName) {
    throw new Error(`拒绝删除 canonical 实例库: ${dbName}`);
  }
  const drop = psqlAdmin(instance, runId, `DROP DATABASE IF EXISTS ${dbName};`);
  if (drop.status !== 0) {
    throw new Error(drop.stderr || drop.stdout || `DROP DATABASE failed: ${dbName}`);
  }
  registry.entries = registry.entries.filter((e) => e.dbName !== dbName);
  writeRegistry(runId, registry);
}

export function assertDatabaseRegistered(runId, dbName) {
  const registry = readRegistry(runId);
  if (!registry.entries.some((e) => e.dbName === dbName)) {
    throw new Error(`辅助库未登记: ${dbName}`);
  }
}
