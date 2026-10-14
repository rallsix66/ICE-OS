import { spawnSync } from 'node:child_process';

import { pgExe, withHiddenWindowsSpawnOptions } from './common.mjs';

export const FIXTURE_USER_IDS = [
  '11111111-1111-4111-8111-111111111101',
  '11111111-1111-4111-8111-111111111102',
  '11111111-1111-4111-8111-111111111103',
  '11111111-1111-4111-8111-111111111104',
];

const BIZ_TABLES = [
  'markets',
  'warehouses',
  'products',
  'product_variants',
  'ice_users',
  'ice_auth_user_map',
  'user_market_grants',
  'user_warehouse_grants',
  'user_amount_grants',
  'inventory',
  'inventory_unit_costs',
];

function psqlJson(instance, sql) {
  const result = spawnSync(
    pgExe('psql', instance.runId),
    [
      '-h',
      instance.host,
      '-p',
      String(instance.port),
      '-U',
      instance.bootstrapUser,
      '-d',
      instance.dbName,
      '-tA',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      sql,
    ],
    withHiddenWindowsSpawnOptions({
      encoding: 'utf8',
      env: { PGPASSWORD: instance.bootstrapPassword },
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'psql json failed');
  }
  const text = (result.stdout ?? '').trim();
  if (!text || text === 'null') {
    return [];
  }
  return JSON.parse(text);
}

function psqlExec(instance, sql) {
  const result = spawnSync(
    pgExe('psql', instance.runId),
    [
      '-h',
      instance.host,
      '-p',
      String(instance.port),
      '-U',
      instance.bootstrapUser,
      '-d',
      instance.dbName,
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      sql,
    ],
    withHiddenWindowsSpawnOptions({
      encoding: 'utf8',
      env: { PGPASSWORD: instance.bootstrapPassword },
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'psql exec failed');
  }
}

function sqlLiteral(value) {
  if (value === null || value === undefined) {
    return 'NULL';
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : 'NULL';
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

function captureTable(instance, table) {
  return psqlJson(
    instance,
    `SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM (
       SELECT * FROM p0_01_biz.${table}
       ORDER BY 1
     ) t`,
  );
}

export function captureBizFixture(instance) {
  const tables = {};
  for (const table of BIZ_TABLES) {
    tables[table] = captureTable(instance, table);
  }
  return { tables };
}

function deleteBizSeedTables(instance) {
  psqlExec(
    instance,
    `DELETE FROM p0_01_biz.user_amount_grants;
     DELETE FROM p0_01_biz.user_warehouse_grants;
     DELETE FROM p0_01_biz.user_market_grants;
     DELETE FROM p0_01_biz.inventory_unit_costs;
     DELETE FROM p0_01_biz.inventory;
     DELETE FROM p0_01_biz.ice_auth_user_map;
     DELETE FROM p0_01_biz.ice_users;
     DELETE FROM p0_01_biz.product_variants;
     DELETE FROM p0_01_biz.products;
     DELETE FROM p0_01_biz.warehouses;
     DELETE FROM p0_01_biz.markets;`,
  );
}

function insertRow(instance, table, row) {
  const columns = Object.keys(row);
  const values = columns.map((col) => sqlLiteral(row[col]));
  psqlExec(
    instance,
    `INSERT INTO p0_01_biz.${table} (${columns.join(', ')}) VALUES (${values.join(', ')})`,
  );
}

export function restoreBizFixture(instance, snapshot) {
  deleteBizSeedTables(instance);
  for (const table of BIZ_TABLES) {
    for (const row of snapshot.tables[table] ?? []) {
      insertRow(instance, table, row);
    }
  }
  const after = captureBizFixture(instance);
  if (JSON.stringify(after) !== JSON.stringify(snapshot)) {
    throw new Error('业务 fixture 恢复后与快照不一致');
  }
}
