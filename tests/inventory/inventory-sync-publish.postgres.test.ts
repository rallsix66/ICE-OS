/* eslint-disable @typescript-eslint/no-explicit-any -- PG RPC JSON is dynamic; test-only helper */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { Harness } from './helpers/repair-fixture';

let h: Harness;
let WM0011: string; let WM0049: string;
const iso = (v: any) => new Date(v).toISOString();

afterEach(async () => { if (h) await h.clearTestState(); });

beforeAll(async () => {
  h = new Harness();
  await h.open();
  const codes: Record<string, string> = Object.fromEntries(
    (await h.itemCodes()).map((r: any) => [r.ice_code, r.item_id]));
  WM0011 = codes.WM0011; WM0049 = codes.WM0049;
  await h.registerWorker();
});

afterAll(async () => {
  if (h) { await h.restore(); await h.close(); }
});

async function setupWarehouses() {
  const a = await h.makeWarehouse('PUB-A', { market: 'PH', status: 'confirmed' });
  const b = await h.makeWarehouse('PUB-B', { market: 'MY', status: 'confirmed' });
  await h.setScope([a, b]);
  return { a, b };
}

describe('R3 complete-warehouse publish gates', () => {
  it('publish refuses unverified/missing identity and blocked file validation', async () => {
    const wh = await h.makeWarehouse('IDENT', { market: 'PH', status: 'confirmed' });
    await h.setScope([wh]);
    const sku = `IDENT-${h.suffix}`;
    const rows = [h.row(2, wh.external_warehouse_id, sku, 1)];
    // missing identity label
    const { runId, lease } = await h.startRun();
    const missing = await h.registerExport(runId, lease, h.exportPayload(rows, {
      identity: { label: null, verified: false } }));
    expect(missing.accountIdentityStatus).toBe('missing');
    await h.expectSyncError('publish_inventory_warehouse',
      [runId, lease, { warehouseId: wh.id, rowCount: 1 }, rows], 'INVENTORY_IDENTITY_UNVERIFIED:missing');
    await h.fail(runId, lease, 'TEST_CLEANUP');
    // mismatched label
    const mismatchRun = await h.startRun();
    const mismatch = await h.registerExport(mismatchRun.runId, mismatchRun.lease, h.exportPayload(rows, {
      identity: { label: 'other-account', verified: true } }));
    expect(mismatch.accountIdentityStatus).toBe('mismatch');
    await h.expectSyncError('publish_inventory_warehouse',
      [mismatchRun.runId, mismatchRun.lease, { warehouseId: wh.id, rowCount: 1 }, rows],
      'INVENTORY_IDENTITY_UNVERIFIED:mismatch');
    await h.fail(mismatchRun.runId, mismatchRun.lease, 'TEST_CLEANUP');
    // verified flag false cannot be upgraded by a matching label
    const notVerifiedRun = await h.startRun();
    const notVerified = await h.registerExport(notVerifiedRun.runId, notVerifiedRun.lease,
      h.exportPayload(rows, { identity: { label: 'laiguoyong@KNZX019402', verified: false } }));
    expect(notVerified.accountIdentityStatus).toBe('mismatch');
    await h.fail(notVerifiedRun.runId, notVerifiedRun.lease, 'TEST_CLEANUP');
    // file validation blocked
    const blockedRun = await h.startRun();
    await h.registerExport(blockedRun.runId, blockedRun.lease, h.exportPayload(rows, {
      fileValidation: { blocked: true, reason: 'HEADER_AMBIGUOUS' } }));
    await h.expectSyncError('publish_inventory_warehouse',
      [blockedRun.runId, blockedRun.lease, { warehouseId: wh.id, rowCount: 1 }, rows],
      'INVENTORY_FILE_VALIDATION_BLOCKED');
    await h.fail(blockedRun.runId, blockedRun.lease, 'TEST_CLEANUP');
    // missing export_finished_at is rejected at registration (no now() substitution)
    const noTimeRun = await h.startRun();
    const payload = h.exportPayload(rows);
    delete (payload as any).exportFinishedAt;
    await h.expectSyncError('register_inventory_export',
      [noTimeRun.runId, noTimeRun.lease, payload], 'INVENTORY_EXPORT_TIME_MISSING');
    await h.fail(noTimeRun.runId, noTimeRun.lease, 'TEST_CLEANUP');
  });

  it('file-level defects (missing warehouse, combo sku) block every warehouse in the file', async () => {
    const { a, b } = await setupWarehouses();
    const rows = [
      h.row(2, a.external_warehouse_id, `MISSINGWH-${h.suffix}`, 1),
      h.row(3, null, `NOWH-${h.suffix}`, 2, { parseStatus: 'missing_warehouse', reason: 'no warehouse' }),
    ];
    const { runId, lease } = await h.startRun();
    await h.registerExport(runId, lease, h.exportPayload(rows));
    await h.expectSyncError('publish_inventory_warehouse',
      [runId, lease, { warehouseId: a.id, rowCount: 1 }, [rows[0]]], 'INVENTORY_FILE_BLOCKED');
    await h.expectSyncError('publish_inventory_warehouse',
      [runId, lease, { warehouseId: b.id, rowCount: 0 }, []], 'INVENTORY_FILE_BLOCKED');
    await h.fail(runId, lease, 'TEST_CLEANUP');
    // combo sku also blocks the whole file
    const comboRun = await h.startRun();
    const comboRows = [
      h.row(4, a.external_warehouse_id, `COMBO-${h.suffix}`, 1, { parseStatus: 'combo_sku', reason: 'combo' }),
      h.row(5, b.external_warehouse_id, `COMBO-B-${h.suffix}`, 2),
    ];
    await h.registerExport(comboRun.runId, comboRun.lease, h.exportPayload(comboRows));
    await h.expectSyncError('publish_inventory_warehouse',
      [comboRun.runId, comboRun.lease, { warehouseId: b.id, rowCount: 1 }, [comboRows[1]]],
      'INVENTORY_FILE_BLOCKED');
    await h.fail(comboRun.runId, comboRun.lease, 'TEST_CLEANUP');
  });

  it('publish verifies the exact registered row set (excelRow + rowHash), not a filtered subset', async () => {
    const wh = await h.makeWarehouse('EXACT', { market: 'PH', status: 'confirmed' });
    await h.setScope([wh]);
    const rows = [h.row(2, wh.external_warehouse_id, `EXACT-A-${h.suffix}`, 1),
      h.row(3, wh.external_warehouse_id, `EXACT-B-${h.suffix}`, 2)];
    const { runId, lease } = await h.startRun();
    await h.registerExport(runId, lease, h.exportPayload(rows));
    await h.expectSyncError('publish_inventory_warehouse',
      [runId, lease, { warehouseId: wh.id, rowCount: 1 }, [rows[0]]], 'INVENTORY_WAREHOUSE_INCOMPLETE');
    // an extra, unregistered row also breaks the exact-set comparison
    const extra = h.row(99, wh.external_warehouse_id, `EXACT-EXTRA-${h.suffix}`, 3);
    await h.expectSyncError('publish_inventory_warehouse',
      [runId, lease, { warehouseId: wh.id, rowCount: 3 }, [rows[0], rows[1], extra]],
      'INVENTORY_WAREHOUSE_INCOMPLETE');
    const altered = { ...rows[0], rowHash: 'f'.repeat(64) };
    await h.expectSyncError('publish_inventory_warehouse',
      [runId, lease, { warehouseId: wh.id, rowCount: 2 }, [altered, rows[1]]], 'INVENTORY_WAREHOUSE_INCOMPLETE');
    const ok = await h.publish(runId, lease, wh.id, rows);
    expect(ok.rowCount).toBe(2);
    // publishing the same warehouse again replays instead of duplicating (before finish/lease end)
    const replay = await h.publish(runId, lease, wh.id, rows);
    expect(replay.replayed).toBe(true);
    expect(replay.batchId).toBe(ok.batchId);
    await h.expectSyncError('publish_inventory_warehouse',
      [runId, lease, { warehouseId: wh.id, rowCount: 2 },
        [rows[0], { ...rows[1], rowHash: 'e'.repeat(64) }]], 'INVENTORY_BATCH_CONFLICT');
    await h.finish(runId, lease, 'success');
  });

  it('rejects out-of-scope / unconfirmed / undiscovered warehouses and rows with bad payload', async () => {
    const { a, b } = await setupWarehouses();
    const outsider = await h.makeWarehouse('OUTSIDE', { market: 'TH', status: 'confirmed' });
    const candidate = await h.makeWarehouse('CAND', { market: 'TH', status: 'candidate' });
    const rows = [h.row(2, a.external_warehouse_id, `SCOPE-${h.suffix}`, 1)];
    const { runId, lease } = await h.startRun();
    await h.registerExport(runId, lease, h.exportPayload(rows, {
      discovery: [{ externalId: a.external_warehouse_id, name: 'A' }] }));
    await h.expectSyncError('publish_inventory_warehouse',
      [runId, lease, { warehouseId: outsider.id, rowCount: 1 }, rows], 'INVENTORY_WAREHOUSE_OUT_OF_SCOPE');
    await h.expectSyncError('publish_inventory_warehouse',
      [runId, lease, { warehouseId: candidate.id, rowCount: 1 }, rows], 'INVENTORY_WAREHOUSE_OUT_OF_SCOPE');
    await h.expectSyncError('publish_inventory_warehouse',
      [runId, lease, { warehouseId: b.id, rowCount: 1 }, rows], 'INVENTORY_WAREHOUSE_OUT_OF_SCOPE');
    // duplicate SKU and invalid typed quantities inside the row payload
    const dupSkuRows = [h.row(2, a.external_warehouse_id, `DUP-${h.suffix}`, 1),
      h.row(3, a.external_warehouse_id, `DUP-${h.suffix}`, 2)];
    await h.expectSyncError('publish_inventory_warehouse',
      [runId, lease, { warehouseId: a.id, rowCount: 2 }, dupSkuRows], 'INVENTORY_WAREHOUSE_INCOMPLETE');
    const badQty = { ...rows[0], onHand: 'not-a-number' };
    await h.expectSyncError('publish_inventory_warehouse',
      [runId, lease, { warehouseId: a.id, rowCount: 1 }, [badQty]], 'INVENTORY_INVALID_ROW');
    await h.fail(runId, lease, 'TEST_CLEANUP');
  });

  it('a warehouse with an invalid registered row is blocked while other warehouses can succeed', async () => {
    const { a, b } = await setupWarehouses();
    const rows = [
      h.row(2, a.external_warehouse_id, `PART-A-${h.suffix}`, 3),
      h.row(3, b.external_warehouse_id, `PART-B-${h.suffix}`, 4, { parseStatus: 'invalid_quantity', reason: 'qty' }),
    ];
    const { runId, lease } = await h.startRun();
    await h.registerExport(runId, lease, h.exportPayload(rows));
    await h.publish(runId, lease, a.id, [rows[0]]);
    await h.expectSyncError('publish_inventory_warehouse',
      [runId, lease, { warehouseId: b.id, rowCount: 0 }, []], 'INVENTORY_WAREHOUSE_BLOCKED');
    const finished = await h.finish(runId, lease, 'partial', {
      warehouseResults: [
        { warehouseId: a.id, status: 'published', errorCode: null },
        { warehouseId: b.id, status: 'blocked', errorCode: 'INVENTORY_WAREHOUSE_BLOCKED' },
      ],
    });
    expect(finished.status).toBe('partial');
    expect(finished.publishedWarehouses).toBe(1);
    expect(finished.scopeAllSuccess).toBe(false);
    // per-warehouse row issues are exposed for the web run detail
    const detail = await h.runDetail(runId);
    const whA = detail.warehouses.find((w: any) => w.warehouseId === a.id);
    const whB = detail.warehouses.find((w: any) => w.warehouseId === b.id);
    expect(whA.invalidRows).toBe(0);
    expect(whA.duplicateSkuRows).toBe(0);
    expect(whB.invalidRows).toBe(1);
    expect(whB.duplicateSkuRows).toBe(0);
    expect(whB.errorCode).toContain('INVENTORY_WAREHOUSE_BLOCKED');
  });

  it('publish rechecks the frozen scope: removing a warehouse in settings blocks publishing it later', async () => {
    const a = await h.makeWarehouse('FROZ-A', { market: 'PH', status: 'confirmed' });
    const b = await h.makeWarehouse('FROZ-B', { market: 'MY', status: 'confirmed' });
    await h.setScope([a, b]);
    const rows = [h.row(2, a.external_warehouse_id, `FROZ-A-${h.suffix}`, 1),
      h.row(3, b.external_warehouse_id, `FROZ-B-${h.suffix}`, 2)];
    const { runId, lease } = await h.startRun();
    await h.registerExport(runId, lease, h.exportPayload(rows));
    await h.setScope([a]); // b is removed -> candidate
    await h.publish(runId, lease, a.id, [rows[0]]);
    await h.expectSyncError('publish_inventory_warehouse',
      [runId, lease, { warehouseId: b.id, rowCount: 1 }, [rows[1]]], 'INVENTORY_WAREHOUSE_OUT_OF_SCOPE');
    await h.finish(runId, lease, 'partial');
  });
});

describe('R4 capture identity / replay / recovery / observation time', () => {
  it('two different runs with identical file bytes both succeed; the same run with different bytes conflicts', async () => {
    const wh = await h.makeWarehouse('SHA', { market: 'PH', status: 'confirmed' });
    await h.setScope([wh]);
    const sku = `SHA-${h.suffix}`;
    await h.confirmMappings([{ sku, warehouseExternalId: wh.external_warehouse_id, itemId: WM0011, unit: '件' }]);
    const rows = [h.row(2, wh.external_warehouse_id, sku, 10)];
    const payload = h.exportPayload(rows, { sha: 'c'.repeat(64),
      exportFinishedAt: new Date('2026-10-23T00:10:00.000Z').toISOString() });
    const first = await h.publishRun({ warehouses: [wh], rows, sha: payload.file.sha256,
      exportFinishedAt: payload.exportFinishedAt, exportMark: 'identical-bytes-1' });
    expect(first.finished.status).toBe('success');
    const second = await h.publishRun({ warehouses: [wh], rows, sha: payload.file.sha256,
      exportFinishedAt: new Date('2026-10-23T01:10:00.000Z').toISOString(), exportMark: 'identical-bytes-2' });
    expect(second.finished.status).toBe('success');
    expect(second.receipt.file.fileId).not.toBe(first.receipt.file.fileId);
    // same run, different content -> conflict; same content -> original receipt (no new file)
    const { runId, lease } = await h.startRun();
    await h.registerExport(runId, lease, h.exportPayload(rows, { sha: 'd'.repeat(64) }));
    await h.expectSyncError('register_inventory_export',
      [runId, lease, h.exportPayload(rows, { sha: 'e'.repeat(64) })], 'INVENTORY_EXPORT_CONFLICT');
    const replay = await h.registerExport(runId, lease, h.exportPayload([
      h.row(9, wh.external_warehouse_id, `OTHER-${h.suffix}`, 99)], { sha: 'd'.repeat(64) }));
    expect(replay.rows).toHaveLength(1);
    expect(replay.rows[0].externalSku).toBe(`SHA-${h.suffix}`);
    expect(replay.file.sha256).toBe('d'.repeat(64));
    await h.fail(runId, lease, 'TEST_CLEANUP');
  });

  it('recovery keeps the original exportFinishedAt and never rewrites it as now()', async () => {
    const wh = await h.makeWarehouse('RECOVER', { market: 'PH', status: 'confirmed' });
    await h.setScope([wh]);
    const oldExportFinished = new Date('2026-10-20T05:00:00.000Z').toISOString();
    const rows = [h.row(2, wh.external_warehouse_id, `REC-${h.suffix}`, 12)];
    const { runId, lease } = await h.startRun();
    const payload = h.exportPayload(rows, { exportFinishedAt: oldExportFinished, exportMark: 'recovered-file' });
    const receipt = await h.registerExport(runId, lease, payload);
    expect(iso(receipt.exportFinishedAt)).toBe(iso(oldExportFinished));
    const published = await h.publish(runId, lease, wh.id, rows);
    expect(iso(published.observationAt)).toBe(iso(oldExportFinished));
    // replaying the registration after a restart returns the same observation time
    const replayReceipt = await h.registerExport(runId, lease, payload);
    expect(iso(replayReceipt.exportFinishedAt)).toBe(iso(oldExportFinished));
    expect(replayReceipt.file.fileId).toBe(receipt.file.fileId);
    const runDetail = await h.runDetail(runId);
    expect(iso(runDetail.exportFinishedAt)).toBe(iso(oldExportFinished));
    expect(iso(runDetail.observationAt)).toBe(iso(oldExportFinished));
    const batch = await h.bootOne(`SELECT observation_at,source_row_count FROM catalog.inventory_batch
      WHERE run_id=$1 AND warehouse_id=$2`, [runId, wh.id]);
    expect(new Date(batch.observation_at).toISOString()).toBe(oldExportFinished);
    expect(batch.source_row_count).toBe(1);
    await h.finish(runId, lease, 'success');
  });

  it('an older observation is stored but never advances success or all-green', async () => {
    const wh = await h.makeWarehouse('OLD-OBS', { market: 'PH', status: 'confirmed' });
    await h.setScope([wh]);
    const sku = `OLD-${h.suffix}`;
    await h.confirmMappings([{ sku, warehouseExternalId: wh.external_warehouse_id, itemId: WM0049, unit: '件' }]);
    const newer = await h.publishRun({ warehouses: [wh], rows: [h.row(2, wh.external_warehouse_id, sku, 500)],
      exportFinishedAt: new Date('2026-10-25T00:10:00.000Z').toISOString() });
    expect(newer.finished.status).toBe('success');
    const overviewBefore = await h.overview();
    const older = await h.publishRun({ warehouses: [wh], rows: [h.row(2, wh.external_warehouse_id, sku, 100)],
      exportFinishedAt: new Date('2026-10-24T00:10:00.000Z').toISOString() });
    expect(iso(older.published[0].observationAt)).toBe(iso('2026-10-24T00:10:00.000Z'));
    expect(older.published[0].observationStale).toBe(true);
    expect(older.published[0].successRecorded).toBe(false);
    expect(older.finished.status).not.toBe('success');
    expect(older.finished.scopeAllSuccess).toBe(false);
    // current read model keeps the newer successful observation, not the stale replay
    expect((await h.listItem(WM0049)).knownSubtotal).toBe(500);
    const overviewAfter = await h.overview();
    expect(iso(overviewAfter.scopeLastAllSuccessAt)).toBe(iso(overviewBefore.scopeLastAllSuccessAt));
    const state = await h.bootOne(`SELECT last_observation_at,last_success_run_id
      FROM catalog.inventory_warehouse_state WHERE account_id=$1 AND warehouse_id=$2`, [h.accountId, wh.id]);
    expect(new Date(state.last_observation_at).toISOString()).toBe(iso(overviewBefore.warehouseState
      .find((w: any) => w.warehouseId === wh.id).lastObservationAt));
    expect(state.last_success_run_id).toBe(newer.runId);
  });

  it('an expired lease cannot be used by the old worker; the re-claimed run stays owned once', async () => {
    const wh = await h.makeWarehouse('LEASE', { market: 'PH', status: 'confirmed' });
    await h.setScope([wh]);
    const rows = [h.row(2, wh.external_warehouse_id, `LEASE-${h.suffix}`, 1)];
    const { runId, lease } = await h.startRun();
    await h.registerExport(runId, lease, h.exportPayload(rows));
    await h.bootQuery(`UPDATE catalog.inventory_sync_run SET lease_expires_at=now()-interval '1 minute'
      WHERE id=$1`, [runId]);
    const reclaimed = await h.syncCall('claim_inventory_run', [`second-worker-${h.suffix}`, 120]);
    expect(reclaimed.runId).toBe(runId);
    expect(reclaimed.attempt).toBe(2);
    expect(reclaimed.leaseToken).not.toBe(lease);
    await h.expectSyncError('publish_inventory_warehouse',
      [runId, lease, { warehouseId: wh.id, rowCount: 1 }, rows], 'INVENTORY_LEASE_LOST');
    const published = await h.publish(runId, reclaimed.leaseToken, wh.id, rows);
    expect(published.ok).toBe(true);
    await h.finish(runId, reclaimed.leaseToken, 'success');
  });

  it('finish forces failed when identity is not verified even if warehouses published', async () => {
    const wh = await h.makeWarehouse('FINFAIL', { market: 'PH', status: 'confirmed' });
    await h.setScope([wh]);
    const rows = [h.row(2, wh.external_warehouse_id, `FINFAIL-${h.suffix}`, 1)];
    const { runId, lease } = await h.startRun();
    await h.registerExport(runId, lease, h.exportPayload(rows, {
      identity: { label: null, verified: false } }));
    await h.expectSyncError('publish_inventory_warehouse',
      [runId, lease, { warehouseId: wh.id, rowCount: 1 }, rows], 'INVENTORY_IDENTITY_UNVERIFIED');
    const finished = await h.finish(runId, lease, 'failed');
    expect(finished.status).toBe('failed');
    expect(finished.scopeAllSuccess).toBe(false);
  });
});
