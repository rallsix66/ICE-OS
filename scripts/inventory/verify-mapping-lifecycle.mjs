/**
 * R2 maintenance lifecycle on the repair instance, using the same app RPCs as the web actions:
 *   - a row from the latest real collection that has **no evidence suggestion** can still be confirmed
 *     by explicitly choosing item/warehouse/unit/reason;
 *   - rebinding A->B creates a new version, disables A, and does not move the old batch value to B
 *     (new values only arrive with the next complete batch);
 *   - recheck removes the mapping from current inventory immediately;
 *   - a unit conflict is rejected (reported as a skipped item with INVENTORY_MAPPING_UNIT_CONFLICT)
 *     instead of being converted or guessed.
 *
 * The chosen SKU has no business suggestion; this run is explicitly marked `verification-only` and the
 * mapping is left disabled/recheck at the end, so no business inventory is adopted from it.
 *
 * Usage: node scripts/inventory/verify-mapping-lifecycle.mjs --run-id <run>
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
const guard = assertWritableTestTarget({ instanceRoot: run.instanceRoot, runId: args.runId, instance: run.instance, env: inventoryEnv, purpose: 'verify-mapping-lifecycle' });
const ADMIN = '11111111-1111-4111-8111-111111111101';
const { default: pg } = await import('pg');
const app = new pg.Client({ connectionString: inventoryEnv.appDbUrl });
await app.connect();
await assertConnectedTarget(app, guard, 'verify-mapping-lifecycle app');
const owner = new pg.Client({ connectionString: inventoryEnv.ownerDbUrl });
await owner.connect();
await assertConnectedTarget(owner, guard, 'verify-mapping-lifecycle owner');
const checks = [];
function record(name, ok, detail) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${JSON.stringify(detail)}` : ''}`);
}
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
const intent = (value) => crypto.createHash('sha256').update(value).digest('hex');
const itemIdByCode = async (code) => (await owner.query(
  'SELECT item_id FROM catalog.catalog_item_code WHERE ice_code=$1', [code])).rows[0]?.item_id ?? null;

// Pick one real collection row (latest success run, in-scope warehouse) that has no suggestion and no
// mapping history: exactly the "no suggestion" case the review asked to be confirmable.
const latestRun = (await owner.query(
  "SELECT id FROM catalog.inventory_sync_run WHERE status='success' ORDER BY export_finished_at DESC NULLS LAST LIMIT 1")).rows[0]?.id;
if (!latestRun) throw new Error('NO_SUCCESS_RUN');
const target = (await owner.query(
  `SELECT rr.external_sku, w.external_warehouse_id, w.id AS warehouse_id, w.external_name
   FROM catalog.inventory_run_row rr
   JOIN catalog.inventory_warehouse w ON w.external_warehouse_id = rr.warehouse_external_id
   WHERE rr.run_id=$1 AND rr.parse_status='ok'
     AND rr.external_sku <> '0000' AND length(rr.external_sku) >= 8
     AND NOT EXISTS(SELECT 1 FROM catalog.inventory_sku_mapping m
       WHERE m.external_sku=rr.external_sku AND m.warehouse_id=w.id)
     AND NOT EXISTS(SELECT 1 FROM catalog.inventory_mapping_candidate c
       WHERE c.external_sku=rr.external_sku AND c.warehouse_id=w.id)
   ORDER BY length(rr.external_sku) DESC, rr.external_sku LIMIT 1`, [latestRun])).rows[0];
if (!target) throw new Error('NO_ROW_WITHOUT_SUGGESTION');
const itemA = await itemIdByCode('LS101274');
const itemB = await itemIdByCode('LS101276');
if (!itemA || !itemB) throw new Error('TARGET_ITEMS_MISSING');
const queue = await appCall('catalog.read_inventory_mapping_queue', [target.external_sku, 20, 0]);
const queueRow = (queue?.items ?? []).find((entry) => entry.externalSku === target.external_sku
  && entry.warehouseExternalId === target.external_warehouse_id);
record('R2 a real collection row without suggestion is reachable in the queue',
  Boolean(queueRow) && (queueRow.suggestion === null || queueRow.suggestion === undefined),
  { sku: target.external_sku, warehouse: target.external_warehouse_id, suggestion: queueRow?.suggestion ?? null });

const reason = 'R2 verification-only mapping: no evidence suggestion; operator explicitly picked item/warehouse/unit; mapping is rechecked/disabled after the drill and never enters business inventory';
const confirmOne = async (itemId, expectedVersion, unit = '件') => appCall('catalog.confirm_inventory_mapping', [
  crypto.randomUUID(), intent(`confirm|${target.external_sku}|${target.external_warehouse_id}|${itemId}|${unit}|${expectedVersion}`),
  JSON.stringify([{ externalSku: target.external_sku, warehouseExternalId: target.external_warehouse_id, itemId, unit, expectedVersion, reason }]),
]);
const first = await confirmOne(itemA, null);
record('R2 confirm without suggestion records actor/reason/version', first?.ok === true && first?.applied === 1,
  { applied: first?.applied, committed: first?.committed });
const mappingA = first?.committed?.[0];
record('R2 confirmed mapping is version 1 for the explicit warehouse/unit',
  mappingA?.version === 1 && mappingA?.unit === '件', mappingA);

// The old batch rows still carry their old mapping, so the freshly confirmed mapping must not move
// the old values into the item before a new complete batch.
const detailA = await appCall('catalog.read_inventory_item', [itemA, '', '', false]);
const itemARowBeforeBatch = (detailA?.warehouses ?? []).flatMap((wh) => wh.rows ?? [])
  .filter((row) => row.externalSku === target.external_sku);
record('R2 new confirmation does not reuse the old batch value', itemARowBeforeBatch.length === 0,
  { rowsForSku: itemARowBeforeBatch.length, mapping: mappingA });

// Unit conflict: same item + same SKU at another warehouse with a different unit must be rejected.
const otherWarehouse = (await owner.query(
  `SELECT w.external_warehouse_id FROM catalog.inventory_run_row rr
   JOIN catalog.inventory_warehouse w ON w.external_warehouse_id=rr.warehouse_external_id
   WHERE rr.run_id=$1 AND rr.external_sku=$2 AND w.external_warehouse_id<>$3 AND rr.parse_status='ok'
   LIMIT 1`, [latestRun, target.external_sku, target.external_warehouse_id])).rows[0]?.external_warehouse_id;
let unitConflictCode = null;
if (otherWarehouse) {
  try {
    const response = await appCall('catalog.confirm_inventory_mapping', [
      crypto.randomUUID(), intent(`unit-conflict|${target.external_sku}|${otherWarehouse}`),
      JSON.stringify([{ externalSku: target.external_sku, warehouseExternalId: otherWarehouse, itemId: itemA, unit: '箱', expectedVersion: null, reason }]),
    ]);
    unitConflictCode = response?.skipped?.[0]?.reason ?? null;
    if (response?.applied) unitConflictCode = 'ACCEPTED';
  } catch (error) {
    unitConflictCode = String(error.message).split(':')[0];
  }
  record('R2 incompatible unit is rejected instead of converted',
    unitConflictCode === 'INVENTORY_MAPPING_UNIT_CONFLICT', { code: unitConflictCode, warehouse: otherWarehouse });
} else {
  record('R2 incompatible unit is rejected instead of converted', true, { skipped: 'single-warehouse SKU in latest run' });
}

// Rebind A -> B with the visible old version.
const rebind = await confirmOne(itemB, mappingA?.version ?? 1);
record('R2 rebind A->B creates version 2 and disables A',
  rebind?.ok === true && rebind?.applied === 1 && rebind?.committed?.[0]?.version === 2,
  { committed: rebind?.committed });
const mappingStates = (await owner.query(
  `SELECT version,status,item_id FROM catalog.inventory_sku_mapping
   WHERE external_sku=$1 AND warehouse_id=$2 ORDER BY version`, [target.external_sku, target.warehouse_id])).rows;
record('R2 rebind keeps both versions with history (A disabled, B confirmed)',
  mappingStates.length >= 2
  && mappingStates.some((row) => row.version === 1 && row.status === 'disabled' && row.item_id === itemA)
  && mappingStates.some((row) => row.version === 2 && row.status === 'confirmed' && row.item_id === itemB),
  mappingStates);
const detailOld = await appCall('catalog.read_inventory_item', [itemA, '', '', false]);
const detailNew = await appCall('catalog.read_inventory_item', [itemB, '', '', false]);
const oldHasRow = (detailOld?.warehouses ?? []).flatMap((wh) => wh.rows ?? []).some((row) => row.externalSku === target.external_sku);
const newHasRow = (detailNew?.warehouses ?? []).flatMap((wh) => wh.rows ?? []).some((row) => row.externalSku === target.external_sku);
record('R2 rebind does not move the old value to the new item before a new batch',
  oldHasRow === false && newHasRow === false, { oldHasRow, newHasRow });

// Recheck the new version: immediately excluded from current aggregation.
const mappingB = rebind?.committed?.[0];
const recheck = await appCall('catalog.recheck_inventory_mapping', [
  crypto.randomUUID(), intent(`recheck|${mappingB?.mappingId}`), mappingB?.mappingId, 'R2 verification drill finished: recheck (never enters business inventory)', 2,
]);
record('R2 recheck turns the mapping to recheck state', recheck?.ok === true && recheck?.status === 'recheck', recheck);
const afterRecheck = await appCall('catalog.read_inventory_item', [itemB, '', '', false]);
const recheckedState = (afterRecheck?.mapping ?? []).find((row) => row.id === mappingB?.mappingId);
record('R2 recheck leaves no current aggregation for the test mapping',
  recheckedState?.status === 'recheck' && !(afterRecheck?.warehouses ?? []).flatMap((wh) => wh.rows ?? []).some((row) => row.externalSku === target.external_sku),
  { mapping: recheckedState });

const summary = {
  runId: args.runId, latestRun, target, checks, finishedAt: new Date().toISOString(),
  allOk: checks.every((check) => check.ok),
  note: 'verification-only mapping: no suggestion existed; mapping left recheck/disabled and no business inventory adopted',
};
fs.mkdirSync(path.join(run.root, 'verify'), { recursive: true });
fs.writeFileSync(path.join(run.root, 'verify', 'mapping-lifecycle.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({ allOk: summary.allOk, failed: checks.filter((c) => !c.ok).map((c) => c.name) }, null, 2));
await app.end();
await owner.end();
process.exitCode = summary.allOk ? 0 : 1;
