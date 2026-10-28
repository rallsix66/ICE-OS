/**
 * R5 end-to-end recovery chain on the repair instance (same app RPCs as the web actions):
 *
 *   begin pending -> action commits (response "lost") -> a new write is blocked ->
 *   reconcile with a wrong intent fails but keeps the pending request -> reconcile with the original
 *   intent finds the stored receipt -> complete pending -> repeating the SAME requestId+intent returns
 *   the original receipt without a second effect.
 *
 * The same chain is repeated for the disable entry point (different action/parameters). Reconcile stays
 * read-only: it never replays the write; only the explicit completion clears the R5 lock.
 *
 * Usage: node scripts/inventory/verify-r5-recovery-chain.mjs --run-id <run>
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { openRun, readArgs } from '../catalog/prepare.mjs';
import { assertConnectedTarget, assertWritableTestTarget } from './test-target-guard.mjs';

const args = readArgs(process.argv.slice(2));
const run = openRun(args);
const inventoryEnv = JSON.parse(fs.readFileSync(path.join(run.instanceRoot, 'env.inventory.json'), 'utf8'));
// Refuse protected/delivered instances before opening any DB connection (F5.3).
const guard = assertWritableTestTarget({ instanceRoot: run.instanceRoot, runId: args.runId, instance: run.instance, env: inventoryEnv, purpose: 'verify-r5-recovery-chain' });
const ADMIN = '11111111-1111-4111-8111-111111111101';
const { default: pg } = await import('pg');
const app = new pg.Client({ connectionString: inventoryEnv.appDbUrl });
await app.connect();
await assertConnectedTarget(app, guard, 'verify-r5-recovery-chain app');
const owner = new pg.Client({ connectionString: inventoryEnv.ownerDbUrl });
await owner.connect();
await assertConnectedTarget(owner, guard, 'verify-r5-recovery-chain owner');
const checks = [];
function record(name, ok, detail) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${JSON.stringify(detail)}` : ''}`);
}
async function call(fn, fnArgs) {
  await app.query('BEGIN');
  try {
    await app.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [ADMIN]);
    const placeholders = fnArgs.map((_, index) => `$${index + 1}`).join(', ');
    const result = await app.query(`SELECT ${fn}(${placeholders}) AS result`, fnArgs);
    await app.query('COMMIT');
    return { ok: true, result: result.rows[0]?.result ?? null };
  } catch (error) {
    try { await app.query('ROLLBACK'); } catch { /* ignore */ }
    return { ok: false, error: String(error.message) };
  }
}
const intent = (value) => crypto.createHash('sha256').update(value).digest('hex');
const settingsRow = async () => (await owner.query(
  'SELECT enabled,interval_minutes,next_run_at,config_version,scope_id FROM catalog.inventory_sync_settings LIMIT 1')).rows[0];
const pendingRows = async () => (await owner.query(
  "SELECT request_id,status,action FROM catalog.inventory_pending_action WHERE status='pending'")).rows;

// ---- settings chain -------------------------------------------------------------------------------
const before = await settingsRow();
const requestId = crypto.randomUUID();
const settingsIntent = intent(`settings|${requestId}|enabled=false|interval=60|no-scope-change`);
const begin = await call('catalog.begin_inventory_pending_action', [
  requestId, settingsIntent, 'update_inventory_sync_settings', { enabled: false, intervalMinutes: 61, scopeProvided: false },
]);
record('R5 begin pending for settings stores the full original payload',
  begin.ok && begin.result?.ok === true, begin.result ?? begin.error);
const blocked = await call('catalog.update_inventory_sync_settings', [
  crypto.randomUUID(), intent('settings|blocked-by-pending'), false, 61, false, []]);
record('R5 new settings write is refused while the original request is pending',
  blocked.ok === false && String(blocked.error).includes('INVENTORY_PENDING_RECOVERY_REQUIRED'), blocked.error);
const committed = await call('catalog.update_inventory_sync_settings', [requestId, settingsIntent, false, 61, false, []]);
record('R5 original settings action committed (simulated lost response)',
  committed.ok && committed.result?.ok === true, committed.result ?? committed.error);
const afterCommit = await settingsRow();
record('R5 the committed action has exactly one effect (config_version +1 once)',
  Number(afterCommit.config_version) === Number(before.config_version) + 1,
  { before: before.config_version, after: afterCommit.config_version });
const reconcileBad = await call('catalog.reconcile_inventory_request', [requestId, intent('wrong-intent')]);
record('R5 reconcile with the wrong intent fails without replaying or clearing the request',
  reconcileBad.ok === false && String(reconcileBad.error).includes('INVENTORY_REQUEST_CONFLICT') && (await pendingRows()).length === 1,
  { error: reconcileBad.error, pending: (await pendingRows()).length });
const reconcileGood = await call('catalog.reconcile_inventory_request', [requestId, settingsIntent]);
record('R5 reconcile with the original intent finds the stored receipt (read-only)',
  reconcileGood.ok && reconcileGood.result?.found === true
  && reconcileGood.result?.response?.settings?.configVersion === afterCommit.config_version,
  reconcileGood.result ?? reconcileGood.error);
const completed = await call('catalog.complete_inventory_pending_action', [requestId, 'completed', reconcileGood.result?.response ?? null, null]);
record('R5 completing the pending action releases the lock', completed.ok && completed.result?.ok === true, completed.result ?? completed.error);
const afterComplete = await call('catalog.update_inventory_sync_settings', [
  crypto.randomUUID(), intent('settings|after-pending'), false, 60, false, []]);
record('R5 new writes are accepted after the pending request is resolved', afterComplete.ok, afterComplete.error);
const versionBeforeReplay = (await settingsRow()).config_version;
const replay = await call('catalog.update_inventory_sync_settings', [requestId, settingsIntent, false, 61, false, []]);
const afterReplay = await settingsRow();
record('R5 repeating the same requestId+intent returns the receipt without a second effect',
  replay.ok && replay.result?.ok === true && Number(afterReplay.config_version) === Number(versionBeforeReplay),
  { replay: replay.result, versionBeforeReplay, versionAfterReplay: afterReplay.config_version });
// Restore the delivered settings (interval 60) after the drill.
await call('catalog.update_inventory_sync_settings', [crypto.randomUUID(), intent('settings|restore-60'), false, 60, false, []]);

// ---- disable chain (different action/parameters) --------------------------------------------------
// Create one clearly-marked verification-only mapping, then use the disable entry point.
const latestRun = (await owner.query(
  "SELECT id FROM catalog.inventory_sync_run WHERE status='success' ORDER BY export_finished_at DESC NULLS LAST LIMIT 1")).rows[0]?.id;
const target = (await owner.query(
  `SELECT rr.external_sku, w.external_warehouse_id, w.id AS warehouse_id
   FROM catalog.inventory_run_row rr
   JOIN catalog.inventory_warehouse w ON w.external_warehouse_id=rr.warehouse_external_id
   WHERE rr.run_id=$1 AND rr.parse_status='ok' AND rr.external_sku LIKE 'R5-verification-%'
   ORDER BY rr.external_sku LIMIT 1`, [latestRun])).rows[0];
let mapping;
if (!target) {
  // No sentinel SKU in the real file: use an already disabled verification mapping's SKU at another
  // warehouse and confirm a fresh version on it, then disable that version.
  const prior = (await owner.query(
    `SELECT external_sku, warehouse_id, version FROM (
       SELECT external_sku, warehouse_id, version,
         row_number() OVER (PARTITION BY external_sku, warehouse_id ORDER BY version DESC) AS rn
       FROM catalog.inventory_sku_mapping
       WHERE status IN ('disabled','recheck')
         AND evidence->>'reason' LIKE '%verification-only%'
     ) t WHERE rn=1 ORDER BY version DESC LIMIT 1`)).rows[0];
  if (!prior) throw new Error('NO_VERIFICATION_MAPPING_FOR_DISABLE_CHAIN');
  const itemB = (await owner.query(
    "SELECT item_id FROM catalog.catalog_item_code WHERE ice_code='LS101276'")).rows[0].item_id;
  const confirm = await call('catalog.confirm_inventory_mapping', [
    crypto.randomUUID(), intent(`confirm-disable-chain|${prior.external_sku}`),
    JSON.stringify([{ externalSku: prior.external_sku, warehouseExternalId: (await owner.query(
      'SELECT external_warehouse_id FROM catalog.inventory_warehouse WHERE id=$1', [prior.warehouse_id])).rows[0].external_warehouse_id,
    itemId: itemB, unit: '件', expectedVersion: prior.version, reason: 'R5 verification-only mapping for the disable recovery chain' }]),
  ]);
  mapping = confirm.result?.committed?.[0];
  if (!mapping) throw new Error(`DISABLE_CHAIN_CONFIRM_FAILED:${JSON.stringify(confirm)}`);
} else {
  const confirm = await call('catalog.confirm_inventory_mapping', [
    crypto.randomUUID(), intent(`confirm-disable-chain|${target.external_sku}`),
    JSON.stringify([{ externalSku: target.external_sku, warehouseExternalId: target.external_warehouse_id,
      itemId: (await owner.query("SELECT item_id FROM catalog.catalog_item_code WHERE ice_code='LS101276'")).rows[0].item_id,
      unit: '件', expectedVersion: null, reason: 'R5 verification-only mapping for the disable recovery chain' }]),
  ]);
  mapping = confirm.result?.committed?.[0];
  if (!mapping) throw new Error(`DISABLE_CHAIN_CONFIRM_FAILED:${JSON.stringify(confirm)}`);
}
const disableRequest = crypto.randomUUID();
const disableNote = 'R5 verification-only disable chain';
const disableIntent = intent(`disable|${mapping.mappingId}|${mapping.version}|${disableNote}`);
const beginDisable = await call('catalog.begin_inventory_pending_action', [
  disableRequest, disableIntent, 'disable_inventory_mapping',
  { mappingId: mapping.mappingId, expectedVersion: mapping.version, note: disableNote }]);
record('R5 begin pending for disable keeps the original mappingId/version/note',
  beginDisable.ok && beginDisable.result?.ok === true, beginDisable.result ?? beginDisable.error);
const disableCommitted = await call('catalog.disable_inventory_mapping', [
  disableRequest, disableIntent, mapping.mappingId, disableNote, mapping.version]);
record('R5 disable action committed (simulated lost response)',
  disableCommitted.ok && disableCommitted.result?.status === 'disabled', disableCommitted.result ?? disableCommitted.error);
const disableReconcileBad = await call('catalog.reconcile_inventory_request', [disableRequest, intent('wrong-disable-intent')]);
record('R5 disable reconcile with wrong intent fails and keeps pending',
  disableReconcileBad.ok === false && (await pendingRows()).length === 1, disableReconcileBad.error);
const disableReconcile = await call('catalog.reconcile_inventory_request', [disableRequest, disableIntent]);
record('R5 disable reconcile finds the original receipt',
  disableReconcile.ok && disableReconcile.result?.found === true, disableReconcile.result ?? disableReconcile.error);
const disableComplete = await call('catalog.complete_inventory_pending_action', [
  disableRequest, 'completed', disableReconcile.result?.response ?? null, null]);
record('R5 disable pending completion releases the lock', disableComplete.ok, disableComplete.error);
const disableReplay = await call('catalog.disable_inventory_mapping', [
  disableRequest, disableIntent, mapping.mappingId, disableNote, mapping.version]);
const mappingState = (await owner.query(
  'SELECT status FROM catalog.inventory_sku_mapping WHERE id=$1', [mapping.mappingId])).rows[0];
record('R5 repeating the disable request returns the receipt with one effect',
  disableReplay.ok && mappingState?.status === 'disabled', { replayed: disableReplay.result, state: mappingState });

const summary = {
  runId: args.runId, checks, finishedAt: new Date().toISOString(),
  allOk: checks.every((check) => check.ok),
  note: 'R5 chains used verification-only settings write (no scope/enable change) and a verification-only mapping; reconcile never replayed a write',
  pendingLeft: await pendingRows(),
};
fs.mkdirSync(path.join(run.root, 'verify'), { recursive: true });
fs.writeFileSync(path.join(run.root, 'verify', 'r5-recovery-chain.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({ allOk: summary.allOk, failed: checks.filter((c) => !c.ok).map((c) => c.name) }, null, 2));
await app.end();
await owner.end();
process.exitCode = summary.allOk ? 0 : 1;



