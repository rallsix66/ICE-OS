/**
 * Trigger a manual sync through the app RPC (same requestId/intent contract as the web action) and
 * wait for the background worker to finish it. Used by the Lead integration runs.
 *
 * Usage: node .local/inventory-sync-repair-20261026/run-manual-sync.mjs --run-id <run> [--wait-seconds 600]
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { openRun, readArgs } from '../catalog/prepare.mjs';
import { assertConnectedTarget, assertWritableTestTarget } from './test-target-guard.mjs';

const args = readArgs(process.argv.slice(2));
const waitIndex = process.argv.indexOf('--wait-seconds');
const waitSeconds = waitIndex >= 0 ? Number(process.argv[waitIndex + 1]) : 600;
const run = openRun(args);
const inventoryEnv = JSON.parse(fs.readFileSync(path.join(run.instanceRoot, 'env.inventory.json'), 'utf8'));
// Refuse protected/delivered instances before opening any DB connection (F5.3).
const guard = assertWritableTestTarget({ instanceRoot: run.instanceRoot, runId: args.runId, instance: run.instance, env: inventoryEnv, purpose: 'run-manual-sync' });
const ADMIN = '11111111-1111-4111-8111-111111111101';
const { default: pg } = await import('pg');
const client = new pg.Client({ connectionString: inventoryEnv.appDbUrl });
await client.connect();
// R4: prove the live server identity READ ONLY before the first write (not just the marker file).
await assertConnectedTarget(client, guard, 'run-manual-sync app');

async function appCall(fn, fnArgs) {
  await client.query('BEGIN');
  try {
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [ADMIN]);
    const placeholders = fnArgs.map((_, index) => `$${index + 1}`).join(', ');
    const result = await client.query(`SELECT ${fn}(${placeholders}) AS result`, fnArgs);
    await client.query('COMMIT');
    return { ok: true, result: result.rows[0]?.result ?? null };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    return { ok: false, error: error.message };
  }
}

const requestId = crypto.randomUUID();
const intent = crypto.createHash('sha256').update(`manual|${requestId}|${Date.now()}`).digest('hex');
const created = await appCall('catalog.request_inventory_manual_sync', [requestId, intent]);
console.log(JSON.stringify({ requestId, created }, null, 2));
if (!created.ok) { await client.end(); process.exit(1); }
const runId = created.result?.runId;
if (!runId) { console.log('no run created (deduped or rejected)'); await client.end(); process.exit(0); }

const deadline = Date.now() + waitSeconds * 1000;
let lastStatus = null;
while (Date.now() < deadline) {
  const detail = await appCall('catalog.read_inventory_sync_run', [runId]);
  const status = detail.result?.status;
  if (status !== lastStatus) {
    console.log(`run ${runId} status=${status} phase=${JSON.stringify(detail.result?.summary?.phase?.name ?? null)}`);
    lastStatus = status;
  }
  if (['success', 'partial', 'failed', 'needs_login'].includes(status)) {
    const summary = {
      runId,
      status,
      errorCode: detail.result?.errorCode,
      errorDetail: detail.result?.errorDetail,
      exportStartedAt: detail.result?.exportStartedAt,
      exportFinishedAt: detail.result?.exportFinishedAt,
      accountIdentity: detail.result?.accountIdentity,
      fileValidation: detail.result?.fileValidation,
      file: detail.result?.file,
      warehouses: detail.result?.warehouses,
    };
    fs.mkdirSync(path.join(run.root, 'verify'), { recursive: true });
    fs.writeFileSync(path.join(run.root, 'verify', `manual-run-${runId}.json`), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(JSON.stringify({ ...summary, file: summary.file && { sha256: summary.file.sha256, rowCount: summary.file.rowCount, storageRelpath: summary.file.storageRelpath, downloadedAt: summary.file.downloadedAt } }, null, 2));
    await client.end();
    process.exit(status === 'success' ? 0 : 2);
  }
  await new Promise((resolve) => setTimeout(resolve, 3000));
}
console.error(`run ${runId} did not finish within ${waitSeconds}s (last status ${lastStatus})`);
await client.end();
process.exit(3);

