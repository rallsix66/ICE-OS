/**
 * R4.3 controlled mid-run interruption / restart drill on the repair instance.
 *
 * Flow:
 *   1. worker stopped, settings disabled (manual run only), no active run;
 *   2. trigger one manual sync through the app RPC (same requestId/intent as the page);
 *   3. start the worker with the test-only hold `INVENTORY_WORKER_TEST_HOLD_PHASE=publish`, so it
 *      publishes the first warehouse and then pauses before the second;
 *   4. SIGKILL the worker (simulated crash, not a graceful stop) once at least one batch exists;
 *   5. restart the worker normally; after the old lease expires it must take over (attempt+1), keep the
 *      already-published warehouse as the original batch, publish the rest, and finish success;
 *   6. prove the old lease token can no longer publish, and that the observation time/file are the
 *      original attempt's values (never now()/a second export).
 *
 * Usage: node scripts/inventory/recovery-drill.mjs --run-id <run> [--hold-ms 120000]
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT, openRun, readArgs, safeEnv } from '../catalog/prepare.mjs';
import { assertConnectedTarget, assertWritableTestTarget } from './test-target-guard.mjs';

const args = readArgs(process.argv.slice(2));
const holdIndex = process.argv.indexOf('--hold-ms');
const holdMs = holdIndex >= 0 ? Number(process.argv[holdIndex + 1]) : 120_000;
const run = openRun(args);
const instanceRoot = run.instanceRoot;
const inventoryEnv = JSON.parse(fs.readFileSync(path.join(instanceRoot, 'env.inventory.json'), 'utf8'));
// Refuse protected/delivered instances before opening any DB connection (F5.3).
const guard = assertWritableTestTarget({ instanceRoot, runId: args.runId, instance: run.instance, env: inventoryEnv, purpose: 'recovery-drill' });
const evidenceDir = path.join(run.root, 'verify');
fs.mkdirSync(evidenceDir, { recursive: true });
const summary = { runId: args.runId, startedAt: new Date().toISOString(), steps: [] };
const errors = [];
function step(name, ok, detail) {
  summary.steps.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` —${JSON.stringify(detail)}` : ''}`);
  if (!ok) errors.push(name);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function nodeScript(name, extraArgs = [], env = {}) {
  return spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts/inventory', name), '--run-id', args.runId, ...extraArgs], {
    cwd: REPO_ROOT, env: safeEnv(env), encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024,
  });
}
function workerMarker() {
  const file = path.join(instanceRoot, 'inventory-worker.pid.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}
function workerAlive() {
  const marker = workerMarker();
  if (!marker) return false;
  try { process.kill(marker.pid, 0); return true; } catch { return false; }
}

const { default: pg } = await import('pg');
const owner = new pg.Client({ connectionString: inventoryEnv.ownerDbUrl });
await owner.connect();
await assertConnectedTarget(owner, guard, 'recovery-drill owner');
const app = new pg.Client({ connectionString: inventoryEnv.appDbUrl });
await app.connect();
await assertConnectedTarget(app, guard, 'recovery-drill app');
const ADMIN = '11111111-1111-4111-8111-111111111101';

async function appCall(fn, fnArgs) {
  await app.query('BEGIN');
  try {
    await app.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [ADMIN]);
    const placeholders = fnArgs.map((_, index) => `$${index + 1}`).join(', ');
    const result = await app.query(`SELECT ${fn}(${placeholders}) AS result`, fnArgs);
    await app.query('COMMIT');
    return result.rows[0]?.result ?? null;
  } catch (error) {
    try { await app.query('ROLLBACK'); } catch { /* ignore */ }
    throw error;
  }
}
async function runRow(runId) {
  return (await owner.query(
    `SELECT id,status,attempt,lease_token,lease_owner,lease_expires_at,export_started_at,
            export_finished_at,file_id,finished_at,error_code
     FROM catalog.inventory_sync_run WHERE id=$1`, [runId])).rows[0] ?? null;
}
async function batches(runId) {
  return (await owner.query(
    `SELECT b.id,b.warehouse_id,w.external_warehouse_id,b.row_count,b.observation_at
     FROM catalog.inventory_batch b JOIN catalog.inventory_warehouse w ON w.id=b.warehouse_id
     WHERE b.run_id=$1 ORDER BY w.external_warehouse_id`, [runId])).rows;
}
async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(2000);
  }
  throw new Error(`TIMEOUT:${label}`);
}

const wasRunning = workerAlive();
let drillRunId = null;
try {
  if (wasRunning) {
    const stop = nodeScript('stop-worker.mjs');
    step('worker stopped before drill', stop.status === 0, { exit: stop.status });
  } else {
    step('worker already stopped before drill', true);
  }
  const active = (await owner.query(
    `SELECT count(*)::integer AS n FROM catalog.inventory_sync_run
     WHERE status IN ('queued','running','downloading','parsing','publishing','outcome_unknown')`)).rows[0].n;
  step('no active run before drill', active === 0, { active });

  const requestId = crypto.randomUUID();
  const intent = crypto.createHash('sha256').update(`manual|drill|${requestId}|${Date.now()}`).digest('hex');
  const created = await appCall('catalog.request_inventory_manual_sync', [requestId, intent]);
  drillRunId = created?.runId;
  step('manual run queued for drill', Boolean(drillRunId) && created?.status === 'queued', { requestId, runId: drillRunId, created });

  const startHeld = nodeScript('start-worker.mjs', [], {
    INVENTORY_WORKER_TEST_HOLD_PHASE: 'publish',
    INVENTORY_WORKER_TEST_HOLD_MS: String(holdMs),
  });
  step('worker started with test hold at publish', startHeld.status === 0, { exit: startHeld.status, stderr: String(startHeld.stderr).slice(0, 300) });

  await waitFor(async () => (await batches(drillRunId)).length >= 1, 240_000, 'first warehouse published');
  // Give the worker a moment to enter the hold before the second warehouse.
  await sleep(3_000);
  const before = await runRow(drillRunId);
  const firstBatches = await batches(drillRunId);
  step('first attempt published at least one warehouse and is still active',
    firstBatches.length >= 1 && ['publishing', 'parsing', 'downloading'].includes(before.status),
    { published: firstBatches.length, status: before.status, attempt: before.attempt });
  const marker = workerMarker();
  const archivedLease = { runId: drillRunId, attempt: before.attempt, leaseToken: before.lease_token, leaseOwner: before.lease_owner, exportFinishedAt: before.export_finished_at, fileId: before.file_id };
  summary.firstAttempt = { ...archivedLease, publishedWarehouses: firstBatches.map((b) => b.external_warehouse_id) };

  // Simulated crash: SIGKILL, no graceful lease release.
  try { process.kill(marker.pid, 'SIGKILL'); } catch { /* already gone */ }
  await waitFor(async () => !workerAlive(), 20_000, 'worker killed');
  fs.rmSync(path.join(instanceRoot, 'inventory-worker.pid.json'), { force: true });
  const afterKill = await runRow(drillRunId);
  step('killed worker left the run leased (no graceful release)',
    afterKill.status === before.status && afterKill.lease_token === archivedLease.leaseToken,
    { status: afterKill.status, attempt: afterKill.attempt });

  // Restart normally; it can only take over once the old lease expires.
  const restart = nodeScript('start-worker.mjs');
  step('worker restarted without test hold', restart.status === 0, { exit: restart.status, stderr: String(restart.stderr).slice(0, 300) });

  await waitFor(async () => {
    const row = await runRow(drillRunId);
    return row.attempt > archivedLease.attempt;
  }, 300_000, 'lease takeover');
  const takeover = await runRow(drillRunId);
  step('old lease taken over as a new attempt', takeover.attempt === archivedLease.attempt + 1,
    { oldAttempt: archivedLease.attempt, newAttempt: takeover.attempt, leaseChanged: takeover.lease_token !== archivedLease.leaseToken });

  // The old execution token must not be able to publish anymore (lease gate is checked first).
  const sync = new pg.Client({ connectionString: inventoryEnv.syncDbUrl });
  await sync.connect();
  await assertConnectedTarget(sync, guard, 'recovery-drill sync lease-probe');
  let oldLeaseRejected = null;
  let oldLeaseMessage = null;
  try {
    await sync.query(
      `SELECT catalog.publish_inventory_warehouse($1,$2,$3::jsonb,$4::jsonb)`,
      [drillRunId, archivedLease.leaseToken, JSON.stringify({ warehouseId: firstBatches[0].warehouse_id }), JSON.stringify([])]);
    oldLeaseRejected = false;
  } catch (error) {
    oldLeaseRejected = String(error.message).includes('INVENTORY_LEASE_LOST');
    oldLeaseMessage = String(error.message).slice(0, 300);
  } finally {
    await sync.end();
  }
  step('old execution token can no longer publish', oldLeaseRejected === true, { rejected: oldLeaseRejected, message: oldLeaseMessage });

  await waitFor(async () => {
    const row = await runRow(drillRunId);
    return ['success', 'partial', 'failed', 'needs_login'].includes(row.status);
  }, 420_000, 'run finished after recovery');
  const finished = await runRow(drillRunId);
  const finalBatches = await batches(drillRunId);
  step('recovered run finished success with every warehouse published once',
    finished.status === 'success' && finalBatches.length === 7
    && new Set(finalBatches.map((b) => b.warehouse_id)).size === 7,
    { status: finished.status, batches: finalBatches.length, errorCode: finished.error_code });
  step('observation time is the original attempt export time (not now())',
    String(finished.export_finished_at) === String(archivedLease.exportFinishedAt),
    { first: archivedLease.exportFinishedAt, final: finished.export_finished_at });
  step('same export file, no second export',
    finished.file_id === archivedLease.fileId && (await owner.query(
      `SELECT count(*)::integer AS n FROM catalog.inventory_export_file WHERE run_id=$1`, [drillRunId])).rows[0].n === 1,
    { fileId: finished.file_id, firstFileId: archivedLease.fileId });
  const firstWarehouseBatch = finalBatches.find((b) => b.external_warehouse_id === summary.firstAttempt.publishedWarehouses[0]);
  const originalFirst = firstBatches.find((b) => b.external_warehouse_id === summary.firstAttempt.publishedWarehouses[0]);
  step('already-published warehouse kept its original batch (no duplicate publish)',
    firstWarehouseBatch?.id === originalFirst?.id,
    { first: originalFirst?.external_warehouse_id, batchBefore: originalFirst?.id, batchAfter: firstWarehouseBatch?.id });
  const warehouseStates = (await owner.query(
    `SELECT count(*)::integer AS n FROM catalog.inventory_warehouse_state ws
     JOIN catalog.inventory_warehouse w ON w.id=ws.warehouse_id
     WHERE ws.last_success_run_id=$1`, [drillRunId])).rows[0].n;
  step('all 7 warehouses recorded this run as their success', warehouseStates === 7, { warehouseStates });
  summary.recovered = {
    status: finished.status, attempt: finished.attempt, batches: finalBatches.length,
    exportFinishedAt: finished.export_finished_at, fileId: finished.file_id,
    publishedAtFirstAttempt: summary.firstAttempt.publishedWarehouses,
  };
} catch (error) {
  summary.error = String(error?.message ?? error);
  console.error(summary.error);
} finally {
  try {
    // Leave the instance with a healthy worker online (the drill stops/starts it).
    if (!workerAlive()) {
      const restart = nodeScript('start-worker.mjs');
      summary.finalWorkerRestart = restart.status === 0;
    }
  } catch (error) {
    summary.finalWorkerRestartError = String(error?.message ?? error);
  }
  summary.finishedAt = new Date().toISOString();
  summary.allOk = errors.length === 0 && !summary.error;
  summary.failedSteps = errors;
  fs.writeFileSync(path.join(evidenceDir, 'recovery-drill.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify({ allOk: summary.allOk, failedSteps: errors, error: summary.error ?? null, recovered: summary.recovered ?? null }, null, 2));
  await owner.end();
  await app.end();
  process.exitCode = summary.allOk ? 0 : 1;
}

