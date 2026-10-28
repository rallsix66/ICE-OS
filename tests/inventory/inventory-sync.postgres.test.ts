/* eslint-disable @typescript-eslint/no-explicit-any -- PG RPC JSON is dynamic; test-only helper */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { Harness, ADMIN_ID, OPERATOR_ID, INACTIVE_ADMIN_ID, randomId, intentHash } from './helpers/repair-fixture';

let h: Harness;
let LS101295: string; let LS101302: string; let WM0011: string; let WM0026: string; let WM0049: string;

afterEach(async () => { if (h) await h.clearTestState(); });

beforeAll(async () => {
  h = new Harness();
  await h.open();
  const codes: Record<string, string> = Object.fromEntries(
    (await h.itemCodes()).map((r: any) => [r.ice_code, r.item_id]));
  LS101295 = codes.LS101295; LS101302 = codes.LS101302; WM0011 = codes.WM0011;
  WM0026 = codes.WM0026; WM0049 = codes.WM0049;
  await h.registerWorker();
});

afterAll(async () => {
  if (h) { await h.restore(); await h.close(); }
});

describe('repair v2 DB schema and interfaces', () => {
  it('fresh 016 structure has the v2 tables/columns, no global sha uniqueness and version handshake', async () => {
    const tables = (await h.bootQuery(
      `SELECT tablename FROM pg_tables WHERE schemaname='catalog' AND tablename LIKE 'inventory_%'`))
      .map((r: any) => r.tablename);
    for (const t of ['inventory_source_account', 'inventory_warehouse', 'inventory_scope',
      'inventory_sync_settings', 'inventory_sync_run', 'inventory_export_file', 'inventory_run_row',
      'inventory_variant', 'inventory_sku_mapping', 'inventory_mapping_candidate', 'inventory_batch',
      'inventory_batch_row', 'inventory_current', 'inventory_warehouse_state', 'inventory_scope_state',
      'inventory_request', 'inventory_pending_action', 'inventory_audit', 'inventory_worker',
      'inventory_schema_state']) {
      expect(tables, `missing ${t}`).toContain(t);
    }
    const state = await h.bootOne(`SELECT version,source_sha256,functions_sha256,upgraded_from
      FROM catalog.inventory_schema_state WHERE id`);
    expect(state.version).toBe(5);
    // A raw psql apply leaves 'pending'/'unmanaged'; prepare-instance.mjs writes the real file hash
    // after applying structure + functions, so both states are valid here.
    expect(state.source_sha256 === 'pending' || state.source_sha256 === 'unmanaged'
      || /^[a-f0-9]{64}$/.test(state.source_sha256)).toBe(true);
    expect(state.functions_sha256 === 'pending' || state.functions_sha256 === 'unmanaged'
      || /^[a-f0-9]{64}$/.test(state.functions_sha256)).toBe(true);
    const cols = async (table: string) => (await h.bootQuery(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='catalog' AND table_name=$1`,
      [table])).map((r: any) => r.column_name);
    expect(await cols('inventory_sync_run')).toEqual(expect.arrayContaining(
      ['account_identity_status', 'account_identity_label', 'file_validation', 'warehouse_discovery', 'source_row_count']));
    expect(await cols('inventory_batch')).toEqual(expect.arrayContaining(['observation_at', 'source_row_count']));
    expect(await cols('inventory_batch_row')).toEqual(expect.arrayContaining(['excel_row', 'item_revision']));
    expect(await cols('inventory_warehouse')).toEqual(expect.arrayContaining(['market', 'market_evidence']));
    const variantUnit = await h.bootOne(
      `SELECT is_nullable,column_default FROM information_schema.columns
       WHERE table_schema='catalog' AND table_name='inventory_variant' AND column_name='unit'`);
    expect(variantUnit.is_nullable).toBe('YES');
    expect(variantUnit.column_default).toBeNull();
    const shaIdx = await h.bootQuery(
      `SELECT indexdef FROM pg_indexes WHERE schemaname='catalog' AND tablename='inventory_export_file'
        AND indexname='inventory_export_file_sha_idx'`);
    expect(shaIdx).toHaveLength(1);
    expect(shaIdx[0].indexdef).not.toContain('UNIQUE');
    const statusCheck = (await h.bootOne(
      `SELECT pg_get_constraintdef(con.oid) def FROM pg_constraint con
       JOIN pg_class rel ON rel.oid=con.conrelid JOIN pg_namespace n ON n.oid=rel.relnamespace
       WHERE n.nspname='catalog' AND rel.relname='inventory_sku_mapping' AND con.contype='c'
        AND pg_get_constraintdef(con.oid) LIKE '%status%'`)).def;
    expect(statusCheck).toContain('recheck');
    const scopeEmpty = await h.bootOne(
      `SELECT pg_get_constraintdef(con.oid) def FROM pg_constraint con
       JOIN pg_class rel ON rel.oid=con.conrelid JOIN pg_namespace n ON n.oid=rel.relnamespace
       WHERE n.nspname='catalog' AND rel.relname='inventory_scope' AND con.contype='c'
        AND pg_get_constraintdef(con.oid) LIKE '%warehouse_ids%'`);
    expect(scopeEmpty).toBeNull();
  });

  it('app and sync execution surfaces stay disjoint (repair v2 additions included)', async () => {
    const holds = async (role: string, fn: string) => (await h.bootOne(
      `SELECT has_function_privilege($1,$2,'EXECUTE') AS ok`, [role, fn])).ok;
    const appFns = [
      'catalog.read_inventory_sync_overview()',
      'catalog.read_inventory_sync_run(uuid)',
      'catalog.update_inventory_sync_settings(uuid,text,boolean,integer,boolean,text[])',
      'catalog.request_inventory_manual_sync(uuid,text)',
      'catalog.read_inventory_mapping_queue(text,integer,integer)',
      'catalog.confirm_inventory_mapping(uuid,text,jsonb)',
      'catalog.recheck_inventory_mapping(uuid,text,uuid,text,integer)',
      'catalog.disable_inventory_mapping(uuid,text,uuid,text,integer)',
      'catalog.read_inventory_list(text,text,text,integer,integer)',
      'catalog.read_inventory_item(uuid,text,text,boolean)',
      'catalog.search_inventory_items(text,integer)',
      'catalog.read_inventory_pending_actions()',
      'catalog.begin_inventory_pending_action(uuid,text,text,jsonb)',
      'catalog.complete_inventory_pending_action(uuid,text,jsonb,text)',
      'catalog.settle_inventory_pending_action(uuid,text,text,jsonb,text)',
      'catalog.reconcile_inventory_request(uuid,text)',
    ];
    for (const fn of appFns) expect(await holds('ice_p0_02_app_runner', fn), fn).toBe(true);
    const syncOnly = [
      'catalog.register_inventory_worker(text,text,integer,text)',
      'catalog.refresh_inventory_account_status(text,boolean,text)',
      'catalog.claim_inventory_run(text,integer)',
      'catalog.update_inventory_run_phase(uuid,uuid,text,jsonb)',
      'catalog.register_inventory_export(uuid,uuid,jsonb)',
      'catalog.publish_inventory_warehouse(uuid,uuid,jsonb,jsonb)',
      'catalog.finish_inventory_run(uuid,uuid,text,jsonb)',
      'catalog.fail_inventory_run(uuid,uuid,text,text,boolean,boolean)',
      'catalog.read_inventory_run_work(uuid,uuid)',
    ];
    for (const fn of syncOnly) {
      expect(await holds('ice_p0_02_sync_runner', fn), fn).toBe(true);
      expect(await holds('ice_p0_02_app_runner', fn), fn).toBe(false);
    }
    expect(await holds('ice_p0_02_sync_runner', 'catalog.read_inventory_list(text,text,text,integer,integer)')).toBe(false);
    expect(await holds('ice_p0_02_app_runner', 'catalog.claim_inventory_run(text,integer)')).toBe(false);
    // runtime roles may at most SELECT public projection tables; never DML history/evidence and
    // never read the private amount table.
    for (const role of ['ice_p0_02_app_runner', 'ice_p0_02_sync_runner']) {
      const amount = await h.bootOne(
        `SELECT has_table_privilege($1,'catalog_private.inventory_run_row_amount','SELECT')
          OR has_table_privilege($1,'catalog_private.inventory_run_row_amount','INSERT')
          OR has_table_privilege($1,'catalog_private.inventory_run_row_amount','UPDATE')
          OR has_table_privilege($1,'catalog_private.inventory_run_row_amount','DELETE') AS any_priv`, [role]);
      expect(amount.any_priv, `${role} private amount`).toBe(false);
      for (const table of ['catalog.inventory_batch_row', 'catalog.inventory_run_row',
        'catalog.inventory_batch', 'catalog.inventory_export_file', 'catalog.inventory_current']) {
        const dml = await h.bootOne(
          `SELECT has_table_privilege($1,$2,'INSERT') OR has_table_privilege($1,$2,'UPDATE')
            OR has_table_privilege($1,$2,'DELETE') AS any_dml`,
          [role, table]);
        expect(dml.any_dml, `${role} ${table} DML`).toBe(false);
      }
    }
    for (const identity of [OPERATOR_ID, INACTIVE_ADMIN_ID]) {
      await h.adminSetIdentity(identity);
      await h.expectError('read_inventory_sync_overview', [], /FORBIDDEN/);
      await h.expectError('read_inventory_list', [null, null, null, 10, 0], /FORBIDDEN/);
      await h.expectError('search_inventory_items', ['LS', 10], /FORBIDDEN/);
      await h.expectError('begin_inventory_pending_action', [randomId(), intentHash(), 'x', {}], /FORBIDDEN/);
    }
    await h.adminSetIdentity(ADMIN_ID);
  });

  it('definer-owner RLS policy does not open direct app-role table access (negative)', async () => {
    // No JWT claim: FORCE RLS still hides every inventory row from the app role. The new
    // inventory_definer_owner policy only matches SECURITY DEFINER execution as ice_p0_02_owner.
    await h.admin.query(`SELECT set_config('request.jwt.claim.sub','',false)`);
    const noJwt = await h.admin.query(
      `SELECT count(*)::integer AS c FROM catalog.inventory_warehouse`);
    expect(noJwt.rows[0].c).toBe(0);
    const noJwtMappings = await h.admin.query(
      `SELECT count(*)::integer AS c FROM catalog.inventory_sku_mapping`);
    expect(noJwtMappings.rows[0].c).toBe(0);
    // non-admin operator identity also sees nothing
    await h.admin.query(`SELECT set_config('request.jwt.claim.sub',$1,false)`, [OPERATOR_ID]);
    const operator = await h.admin.query(
      `SELECT count(*)::integer AS c FROM catalog.inventory_warehouse`);
    expect(operator.rows[0].c).toBe(0);
    // private amount table stays permission-denied even though it also has the owner policy
    await expect(h.admin.query(
      `SELECT count(*) FROM catalog_private.inventory_run_row_amount`))
      .rejects.toThrow(/permission denied/i);
    // app role cannot escalate to the package owner role
    let roleError: any = null;
    try { await h.admin.query(`SET ROLE ice_p0_02_owner`); } catch (error: any) { roleError = error; }
    await h.admin.query('RESET ROLE').catch(() => undefined);
    expect(roleError).not.toBeNull();
    expect(String(roleError.message)).toMatch(/permission denied|cannot set|not member/i);
    // the admin JWT path is unchanged (enabled_admin policy)
    await h.adminSetIdentity(ADMIN_ID);
    const adminRows = await h.admin.query(
      `SELECT count(*)::integer AS c FROM catalog.inventory_warehouse`);
    expect(adminRows.rows[0].c).toBeGreaterThan(0);
  });

  it('settings distinguish "do not change scope" from explicit empty scope (R7)', async () => {
    const w1 = await h.makeWarehouse('S1', { market: 'PH', status: 'confirmed' });
    const w2 = await h.makeWarehouse('S2', { market: 'MY', status: 'confirmed' });
    const saved = await h.setScope([w1, w2]);
    expect(saved.ok).toBe(true);
    expect(saved.settings.scopeEmpty).toBe(false);
    expect(saved.settings.warehouseCount).toBe(2);
    const same = await h.appCall('update_inventory_sync_settings',
      [randomId(), intentHash(), true, 45, false, []]);
    expect(same.settings.scopeVersion).toBe(saved.settings.scopeVersion);
    expect(same.settings.intervalMinutes).toBe(45);
    expect(same.changed).not.toContain('scope');
    const cleared = await h.appCall('update_inventory_sync_settings',
      [randomId(), intentHash(), true, 45, true, []]);
    expect(cleared.settings.scopeEmpty).toBe(true);
    expect(cleared.settings.enabled).toBe(false);
    expect(cleared.settings.nextRunAt).toBeNull();
    expect(cleared.changed).toEqual(expect.arrayContaining(['scope', 'scopeEmpty']));
    const overview = await h.overview();
    expect(overview.scope.empty).toBe(true);
    expect(overview.settings.enabled).toBe(false);
    // R7: the selection list is the account's full warehouse list even when the scope is empty,
    // so the UI can re-select warehouses after an explicit clear.
    expect(overview.warehouses.some((w: any) => w.externalId === w1.external_warehouse_id)).toBe(true);
    expect(overview.warehouses.some((w: any) => w.externalId === w2.external_warehouse_id)).toBe(true);
    expect(overview.warehouses.find((w: any) => w.externalId === w1.external_warehouse_id))
      .toEqual(expect.objectContaining({ status: 'candidate', market: 'PH' }));
    expect(overview.scope.warehouseCount).toBe(0);
    await h.expectError('request_inventory_manual_sync', [randomId(), intentHash()], 'INVENTORY_SCOPE_EMPTY');
    expect((await h.syncCall('claim_inventory_run', [h.workerId, 120])).reason).toBe('scope_empty');
    const restored = await h.setScope([w1]);
    expect(restored.settings.scopeEmpty).toBe(false);
    expect(restored.settings.enabled).toBe(true);
    const run = await h.startRun();
    expect(run.runId).toBeTruthy();
    await h.fail(run.runId, run.lease, 'TEST_CLEANUP');
  });

  it('all-green requires every scope warehouse last_success_run_id = this run', async () => {
    const w1 = await h.makeWarehouse('G1', { market: 'PH', status: 'confirmed' });
    const w2 = await h.makeWarehouse('G2', { market: 'MY', status: 'confirmed' });
    await h.setScope([w1, w2]);
    const rows = [h.row(2, w1.external_warehouse_id, `G1-${h.suffix}`, 5),
      h.row(3, w2.external_warehouse_id, `G2-${h.suffix}`, 7)];
    const { runId, lease } = await h.startRun();
    await h.registerExport(runId, lease, h.exportPayload(rows));
    await h.publish(runId, lease, w1.id, [rows[0]]);
    const partial = await h.finish(runId, lease, 'success');
    expect(partial.status).toBe('partial');
    expect(partial.scopeAllSuccess).toBe(false);
    expect(partial.publishedWarehouses).toBe(1);
    expect(partial.scopeWarehouseCount).toBe(2);
    const w2run = await h.publishRun({ warehouses: [w2], rows: [h.row(4, w2.external_warehouse_id, `G2-${h.suffix}`, 8)] });
    expect(w2run.finished.status).toBe('partial');
    const full = await h.publishRun({
      warehouses: [w1, w2],
      rows: [h.row(2, w1.external_warehouse_id, `G1-${h.suffix}`, 6),
        h.row(3, w2.external_warehouse_id, `G2-${h.suffix}`, 9)],
    });
    expect(full.finished.status).toBe('success');
    expect(full.finished.scopeAllSuccess).toBe(true);
    const overview = await h.overview();
    expect(overview.scopeLastAllSuccessAt).toBe(full.finished.observationAt);
  });
});

describe('R1 effective-row read model', () => {
  it('pinned LS101295/LS101302/WM0011/WM0026/WM0049 quantities are counted once (no account-level double join, no LIMIT 1)', async () => {
    const ph = await h.makeWarehouse('R1PH', { market: 'PH', status: 'confirmed', name: 'PH-彩妆日均万单简简单单仓' });
    const vn = await h.makeWarehouse('R1VN', { market: 'VN', status: 'confirmed', name: '越南青林湾仓库' });
    const my = await h.makeWarehouse('R1MY', { market: 'MY', status: 'confirmed', name: '喜运达MY仓' });
    await h.setScope([ph, vn, my]);
    const skuLsA = `LS101295-PH-${h.suffix}`;
    const skuLsB = `LS101295-VN-${h.suffix}`;
    const skuM26a = `WM0026-PH-a-${h.suffix}`;
    const skuM26b = `WM0026-PH-b-${h.suffix}`;
    const skuM49a = `WM0049-PH-a-${h.suffix}`;
    const skuM49b = `WM0049-PH-b-${h.suffix}`;
    const skuM11 = `WM0011-VN-${h.suffix}`;
    const skuLs302 = `LS101302-VN-${h.suffix}`;
    const confirmed = await h.confirmMappings([
      { sku: skuLsA, warehouseExternalId: ph.external_warehouse_id, itemId: LS101295 },
      { sku: skuLsB, warehouseExternalId: vn.external_warehouse_id, itemId: LS101295 },
      { sku: skuM26a, warehouseExternalId: my.external_warehouse_id, itemId: WM0026 },
      { sku: skuM26b, warehouseExternalId: my.external_warehouse_id, itemId: WM0026 },
      { sku: skuM49a, warehouseExternalId: ph.external_warehouse_id, itemId: WM0049 },
      { sku: skuM49b, warehouseExternalId: ph.external_warehouse_id, itemId: WM0049 },
      { sku: skuM11, warehouseExternalId: vn.external_warehouse_id, itemId: WM0011 },
      { sku: skuLs302, warehouseExternalId: vn.external_warehouse_id, itemId: LS101302 },
    ]);
    expect(confirmed.applied).toBe(8);
    const variantId = (await h.bootOne(
      `INSERT INTO catalog.inventory_variant(item_id,variant_key,unit) VALUES($1,$2,'件') RETURNING id`,
      [LS101295, `legacy-${h.suffix}-${randomId().slice(0, 8)}`])).id;
    await h.bootQuery(
      `INSERT INTO catalog.inventory_sku_mapping(account_id,warehouse_id,external_sku,item_id,variant_id,
        unit,status,version,evidence)
       VALUES($1,NULL,$2,$3,$4,'件','confirmed',1,'{"source":"legacy_account_default"}'::jsonb)`,
      [h.accountId, skuLsA, LS101295, variantId]);
    const rows = [
      h.row(2, ph.external_warehouse_id, skuLsA, 129),
      h.row(3, vn.external_warehouse_id, skuLsB, 899),
      h.row(4, my.external_warehouse_id, skuM26a, 3122),
      h.row(5, my.external_warehouse_id, skuM26b, 4139),
      h.row(6, ph.external_warehouse_id, skuM49a, 0),
      h.row(7, ph.external_warehouse_id, skuM49b, 39090),
      h.row(8, vn.external_warehouse_id, skuM11, 23),
      h.row(9, vn.external_warehouse_id, skuLs302, 247),
    ];
    const run = await h.publishRun({ warehouses: [ph, vn, my], rows });
    expect(run.finished.status).toBe('success');
    const ls = await h.listItem(LS101295);
    expect(ls.knownSubtotal).toBe(1028);
    expect(ls.unitGroups).toHaveLength(1);
    expect(ls.unitGroups[0].subtotal).toBe(1028);
    expect(ls.warehouseCount).toBe(2);
    expect((await h.listItem(LS101302)).knownSubtotal).toBe(247);
    expect((await h.listItem(WM0011)).knownSubtotal).toBe(23);
    const m26 = await h.listItem(WM0026);
    expect(m26.knownSubtotal).toBe(7261);
    expect(m26.unitGroups[0].subtotal).toBe(7261);
    expect((await h.listItem(WM0049)).knownSubtotal).toBe(39090);
    const d26 = await h.detail(WM0026, my.id, null, false);
    expect(d26.warehouses).toHaveLength(1);
    expect(d26.warehouses[0].status).toBe('current');
    expect(d26.warehouses[0].rows).toHaveLength(2);
    expect(d26.totals.knownSubtotal).toBe(7261);
    expect(d26.totals.byUnit[0].subtotal).toBe(7261);
    const d49 = await h.detail(WM0049, ph.id, null, false);
    expect(d49.warehouses[0].rows).toHaveLength(2);
    expect(d49.totals.knownSubtotal).toBe(39090);
    const dLs = await h.detail(LS101295, null, null, false);
    // F2: detail covers the whole selected scope, including warehouses without a mapping/current row.
    expect(dLs.warehouses).toHaveLength(3);
    expect(dLs.warehouses.filter((w: any) => w.status === 'current')).toHaveLength(2);
    expect(dLs.warehouses.filter((w: any) => w.status === 'not_mapped').length).toBeGreaterThanOrEqual(1);
    expect(dLs.coverage).toEqual({ scopeWarehouses: 3, coveredWarehouses: 2 });
    expect(dLs.totals.knownSubtotal).toBe(1028);
    expect(ls.coverage).toEqual({ scopeWarehouses: 3, coveredWarehouses: 2 });
    expect(ls.markets).toEqual(['PH', 'VN']);
    expect(ls.hasUnknownMarket).toBe(false);
    const phOnly = await h.list(null, ph.id, null, 200, 0);
    expect(phOnly.items.find((i: any) => i.itemId === LS101295).knownSubtotal).toBe(129);
    expect(phOnly.items.find((i: any) => i.itemId === LS101295).warehouseCount).toBe(1);
    const marketPh = await h.list(null, null, 'PH', 200, 0);
    expect(marketPh.items.find((i: any) => i.itemId === LS101295).knownSubtotal).toBe(129);
    const marketMy = await h.list(null, null, 'MY', 200, 0);
    expect(marketMy.items.find((i: any) => i.itemId === WM0026).knownSubtotal).toBe(7261);
    expect(marketMy.items.find((i: any) => i.itemId === LS101295)).toBeUndefined();
    const search = await h.list(skuLsA, null, null, 50, 0);
    expect(search.items.map((i: any) => i.itemId)).toContain(LS101295);
  });

  it('same warehouse multiple SKUs with incompatible units hide the total but keep per-unit groups', async () => {
    const wh = await h.makeWarehouse('UNIT', { market: 'PH', status: 'confirmed' });
    await h.setScope([wh]);
    const skuA = `UNIT-A-${h.suffix}`; const skuB = `UNIT-B-${h.suffix}`;
    await h.confirmMappings([
      { sku: skuA, warehouseExternalId: wh.external_warehouse_id, itemId: WM0026, unit: '件', variantKey: 'each' },
      { sku: skuB, warehouseExternalId: wh.external_warehouse_id, itemId: WM0026, unit: '箱', variantKey: 'box' },
    ]);
    const run = await h.publishRun({ warehouses: [wh], rows: [
      h.row(2, wh.external_warehouse_id, skuA, 100), h.row(3, wh.external_warehouse_id, skuB, 3)] });
    expect(run.finished.status).toBe('success');
    const list = await h.listItem(WM0026);
    expect(list.unitConflict).toBe(true);
    expect(list.knownSubtotal).toBeNull();
    expect(list.unitGroups).toHaveLength(2);
    const detail = await h.detail(WM0026, wh.id, null, false);
    expect(detail.totals.unitConflict).toBe(true);
    expect(detail.totals.knownSubtotal).toBeNull();
    expect(detail.warehouses[0].rows).toHaveLength(2);
    expect(detail.scopedWarnings.join(' ')).toContain('单位');
  });

  it('a rebind waits for the next complete batch: no old quantity is moved to the new item', async () => {
    const wh = await h.makeWarehouse('REBIND', { market: 'MY', status: 'confirmed' });
    await h.setScope([wh]);
    const sku = `REBIND-${h.suffix}`;
    await h.confirmMappings([{ sku, warehouseExternalId: wh.external_warehouse_id, itemId: WM0011, unit: '件' }]);
    await h.publishRun({ warehouses: [wh], rows: [h.row(2, wh.external_warehouse_id, sku, 66)] });
    expect((await h.listItem(WM0011)).knownSubtotal).toBe(66);
    const mapping = await h.bootOne(
      `SELECT id,version FROM catalog.inventory_sku_mapping
       WHERE account_id=$1 AND external_sku=$2 AND status='confirmed' ORDER BY version DESC LIMIT 1`,
      [h.accountId, sku]);
    const rebound = await h.confirmMappings([{
      sku, warehouseExternalId: wh.external_warehouse_id, itemId: WM0049, unit: '件',
      expectedVersion: mapping.version,
    }]);
    expect(rebound.applied).toBe(1);
    const oldItem = (await h.listItem(WM0011)) ?? { knownSubtotal: null, hasCurrentData: false, unseenWarehouses: [] };
    expect(oldItem.hasCurrentData).toBe(false);
    expect(oldItem.knownSubtotal).toBeNull();
    const newItem = await h.listItem(WM0049);
    expect(newItem.hasCurrentData).toBe(false);
    expect(newItem.unseenWarehouses.length).toBeGreaterThan(0);
    expect(newItem.unseenWarehouses[0].lastKnownQty ?? null).toBeNull();
    await h.publishRun({ warehouses: [wh], rows: [h.row(3, wh.external_warehouse_id, sku, 77)] });
    expect((await h.listItem(WM0049)).knownSubtotal).toBe(77);
    const oldAgain = (await h.listItem(WM0011)) ?? { hasCurrentData: false };
    expect(oldAgain.hasCurrentData).toBe(false);
  });

  it('a missing row in the latest complete batch is 本次未见 with last known value, never current', async () => {
    const wh = await h.makeWarehouse('MISS', { market: 'PH', status: 'confirmed' });
    await h.setScope([wh]);
    const skuA = `MISS-A-${h.suffix}`; const skuB = `MISS-B-${h.suffix}`;
    await h.confirmMappings([
      { sku: skuA, warehouseExternalId: wh.external_warehouse_id, itemId: WM0049, unit: '件' },
      { sku: skuB, warehouseExternalId: wh.external_warehouse_id, itemId: LS101302, unit: '件' },
    ]);
    await h.publishRun({ warehouses: [wh], rows: [
      h.row(2, wh.external_warehouse_id, skuA, 11), h.row(3, wh.external_warehouse_id, skuB, 22)] });
    expect((await h.listItem(LS101302)).knownSubtotal).toBe(22);
    await h.publishRun({ warehouses: [wh], rows: [h.row(4, wh.external_warehouse_id, skuA, 33)],
      exportFinishedAt: new Date('2026-10-21T00:10:00.000Z').toISOString() });
    expect((await h.listItem(WM0049)).knownSubtotal).toBe(33);
    const unseen = await h.listItem(LS101302);
    expect(unseen.hasCurrentData).toBe(false);
    expect(unseen.knownSubtotal).toBeNull();
    expect(unseen.unseenWarehouses).toHaveLength(1);
    expect(unseen.unseenWarehouses[0].lastKnownQty).toBe(22);
    expect(unseen.unseenWarehouses[0].lastKnownObservedAt).toBeTruthy();
    const detail = await h.detail(LS101302, wh.id, null, false);
    expect(detail.warehouses[0].status).toBe('unseen');
    expect(detail.warehouses[0].rows ?? []).toHaveLength(0);
    expect(detail.scopedWarnings.join(' ')).toContain('本次未见');
  });

  it('a failed warehouse keeps its old value (stale) while a good warehouse succeeds independently', async () => {
    const good = await h.makeWarehouse('FAIL-GOOD', { market: 'MY', status: 'confirmed' });
    const bad = await h.makeWarehouse('FAIL-BAD', { market: 'PH', status: 'confirmed' });
    await h.setScope([good, bad]);
    const skuGood = `FG-${h.suffix}`; const skuBad = `FB-${h.suffix}`;
    await h.confirmMappings([
      { sku: skuGood, warehouseExternalId: good.external_warehouse_id, itemId: WM0011, unit: '件' },
      { sku: skuBad, warehouseExternalId: bad.external_warehouse_id, itemId: WM0049, unit: '件' },
    ]);
    await h.publishRun({ warehouses: [good, bad], rows: [
      h.row(2, good.external_warehouse_id, skuGood, 10), h.row(3, bad.external_warehouse_id, skuBad, 20)] });
    const overviewBefore = await h.overview();
    const { runId, lease } = await h.startRun();
    const badRow = h.row(2, bad.external_warehouse_id, skuBad, 999, { parseStatus: 'invalid_quantity', reason: 'qty' });
    const goodRow = h.row(3, good.external_warehouse_id, skuGood, 30);
    const payload = h.exportPayload([badRow, goodRow], {
      exportFinishedAt: new Date('2026-10-22T00:10:00.000Z').toISOString(),
      fileValidation: { blocked: false, invalidRowCount: 1 },
    });
    await h.registerExport(runId, lease, payload);
    await h.publish(runId, lease, good.id, [goodRow]);
    await h.expectSyncError('publish_inventory_warehouse',
      [runId, lease, { warehouseId: bad.id, rowCount: 1 }, [h.row(5, bad.external_warehouse_id, skuBad, 999)]],
      'INVENTORY_WAREHOUSE_BLOCKED');
    const finished = await h.finish(runId, lease, 'partial', {
      warehouseResults: [
        { warehouseId: good.id, status: 'published', errorCode: null },
        { warehouseId: bad.id, status: 'blocked', errorCode: 'INVENTORY_WAREHOUSE_BLOCKED' },
      ],
    });
    expect(finished.status).toBe('partial');
    expect((await h.listItem(WM0011)).knownSubtotal).toBe(30);
    const badItem = await h.listItem(WM0049);
    expect(badItem.knownSubtotal).toBe(20);
    expect(badItem.failedWarehouses.length).toBe(1);
    expect(badItem.failedWarehouses[0].lastErrorCode).toContain('INVENTORY_WAREHOUSE_BLOCKED');
    const detail = await h.detail(WM0049, bad.id, null, false);
    expect(detail.warehouses[0].status).toBe('failed');
    expect(detail.warehouses[0].reason).toBe('failed');
    expect(detail.warehouses[0].stale).toBe(true);
    expect(detail.warehouses[0].rows[0].onHand).toBe(20);
    const overviewAfter = await h.overview();
    expect(new Date(overviewAfter.scopeLastAllSuccessAt).toISOString())
      .toBe(new Date(overviewBefore.scopeLastAllSuccessAt).toISOString());
    expect(overviewAfter.warehouseState.some((w: any) => w.warehouseId === bad.id && w.failed)).toBe(true);
  });

  it('disabling or rechecking a mapping removes it from current inventory immediately', async () => {
    const wh = await h.makeWarehouse('MAPEXIT', { market: 'VN', status: 'confirmed' });
    await h.setScope([wh]);
    const sku = `MEXIT-${h.suffix}`;
    await h.confirmMappings([{ sku, warehouseExternalId: wh.external_warehouse_id, itemId: LS101302, unit: '件' }]);
    await h.publishRun({ warehouses: [wh], rows: [h.row(2, wh.external_warehouse_id, sku, 44)] });
    expect((await h.listItem(LS101302)).knownSubtotal).toBe(44);
    const mapping = await h.bootOne(
      `SELECT id,version FROM catalog.inventory_sku_mapping WHERE account_id=$1 AND external_sku=$2
        AND status='confirmed' ORDER BY version DESC LIMIT 1`, [h.accountId, sku]);
    const rechecked = await h.appCall('recheck_inventory_mapping', [
      randomId(), intentHash(), mapping.id, 'fixture recheck', mapping.version]);
    expect(rechecked.status).toBe('recheck');
    const afterRecheck = await h.listItem(LS101302);
    expect(afterRecheck.hasCurrentData).toBe(false);
    expect(afterRecheck.notMappedWarehouses.length).toBeGreaterThan(0);
    await h.confirmMappings([{ sku, warehouseExternalId: wh.external_warehouse_id, itemId: LS101302,
      unit: '件', expectedVersion: mapping.version }]);
    await h.publishRun({ warehouses: [wh], rows: [h.row(3, wh.external_warehouse_id, sku, 45)] });
    expect((await h.listItem(LS101302)).knownSubtotal).toBe(45);
    const current = await h.bootOne(
      `SELECT id,version FROM catalog.inventory_sku_mapping WHERE account_id=$1 AND external_sku=$2
        AND status='confirmed' ORDER BY version DESC LIMIT 1`, [h.accountId, sku]);
    const disabled = await h.appCall('disable_inventory_mapping', [
      randomId(), intentHash(), current.id, 'fixture disable', current.version]);
    expect(disabled.status).toBe('disabled');
    expect((await h.listItem(LS101302)).hasCurrentData).toBe(false);
  });

  it('overview/run detail/list expose the repair fields the web needs', async () => {
    const wh = await h.makeWarehouse('UI', { market: 'PH', status: 'confirmed' });
    await h.setScope([wh]);
    const sku = `UI-${h.suffix}`;
    await h.confirmMappings([{ sku, warehouseExternalId: wh.external_warehouse_id, itemId: WM0026, unit: '件' }]);
    const run = await h.publishRun({ warehouses: [wh], rows: [
      h.row(2, wh.external_warehouse_id, sku, 8, { gtin: '6974674957325' })] });
    const overview = await h.overview();
    expect(overview.scope).toHaveProperty('warehouseCount');
    expect(overview.scope).toHaveProperty('lastAllSuccessAt');
    expect(overview.marketOptions.some((m: any) => m.market === 'PH')).toBe(true);
    // market options only come from the current scope (never from excluded / out-of-scope warehouses)
    expect(overview.marketOptions.every((m: any) => m.market === 'PH')).toBe(true);
    expect((await h.list(null, null, null, 50, 0)).marketOptions.every((m: any) => m.market === 'PH')).toBe(true);
    expect(overview.warehouseState.find((w: any) => w.warehouseId === wh.id)).toHaveProperty('stale');
    expect(overview.mappings).toHaveProperty('confirmed');
    expect(overview.mappings).toHaveProperty('accountLevelIgnored');
    expect(overview.candidates).toHaveProperty('pending');
    expect(overview.pendingAction ?? null).toBeNull();
    const detail = await h.runDetail(run.runId);
    expect(detail.accountIdentityStatus).toBe('verified');
    expect(new Date(detail.observationAt).toISOString()).toBe(new Date(run.payload.exportFinishedAt).toISOString());
    expect(detail.accountIdentityLabel).toBe('laiguoyong@KNZX019402');
    expect(detail.fileValidation.blocked).toBe(false);
    expect(detail.warehouseDiscovery).toHaveLength(1);
    expect(detail.sourceRowCount).toBe(1);
    expect(detail.warehouses[0].status).toBe('published');
    expect(new Date(detail.warehouses[0].observationAt).toISOString())
      .toBe(new Date(run.payload.exportFinishedAt).toISOString());
    expect(detail.file.storageRelpath).toContain('fixtures/');
    expect(detail.groups[0].warehouseId).toBe(wh.id);
    const list = await h.listItem(WM0026);
    expect(list.gtin).toBe('6974674957325');
    expect(new Date(list.lastObservedAt).toISOString()).toBe(new Date(run.payload.exportFinishedAt).toISOString());
    expect(Array.isArray(list.failedWarehouses)).toBe(true);
    expect(Array.isArray(list.unseenWarehouses)).toBe(true);
    expect(Array.isArray(list.notMappedWarehouses)).toBe(true);
    expect((await h.searchItems('6974674957325')).some((i: any) => i.itemId === WM0026)).toBe(true);
    expect((await h.searchItems(sku)).some((i: any) => i.itemId === WM0026)).toBe(true);
    expect(await h.searchItems('', 1)).toHaveLength(1);
    const live = await h.startRun();
    const work = await h.syncCall('read_inventory_run_work', [live.runId, live.lease]);
    expect(work.warehouseDiscovery).toEqual([]);
    expect(work).toHaveProperty('exportFinishedAt');
    await h.fail(live.runId, live.lease, 'TEST_CLEANUP');
  });
  it('F2 historical previousOnHand uses the adjacent earlier observation and publish stores the item revision', async () => {
    const wh = await h.makeWarehouse('F2H', { market: 'VN', status: 'confirmed', name: '越南青林湾仓库' });
    await h.setScope([wh]);
    const sku49 = `F2-49-${h.suffix}`;
    const item49 = await h.itemId('WM0049');
    await h.confirmMappings([{ sku: sku49, warehouseExternalId: wh.external_warehouse_id, itemId: item49 }]);
    const t1 = '2026-10-26T03:29:45.675Z';
    const t2 = '2026-10-26T03:31:13.035Z';
    await h.publishRun({ warehouses: [wh], exportFinishedAt: t1,
      rows: [h.row(2, wh.external_warehouse_id, sku49, 83025)] });
    await h.publishRun({ warehouses: [wh], exportFinishedAt: t2,
      rows: [h.row(3, wh.external_warehouse_id, sku49, 83022)] });
    const d49 = await h.detail(item49, wh.id, null, false);
    expect(d49.history[0].onHand).toBe(83022);
    expect(d49.history[0].previousOnHand).toBe(83025);
    expect(d49.history[1].onHand).toBe(83025);
    expect(d49.history[1].previousOnHand).toBeNull();
    const rev: any = await h.bootOne(
      `SELECT br.item_revision,ic.revision AS current_revision
       FROM catalog.inventory_batch_row br
       JOIN catalog.inventory_batch b ON b.id=br.batch_id
       JOIN catalog.item_current ic ON ic.item_id=br.item_id
       WHERE br.external_sku=$1 ORDER BY b.observation_at DESC,b.id DESC LIMIT 1`, [sku49]);
    expect(rev.item_revision).not.toBeNull();
    expect(rev.item_revision).toBe(rev.current_revision);
    // same quantity in the next observation: previousOnHand must be 2001, not an early frozen value
    const sku26 = `F2-26-${h.suffix}`;
    const item26 = await h.itemId('WM0026');
    await h.confirmMappings([{ sku: sku26, warehouseExternalId: wh.external_warehouse_id, itemId: item26 }]);
    await h.publishRun({ warehouses: [wh], exportFinishedAt: '2026-10-26T03:40:00.000Z',
      rows: [h.row(4, wh.external_warehouse_id, sku26, 2001)] });
    await h.publishRun({ warehouses: [wh], exportFinishedAt: '2026-10-26T03:41:00.000Z',
      rows: [h.row(5, wh.external_warehouse_id, sku26, 2001)] });
    const d26 = await h.detail(item26, wh.id, null, false);
    expect(d26.history[0].onHand).toBe(2001);
    expect(d26.history[0].previousOnHand).toBe(2001);
  });

  it('F2 coverage lists every scope warehouse with distinct gap reasons/markets', async () => {
    const whs: any[] = [];
    for (let i = 0; i < 7; i += 1) {
      whs.push(await h.makeWarehouse(`F2C${i}`, { market: i === 0 ? null : 'PH', status: 'confirmed' }));
    }
    await h.setScope(whs);
    const item = await h.itemId('WM0026');
    const mapped = whs.slice(0, 5);
    const mappings = mapped.map((w: any, i: number) => ({
      sku: `F2C-${i}-${h.suffix}`, warehouseExternalId: w.external_warehouse_id, itemId: item,
    }));
    expect((await h.confirmMappings(mappings)).applied).toBe(5);
    const pendingSku = `F2C-PENDING-${h.suffix}`;
    await h.bootQuery(
      `INSERT INTO catalog.inventory_mapping_candidate(account_id,warehouse_id,external_sku,
        suggested_item_id,evidence,status) VALUES($1,$2,$3,$4,$5::jsonb,'pending')`,
      [h.accountId, whs[5].id, pendingSku, item, JSON.stringify({ label: 'has source, not mapped' })]);
    const rows = mapped.map((w: any, i: number) =>
      h.row(10 + i, w.external_warehouse_id, `F2C-${i}-${h.suffix}`, 1));
    // whs[5] has a real source row but no confirmed mapping -> unmapped_source; whs[6] has neither.
    rows.push(h.row(20, whs[5].external_warehouse_id, pendingSku, 2));
    const run = await h.publishRun({ warehouses: mapped, rows,
      publishOnly: mapped.map((w: any) => w.external_warehouse_id) });
    expect(run.finished.status).toBe('partial');
    const list = await h.listItem(item);
    expect(list.coverage).toEqual({ scopeWarehouses: 7, coveredWarehouses: 5 });
    const reasons = list.notMappedWarehouses.map((w: any) => w.reason).sort();
    expect(reasons).toEqual(['no_source', 'unmapped_source']);
    expect(list.markets).toEqual(['PH']);
    expect(list.hasUnknownMarket).toBe(true);
    const detail = await h.detail(item, null, null, false);
    expect(detail.warehouses).toHaveLength(7);
    expect(detail.warehouses.filter((w: any) => w.status === 'current')).toHaveLength(5);
    expect(detail.warehouses.filter((w: any) => w.status === 'not_mapped')).toHaveLength(2);
    expect(detail.warehouses.every((w: any) => Object.prototype.hasOwnProperty.call(w, 'reason'))).toBe(true);
    expect(detail.coverage).toEqual(list.coverage);
  });

  it('F3 publish binds registered source content; same excelRow/hash changed quantity or SKU is rejected', async () => {
    const wh = await h.makeWarehouse('F3', { market: 'PH', status: 'confirmed' });
    await h.setScope([wh]);
    const sku = `F3-${h.suffix}`;
    const item = await h.itemId('WM0011');
    await h.confirmMappings([{ sku, warehouseExternalId: wh.external_warehouse_id, itemId: item }]);
    await h.publishRun({ warehouses: [wh], rows: [h.row(2, wh.external_warehouse_id, sku, 10)] });
    const run = await h.startRun();
    const rows = [h.row(2, wh.external_warehouse_id, sku, 20)];
    await h.registerExport(run.runId, run.lease, h.exportPayload(rows));
    const qtyTampered = [{ ...rows[0], onHand: 999, rawOnHand: '999',
      warehouseAvailable: 999, rawWarehouseAvailable: '999' }];
    await h.expectSyncError('publish_inventory_warehouse',
      [run.runId, run.lease, { warehouseId: wh.id, rowCount: 1 }, qtyTampered],
      'INVENTORY_WAREHOUSE_CONTENT_MISMATCH');
    expect(await h.bootOne(
      `SELECT count(*)::integer AS n FROM catalog.inventory_batch WHERE run_id=$1`, [run.runId]))
      .toEqual({ n: 0 });
    const current: any = await h.bootOne(
      `SELECT on_hand FROM catalog.inventory_current WHERE warehouse_id=$1 AND external_sku=$2`,
      [wh.id, sku]);
    expect(current.on_hand).toBe(10);
    const skuTampered = [{ ...rows[0], externalSku: `${sku}-SWAP` }];
    await h.expectSyncError('publish_inventory_warehouse',
      [run.runId, run.lease, { warehouseId: wh.id, rowCount: 1 }, skuTampered],
      'INVENTORY_WAREHOUSE_CONTENT_MISMATCH');
    await h.fail(run.runId, run.lease, 'TEST_CLEANUP');
  });
});

describe('R1 v4 source presence and same-warehouse partial gap', () => {
  it('a current adopted SKU does not hide another known-code source row in the same warehouse (not counted)', async () => {
    const wMain = await h.makeWarehouse('R1V4-MAIN', { market: 'TH', status: 'confirmed' });
    const wOther = await h.makeWarehouse('R1V4-OTHER', { market: 'MY', status: 'confirmed' });
    await h.setScope([wMain, wOther]);
    const item = WM0026;
    const skuA = `R1V4-A-${h.suffix}`;
    const skuB = `R1V4-B-${h.suffix}`;
    // A is mapped in this warehouse; B is a known code (confirmed in the other warehouse) that also appears
    // in this warehouse's latest source file but has no mapping here -> pending attribution.
    expect((await h.confirmMappings([
      { sku: skuA, warehouseExternalId: wMain.external_warehouse_id, itemId: item },
      { sku: skuB, warehouseExternalId: wOther.external_warehouse_id, itemId: item },
    ])).applied).toBe(2);
    const rows = [
      h.row(21, wMain.external_warehouse_id, skuA, 10),
      h.row(22, wMain.external_warehouse_id, skuB, 0),
      h.row(23, wOther.external_warehouse_id, skuB, 7),
    ];
    const run = await h.publishRun({ warehouses: [wMain, wOther], rows });
    expect(run.finished.status).toBe('success');
    const list = await h.listItem(item);
    // adopted totals only include the mapped rows (10 + 7); the unmapped 0 is NOT counted and NOT a fake 0.
    expect(list.knownSubtotal).toBe(17);
    expect(list.coverage).toEqual({ scopeWarehouses: 2, coveredWarehouses: 2 });
    expect(list.notMappedWarehouses).toHaveLength(0);
    expect(list.hasPendingSourceWarehouses).toBe(true);
    expect(list.pendingSourceWarehouses).toHaveLength(1);
    const pending = list.pendingSourceWarehouses[0];
    expect(pending.warehouseId).toBe(wMain.id);
    expect(pending.sourceRowCount).toBe(2);
    expect(pending.pendingSourceRowCount).toBe(1);
    expect(pending.pendingSkus).toEqual([skuB]);
    expect(pending.mappedSkus).toEqual([skuA]);
    const pendingRow = pending.pendingSourceRows.find((row: any) => row.externalSku === skuB);
    expect(pendingRow).toMatchObject({ externalSku: skuB, excelRow: 22, onHand: 0, mapped: false });
    expect(pendingRow.mappingId).toBeNull();
    // detail carries the same summary explanation plus per-warehouse pending rows / adopted SKUs.
    const detail = await h.detail(item, null, null, false);
    expect(detail.warehouses).toHaveLength(2);
    expect(detail.coverage).toEqual(list.coverage);
    expect(detail.hasPendingSourceWarehouses).toBe(true);
    expect(detail.pendingSourceWarehouses).toEqual(list.pendingSourceWarehouses);
    const mainWh = detail.warehouses.find((w: any) => w.warehouseId === wMain.id);
    expect(mainWh.status).toBe('current');
    expect(mainWh.reason).toBeNull();
    expect(mainWh.adoptedSkus).toEqual([skuA]);
    // A published + mapped row is adopted: nothing is waiting for the next complete batch.
    expect(mainWh.pendingAdoptionSkus).toEqual([]);
    expect(mainWh.mappedSkus).toEqual([skuA]);
    expect(mainWh.pendingSourceRowCount).toBe(1);
    const detailPending = mainWh.pendingSourceRows.filter((row: any) => row.mapped === false);
    expect(detailPending).toHaveLength(1);
    expect(detailPending[0]).toMatchObject({ externalSku: skuB, excelRow: 22, onHand: 0 });
    const otherWh = detail.warehouses.find((w: any) => w.warehouseId === wOther.id);
    expect(otherWh.pendingSourceRowCount).toBe(0);
    expect(otherWh.adoptedSkus).toEqual([skuB]);
    expect(otherWh.pendingAdoptionSkus).toEqual([]);
    // status is not masked: the current warehouse stays "current", never not_mapped/unseen.
    expect(detail.warehouses.some((w: any) => w.warehouseId === wMain.id && w.status === 'current')).toBe(true);
  });

  it('a known code sourced in a warehouse without its own candidate is unmapped_source; a truly absent code is no_source', async () => {
    const wMapped = await h.makeWarehouse('R1V4-MAPPED', { market: 'TH', status: 'confirmed' });
    const wSource = await h.makeWarehouse('R1V4-SOURCE', { market: 'TH', status: 'confirmed' });
    const wNone = await h.makeWarehouse('R1V4-NONE', { market: 'PH', status: 'confirmed', name: 'PH-彩妆日均万单简简单单仓' });
    await h.setScope([wMapped, wSource, wNone]);
    const item = LS101295;
    const known = `R1V4-KNOWN-${h.suffix}`;
    // Only ONE confirmed mapping exists (in wMapped). wSource has no mapping and no candidate at all, but it
    // still has a source row for the account-known code -> unmapped_source (not no_source). wNone has no row.
    expect((await h.confirmMappings([
      { sku: known, warehouseExternalId: wMapped.external_warehouse_id, itemId: item },
    ])).applied).toBe(1);
    const rows = [
      h.row(31, wMapped.external_warehouse_id, known, 5),
      h.row(32, wSource.external_warehouse_id, known, 0),
    ];
    const run = await h.publishRun({
      warehouses: [wMapped, wSource, wNone], rows,
      publishOnly: [wMapped.external_warehouse_id],
    });
    expect(run.finished.status).toBe('partial');
    const list = await h.listItem(item);
    expect(list.knownSubtotal).toBe(5);
    expect(list.coverage).toEqual({ scopeWarehouses: 3, coveredWarehouses: 1 });
    const byId = new Map(list.notMappedWarehouses.map((w: any) => [w.warehouseId, w]));
    const sourceGap: any = byId.get(wSource.id);
    expect(sourceGap).toMatchObject({ reason: 'unmapped_source', sourceRowCount: 1 });
    expect(sourceGap.sourceSkus).toEqual([known]);
    // quantity 0 is still a real source row: onHand=0 with file row and no silent "no source" claim.
    expect(sourceGap.pendingSourceRows[0]).toMatchObject({ externalSku: known, excelRow: 32, onHand: 0, mapped: false });
    const noneGap: any = byId.get(wNone.id);
    expect(noneGap).toMatchObject({ reason: 'no_source', sourceRowCount: 0 });
    expect(byId.has(wMapped.id)).toBe(false);
    const detail = await h.detail(item, null, null, false);
    expect(detail.warehouses).toHaveLength(3);
    expect(detail.coverage).toEqual(list.coverage);
    const detailSource = detail.warehouses.find((w: any) => w.warehouseId === wSource.id);
    expect(detailSource.status).toBe('not_mapped');
    expect(detailSource.reason).toBe('unmapped_source');
    expect(detailSource.sourceSkus).toEqual([known]);
    expect(detailSource.pendingSourceRowCount).toBe(1);
    expect(detailSource.pendingSourceRows[0]).toMatchObject({ externalSku: known, excelRow: 32, onHand: 0, mapped: false });
    expect(detailSource.adoptedSkus).toEqual([]);
    // not mapped in this warehouse -> nothing pending adoption either (skipped, not "awaiting").
    expect(detailSource.pendingAdoptionSkus).toEqual([]);
    const detailNone = detail.warehouses.find((w: any) => w.warehouseId === wNone.id);
    expect(detailNone.status).toBe('not_mapped');
    expect(detailNone.reason).toBe('no_source');
    expect(detailNone.sourceRowCount).toBe(0);
    expect(detailNone.pendingSourceRowCount).toBe(0);
    // list and detail use the same scope and the same reasons (same explanation).
    expect(detail.coverage).toEqual(list.coverage);
    expect(detailSource.reason).toBe(sourceGap.reason);
    expect(detailNone.reason).toBe(noneGap.reason);
  });

  it('does not auto-bind or confirm pending source rows and keeps the adopted total intact', async () => {
    const wh = await h.makeWarehouse('R1V4-NOBIND', { market: 'VN', status: 'confirmed' });
    await h.setScope([wh]);
    const item = WM0049;
    const mappedSku = `R1V4-M49-${h.suffix}`;
    const pendingSku = `R1V4-P49-${h.suffix}`;
    // pendingSku is known only via the candidate suggested SKU (no confirmed mapping anywhere).
    await h.confirmMappings([{ sku: mappedSku, warehouseExternalId: wh.external_warehouse_id, itemId: item }]);
    await h.bootQuery(
      `INSERT INTO catalog.inventory_mapping_candidate(account_id,warehouse_id,external_sku,
        suggested_item_id,evidence,status) VALUES($1,$2,$3,$4,$5::jsonb,'pending')`,
      [h.accountId, wh.id, pendingSku, item, JSON.stringify({ label: 'known via candidate only' })]);
    // Baseline: only the mapped SKU is published, so the adopted subtotal is a real known value (7).
    await h.publishRun({ warehouses: [wh], rows: [
      h.row(40, wh.external_warehouse_id, mappedSku, 7)] });
    const before = await h.listItem(item);
    expect(before.knownSubtotal).toBe(7);
    // Next observation introduces the candidate-only SKU as an unmapped source row (quantity 0).
    await h.publishRun({ warehouses: [wh], rows: [
      h.row(41, wh.external_warehouse_id, mappedSku, 7),
      h.row(42, wh.external_warehouse_id, pendingSku, 0)] });
    const after = await h.listItem(item);
    // pending source rows must not create a mapping or change the adopted total.
    const mappingsAfter = await h.bootQuery(
      `SELECT external_sku,status FROM catalog.inventory_sku_mapping
       WHERE account_id=$1 AND external_sku=$2`, [h.accountId, pendingSku]);
    expect(mappingsAfter).toHaveLength(0);
    expect(after.knownSubtotal).toBe(before.knownSubtotal);
    expect(after.pendingSourceWarehouses).toHaveLength(1);
    expect(after.pendingSourceWarehouses[0].pendingSkus).toEqual([pendingSku]);
    expect(after.pendingSourceWarehouses[0].mappedSkus).toEqual([mappedSku]);
    const afterPendingRows = after.pendingSourceWarehouses[0].pendingSourceRows
      .filter((row: any) => row.mapped === false);
    expect(afterPendingRows).toHaveLength(1);
    expect(afterPendingRows[0]).toMatchObject({
      externalSku: pendingSku, excelRow: 42, onHand: 0, mapped: false,
    });
  });
});

describe('R1 v4 final: adopted vs mapped (confirmed mapping is not adopted inventory)', () => {
  it('a mapping confirmed after the latest complete batch stays pendingAdoption (not adopted, not counted) until a new batch adopts it', async () => {
    const wh = await h.makeWarehouse('B4VN', { market: 'VN', status: 'confirmed', name: '越南青林湾仓库' });
    await h.setScope([wh]);
    const item = LS101295;
    const adoptedSku = `B4-ADOPTED-${h.suffix}`;
    const lateSku = `B4-LATE-${h.suffix}`;
    // 1) The latest complete batch contains both source rows, but only adoptedSku has a confirmed mapping,
    //    so only it is adopted/counted (7); lateSku keeps its source quantity without being counted.
    await h.confirmMappings([{ sku: adoptedSku, warehouseExternalId: wh.external_warehouse_id, itemId: item }]);
    await h.publishRun({ warehouses: [wh], rows: [
      h.row(60, wh.external_warehouse_id, adoptedSku, 7),
      h.row(61, wh.external_warehouse_id, lateSku, 14410),
    ] });
    const before = await h.listItem(item);
    expect(before.knownSubtotal).toBe(7);
    // 2) Confirm the mapping afterwards (as in the real candidate: a confirmed relation, no new batch yet).
    expect((await h.confirmMappings([
      { sku: lateSku, warehouseExternalId: wh.external_warehouse_id, itemId: item },
    ])).applied).toBe(1);
    const list = await h.listItem(item);
    // mapped and adopted are now different sets: only adoptedSku makes up the total.
    expect(list.knownSubtotal).toBe(7);
    expect(list.hasPendingAdoptionWarehouses).toBe(true);
    const pendingAdoption = (list.pendingAdoptionWarehouses ?? []).find((entry: any) => entry.warehouseId === wh.id);
    expect(pendingAdoption).toBeTruthy();
    expect(pendingAdoption.adoptedSkus).toEqual([adoptedSku]);
    expect(pendingAdoption.mappedSkus).toEqual([adoptedSku, lateSku].sort());
    expect(pendingAdoption.pendingAdoptionSkus).toEqual([lateSku]);
    const detail = await h.detail(item, null, null, false);
    expect(detail.hasPendingAdoptionWarehouses).toBe(true);
    expect(detail.pendingAdoptionWarehouses).toEqual(list.pendingAdoptionWarehouses);
    const detailWh = detail.warehouses.find((entry: any) => entry.warehouseId === wh.id);
    expect(detailWh.status).toBe('current');
    // adoptedSkus must never be the confirmed mapping set again (the v4 R1 regression).
    expect(detailWh.adoptedSkus).toEqual([adoptedSku]);
    expect(detailWh.mappedSkus).toEqual([adoptedSku, lateSku].sort());
    expect(detailWh.pendingAdoptionSkus).toEqual([lateSku]);
    expect(detailWh.rows.map((row: any) => row.externalSku)).toEqual([adoptedSku]);
    // warning tells the reader the confirmed mapping is waiting, without claiming it is counted.
    expect((detail.scopedWarnings ?? []).some((w: string) => w.includes('等待下一次完整同步采用'))).toBe(true);
    // 3) The next complete batch adopts it: it moves from pendingAdoption into adopted and is counted once.
    await h.publishRun({ warehouses: [wh], rows: [
      h.row(62, wh.external_warehouse_id, adoptedSku, 7),
      h.row(63, wh.external_warehouse_id, lateSku, 3),
    ] });
    const after = await h.listItem(item);
    expect(after.knownSubtotal).toBe(10);
    expect(after.hasPendingAdoptionWarehouses).toBe(false);
    expect(after.pendingAdoptionWarehouses).toEqual([]);
    const afterDetail = await h.detail(item, null, null, false);
    const afterWh = afterDetail.warehouses.find((entry: any) => entry.warehouseId === wh.id);
    expect(afterWh.adoptedSkus).toEqual([adoptedSku, lateSku].sort());
    expect(afterWh.pendingAdoptionSkus).toEqual([]);
    expect(afterWh.mappedSkus).toEqual([adoptedSku, lateSku].sort());
    expect((afterDetail.scopedWarnings ?? []).some((w: string) => w.includes('等待下一次完整同步采用'))).toBe(false);
  });

  it('a mapping confirmed before any batch exists is pendingAdoption (unseen), never adopted', async () => {
    const wh = await h.makeWarehouse('B4NEW', { market: 'VN', status: 'confirmed' });
    await h.setScope([wh]);
    const item = LS101302;
    const sku = `B4-NEW-${h.suffix}`;
    expect((await h.confirmMappings([
      { sku, warehouseExternalId: wh.external_warehouse_id, itemId: item },
    ])).applied).toBe(1);
    const list = await h.listItem(item);
    // no complete batch for this warehouse yet: nothing is adopted and nothing is counted.
    expect(list.hasCurrentData).toBe(false);
    expect(list.hasPendingAdoptionWarehouses).toBe(true);
    const pendingAdoption = (list.pendingAdoptionWarehouses ?? []).find((entry: any) => entry.warehouseId === wh.id);
    expect(pendingAdoption).toBeTruthy();
    expect(pendingAdoption.adoptedSkus).toEqual([]);
    expect(pendingAdoption.pendingAdoptionSkus).toEqual([sku]);
    const detail = await h.detail(item, wh.id, null, false);
    const detailWh = detail.warehouses.find((entry: any) => entry.warehouseId === wh.id);
    expect(detailWh.status).toBe('unseen');
    expect(detailWh.adoptedSkus).toEqual([]);
    expect(detailWh.mappedSkus).toEqual([sku]);
    expect(detailWh.pendingAdoptionSkus).toEqual([sku]);
    expect(detailWh.rows).toEqual([]);
  });
});

describe('R2 mapping maintenance (candidates, confirm, queue)', () => {
  it('queue seeds evidence candidates, supports search/paging and confirm requires warehouse+unit+reason', async () => {
    const wh = await h.makeWarehouse('QUEUE', { market: 'PH', status: 'confirmed' });
    await h.setScope([wh]);
    const skuA = `QUEUE-A-${h.suffix}`; const skuB = `QUEUE-B-${h.suffix}`;
    const { runId, lease } = await h.startRun();
    const rows = [h.row(2, wh.external_warehouse_id, skuA, 1), h.row(3, wh.external_warehouse_id, skuB, 2)];
    await h.registerExport(runId, lease, h.exportPayload(rows));
    await h.publish(runId, lease, wh.id, rows);
    await h.finish(runId, lease, 'partial');
    await h.bootQuery(
      `INSERT INTO catalog.inventory_mapping_candidate(account_id,warehouse_id,external_sku,
        suggested_item_id,evidence,status) VALUES($1,$2,$3,$4,$5::jsonb,'pending')`,
      [h.accountId, wh.id, skuA, LS101295, JSON.stringify({ label: 'fixture candidate' })]);
    const queue = await h.mappingQueue(`QUEUE-A-${h.suffix}`, 1, 0);
    expect(queue.total).toBe(1);
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0].externalSku).toBe(skuA);
    expect(queue.items[0].warehouseId).toBe(wh.id);
    expect(queue.items[0].suggestion.itemId).toBe(LS101295);
    expect((await h.mappingQueue('LS101295', 10, 0)).total).toBeGreaterThanOrEqual(1);
    expect((await h.mappingQueue('QUEUE', 10, 0)).total).toBeGreaterThanOrEqual(2);
    const bad = await h.appCall('confirm_inventory_mapping', [randomId(), intentHash(), [{
      externalSku: skuA, warehouseExternalId: wh.external_warehouse_id, itemId: LS101295, reason: 'no unit' }]]);
    expect(bad.applied).toBe(0);
    expect(bad.skipped).toHaveLength(1);
    expect((await h.mappingQueue(skuA, 5, 0)).total).toBe(1);
    const ok = await h.appCall('confirm_inventory_mapping', [randomId(), intentHash(), [{
      externalSku: skuA, warehouseExternalId: wh.external_warehouse_id, itemId: LS101295,
      unit: '件', reason: 'queue confirm' }]]);
    expect(ok.applied).toBe(1);
    expect(ok.committed[0].effectiveAt).toBe('next_batch');
    expect((await h.mappingQueue(skuA, 5, 0)).total).toBe(0);
    const cand = await h.bootOne(
      `SELECT status,resolved_mapping_id FROM catalog.inventory_mapping_candidate
       WHERE account_id=$1 AND external_sku=$2 AND warehouse_id=$3`, [h.accountId, skuA, wh.id]);
    expect(cand.status).toBe('confirmed');
    expect(cand.resolved_mapping_id).toBeTruthy();
    // evidence candidates appear in the queue even when no run has rows for them (fresh instance)
    const skuC = `QUEUE-C-${h.suffix}`;
    const isolatedCandidate = await h.bootOne(
      `INSERT INTO catalog.inventory_mapping_candidate(account_id,warehouse_id,external_sku,
        suggested_item_id,evidence,status) VALUES($1,$2,$3,$4,$5::jsonb,'pending') RETURNING id`,
      [h.accountId, wh.id, skuC, LS101302, JSON.stringify({ label: 'candidate only, no run row' })]);
    const candidateOnly = await h.mappingQueue(skuC, 5, 0);
    expect(candidateOnly.total).toBe(1);
    expect(candidateOnly.items[0].candidateId).toBe(isolatedCandidate.id);
    expect(candidateOnly.items[0].candidateStatus).toBe('pending');
    expect(candidateOnly.items[0].latestRunAt).toBeNull();
    expect(candidateOnly.items[0].suggestion.itemId).toBe(LS101302);
    // dismissed candidates stay visible with their real status (the UI can distinguish them)
    const skuD = `QUEUE-D-${h.suffix}`;
    await h.bootQuery(
      `INSERT INTO catalog.inventory_mapping_candidate(account_id,warehouse_id,external_sku,
        suggested_item_id,evidence,status) VALUES($1,$2,$3,$4,$5::jsonb,'dismissed')`,
      [h.accountId, wh.id, skuD, LS101302, JSON.stringify({ label: 'dismissed candidate' })]);
    const dismissed = await h.mappingQueue(skuD, 5, 0);
    expect(dismissed.total).toBe(1);
    expect(dismissed.items[0].candidateStatus).toBe('dismissed');
  });

  it('F1 queue exposes currentMapping/version; re-confirm needs the seen version; same SKU two warehouses stays independent', async () => {
    const wh1 = await h.makeWarehouse('F1A', { market: 'PH', status: 'confirmed' });
    const wh2 = await h.makeWarehouse('F1B', { market: 'PH', status: 'confirmed' });
    await h.setScope([wh1, wh2]);
    const sku = `F1-${h.suffix}`;
    const first = await h.confirmMappings([
      { sku, warehouseExternalId: wh1.external_warehouse_id, itemId: LS101295 },
      { sku, warehouseExternalId: wh2.external_warehouse_id, itemId: LS101295 },
    ]);
    expect(first.applied).toBe(2);
    const map1: any = await h.bootOne(
      `SELECT id,version,status FROM catalog.inventory_sku_mapping
       WHERE account_id=$1 AND warehouse_id=$2 AND external_sku=$3`, [h.accountId, wh1.id, sku]);
    const disabled = await h.appCall('disable_inventory_mapping',
      [randomId(), intentHash(), map1.id, 'fixture disable', 1]);
    expect(disabled.status).toBe('disabled');
    const map2: any = await h.bootOne(
      `SELECT version,status FROM catalog.inventory_sku_mapping
       WHERE account_id=$1 AND warehouse_id=$2 AND external_sku=$3`, [h.accountId, wh2.id, sku]);
    expect(map2.status).toBe('confirmed');
    await h.bootQuery(
      `INSERT INTO catalog.inventory_mapping_candidate(account_id,warehouse_id,external_sku,
        suggested_item_id,evidence,status) VALUES($1,$2,$3,$4,$5::jsonb,'pending')`,
      [h.accountId, wh1.id, sku, LS101295, JSON.stringify({ label: 'F1 candidate' })]);
    const queue = await h.mappingQueue(sku, 10, 0);
    expect(queue.total).toBe(1);
    expect(queue.items[0].mappingStatus).toBe('disabled');
    expect(queue.items[0].currentMapping).toEqual({
      id: map1.id, status: 'disabled', version: 1, itemId: LS101295, unit: '件',
    });
    // no expectedVersion is only valid for a first mapping; disabled re-confirm must carry the seen version
    const noVersion = await h.confirmMappings([{ sku, warehouseExternalId: wh1.external_warehouse_id, itemId: LS101295 }]);
    expect(noVersion.applied).toBe(0);
    expect(noVersion.skipped[0].reason).toBe('INVENTORY_MAPPING_VERSION_CONFLICT');
    const stale = await h.confirmMappings([{ sku, warehouseExternalId: wh1.external_warehouse_id, itemId: LS101295, expectedVersion: 0 }]);
    expect(stale.applied).toBe(0);
    expect(stale.skipped[0].reason).toBe('INVENTORY_MAPPING_VERSION_CONFLICT');
    const revalidated = await h.confirmMappings([{
      sku, warehouseExternalId: wh1.external_warehouse_id, itemId: LS101295,
      expectedVersion: 1, verification: true, reason: '页面验证：业务包装单位待确认',
    }]);
    expect(revalidated.applied).toBe(1);
    expect(revalidated.committed[0].version).toBe(2);
    const evidence: any = await h.bootOne(
      `SELECT evidence FROM catalog.inventory_sku_mapping
       WHERE account_id=$1 AND warehouse_id=$2 AND external_sku=$3 AND status='confirmed'`,
      [h.accountId, wh1.id, sku]);
    expect(evidence.evidence.source).toBe('manual_confirm_validation');
    expect(evidence.evidence.verification).toBe(true);
    expect(evidence.evidence.unitConfirmed).toBe(false);
    const unaffected: any = await h.bootOne(
      `SELECT status,version FROM catalog.inventory_sku_mapping
       WHERE account_id=$1 AND warehouse_id=$2 AND external_sku=$3`, [h.accountId, wh2.id, sku]);
    expect(unaffected).toEqual({ status: 'confirmed', version: 1 });
    await h.setScope([wh1]);
    const run = await h.publishRun({ warehouses: [wh1], rows: [h.row(2, wh1.external_warehouse_id, sku, 4)] });
    expect(run.finished.status).toBe('success');
    const item = await h.listItem(LS101295);
    expect(item.verificationOnly).toBe(true);
    expect(item.unitUnconfirmed).toBe(true);
  });

  it('pending actions lock other writes until resolved and reconcile distinguishes all three outcomes (R5)', async () => {
    const wh = await h.makeWarehouse('PEND', { market: 'PH', status: 'confirmed' });
    await h.setScope([wh]);
    const requestId = randomId(); const intent = intentHash();
    const pendingPayload = { enabled: false, intervalMinutes: 60, scopeProvided: false, warehouseIds: [] };
    const begun = await h.appCall('begin_inventory_pending_action',
      [requestId, intent, 'update_inventory_sync_settings', pendingPayload]);
    expect(begun.status).toBe('pending');
    expect(begun.actorId).toBe(ADMIN_ID);
    await h.expectError('update_inventory_sync_settings',
      [randomId(), intentHash(), true, 60, false, []], 'INVENTORY_PENDING_RECOVERY_REQUIRED');
    await h.expectError('request_inventory_manual_sync', [randomId(), intentHash()],
      'INVENTORY_PENDING_RECOVERY_REQUIRED');
    const replay = await h.appCall('begin_inventory_pending_action',
      [requestId, intent, 'update_inventory_sync_settings', pendingPayload]);
    expect(replay.replayed).toBe(true);
    // v4: the same requestId/intent with a different complete payload is not a replay.
    await h.expectError('begin_inventory_pending_action',
      [requestId, intent, 'update_inventory_sync_settings', { ...pendingPayload, enabled: true }],
      'INVENTORY_REQUEST_CONFLICT');
    const notFound = await h.appCall('reconcile_inventory_request', [randomId(), intentHash()]);
    expect(notFound.found).toBe(false);
    // resolve the unknown-outcome request first, then a new write is accepted again
    const completed = await h.appCall('complete_inventory_pending_action',
      [requestId, 'failed', null, 'NETWORK_UNKNOWN']);
    expect(completed.status).toBe('failed');
    const settingsRequest = randomId();
    const settingsIntent = intentHash();
    await h.appCall('update_inventory_sync_settings', [settingsRequest, settingsIntent, true, 30, false, []]);
    const found = await h.appCall('reconcile_inventory_request', [settingsRequest, settingsIntent]);
    expect(found.found).toBe(true);
    expect(found.action).toBe('update_inventory_sync_settings');
    await h.expectError('reconcile_inventory_request', [settingsRequest, intentHash()], 'INVENTORY_REQUEST_CONFLICT');
    const pending = await h.pendingActions();
    expect(pending.items.some((i: any) => i.requestId === requestId && i.status === 'failed')).toBe(true);
    const next = await h.appCall('begin_inventory_pending_action',
      [randomId(), intentHash(), 'disable_inventory_mapping', {}]);
    expect(next.status).toBe('pending');
    await h.appCall('complete_inventory_pending_action', [next.requestId, 'failed', null, 'TEST_CLEANUP']);
    await h.adminSetIdentity(OPERATOR_ID);
    await h.expectError('begin_inventory_pending_action', [randomId(), intentHash(), 'x', {}], /FORBIDDEN/);
    await h.adminSetIdentity(ADMIN_ID);
  });

  it('F4 another admin cannot begin/complete/reconcile or take over a pending request (persisted actor/intent)', async () => {
    const wh = await h.makeWarehouse('F4', { market: 'PH', status: 'confirmed' });
    await h.setScope([wh]);
    const originalRole: any = await h.bootOne(
      `SELECT role_id FROM public.profiles WHERE id=$1`, [OPERATOR_ID]);
    await h.bootQuery(
      `UPDATE public.profiles SET role_id=(SELECT id FROM public.role WHERE name='admin') WHERE id=$1`,
      [OPERATOR_ID]);
    const requestId = randomId();
    const intent = intentHash();
    const action = 'update_inventory_sync_settings';
    const pendingPayload = { enabled: true, intervalMinutes: 60, scopeProvided: false, warehouseIds: [] };
    try {
      await h.adminSetIdentity(ADMIN_ID);
      const begun = await h.appCall('begin_inventory_pending_action',
        [requestId, intent, action, pendingPayload]);
      expect(begun.status).toBe('pending');
      await h.adminSetIdentity(OPERATOR_ID);
      const otherOverview = await h.overview();
      expect(otherOverview.pendingAction.foreign).toBe(true);
      expect(otherOverview.pendingAction.mine).toBe(false);
      expect(otherOverview.pendingAction.requestId).toBeUndefined();
      expect(otherOverview.pendingAction.intentHash).toBeUndefined();
      const otherPending = await h.pendingActions();
      const foreign = otherPending.items.find((i: any) => i.foreign === true);
      expect(foreign).toBeTruthy();
      expect(foreign.requestId).toBeUndefined();
      await h.expectError('begin_inventory_pending_action',
        [requestId, intent, action, pendingPayload], 'INVENTORY_FORBIDDEN');
      await h.expectError('complete_inventory_pending_action',
        [requestId, 'failed', null, 'TAKEOVER'], 'INVENTORY_FORBIDDEN');
      await h.expectError('reconcile_inventory_request', [requestId, intent], 'INVENTORY_FORBIDDEN');
      await h.expectError('update_inventory_sync_settings',
        [requestId, intent, true, 60, false, []], 'INVENTORY_FORBIDDEN');
      await h.adminSetIdentity(ADMIN_ID);
      // same requestId with another intent is still the original request's lock
      await h.expectError('update_inventory_sync_settings',
        [requestId, intentHash(), true, 60, false, []], 'INVENTORY_FORBIDDEN');
      // reconcile binds the persisted intent too (not only the actor)
      await h.expectError('reconcile_inventory_request', [requestId, intentHash()],
        'INVENTORY_REQUEST_CONFLICT');
      // no business receipt yet -> completed unlock must fail and keep the lock
      await h.expectError('complete_inventory_pending_action',
        [requestId, 'completed', { ok: true }, null], 'INVENTORY_RECEIPT_MISSING');
      const applied = await h.appCall('update_inventory_sync_settings',
        [requestId, intent, true, 60, false, []]);
      expect(applied.settings.enabled).toBe(true);
      const receipt = await h.appCall('reconcile_inventory_request', [requestId, intent]);
      expect(receipt.found).toBe(true);
      const done = await h.appCall('complete_inventory_pending_action',
        [requestId, 'completed', receipt.response, null]);
      expect(done.status).toBe('completed');
    } finally {
      await h.adminSetIdentity(ADMIN_ID);
      await h.bootQuery(`UPDATE public.profiles SET role_id=$2 WHERE id=$1`,
        [OPERATOR_ID, originalRole.role_id]);
    }
  });

  it('legacy history rows are immutable (no UPDATE/DELETE through the owner)', async () => {
    const wh = await h.makeWarehouse('IMMUT', { market: 'PH', status: 'confirmed' });
    await h.setScope([wh]);
    const sku = `IMMUT-${h.suffix}`;
    await h.confirmMappings([{ sku, warehouseExternalId: wh.external_warehouse_id, itemId: WM0011, unit: '件' }]);
    const run = await h.publishRun({ warehouses: [wh], rows: [h.row(2, wh.external_warehouse_id, sku, 1)] });
    const batch = await h.bootOne(`SELECT id FROM catalog.inventory_batch WHERE run_id=$1`, [run.runId]);
    await expect(h.bootQuery(`UPDATE catalog.inventory_batch_row SET on_hand=2 WHERE batch_id=$1`, [batch.id]))
      .rejects.toThrow(/CATALOG_IMMUTABLE|IMMUTABLE|history/i);
    await expect(h.bootQuery(`DELETE FROM catalog.inventory_batch_row WHERE batch_id=$1`, [batch.id]))
      .rejects.toThrow(/CATALOG_IMMUTABLE|IMMUTABLE|history/i);
    await expect(h.bootQuery(`DELETE FROM catalog.inventory_batch WHERE id=$1`, [batch.id]))
      .rejects.toThrow(/CATALOG_IMMUTABLE|IMMUTABLE|history/i);
  });

  it('worker refresh never revives disabled accounts and requires a matching label (R3/R6)', async () => {
    await h.registerWorker();
    await h.bootQuery(`UPDATE catalog.inventory_source_account SET status='needs_login' WHERE id=$1`, [h.accountId]);
    const wrong = await h.syncCall('refresh_inventory_account_status',
      [h.workerId, true, 'someone-else@KNZX019402']);
    expect(wrong.accountIdentityStatus).toBe('mismatch');
    expect(wrong.changed).toBe(false);
    expect((await h.bootOne(`SELECT status FROM catalog.inventory_source_account WHERE id=$1`, [h.accountId])).status)
      .toBe('needs_login');
    const right = await h.syncCall('refresh_inventory_account_status',
      [h.workerId, true, 'laiguoyong@KNZX019402']);
    expect(right.accountIdentityStatus).toBe('verified');
    expect(right.changed).toBe(true);
    expect(right.status).toBe('active');
    await h.bootQuery(`UPDATE catalog.inventory_source_account SET status='disabled' WHERE id=$1`, [h.accountId]);
    const disabled = await h.syncCall('refresh_inventory_account_status',
      [h.workerId, true, 'laiguoyong@KNZX019402']);
    expect(disabled.status).toBe('disabled');
    expect(disabled.changed).toBe(false);
    await h.bootQuery(`UPDATE catalog.inventory_source_account SET status='active' WHERE id=$1`, [h.accountId]);
  });

  it('v4 complete-content key is order-insensitive but content-sensitive (R2)', async () => {
    const key = async (action: string, payload: any): Promise<string> => (await h.bootOne(
      `SELECT catalog.inventory_payload_key($1,$2::jsonb) AS k`, [action, JSON.stringify(payload)])).k;
    const one = {
      externalSku: 'KEY-1', warehouseExternalId: 'W-1', itemId: WM0011, unit: '件',
      reason: 'r1', note: 'n|1;x', expectedVersion: null, verification: true,
    };
    const other = { ...one, externalSku: 'KEY-2' };
    expect(await key('confirm_inventory_mapping', { mappings: [one, other] }))
      .toBe(await key('confirm_inventory_mapping', { mappings: [other, one] }));
    expect(await key('confirm_inventory_mapping', { mappings: [one] }))
      .not.toBe(await key('confirm_inventory_mapping', { mappings: [one, other] }));
    const settingsA = { enabled: true, intervalMinutes: 60, scopeProvided: true, warehouseIds: ['b', 'a'] };
    const settingsB = { enabled: true, intervalMinutes: 60, scopeProvided: true, warehouseIds: ['a', 'b'] };
    expect(await key('update_inventory_sync_settings', settingsA))
      .toBe(await key('update_inventory_sync_settings', settingsB));
    expect(await key('update_inventory_sync_settings', { ...settingsA, enabled: false }))
      .not.toBe(await key('update_inventory_sync_settings', settingsA));
  });

  it('legacy v3-style pending fingerprint remains recoverable with the stored complete payload (R2)', async () => {
    const wh = await h.makeWarehouse('LEGACY', { market: 'PH', status: 'confirmed' });
    await h.setScope([wh]);
    const requestId = randomId();
    // Any 64-hex hash: a v3 engine wrote it and the DB must not need to recompute the old encoding.
    const legacyIntent = intentHash();
    const payload = {
      mappings: [{
        externalSku: `LEG-${h.suffix}`, warehouseExternalId: wh.external_warehouse_id,
        itemId: WM0011, unit: '件', reason: 'legacy pending', note: 'a|b;c',
        expectedVersion: null, verification: true,
      }],
    };
    const begun = await h.appCall('begin_inventory_pending_action',
      [requestId, legacyIntent, 'confirm_inventory_mapping', payload]);
    expect(begun.status).toBe('pending');
    const applied = await h.appCall('confirm_inventory_mapping',
      [requestId, legacyIntent, payload.mappings]);
    expect(applied.applied).toBe(1);
    const receipt = await h.appCall('reconcile_inventory_request', [requestId, legacyIntent]);
    expect(receipt.found).toBe(true);
    const done = await h.appCall('complete_inventory_pending_action',
      [requestId, 'completed', receipt.response, null]);
    expect(done.status).toBe('completed');
  });

  it('same legacy fingerprint with a different confirm row set is rejected, not executed (R2)', async () => {
    const wh = await h.makeWarehouse('FPCONFLICT', { market: 'PH', status: 'confirmed' });
    await h.setScope([wh]);
    const requestId = randomId();
    const legacyIntent = intentHash();
    const one = {
      externalSku: `FP-ONE-${h.suffix}`, warehouseExternalId: wh.external_warehouse_id,
      itemId: WM0011, unit: '件', reason: 'fingerprint A', expectedVersion: null, verification: false,
    };
    const two = [one, {
      externalSku: `FP-TWO-${h.suffix}`, warehouseExternalId: wh.external_warehouse_id,
      itemId: WM0011, unit: '件', reason: 'fingerprint B', expectedVersion: null, verification: false,
    }];
    await h.appCall('begin_inventory_pending_action',
      [requestId, legacyIntent, 'confirm_inventory_mapping', { mappings: [one] }]);
    // Different complete content under the same old fingerprint: conflict, not "already recorded".
    await h.expectError('confirm_inventory_mapping', [requestId, legacyIntent, two],
      'INVENTORY_REQUEST_CONFLICT');
    await h.expectError('begin_inventory_pending_action',
      [requestId, legacyIntent, 'confirm_inventory_mapping', { mappings: two }],
      'INVENTORY_REQUEST_CONFLICT');
    // The registered original content still executes exactly once.
    const applied = await h.appCall('confirm_inventory_mapping', [requestId, legacyIntent, [one]]);
    expect(applied.applied).toBe(1);
    const done = await h.appCall('complete_inventory_pending_action',
      [requestId, 'failed', null, 'TEST_CLEANUP']);
    expect(done.status).toBe('failed');
  });
});

/**
 * v4-final R2：失败结案必须由服务端单事务核 actor/action/intent/完整 payload_key；
 * 错 intent/参数只返回 NOT_ORIGINAL（原 pending 不变）；已有成功回执不得改判；
 * 无 pending 且无 request 行才算 NO_PENDING。这三个断言对应 actions.ts 的 settle 分支。
 */
describe('v4-final R2 settle RPC binds the original request completely', () => {
  const settingsPayload = {
    enabled: true, intervalMinutes: 60, scopeProvided: false, warehouseIds: [] as string[],
  };

  it('wrong intent/action/payload are rejected (NOT_ORIGINAL) and the original pending is unchanged', async () => {
    const requestId = randomId();
    const intent = intentHash();
    const begun = await h.appCall('begin_inventory_pending_action',
      [requestId, intent, 'update_inventory_sync_settings', settingsPayload]);
    expect(begun.status).toBe('pending');

    const wrongIntent = await h.appCall('settle_inventory_pending_action',
      [requestId, 'update_inventory_sync_settings', intentHash(), settingsPayload, 'INVALID_INPUT']);
    expect(wrongIntent).toMatchObject({ ok: false, settled: false, reason: 'NOT_ORIGINAL' });
    const wrongAction = await h.appCall('settle_inventory_pending_action',
      [requestId, 'request_inventory_manual_sync', intent, {}, 'INVALID_INPUT']);
    expect(wrongAction.reason).toBe('NOT_ORIGINAL');
    const wrongPayload = await h.appCall('settle_inventory_pending_action',
      [requestId, 'update_inventory_sync_settings', intent, { ...settingsPayload, enabled: false }, 'INVALID_INPUT']);
    expect(wrongPayload.reason).toBe('NOT_ORIGINAL');

    // 原 pending 仍是 pending，且仍可按原 intent 核对（没有把原锁解除）。
    const row = (await h.pendingActions()).items.find((i: any) => i.requestId === requestId);
    expect(row.status).toBe('pending');
    expect(row.intentHash).toBe(intent);
    const reconciled = await h.appCall('reconcile_inventory_request', [requestId, intent]);
    expect(reconciled.found).toBe(false);

    // 另一位管理员不能结案别人的原请求。
    await h.adminSetIdentity(OPERATOR_ID);
    try {
      await h.expectError('settle_inventory_pending_action',
        [requestId, 'update_inventory_sync_settings', intent, settingsPayload, 'TAKEOVER'], /FORBIDDEN/);
    } finally {
      await h.adminSetIdentity(ADMIN_ID);
    }

    // 完整参数一致才 SETTLED；结案后原请求为 failed，重复结案是 NOT_PENDING。
    const settled = await h.appCall('settle_inventory_pending_action',
      [requestId, 'update_inventory_sync_settings', intent, settingsPayload, 'INVALID_INPUT']);
    expect(settled).toMatchObject({ ok: true, settled: true, reason: 'SETTLED', status: 'failed' });
    expect((await h.pendingActions()).items.find((i: any) => i.requestId === requestId).status)
      .toBe('failed');
    const again = await h.appCall('settle_inventory_pending_action',
      [requestId, 'update_inventory_sync_settings', intent, settingsPayload, 'INVALID_INPUT']);
    expect(again.reason).toBe('NOT_PENDING');
  });

  it('a failed terminal is repeatable through reconcile and can never re-run the original business', async () => {
    const requestId = randomId();
    const intent = intentHash();
    const begun = await h.appCall('begin_inventory_pending_action',
      [requestId, intent, 'request_inventory_manual_sync', {}]);
    expect(begun).toMatchObject({ status: 'pending', replayed: false });

    // 未结案前核对仍是普通 not_found（不是失败终态）。
    const before = await h.appCall('reconcile_inventory_request', [requestId, intent]);
    expect(before).toMatchObject({ found: false });
    expect(before.terminal).toBeUndefined();

    const settled = await h.appCall('settle_inventory_pending_action',
      [requestId, 'request_inventory_manual_sync', intent, {}, 'INVENTORY_SCOPE_EMPTY']);
    expect(settled).toMatchObject({ ok: true, settled: true, reason: 'SETTLED', status: 'failed' });

    // 失败终态可重复读取，返回同一 errorCode；不会变成“从未登记”或成功回执。
    const first = await h.appCall('reconcile_inventory_request', [requestId, intent]);
    expect(first).toMatchObject({
      found: false, terminal: 'failed', terminalErrorCode: 'INVENTORY_SCOPE_EMPTY',
    });
    const again = await h.appCall('reconcile_inventory_request', [requestId, intent]);
    expect(again).toEqual(first);

    // 已结案的原请求：begin 回放带 failed/errorCode（动作层据此拒绝再次执行原业务）。
    const replay = await h.appCall('begin_inventory_pending_action',
      [requestId, intent, 'request_inventory_manual_sync', {}]);
    expect(replay).toMatchObject({ ok: true, replayed: true, status: 'failed', errorCode: 'INVENTORY_SCOPE_EMPTY' });

    // 错 intent 与另一位管理员不能借终态核对清锁。
    await h.expectError('reconcile_inventory_request', [requestId, intentHash()], 'INVENTORY_REQUEST_CONFLICT');
    const originalRole: any = await h.bootOne(
      `SELECT role_id FROM public.profiles WHERE id=$1`, [OPERATOR_ID]);
    await h.bootQuery(
      `UPDATE public.profiles SET role_id=(SELECT id FROM public.role WHERE name='admin') WHERE id=$1`,
      [OPERATOR_ID]);
    await h.adminSetIdentity(OPERATOR_ID);
    try {
      await h.expectError('reconcile_inventory_request', [requestId, intent], 'INVENTORY_FORBIDDEN');
    } finally {
      await h.adminSetIdentity(ADMIN_ID);
      await h.bootQuery(`UPDATE public.profiles SET role_id=$2 WHERE id=$1`,
        [OPERATOR_ID, originalRole.role_id]);
    }
    // 原失败记录保留（没有删除，也不能被“读终态”改写成成功）。
    const row = (await h.pendingActions()).items.find((i: any) => i.requestId === requestId);
    expect(row).toMatchObject({ status: 'failed', errorCode: 'INVENTORY_SCOPE_EMPTY' });
  });

  it('a request that already has a success receipt is never re-judged as failed (HAS_RECEIPT)', async () => {
    const requestId = randomId();
    const intent = intentHash();
    await h.appCall('begin_inventory_pending_action',
      [requestId, intent, 'update_inventory_sync_settings', settingsPayload]);
    const applied = await h.appCall('update_inventory_sync_settings',
      [requestId, intent, true, 60, false, []]);
    expect(applied.settings.enabled).toBe(true);
    const receipt = await h.appCall('reconcile_inventory_request', [requestId, intent]);
    expect(receipt.found).toBe(true);

    const hasReceipt = await h.appCall('settle_inventory_pending_action',
      [requestId, 'update_inventory_sync_settings', intent, settingsPayload, 'INVALID_INPUT']);
    expect(hasReceipt).toMatchObject({ ok: false, settled: false, reason: 'HAS_RECEIPT' });
    // 回执与原 pending 都保留；随后仍可按既有规则 complete(completed) 解锁。
    expect((await h.pendingActions()).items.find((i: any) => i.requestId === requestId).status)
      .toBe('pending');
    const stillFound = await h.appCall('reconcile_inventory_request', [requestId, intent]);
    expect(stillFound.found).toBe(true);
    const done = await h.appCall('complete_inventory_pending_action',
      [requestId, 'completed', receipt.response, null]);
    expect(done.status).toBe('completed');
  });

  it('nothing registered is NO_PENDING (no lock to settle)', async () => {
    const decision = await h.appCall('settle_inventory_pending_action',
      [randomId(), 'request_inventory_manual_sync', intentHash(), {}, 'INVALID_INPUT']);
    expect(decision).toMatchObject({ ok: true, settled: true, reason: 'NO_PENDING' });
  });
});
