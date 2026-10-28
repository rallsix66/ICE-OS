/**
 * Status report for the inventory-sync-v1 instance.
 *
 * "Worker online" requires BOTH the DB heartbeat and proven process ownership (exact frozen worker
 * script path + instance config path + process creation time). A live pid that cannot be proven is
 * reported as `owned:false` and never as this package's online worker.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { openRun, readArgs } from '../catalog/prepare.mjs';
import { verifyFrozenWorkerSource, workerSourceDrift } from './freeze-worker-source.mjs';
import { pidAlive, verifyWorkerOwnership } from './worker-process-ownership.mjs';

function portListening(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port }, () => { socket.end(); resolve(true); });
    socket.on('error', () => resolve(false));
  });
}

const args = readArgs(process.argv.slice(2));
const run = openRun(args);
const envPath = path.join(run.instanceRoot, 'env.inventory.json');
const report = { runId: args.runId, prepared: fs.existsSync(envPath) };
if (!report.prepared) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(1);
}
const inventoryEnv = JSON.parse(fs.readFileSync(envPath, 'utf8'));
const workerMarkerPath = path.join(run.instanceRoot, 'inventory-worker.pid.json');
let workerMarker = null;
if (fs.existsSync(workerMarkerPath)) {
  try {
    workerMarker = JSON.parse(fs.readFileSync(workerMarkerPath, 'utf8'));
  } catch {
    workerMarker = { invalid: true };
  }
}
report.web = {
  port: inventoryEnv.webPort,
  listening: await portListening('127.0.0.1', inventoryEnv.webPort),
  url: `${inventoryEnv.previewUrl}/dashboard/sync`,
  buildMarker: fs.existsSync(path.join(run.instanceRoot, 'preview-build-ready.json'))
    ? JSON.parse(fs.readFileSync(path.join(run.instanceRoot, 'preview-build-ready.json'), 'utf8'))
    : null,
};
report.postgres = {
  host: inventoryEnv.host,
  port: inventoryEnv.port,
  database: inventoryEnv.database,
  listening: await portListening(inventoryEnv.host, inventoryEnv.port),
};
report.workerSource = workerSourceDrift(run.instanceRoot);
report.workerProcess = (() => {
  if (!workerMarker) return null;
  if (workerMarker.invalid) return { markerInvalid: true, owned: false, alive: false };
  if (!pidAlive(workerMarker.pid)) {
    return { pid: workerMarker.pid, alive: false, owned: false, code: 'INVENTORY_WORKER_PID_NOT_ALIVE' };
  }
  const ownership = verifyWorkerOwnership(workerMarker);
  return {
    pid: workerMarker.pid,
    workerId: workerMarker.workerId,
    startedAt: workerMarker.startedAt,
    processCreatedAt: workerMarker.processCreatedAt,
    configPath: workerMarker.configPath,
    workerScript: workerMarker.workerScript,
    workerSourceSnapshotHash: workerMarker.workerSourceSnapshotHash,
    alive: true,
    owned: ownership.ok,
    code: ownership.ok ? null : ownership.code,
    message: ownership.ok ? null : ownership.message,
  };
})();
const frozen = verifyFrozenWorkerSource(run.instanceRoot);
report.workerFrozenSource = frozen.ok
  ? { verified: true, workerScript: frozen.workerScript, snapshotHash: frozen.manifest.snapshotHash }
  : { verified: false, code: frozen.code, message: frozen.message };

if (report.postgres.listening) {
  const { default: pg } = await import('pg');
  // Owner (bootstrap) connection: status is an operator view, the sync role may only call RPCs.
  const pool = new pg.Pool({ connectionString: inventoryEnv.ownerDbUrl ?? inventoryEnv.syncDbUrl, max: 1 });
  try {
    const heartbeat = (await pool.query(
      `SELECT worker_id, host, pid, version, state, started_at, last_seen_at,
              (now() - last_seen_at) < interval '45 seconds' AS online
       FROM catalog.inventory_worker ORDER BY last_seen_at DESC LIMIT 3`)).rows;
    const settings = (await pool.query(
      `SELECT s.enabled, s.interval_minutes, s.next_run_at, s.plan_anchor_at, s.config_version,
              s.scope_id,
              (SELECT cardinality(sc.warehouse_ids) FROM catalog.inventory_scope sc WHERE sc.id = s.scope_id) AS scope_warehouse_count,
              (SELECT count(*) FROM catalog.inventory_sync_run r WHERE r.status IN ('queued','running','downloading','parsing','publishing','outcome_unknown')) AS active_runs,
              (SELECT count(*) FROM catalog.inventory_pending_action p WHERE p.status = 'pending') AS pending_actions
       FROM catalog.inventory_sync_settings s LIMIT 1`)).rows[0] ?? null;
    const lastRuns = (await pool.query(
      `SELECT id, status, trigger_kind, planned_for, started_at, finished_at, export_finished_at, error_code
       FROM catalog.inventory_sync_run ORDER BY created_at DESC LIMIT 5`)).rows;
    const counts = (await pool.query(
      `SELECT (SELECT count(*) FROM catalog.inventory_batch) AS batches,
              (SELECT count(*) FROM catalog.inventory_batch_row) AS batch_rows,
              (SELECT count(*) FROM catalog.inventory_current) AS current_rows,
              (SELECT count(*) FROM catalog.inventory_sku_mapping WHERE status='confirmed') AS confirmed_mappings,
              (SELECT count(*) FROM catalog.inventory_mapping_candidate WHERE status='pending') AS mapping_candidates,
              (SELECT count(*) FROM catalog.inventory_warehouse) AS warehouses`)).rows[0];
    const schemaState = (await pool.query(
      `SELECT to_regclass('catalog.inventory_schema_state') IS NOT NULL AS present`)).rows[0].present
      ? (await pool.query(`SELECT * FROM catalog.inventory_schema_state LIMIT 1`)).rows[0]
      : null;
    report.database = { heartbeat, settings, lastRuns, counts, schemaState };
  } finally {
    await pool.end();
  }
}
const workerOwned = report.workerProcess ? report.workerProcess.owned === true : false;
const workerProblem = report.workerProcess
  ? (report.workerProcess.owned === true ? null : (report.workerProcess.code ?? 'INVENTORY_WORKER_MARKER_INVALID'))
  : null;
report.summary = {
  webListening: report.web.listening,
  postgresListening: report.postgres.listening,
  workerStarted: Boolean(report.workerProcess),
  workerOwned,
  workerProblem,
  frozenWorkerSourceOk: report.workerFrozenSource.verified === true,
};
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.web.listening && report.postgres.listening && (workerProblem === null) ? 0 : 1;
