import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { pgExe, withHiddenWindowsSpawnOptions } from './common.mjs';

export const FIXTURE_USER_IDS = [
  '11111111-1111-4111-8111-111111111101',
  '11111111-1111-4111-8111-111111111102',
  '11111111-1111-4111-8111-111111111103',
  '11111111-1111-4111-8111-111111111104',
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

function psqlExecFile(instance, sqlBody, { singleTransaction = false } = {}) {
  const tmpFile = path.join(os.tmpdir(), `iceos-p0-02-fixture-${process.pid}-${Date.now()}.sql`);
  fs.writeFileSync(tmpFile, sqlBody, 'utf8');
  try {
    const args = [
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
    ];
    if (singleTransaction) {
      args.push('-1');
    }
    args.push('-f', tmpFile);
    const result = spawnSync(
      pgExe('psql', instance.runId),
      args,
      withHiddenWindowsSpawnOptions({
        encoding: 'utf8',
        env: { PGPASSWORD: instance.bootstrapPassword },
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
    if (result.status !== 0) {
      const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
      throw new Error(detail || 'psql exec failed');
    }
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // ignore
    }
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
  if (typeof value === 'object') {
    return `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

function captureInventoryRows(instance) {
  return psqlJson(
    instance,
    `SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM (
       SELECT * FROM public.inventory ORDER BY id
     ) t`,
  );
}

/** Snapshot only inventory rows (write-test scope). */
export function captureInventoryFixture(instance) {
  return { inventory: captureInventoryRows(instance) };
}

function insertInventoryRowSql(row) {
  const columns = Object.keys(row);
  const values = columns.map((col) => sqlLiteral(row[col]));
  return `INSERT INTO public.inventory (${columns.join(', ')}) VALUES (${values.join(', ')});`;
}

/**
 * Restore only inventory to a prior snapshot (single transaction).
 * Does not delete product_variant / profiles — avoids SET NULL on shipment_external_item.matched_variant_id.
 */
export function restoreInventoryFixture(instance, snapshot) {
  const rows = snapshot.inventory ?? [];
  const ids = rows.map((r) => sqlLiteral(r.id)).join(', ');
  const statements = [];
  if (ids.length > 0) {
    statements.push(`DELETE FROM public.inventory WHERE id IN (${ids});`);
  } else {
    statements.push('DELETE FROM public.inventory WHERE true;');
  }
  for (const row of rows) {
    statements.push(insertInventoryRowSql(row));
  }
  psqlExecFile(instance, statements.join('\n'), { singleTransaction: true });
  const after = captureInventoryRows(instance);
  if (JSON.stringify(after) !== JSON.stringify(rows)) {
    throw new Error('inventory fixture 恢复后与快照不一致');
  }
}

/** @deprecated Use captureInventoryFixture or captureFixtureIntegrity. */
export function captureBizFixture(instance) {
  return captureInventoryFixture(instance);
}

/** @deprecated Use restoreInventoryFixture. */
export function restoreBizFixture(instance, snapshot) {
  const normalized =
    snapshot.inventory !== undefined
      ? snapshot
      : { inventory: snapshot.tables?.['public.inventory'] ?? [] };
  return restoreInventoryFixture(instance, normalized);
}
