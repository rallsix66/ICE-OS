#!/usr/bin/env node
/**
 * Build perf-sample-fixture.json with 20 frozen unprefetched items (UUID, revision, quantities, valuation).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  adoptedUnitCostFromFinancial,
  moneyDisplay,
  parseInventoryRpcResult,
  qtyField,
  warehouseScopeView,
} from './perf-fixture-valuation.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runId = process.env.CATALOG_RUN_ID ?? 'run-20261021T100700Z-b3c4d5e6';
const envJson = JSON.parse(fs.readFileSync(path.join(repo, `.local/catalog/${runId}/instance/env.catalog.json`), 'utf8'));
const outPath = path.join(repo, '.local/catalog/ux-perf-u3-20261022/perf-sample-fixture.json');
const iceCodes = JSON.parse(fs.readFileSync(outPath, 'utf8')).unprefetchedIceCodes;

const { default: pg } = await import('pg');
const pool = new pg.Pool({ connectionString: envJson.P0_02_APP_DATABASE_URL });
const ADMIN = '11111111-1111-4111-8111-111111111101';

const WM0043_SELF_CHECK = {
  iceCode: 'WM0043',
  confirmedLineCount: 4,
  confirmedOnHandTotal: '7355',
  unitCostAmount: '2.94',
  estimatedValueCny: '21623.7',
};

async function loadBsNotCreated(client, itemId) {
  const { rows } = await client.query(
    `SELECT EXISTS(
       SELECT 1 FROM catalog.decision_evidence
       WHERE selected_item_id = $1
         AND entry_kind = 'history:batch_bs_not_created'
         AND summary->>'sourceSystem' = 'bigseller'
         AND summary->>'status' = 'user_confirmed_not_created'
     ) AS bs_not_created`,
    [itemId],
  );
  return Boolean(rows[0]?.bs_not_created);
}

async function loadItem(client, iceCode) {
  await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [ADMIN]);
  await client.query('SELECT catalog.require_admin()');
  const itemRow = (await client.query(
    `SELECT i.id AS item_id, c.revision, r.ice_code_snapshot AS ice_code
     FROM catalog.catalog_item i
     JOIN catalog.item_current c ON c.item_id = i.id
     JOIN catalog.item_revision r ON r.item_id = i.id AND r.revision = c.revision
     WHERE r.ice_code_snapshot = $1`,
    [iceCode],
  )).rows[0];
  if (!itemRow) throw new Error(`missing item ${iceCode}`);
  const invRaw = (await client.query(
    `SELECT catalog.read_item_bs_sample_inventory($1, $2) AS result`,
    [itemRow.item_id, null],
  )).rows[0]?.result;
  const invRows = parseInventoryRpcResult(invRaw);
  const financialRaw = (await client.query(
    `SELECT catalog.read_item_amounts($1) AS result`,
    [itemRow.item_id],
  )).rows[0]?.result;
  const financial = typeof financialRaw === 'string' ? JSON.parse(financialRaw) : financialRaw;
  const notCreatedBs = await loadBsNotCreated(client, itemRow.item_id);
  const amountAllowed = true;
  const inventorySlices = invRows.map((r) => ({
    itemId: itemRow.item_id,
    warehouse: String(r.warehouse),
    onHand: qtyField(r.onHand),
    selectionState: String(r.selectionState),
  }));
  const confirmed = invRows.filter((r) => r.selectionState === 'confirmed');
  const inventoryRows = confirmed.map((r) => ({
    warehouse: String(r.warehouse),
    sku: String(r.sku),
    onHand: qtyField(r.onHand),
    orderLocked: qtyField(r.orderLocked),
    warehouseAvailable: qtyField(r.warehouseAvailable),
    activityReserved: qtyField(r.activityReserved),
    inTransit: qtyField(r.inTransit),
  }));
  const valuation = warehouseScopeView(
    inventorySlices,
    itemRow.item_id,
    undefined,
    financial,
    amountAllowed,
    notCreatedBs,
  );
  const adopted = financial ? adoptedUnitCostFromFinancial(financial) : { state: 'missing' };
  const primary = inventoryRows[0] ?? null;
  const unitCost = adopted.state === 'priced' ? moneyDisplay(adopted.amountCny) : null;
  const estimatedValue = valuation.valuationState === 'valued' ? moneyDisplay(valuation.estimatedValueCny) : null;
  return {
    iceCode,
    itemId: itemRow.item_id,
    revision: itemRow.revision,
    warehouse: 'all',
    valuationState: valuation.valuationState,
    valuationReason: valuation.valuationReason,
    estimatedValue,
    unitCost,
    unitCostState: adopted.state,
    confirmedOnHandTotal: valuation.confirmedOnHandTotal,
    confirmedLineCount: valuation.confirmedLineCount,
    inventoryRows,
    onHand: primary?.onHand ?? null,
    orderLocked: primary?.orderLocked ?? null,
    warehouseAvailable: primary?.warehouseAvailable ?? null,
    activityReserved: primary?.activityReserved ?? null,
    inTransit: primary?.inTransit ?? null,
    listExpect: valuation.valuationState === 'valued'
      ? {
        value: estimatedValue,
        inventory: valuation.confirmedOnHandTotal ?? undefined,
      }
      : {
        inventory: valuation.confirmedOnHandTotal ?? undefined,
        valuationMissing: true,
        valuationReason: valuation.valuationReason ?? valuation.valuationState,
      },
  };
}

function assertSelfChecks(items) {
  const wm = items.find((x) => x.iceCode === WM0043_SELF_CHECK.iceCode);
  if (!wm) throw new Error('WM0043 missing from perf fixture set');
  if (wm.inventoryRows.length !== WM0043_SELF_CHECK.confirmedLineCount) {
    throw new Error(`WM0043 inventory row count ${wm.inventoryRows.length} != ${WM0043_SELF_CHECK.confirmedLineCount}`);
  }
  if (wm.confirmedOnHandTotal !== WM0043_SELF_CHECK.confirmedOnHandTotal) {
    throw new Error(`WM0043 on-hand total ${wm.confirmedOnHandTotal} != ${WM0043_SELF_CHECK.confirmedOnHandTotal}`);
  }
  if (wm.unitCost !== moneyDisplay(WM0043_SELF_CHECK.unitCostAmount)) {
    throw new Error(`WM0043 unit cost ${wm.unitCost} != ${moneyDisplay(WM0043_SELF_CHECK.unitCostAmount)}`);
  }
  if (wm.estimatedValue !== moneyDisplay(WM0043_SELF_CHECK.estimatedValueCny)) {
    throw new Error(`WM0043 estimated value ${wm.estimatedValue} != ${moneyDisplay(WM0043_SELF_CHECK.estimatedValueCny)}`);
  }
  for (const item of items) {
    if (item.valuationState === 'valued' && !item.estimatedValue) {
      throw new Error(`${item.iceCode} valued but missing estimatedValue display`);
    }
    if (item.valuationState === 'valued' && item.inventoryRows.length === 0) {
      throw new Error(`${item.iceCode} valued but zero inventory rows`);
    }
  }
}

const client = await pool.connect();
try {
  await client.query('BEGIN READ ONLY');
  const items = [];
  for (const ice of iceCodes.slice(0, 20)) {
    items.push(await loadItem(client, ice));
  }
  assertSelfChecks(items);
  await client.query('ROLLBACK');
  const payload = {
    at: new Date().toISOString(),
    source: 'generate-perf-sample-fixture.mjs',
    generatorSha256: createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
    valuationLibSha256: createHash('sha256').update(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'perf-fixture-valuation.mjs'))).digest('hex'),
    selfChecks: WM0043_SELF_CHECK,
    unprefetchedIceCodes: items.map((x) => x.iceCode),
    items,
  };
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(JSON.stringify({ outPath, count: items.length, sha256: createHash('sha256').update(fs.readFileSync(outPath)).digest('hex') }, null, 2));
} finally {
  client.release();
  await pool.end();
}

const enrich = spawnSync(process.execPath, [
  path.join(repo, 'node_modules/vitest/vitest.mjs'),
  'run',
  'tests/catalog/perf-fixture-enrichment.postgres.test.ts',
  '--config',
  'vitest.config.catalog.mts',
], { cwd: repo, stdio: 'inherit', env: process.env });
if (enrich.status !== 0) process.exit(enrich.status ?? 1);
