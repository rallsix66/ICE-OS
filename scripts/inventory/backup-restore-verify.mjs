/**
 * One backup/restore drill for this package's database + downloaded export files.
 *
 * 1. pg_dump the whole isolated database into .local/catalog/<run>/backup/
 * 2. createdb a scratch database, restore the dump, compare per-table counts and a content
 *    fingerprint of the inventory tables (runs / batches / batch rows / current pointers / receipts)
 * 3. copy the latest exported workbook, verify the sha256, then remove the scratch database
 *
 * Repair v3 F5.2: when this drill paused the instance worker, a failed restart is a hard failure.
 * The evidence/summary reports backup consistency (backupTablesEqual / backupExportOk) separately from
 * worker recovery (workerPaused / workerRestarted / workerRestartError); a paused-but-not-restarted
 * worker makes `evidence.ok=false` and the process exit 1. Backup errors are recorded and the worker is
 * still restarted in the same finally before the evidence is written.
 *
 * It never touches the 3011/3021/3022/3031/3032 instances: every command targets this run's own cluster.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT, openRun, readArgs, writeJson } from '../catalog/prepare.mjs';
import { assertConnectedTarget, assertWritableTestTarget } from './test-target-guard.mjs';

const INVENTORY_TABLES = [
  'catalog.inventory_source_account',
  'catalog.inventory_warehouse',
  'catalog.inventory_scope',
  'catalog.inventory_sync_settings',
  'catalog.inventory_sync_run',
  'catalog.inventory_export_file',
  'catalog.inventory_run_row',
  'catalog.inventory_sync_settings',
  'catalog.inventory_batch',
  'catalog.inventory_batch_row',
  'catalog.inventory_current',
  'catalog.inventory_warehouse_state',
  'catalog.inventory_scope_state',
  'catalog.inventory_request',
  'catalog.inventory_audit',
  'catalog.inventory_worker',
  'catalog.inventory_variant',
  'catalog.inventory_sku_mapping',
  'catalog.inventory_mapping_candidate',
  'catalog.inventory_pending_action',
  'catalog.inventory_schema_state',
  'catalog_private.inventory_run_row_amount',
];

function run(command, args, env = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 128 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) {
    throw new Error(`COMMAND_FAILED:${path.basename(command)}:${result.status}:${(result.stderr || result.stdout || '').slice(0, 500)}`);
  }
  return result.stdout;
}

const args = readArgs(process.argv.slice(2));
const run_ = openRun(args);
const inventoryEnv = JSON.parse(fs.readFileSync(path.join(run_.instanceRoot, 'env.inventory.json'), 'utf8'));
// Writes a scratch database and stops/starts the instance worker: refuse protected/delivered targets
// before any connection is opened (F5.3).
const guard = assertWritableTestTarget({ instanceRoot: run_.instanceRoot, runId: args.runId, instance: run_.instance, env: inventoryEnv, purpose: 'backup-restore-verify' });
const backupDir = path.join(run_.root, 'backup');
fs.mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dumpFile = path.join(backupDir, `inventory-db-${stamp}.sql`);
const scratchDb = `iceos_inventory_restore_${stamp.replace(/[^a-z0-9]/gi, '_').toLowerCase()}`;
const bin = run_.instance.pgBinDir;
const { default: pg } = await import('pg');
const evidence = {
  runId: args.runId,
  startedAt: new Date().toISOString(),
  dumpFile,
  scratchDb,
  tables: {},
  workerPaused: false,
  workerRestarted: null,
  workerRestartError: null,
  backupTablesEqual: false,
  backupExportOk: null,
};

const pgEnv = { PGPASSWORD: run_.instance.bootstrapPassword };
const common = ['-h', run_.instance.host, '-p', String(run_.instance.port), '-U', run_.instance.bootstrapUser];

// A backup/restore drill needs a write-quiet database: the worker heartbeat (and any finishing run)
// would otherwise change rows between the dump and the restore comparison. The drill therefore pauses
// this instance's own worker after any active run finishes and restarts it in `finally`.
const workerMarkerPath = path.join(run_.instanceRoot, 'inventory-worker.pid.json');
function workerAlive() {
  try {
    const marker = JSON.parse(fs.readFileSync(workerMarkerPath, 'utf8'));
    process.kill(marker.pid, 0);
    return marker;
  } catch {
    return null;
  }
}

let workerPaused = false;
let backupError = null;
try {
  const workerBefore = workerAlive();
  if (workerBefore) {
    const { default: pgQuiet } = await import('pg');
    const quiet = new pgQuiet.Client({ connectionString: inventoryEnv.ownerDbUrl });
    await quiet.connect();
    await assertConnectedTarget(quiet, guard, 'backup-restore-verify quiet-owner');
    try {
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const active = Number((await quiet.query(
          `SELECT count(*)::integer AS n FROM catalog.inventory_sync_run
           WHERE status IN ('queued','running','downloading','parsing','publishing','outcome_unknown')`)).rows[0].n);
        if (active === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    } finally {
      await quiet.end();
    }
    const stop = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts/inventory/stop-worker.mjs'), '--run-id', args.runId], {
      encoding: 'utf8', windowsHide: true, env: process.env,
    });
    workerPaused = stop.status === 0;
    if (!workerPaused) throw new Error(`BACKUP_WORKER_PAUSE_FAILED:${stop.status}:${(stop.stderr || '').slice(0, 300)}`);
    evidence.workerPausedDetail = { pid: workerBefore.pid, stopped: true };
  }

  run(path.join(bin, 'pg_dump.exe'), [...common, '-d', run_.instance.dbName, '-f', dumpFile], pgEnv);
  const dumpSize = fs.statSync(dumpFile).size;
  evidence.dump = { bytes: dumpSize, sha256: crypto.createHash('sha256').update(fs.readFileSync(dumpFile)).digest('hex') };

  run(path.join(bin, 'createdb.exe'), [...common, scratchDb], pgEnv);
  run(path.join(bin, 'psql.exe'), [...common, '-d', scratchDb, '-q', '-v', 'ON_ERROR_STOP=1', '-f', dumpFile], pgEnv);

  const original = new pg.Client({ connectionString: inventoryEnv.ownerDbUrl });
  const restoredUrl = `postgres://${run_.instance.bootstrapUser}:${run_.instance.bootstrapPassword}@${run_.instance.host}:${run_.instance.port}/${scratchDb}`;
  const restored = new pg.Client({ connectionString: restoredUrl });
  await original.connect();
  await assertConnectedTarget(original, guard, 'backup-restore-verify original-owner');
  await restored.connect();
  // The restored client deliberately reads the scratch copy created by this drill (read-only compare);
  // the server host/port are still verified, and only that exact scratch database name is allowed.
  await assertConnectedTarget(restored, guard, 'backup-restore-verify restored-scratch', {
    allowDatabaseNames: [scratchDb],
  });
  try {
    for (const table of [...new Set(INVENTORY_TABLES)]) {
      const fingerprint = async (client) => {
        const count = Number((await client.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
        const digest = (await client.query(
          `SELECT coalesce(md5(string_agg(row_to_json(t)::text, '|' ORDER BY row_to_json(t)::text)), 'empty') AS h
           FROM ${table} t`)).rows[0].h;
        return { count, digest };
      };
      const before = await fingerprint(original);
      const after = await fingerprint(restored);
      evidence.tables[table] = { original: before, restored: after, equal: before.count === after.count && before.digest === after.digest };
    }
  } finally {
    await original.end();
    await restored.end();
  }

  // Downloaded workbook backup check (the latest export registered by the worker).
  const fileRow = (await (async () => {
    const client = new pg.Client({ connectionString: inventoryEnv.ownerDbUrl });
    await client.connect();
    await assertConnectedTarget(client, guard, 'backup-restore-verify export-file-owner');
    try {
      return (await client.query(
        `SELECT storage_relpath, sha256, size_bytes FROM catalog.inventory_export_file ORDER BY downloaded_at DESC LIMIT 1`)).rows[0] ?? null;
    } finally {
      await client.end();
    }
  })());
  if (fileRow) {
    const source = path.join(inventoryEnv.workDir, fileRow.storage_relpath);
    const copy = path.join(backupDir, `export-backup-${stamp}.xlsx`);
    fs.copyFileSync(source, copy);
    const hash = crypto.createHash('sha256').update(fs.readFileSync(copy)).digest('hex');
    evidence.exportFile = {
      source,
      copy,
      registeredSha256: fileRow.sha256,
      copiedSha256: hash,
      sizeMatches: fs.statSync(copy).size === Number(fileRow.size_bytes),
      shaMatches: hash === fileRow.sha256,
    };
  }
} catch (error) {
  backupError = String(error?.message ?? error);
  evidence.backupError = backupError.slice(0, 2000);
} finally {
  try {
    run(path.join(bin, 'dropdb.exe'), [...common, '--if-exists', scratchDb], pgEnv);
    evidence.scratchDropped = true;
  } catch (error) {
    evidence.scratchDropped = false;
    evidence.scratchDropError = String(error).slice(0, 300);
  }
  if (workerPaused) {
    const start = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts/inventory/start-worker.mjs'), '--run-id', args.runId], {
      encoding: 'utf8', windowsHide: true, env: process.env,
    });
    evidence.workerRestarted = start.status === 0;
    if (start.status !== 0) {
      evidence.workerRestartError = `${start.stderr || start.stdout || ''}`.trim().slice(0, 1000) || `exit ${start.status}`;
    }
  }
}

const tableValues = Object.values(evidence.tables);
const tablesCompared = tableValues.length;
const tablesEqual = tableValues.filter((value) => value.equal).length;
const backupTablesEqual = tablesCompared > 0 && tablesEqual === tablesCompared;
const backupExportOk = evidence.exportFile
  ? Boolean(evidence.exportFile.sizeMatches && evidence.exportFile.shaMatches)
  : null;
const workerRecoveryOk = !workerPaused || evidence.workerRestarted === true;
evidence.workerPaused = workerPaused;
evidence.workerRestarted = workerPaused ? evidence.workerRestarted : null;
evidence.backupTablesEqual = backupTablesEqual;
evidence.backupExportOk = backupExportOk;
evidence.summary = {
  tablesCompared,
  tablesEqual,
  allTablesEqual: backupTablesEqual,
  backupTablesEqual,
  backupExportOk,
  backupOk: backupError === null && backupTablesEqual && backupExportOk !== false,
  backupError,
  workerPaused,
  workerRestarted: evidence.workerRestarted,
  workerRestartError: evidence.workerRestartError,
  workerRecoveryOk,
  finishedAt: new Date().toISOString(),
};
evidence.ok = backupError === null && backupTablesEqual && backupExportOk !== false && workerRecoveryOk;
writeJson(path.join(run_.root, 'inventory-backup-restore-verify.json'), evidence);
console.log(JSON.stringify({
  ok: evidence.ok,
  backup: { tablesCompared, tablesEqual, backupTablesEqual, backupExportOk, backupError },
  worker: { paused: evidence.workerPaused, restarted: evidence.workerRestarted, error: evidence.workerRestartError },
  summary: evidence.summary,
}, null, 2));
if (!evidence.ok) {
  console.error(`INVENTORY_BACKUP_RESTORE_VERIFY_FAILED:${workerPaused && evidence.workerRestarted !== true ? 'WORKER_RESTART_FAILED' : 'BACKUP_INCONSISTENT'}`);
}
process.exitCode = evidence.ok ? 0 : 1;
