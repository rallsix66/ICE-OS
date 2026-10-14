import { spawnSync } from 'node:child_process';

import { pgExe, withHiddenWindowsSpawnOptions } from './common.mjs';

/** Read-only integrity tables for postgres/http runners (no destructive restore). */
export const INTEGRITY_TABLES = [
  { schema: 'public', table: 'user_warehouses', orderBy: 'user_id, warehouse_id' },
  { schema: 'public', table: 'user_variant_preference' },
  { schema: 'public', table: 'warehouse' },
  { schema: 'public', table: 'product' },
  { schema: 'public', table: 'product_variant' },
  { schema: 'public', table: 'inventory' },
  { schema: 'public', table: 'profiles' },
  { schema: 'p0_02_meta', table: 'ice_auth_user_map' },
];

/** Sync evidence tables — compared on postgres runners that include lifecycle tests. */
export const SYNC_INTEGRITY_TABLES = [
  { schema: 'public', table: 'sync_run', orderBy: 'id' },
  { schema: 'public', table: 'sync_log', orderBy: 'id' },
  { schema: 'public', table: 'sync_warehouse_lock', orderBy: 'warehouse_id' },
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

function tableKey(entry) {
  return `${entry.schema}.${entry.table}`;
}

export function captureLogisticsSkuBindings(instance) {
  return psqlJson(
    instance,
    `SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM (
       SELECT id::text, external_sku, matched_variant_id::text
       FROM public.shipment_external_item
       WHERE matched_variant_id IS NOT NULL
       ORDER BY id
     ) t`,
  );
}

export function captureFixtureIntegrity(instance, { includeSync = false } = {}) {
  const tables = {};
  const rowCounts = {};
  const entries = includeSync ? [...INTEGRITY_TABLES, ...SYNC_INTEGRITY_TABLES] : INTEGRITY_TABLES;
  for (const entry of entries) {
    const key = tableKey(entry);
    const orderBy = entry.orderBy ?? '1';
    tables[key] = psqlJson(
      instance,
      `SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM (
         SELECT * FROM ${entry.schema}.${entry.table}
         ORDER BY ${orderBy}
       ) t`,
    );
    rowCounts[key] = tables[key].length;
  }
  return {
    capturedAt: new Date().toISOString(),
    tables,
    rowCounts,
    logisticsSkuBindings: captureLogisticsSkuBindings(instance),
  };
}

function normalizeUserWarehouseRow(row) {
  const copy = { ...row };
  delete copy.created_at;
  return copy;
}

function sortUserWarehouses(rows) {
  return [...rows].map(normalizeUserWarehouseRow).sort((a, b) => {
    const uid = String(a.user_id).localeCompare(String(b.user_id));
    if (uid !== 0) {
      return uid;
    }
    return String(a.warehouse_id).localeCompare(String(b.warehouse_id));
  });
}

function tablesForStableCompare(tables) {
  const clone = structuredClone(tables);
  for (const row of clone['public.profiles'] ?? []) {
    delete row.updated_at;
  }
  if (clone['public.user_warehouses']) {
    clone['public.user_warehouses'] = sortUserWarehouses(clone['public.user_warehouses']);
  }
  return clone;
}

function tableRowsEqual(key, beforeRows, afterRows) {
  if (key === 'public.user_warehouses') {
    return JSON.stringify(sortUserWarehouses(beforeRows)) === JSON.stringify(sortUserWarehouses(afterRows));
  }
  return JSON.stringify(beforeRows) === JSON.stringify(afterRows);
}

export function assertFixtureIntegrityUnchanged(before, after) {
  if (JSON.stringify(before.logisticsSkuBindings) !== JSON.stringify(after.logisticsSkuBindings)) {
    throw new Error(
      `物流 SKU 绑定在 runner 前后不一致: ${JSON.stringify(before.logisticsSkuBindings)} -> ${JSON.stringify(after.logisticsSkuBindings)}`,
    );
  }
  const beforeJson = JSON.stringify(tablesForStableCompare(before.tables));
  const afterJson = JSON.stringify(tablesForStableCompare(after.tables));
  if (beforeJson !== afterJson) {
    const diffs = [];
    for (const key of Object.keys(before.tables)) {
      const b = before.rowCounts[key] ?? 0;
      const a = after.rowCounts[key] ?? 0;
      const rowsEqual = tableRowsEqual(key, before.tables[key] ?? [], after.tables[key] ?? []);
      if (b !== a || !rowsEqual) {
        diffs.push(`${key}: rows ${b} -> ${a}`);
      }
    }
    throw new Error(`fixture 完整性校验失败（runner 不得修改业务数据）: ${diffs.join('; ')}`);
  }
}

/** Seed contract row counts used to detect accidental empty grants after bad restore. */
export function assertMinimumSeedFixture(instance, integrity) {
  const whGrants = integrity.rowCounts['public.user_warehouses'] ?? 0;
  const profiles = integrity.rowCounts['public.profiles'] ?? 0;
  const logisticsBindings = integrity.logisticsSkuBindings?.length ?? 0;
  if (logisticsBindings < 1) {
    throw new Error(
      '缺少非空物流 SKU 绑定（shipment_external_item.matched_variant_id）。请运行 seed.mjs 或 repair-seed-fixture.mjs。',
    );
  }
  if (profiles >= 2 && whGrants < 2) {
    throw new Error(
      `operator 仓库授权缺失（当前 user_warehouses=${whGrants}，seed 期望 ≥2）。` +
        '可能由历史 fixture 全表清理 CASCADE 导致；请运行 scripts/p0-02/repair-seed-fixture.mjs 并记录 recovery。',
    );
  }
}
