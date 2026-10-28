/**
 * R1 fixed-point verification on the repair instance after a real collection + explicit confirmations.
 *
 * Strongest check: the list/detail RPC numbers are compared with the **raw workbook** of the same run
 * (extracted by verify-raw-vs-detail.py), not with hard-coded values. The pinned old-instance values are
 * reported separately as `pinnedDelta` (the real source may have changed; old numbers are never forced).
 *
 * Usage:
 *   python .local/inventory-sync-repair-20261026/verify-raw-vs-detail.py --run-id <run>
 *   node   .local/inventory-sync-repair-20261026/verify-fixed-samples.mjs --run-id <run>
 */
import fs from 'node:fs';
import path from 'node:path';
import { openRun, readArgs } from '../catalog/prepare.mjs';
import { assertConnectedTarget, assertWritableTestTarget } from './test-target-guard.mjs';

const args = readArgs(process.argv.slice(2));
const run = openRun(args);
const inventoryEnv = JSON.parse(fs.readFileSync(path.join(run.instanceRoot, 'env.inventory.json'), 'utf8'));
// Refuse protected/delivered instances before opening any DB connection (F5.3).
const guard = assertWritableTestTarget({ instanceRoot: run.instanceRoot, runId: args.runId, instance: run.instance, env: inventoryEnv, purpose: 'verify-fixed-samples' });
const ADMIN = '11111111-1111-4111-8111-111111111101';
const { default: pg } = await import('pg');
const client = new pg.Client({ connectionString: inventoryEnv.appDbUrl });
await client.connect();
await assertConnectedTarget(client, guard, 'verify-fixed-samples app');
const owner = new pg.Client({ connectionString: inventoryEnv.ownerDbUrl });
await owner.connect();
await assertConnectedTarget(owner, guard, 'verify-fixed-samples owner');
const checks = [];

async function appCall(fn, fnArgs) {
  await client.query('BEGIN');
  try {
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [ADMIN]);
    const placeholders = fnArgs.map((_, index) => `$${index + 1}`).join(', ');
    const result = await client.query(`SELECT ${fn}(${placeholders}) AS result`, fnArgs);
    await client.query('COMMIT');
    return result.rows[0]?.result ?? null;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw error;
  }
}

function record(name, ok, detail) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` —${JSON.stringify(detail)}` : ''}`);
}

const rawPath = path.join(run.root, 'verify', 'raw-fixed-samples.json');
if (!fs.existsSync(rawPath)) throw new Error(`RAW_FIXED_SAMPLES_MISSING: run verify-raw-vs-detail.py first (${rawPath})`);
const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
const skuRows = (await owner.query(
  `SELECT c.ice_code, m.external_sku
   FROM catalog.inventory_sku_mapping m
   JOIN catalog.catalog_item_code c ON c.item_id=m.item_id
   WHERE m.status='confirmed' AND c.ice_code = ANY($1::text[])`,
  [['LS101295', 'LS101302', 'WM0011', 'WM0026', 'WM0049']])).rows;
const skusByIceCode = {};
for (const row of skuRows) (skusByIceCode[row.ice_code] ??= new Set()).add(row.external_sku);

const overview = await appCall('catalog.read_inventory_sync_overview', []);
const scopeWarehouses = overview?.scope?.warehouses ?? [];
const whByExternal = Object.fromEntries(scopeWarehouses.map((w) => [w.externalId, w]));
record('scope still 7 warehouses after real runs', overview?.scope?.warehouseCount === 7 && overview?.scope?.empty === false);
record('latest run success and all 7 warehouses have success time',
  overview?.lastRun?.status === 'success'
  && (overview?.warehouseState ?? []).every((w) => w.lastSuccessAt != null),
  { lastRun: overview?.lastRun?.status });

const FIXED = [
  { iceCode: 'LS101295', pinned: { total: 1028, parts: { 50455: 899, 56519: 129 } } },
  { iceCode: 'LS101302', pinned: { total: 247, parts: { 50455: 247 } } },
  { iceCode: 'WM0011', pinned: { total: 23, parts: { 50455: 23 } } },
  {
    iceCode: 'WM0026',
    pinned: { total: 13069, sameWarehouseRows: { 56519: [3122, 4139] } },
  },
  {
    iceCode: 'WM0049',
    pinned: { total: 122164, sameWarehouseRows: { 56519: [0, 39090] } },
  },
];

const results = [];
for (const sample of FIXED) {
  const skus = skusByIceCode[sample.iceCode] ?? new Set();
  const rawRows = raw.rows.filter((row) => skus.has(row.sku));
  const rawByWarehouse = {};
  for (const row of rawRows) {
    if (!(row.warehouseExternalId in whByExternal)) continue;
    rawByWarehouse[row.warehouseExternalId] = (rawByWarehouse[row.warehouseExternalId] ?? 0) + (row.onHand ?? 0);
  }
  const rawTotal = Object.values(rawByWarehouse).reduce((sum, value) => sum + value, 0);

  const list = await appCall('catalog.read_inventory_list', [sample.iceCode, '', '', 10, 0]);
  const item = (list?.items ?? []).find((entry) => entry.iceCode === sample.iceCode);
  if (!item) { record(`${sample.iceCode} appears in inventory list`, false, { total: list?.total }); continue; }
  const detail = await appCall('catalog.read_inventory_item', [item.itemId, '', '', false]);
  const detailRows = (detail?.warehouses ?? []).flatMap((wh) => (wh.rows ?? []).map((row) => ({ ...row, warehouseExternalId: wh.externalId })));
  const detailByWarehouse = {};
  for (const row of detailRows) detailByWarehouse[row.warehouseExternalId] = (detailByWarehouse[row.warehouseExternalId] ?? 0) + (row.onHand ?? 0);
  const listGroupTotal = (item.unitGroups ?? []).reduce((sum, group) => sum + (group.subtotal ?? 0), 0);
  const matchesRaw = Object.entries(rawByWarehouse).every(([external, expected]) => (detailByWarehouse[external] ?? 0) === expected)
    && Object.keys(detailByWarehouse).every((external) => (rawByWarehouse[external] ?? 0) === detailByWarehouse[external]);
  const sameContext = item.knownSubtotal === detail?.totals?.knownSubtotal
    && item.knownSubtotal === listGroupTotal
    && detail?.scope?.warehouseCount === 7 && detail?.scope?.allWarehouses === false;
  const sameWarehouseOk = Object.entries(sample.pinned.sameWarehouseRows ?? {}).every(([external]) => {
    const actual = detailRows.filter((row) => row.warehouseExternalId === external).map((row) => row.onHand).sort((a, b) => a - b);
    const wanted = rawRows.filter((row) => row.warehouseExternalId === external).map((row) => row.onHand).sort((a, b) => a - b);
    return wanted.length >= 2 && JSON.stringify(actual) === JSON.stringify(wanted);
  });
  const pinnedDelta = {
    pinnedTotal: sample.pinned.total,
    observedTotal: item.knownSubtotal,
    delta: sample.pinned.total != null && item.knownSubtotal != null ? item.knownSubtotal - sample.pinned.total : null,
    note: 'pinned old-instance value vs this real collection; source may have changed since 2026-10-25',
  };
  results.push({
    iceCode: sample.iceCode, itemId: item.itemId,
    rawTotal, listKnownSubtotal: item.knownSubtotal, detailKnownSubtotal: detail?.totals?.knownSubtotal,
    rawByWarehouse, detailByWarehouse, detailRowCount: detailRows.length,
    sameContext, matchesRaw, sameWarehouseOk, pinnedDelta,
    scope: detail?.scope, warnings: detail?.scopedWarnings,
  });
  record(`${sample.iceCode} detail = list = raw workbook (${rawTotal})`,
    sameContext && matchesRaw && rawTotal === item.knownSubtotal, { rawTotal, list: item.knownSubtotal, detail: detail?.totals?.knownSubtotal });
  if (sample.pinned.sameWarehouseRows) {
    record(`${sample.iceCode} same-warehouse multiple SKUs all kept`, sameWarehouseOk,
      detailRows.filter((row) => sample.pinned.sameWarehouseRows[row.warehouseExternalId])
        .map((row) => ({ warehouseExternalId: row.warehouseExternalId, sku: row.externalSku, onHand: row.onHand, raw: rawRows.filter((r) => r.warehouseExternalId === row.warehouseExternalId).map((r) => ({ sku: r.sku, onHand: r.onHand })) })));
  }
  console.log(`INFO ${sample.iceCode} pinnedDelta=${JSON.stringify(pinnedDelta)}`);
}

// Same-context filters: warehouse filter must narrow list and detail to that warehouse.
const vnWarehouse = whByExternal['50455'];
const listVn = await appCall('catalog.read_inventory_list', ['LS101295', vnWarehouse?.id ?? '', '', 5, 0]);
const lsItem = (listVn?.items ?? []).find((entry) => entry.iceCode === 'LS101295');
const detailVn = lsItem ? await appCall('catalog.read_inventory_item', [lsItem.itemId, vnWarehouse?.id ?? '', '', false]) : null;
record('R1 warehouse filter keeps list/detail in the same scope',
  Boolean(lsItem) && lsItem.knownSubtotal === detailVn?.totals?.knownSubtotal && detailVn?.scope?.warehouseCount === 1,
  { listKnownSubtotal: lsItem?.knownSubtotal, detail: detailVn?.totals?.knownSubtotal, scope: detailVn?.scope });

// Market filter: PH must be server-driven and stay in one context.
const listPh = await appCall('catalog.read_inventory_list', ['', '', 'PH', 100, 0]);
const phItems = listPh?.items ?? [];
const phOption = (overview?.marketOptions ?? []).find((m) => m.market === 'PH');
record('R7 market filter is server-driven and scoped to PH warehouses',
  listPh?.scope?.marketFilter === 'PH' && (listPh?.scope?.warehouseCount ?? 0) === phOption?.warehouseCount,
  { marketFilter: listPh?.scope?.marketFilter, warehouseCount: listPh?.scope?.warehouseCount, optionCount: phOption?.warehouseCount });
const phItem = phItems.find((entry) => entry.iceCode === 'LS101295');
const detailPh = phItem ? await appCall('catalog.read_inventory_item', [phItem.itemId, '', 'PH', false]) : null;
record('R7 detail follows the market filter (PH only)',
  Boolean(phItem) && detailPh?.scope?.marketFilter === 'PH' && phItem.knownSubtotal === detailPh?.totals?.knownSubtotal,
  { list: phItem?.knownSubtotal, detail: detailPh?.totals?.knownSubtotal, scope: detailPh?.scope });
const detailAll = phItem ? await appCall('catalog.read_inventory_item', [phItem.itemId, '', '', true]) : null;
record('R1 explicit all-warehouse view is a different, declared context',
  Boolean(detailAll) && detailAll?.scope?.allWarehouses === true && detailAll?.scope?.warehouseCount === 8,
  { allWarehouses: detailAll?.scope?.allWarehouses, warehouseCount: detailAll?.scope?.warehouseCount });

const summary = {
  runId: args.runId,
  rawFile: raw.file,
  finishedAt: new Date().toISOString(),
  overview: { lastRun: overview?.lastRun, scope: overview?.scope, candidates: overview?.candidates, mappings: overview?.mappings },
  results,
  checks,
  allOk: checks.every((check) => check.ok),
};
fs.mkdirSync(path.join(run.root, 'verify'), { recursive: true });
fs.writeFileSync(path.join(run.root, 'verify', 'fixed-sample-verification.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({ allOk: summary.allOk, failed: checks.filter((c) => !c.ok).map((c) => c.name) }, null, 2));
await client.end();
await owner.end();
process.exitCode = summary.allOk ? 0 : 1;


