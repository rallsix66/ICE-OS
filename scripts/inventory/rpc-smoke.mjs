/**
 * Integration smoke for the repair instance RPC surface (R2/R5/R7 before any real collection).
 * Runs as the app role with the fixture admin identity, exactly like the web server actions.
 *
 * Usage: node .local/inventory-sync-repair-20261026/smoke-rpc.mjs --run-id <run>
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openRun, readArgs } from '../catalog/prepare.mjs';
import { assertConnectedTarget, assertWritableTestTarget } from './test-target-guard.mjs';

const args = readArgs(process.argv.slice(2));
const run = openRun(args);
const inventoryEnv = JSON.parse(fs.readFileSync(path.join(run.instanceRoot, 'env.inventory.json'), 'utf8'));
// Refuse protected/delivered instances before opening any DB connection (F5.3).
const guard = assertWritableTestTarget({ instanceRoot: run.instanceRoot, runId: args.runId, instance: run.instance, env: inventoryEnv, purpose: 'rpc-smoke' });
const ADMIN = '11111111-1111-4111-8111-111111111101';
const { default: pg } = await import('pg');
const client = new pg.Client({ connectionString: inventoryEnv.appDbUrl });
await client.connect();
// R4: verify the live server identity READ ONLY before the first write on both app and owner roles.
await assertConnectedTarget(client, guard, 'rpc-smoke app');
const owner = new pg.Client({ connectionString: inventoryEnv.ownerDbUrl });
await owner.connect();
await assertConnectedTarget(owner, guard, 'rpc-smoke owner');
const steps = [];
const intent = (text) => crypto.createHash('sha256').update(text).digest('hex');

async function call(fn, fnArgs = []) {
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

function record(name, ok, detail) {
  steps.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` —${detail}`}`);
}

const initial = await call('catalog.read_inventory_sync_overview');
record('overview loads', initial.ok, initial.error);
const scopeWarehouseIds = initial.result?.scope?.warehouseIds ?? [];
record('initial scope is 7 warehouses, not empty', scopeWarehouseIds.length === 7 && initial.result?.scope?.empty === false);
const mappingAudit = (await owner.query(
  `SELECT count(*)::integer AS confirmed,
          count(*) FILTER (WHERE COALESCE(evidence->>'source','')='manual_confirm' AND actor_id IS NOT NULL)::integer AS explicit,
          count(*) FILTER (WHERE warehouse_id IS NULL)::integer AS account_level
   FROM catalog.inventory_sku_mapping WHERE status='confirmed'`)).rows[0];
record('candidate pool remains and every confirmed mapping is an explicit admin confirmation',
  Number(initial.result?.candidates?.pending) > 0
  && Number(initial.result?.mappings?.confirmed) === Number(mappingAudit.confirmed)
  && Number(mappingAudit.explicit) === Number(mappingAudit.confirmed)
  && Number(mappingAudit.account_level) === 0
  && Number(initial.result?.mappings?.accountLevelIgnored) === 0,
  JSON.stringify({ candidates: initial.result?.candidates, mappings: initial.result?.mappings, mappingAudit }));
record('marketOptions exclude nothing page-derived (>=4 markets, unknown kept null)',
  (initial.result?.marketOptions ?? []).length >= 4
  && (initial.result?.warehouses ?? []).some((w) => w.market === null), JSON.stringify(initial.result?.marketOptions));

// R7: explicit empty scope is persisted as a real scope version; manual sync gets a clear reason.
const emptyReq = randomUUID();
const emptyIntent = intent('settings|enabled=false|interval=60|scopeProvided=true|warehouses=[]');
const emptySave = await call('catalog.update_inventory_sync_settings', [emptyReq, emptyIntent, false, 60, true, []]);
record('R7 empty scope saves', emptySave.ok && emptySave.result?.settings?.scopeEmpty === true,
  JSON.stringify(emptySave.result ?? emptySave.error));
const afterEmpty = await call('catalog.read_inventory_sync_overview');
record('R7 empty scope persists and disables auto publishing',
  afterEmpty.result?.scope?.empty === true && afterEmpty.result?.scope?.warehouseIds?.length === 0
  && afterEmpty.result?.settings?.enabled === false && afterEmpty.result?.settings?.nextRunAt === null,
  JSON.stringify(afterEmpty.result?.scope ?? afterEmpty.error));
const runsBefore = initial.result?.runs?.length ?? 0;
const manualEmptyReq = randomUUID();
const manualEmpty = await call('catalog.request_inventory_manual_sync', [manualEmptyReq, intent('manual|empty')]);
record('R7 manual sync rejected with explicit reason (empty scope / account state)',
  manualEmpty.ok === false && /INVENTORY_SCOPE_EMPTY|INVENTORY_ACCOUNT_NEEDS_LOGIN|INVENTORY_ACCOUNT_DISABLED/.test(String(manualEmpty.error)),
  manualEmpty.error);
const runsAfterEmpty = (await call('catalog.read_inventory_sync_overview')).result?.runs ?? [];
record('R7 empty scope created no new run', runsAfterEmpty.length === runsBefore,
  JSON.stringify({ before: runsBefore, after: runsAfterEmpty.length }));

// Restore the original 7-warehouse participation scope.
const restoreReq = randomUUID();
const restoreIntent = intent(`settings|enabled=false|interval=60|scopeProvided=true|warehouses=${scopeWarehouseIds.join(',')}`);
const restore = await call('catalog.update_inventory_sync_settings', [restoreReq, restoreIntent, false, 60, true, scopeWarehouseIds]);
record('R7 re-selecting warehouses restores the scope',
  restore.ok && restore.result?.settings?.scopeEmpty === false && restore.result?.settings?.warehouseCount === 7,
  JSON.stringify(restore.result ?? restore.error));

// R2: queue search/paging and suggestion provenance.
const queue = await call('catalog.read_inventory_mapping_queue', ['6974674957325', 20, 0]);
record('R2 mapping queue search works', queue.ok && queue.result?.total >= 1,
  JSON.stringify(queue.result?.total ?? queue.error));
const candidateProbe = (await owner.query(
  `SELECT external_sku, w.external_warehouse_id FROM catalog.inventory_mapping_candidate c
   JOIN catalog.inventory_warehouse w ON w.id=c.warehouse_id
   WHERE c.status='pending' AND c.suggested_item_id IS NOT NULL ORDER BY c.created_at LIMIT 1`)).rows[0];
const candidateQueue = candidateProbe
  ? await call('catalog.read_inventory_mapping_queue', [candidateProbe.external_sku, 50, 0])
  : { ok: false, result: null };
const candidateItem = (candidateQueue.result?.items ?? []).find((entry) => entry.externalSku === candidateProbe?.external_sku
  && entry.warehouseExternalId === candidateProbe?.external_warehouse_id);
const first = queue.result?.items?.[0];
record('R2 queue keeps warehouse identity and evidence suggestions for candidates and collection rows',
  Boolean(candidateItem?.candidateId && candidateItem?.candidateStatus === 'pending' && candidateItem?.warehouseExternalId && candidateItem?.suggestion?.itemId)
  && Boolean(first?.warehouseExternalId && first?.warehouseName && (first?.suggestion || first?.candidateId)),
  JSON.stringify({ candidateItem: candidateItem && { sku: candidateItem.externalSku, warehouse: candidateItem.warehouseExternalId, suggestion: candidateItem.suggestion, candidateId: candidateItem.candidateId, candidateStatus: candidateItem.candidateStatus }, first }));
const queuePage = await call('catalog.read_inventory_mapping_queue', ['', 20, 20]);
record('R2 queue paging reaches beyond the first page', queuePage.ok && Number(queuePage.result?.offset) === 20
  && Array.isArray(queuePage.result?.items), JSON.stringify({ total: queuePage.result?.total, offset: queuePage.result?.offset }));

const itemSearch = await call('catalog.search_inventory_items', ['LS101295', 10]);
record('R2 item search finds the catalog item without requiring current stock',
  itemSearch.ok && Array.isArray(itemSearch.result) && itemSearch.result.some((item) => item.iceCode === 'LS101295'),
  JSON.stringify(itemSearch.result ?? itemSearch.error));

// R5: pending lock blocks new writes, reconcile stays read-only, completion releases the lock.
const pendingReq = randomUUID();
const pendingIntent = intent('settings|enabled=false|interval=60|scopeProvided=false');
const begin = await call('catalog.begin_inventory_pending_action', [pendingReq, pendingIntent, 'update_inventory_sync_settings', { enabled: false, intervalMinutes: 60 }]);
record('R5 begin pending stores full payload', begin.ok && begin.result?.ok === true, JSON.stringify(begin.result ?? begin.error));
const blockedReq = randomUUID();
const blocked = await call('catalog.update_inventory_sync_settings', [blockedReq, intent('settings|blocked'), false, 60, false, []]);
record('R5 new write blocked while pending', blocked.ok === false && String(blocked.error).includes('INVENTORY_PENDING_RECOVERY_REQUIRED'),
  blocked.error);
const reconcileMissing = await call('catalog.reconcile_inventory_request', [pendingReq, pendingIntent]);
record('R5 reconcile a never-committed request returns found=false (read-only)', reconcileMissing.ok && reconcileMissing.result?.found === false,
  JSON.stringify(reconcileMissing.result ?? reconcileMissing.error));
const pendingList = await call('catalog.read_inventory_pending_actions');
record('R5 refresh recovery lists the pending action with original payload',
  pendingList.ok && pendingList.result?.items?.some((entry) => entry.requestId === pendingReq && entry.payload?.intervalMinutes === 60),
  JSON.stringify(pendingList.result ?? pendingList.error));
const complete = await call('catalog.complete_inventory_pending_action', [pendingReq, 'failed', null, 'SMOKE_ABANDONED']);
record('R5 completing pending releases the lock', complete.ok && complete.result?.ok === true, JSON.stringify(complete.result ?? complete.error));
const afterComplete = await call('catalog.update_inventory_sync_settings', [randomUUID(), intent('settings|after-pending'), false, 60, false, []]);
record('R5 write accepted after pending resolved', afterComplete.ok === true, afterComplete.error);

// Read surfaces (no batch yet) still answer with the expected shape; candidate items are listed with
// hasCurrentData=false so the page can lead into the mapping review, never as published inventory.
const list = await call('catalog.read_inventory_list', ['', '', '', 50, 0]);
record('R1 list returns shaped payload before any batch (candidate items flagged, no fake 0)',
  list.ok && Array.isArray(list.result?.items) && Array.isArray(list.result?.marketOptions)
  && (list.result?.items ?? []).every((item) => item.hasCurrentData === false || item.knownSubtotal !== 0),
  JSON.stringify({ total: list.result?.total, first: list.result?.items?.[0] && { iceCode: list.result.items[0].iceCode, hasCurrentData: list.result.items[0].hasCurrentData } }));

const summary = { runId: args.runId, finishedAt: new Date().toISOString(), steps, allOk: steps.every((step) => step.ok) };
fs.mkdirSync(path.join(run.root, 'verify'), { recursive: true });
fs.writeFileSync(path.join(run.root, 'verify', 'smoke-rpc.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({ allOk: summary.allOk, failed: steps.filter((step) => !step.ok).map((step) => step.name) }, null, 2));
await client.end();
await owner.end();
process.exitCode = summary.allOk ? 0 : 1;




