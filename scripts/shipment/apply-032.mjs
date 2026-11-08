/**
 * 把 032「商品在途 RPC 逐条明细」增量应用到实例，并回读结构/权限/功能。
 *
 * 032 只 CREATE OR REPLACE 同一个只读 RPC `catalog.read_product_shipment_in_transit(uuid)`
 * （不改 026–031 文件）：票级行保留，新增 items[]（同票同商品逐条明细）。
 * 剩余/待核/冲突由应用层逐条计算后按票合成（R11 修复“一条待核拖累整票”）。
 *
 * 本脚本（仿 apply-031.mjs）：
 *   1) owner 执行 032 两次（证明幂等）；
 *   2) 结构回读：函数签名 / SECURITY DEFINER / search_path='' / STABLE / app 可执行 / public 不可；
 *   3) 权限负向：无管理员 JWT 时被 catalog.require_admin() 拒绝；
 *   4) 功能回读（与库内独立重算逐票、逐条比对）：LS101274、WM0098 的 items 与票级字段；
 *      027577 只含本品明细；无该商品的商品返回空；
 *      同票同商品多条明细：真实库当前没有这种票，仅在 --rollback 的事务内插入一条探针明细
 *      验证 RPC 会返回两条（不回滚则不写任何测试值）；
 *   5) 默认提交；`--rollback` 整体事务验证后 ROLLBACK（只验证、不安装）。
 *
 * 用法：
 *   node scripts/shipment/apply-032.mjs --rollback --run-id run-20261026T211500Z-11a22b33
 *   node scripts/shipment/apply-032.mjs --run-id <run-id>          # 提交模式（Lead 执行）
 *   node scripts/shipment/apply-032.mjs --database-url postgres://... [--rollback]
 * 证据：.local/shipment-v1-r11-20261106/apply-032.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_RUN_ID = 'run-20261026T211500Z-11a22b33';
const SQL_FILE = 'db/catalog/032_product_transit_item_rows.sql';
const FUNCTION_NAME = 'read_product_shipment_in_transit';
const APP_ROLE = 'ice_p0_02_app_runner';
const ADMIN_PROFILE_ID = '11111111-1111-4111-8111-111111111101';
const EVIDENCE_DIR = path.join(REPO_ROOT, '.local', 'shipment-v1-r11-20261106');
const LS101274 = 'b47da6ed-375c-48b7-b54d-9a3129f445cd';
const WM0098 = 'e9aa760e-6f6e-42c7-90f1-d664959421c0';
const TICKET_KEYS = [
  'shipmentId', 'ticketNo', 'purchaseOrder', 'market', 'waybillsText', 'statusClass',
  'effectiveStatusClass', 'transportText', 'arrivalText', 'ticketItemCount', 'items',
];
const ITEM_KEYS = ['itemId', 'shippedQuantity', 'receivedQuantity', 'manualConflict', 'manualCorrected'];

function readArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else { args[key] = next; i += 1; }
  }
  return args;
}

function check(results, name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail === undefined ? '' : ` :: ${JSON.stringify(detail).slice(0, 900)}`}`);
}

function normalizeItems(items) {
  return (items ?? []).map((item) => ({
    itemId: item.itemId,
    shippedQuantity: Number(item.shippedQuantity),
    receivedQuantity: item.receivedQuantity === null ? null : Number(item.receivedQuantity),
    manualConflict: item.manualConflict === true,
    manualCorrected: item.manualCorrected === true,
  }));
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  const runId = args['run-id'] ?? DEFAULT_RUN_ID;
  const env = JSON.parse(fs.readFileSync(
    path.join(REPO_ROOT, '.local/catalog', runId, 'instance/env.inventory.json'), 'utf8'));
  const rollback = args.rollback === true;
  const { default: pg } = await import('pg');
  const owner = new pg.Client({ connectionString: args['database-url'] ?? env.ownerDbUrl });
  await owner.connect();
  const results = [];
  const evidence = {
    runId, database: env.database, at: new Date().toISOString(),
    mode: rollback ? 'rollback' : 'commit', checks: results,
  };
  if (args['database-url']) {
    evidence.databaseUrlOverride = String(args['database-url']).replace(/:[^:@/]+@/, ':***@');
  }

  const countsSql = `SELECT (SELECT count(*) FROM catalog.shipment)::int AS shipments,
    (SELECT count(*) FROM catalog.shipment_item)::int AS items,
    (SELECT count(*) FROM catalog.shipment_source_snapshot)::int AS snapshots,
    (SELECT count(*) FROM catalog.shipment_item_manual_revision)::int AS manual_revisions`;
  const functionStateSql = `SELECT p.oid::text AS oid, p.prosrc AS body,
    pg_get_function_identity_arguments(p.oid) AS args, p.prosecdef, p.proconfig,
    p.provolatile,
    pg_catalog.has_function_privilege($1, p.oid, 'EXECUTE') AS app_exec,
    pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='catalog' AND p.proname=$2`;
  const latestSnapshotSql = `SELECT id::text FROM catalog.shipment_source_snapshot
    WHERE status='success' ORDER BY read_finished_at DESC,created_at DESC,id DESC LIMIT 1`;

  /** 独立重算（不经过 032）：当前快照里该商品的票级字段 + 逐条明细。 */
  async function expectedTickets(itemId) {
    const rows = (await owner.query(
      `WITH latest AS (SELECT id FROM catalog.shipment_source_snapshot
                        WHERE status='success' ORDER BY read_finished_at DESC,created_at DESC,id DESC LIMIT 1)
       SELECT s.id::text AS shipment_id, s.ticket_no, s.purchase_order, s.market, s.waybills_text,
         s.status_class, catalog.shipment_effective_status_class(s.id) AS effective_status_class,
         s.transport_text, s.arrival_text,
         (SELECT count(*)::int FROM catalog.shipment_item t
           WHERE t.shipment_id=s.id AND t.last_seen_snapshot_id=(SELECT id FROM latest)) AS ticket_item_count,
         (SELECT coalesce(jsonb_agg(jsonb_build_object(
             'itemId',i.id::text,
             'shippedQuantity',i.shipped_quantity,
             'receivedQuantity',i.received_quantity,
             'manualConflict',catalog.shipment_manual_quantity_conflict(i.id),
             'manualCorrected',i.manual_status IS NOT NULL
           ) ORDER BY i.sort_index,i.id),'[]'::jsonb)
          FROM catalog.shipment_item i
          WHERE i.shipment_id=s.id AND i.product_id=$1
            AND i.last_seen_snapshot_id=(SELECT id FROM latest)) AS items
       FROM catalog.shipment s
       WHERE s.last_seen_snapshot_id=(SELECT id FROM latest)
         AND s.source_key=catalog.shipment_current_source_key()
         AND EXISTS (SELECT 1 FROM catalog.shipment_item i
                     WHERE i.shipment_id=s.id AND i.product_id=$1
                       AND i.last_seen_snapshot_id=(SELECT id FROM latest))
       ORDER BY s.ticket_no`, [itemId])).rows;
    return rows;
  }

  function compareTickets(expected, actual) {
    const mismatches = [];
    for (const row of expected) {
      const got = (actual ?? []).find((entry) => entry.ticketNo === row.ticket_no);
      if (!got) { mismatches.push(`${row.ticket_no}:missing`); continue; }
      if (got.shipmentId !== row.shipment_id
        || got.purchaseOrder !== row.purchase_order
        || got.market !== row.market
        || got.statusClass !== row.status_class
        || got.effectiveStatusClass !== row.effective_status_class
        || got.ticketItemCount !== row.ticket_item_count) {
        mismatches.push(`${row.ticket_no}:ticket-fields`);
        continue;
      }
      const expectedItems = normalizeItems(row.items);
      const actualItems = normalizeItems(got.items);
      if (JSON.stringify(expectedItems) !== JSON.stringify(actualItems)) {
        mismatches.push(`${row.ticket_no}:items`);
      }
    }
    return mismatches;
  }

  try {
    evidence.identity = (await owner.query(
      'SELECT current_database() AS db, current_user AS user')).rows[0];
    evidence.before = (await owner.query(countsSql)).rows[0];
    const beforeFn = (await owner.query(functionStateSql, [APP_ROLE, FUNCTION_NAME])).rows[0] ?? null;
    evidence.functionBefore = beforeFn
      ? { oid: beforeFn.oid, args: beforeFn.args, bodyLength: beforeFn.body?.length ?? null }
      : null;

    await owner.query('BEGIN');
    try {
      // ---- 1. 应用 032 两次（幂等） --------------------------------------
      const sqlText = fs.readFileSync(path.join(REPO_ROOT, SQL_FILE), 'utf8');
      for (let round = 1; round <= 2; round += 1) {
        await owner.query(sqlText);
        await owner.query('RESET ROLE');
      }
      evidence.applied = { file: SQL_FILE, applications: 2 };

      // ---- 2. 结构/权限回读 ---------------------------------------------
      const fn = (await owner.query(functionStateSql, [APP_ROLE, FUNCTION_NAME])).rows;
      evidence.functionAfterApply = fn.map((row) => ({
        args: row.args, prosecdef: row.prosecdef, proconfig: row.proconfig,
        provolatile: row.provolatile, app_exec: row.app_exec, public_exec: row.public_exec,
        bodyHasItems: (row.body ?? '').includes("'items'"),
      }));
      check(results, '032 函数存在且只有一个重载', fn.length === 1, fn.map((row) => row.args));
      const row = fn[0] ?? null;
      check(results, '函数签名为 (p_item_id uuid)', row?.args === 'p_item_id uuid', row?.args ?? null);
      check(results, '函数为 SECURITY DEFINER', row?.prosecdef === true, row?.prosecdef);
      check(results, "search_path 锁定为 ''", Array.isArray(row?.proconfig)
        && row.proconfig.some((entry) => /^search_path=(?:''|"")$/
          .test(String(entry).replace(/\s/g, '').toLowerCase())), row?.proconfig);
      check(results, '函数为 STABLE（只读）', row?.provolatile === 's', row?.provolatile);
      check(results, 'app 角色可 EXECUTE', row?.app_exec === true, row?.app_exec);
      check(results, 'PUBLIC 不可 EXECUTE', row?.public_exec === false, row?.public_exec);
      check(results, '函数体返回逐条 items[]', (row?.body ?? '').includes("'items'"), null);

      // ---- 3. 无管理员 JWT 时被拒绝 -------------------------------------
      await owner.query('SAVEPOINT no_jwt');
      let anonRejected = false;
      let anonError = null;
      try {
        await owner.query(`SELECT set_config('request.jwt.claim.sub','',true)`);
        await owner.query('SELECT catalog.read_product_shipment_in_transit($1)', [LS101274]);
      } catch (error) {
        anonRejected = true;
        anonError = String(error.message).slice(0, 200);
      }
      await owner.query('ROLLBACK TO SAVEPOINT no_jwt');
      check(results, '无管理员 JWT 时被 require_admin 拒绝', anonRejected, anonError);

      // ---- 4. 功能回读（只读 RPC，数据驱动比对） ------------------------
      await owner.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`, [ADMIN_PROFILE_ID]);
      const latestId = (await owner.query(latestSnapshotSql)).rows[0].id;

      const lsExpected = await expectedTickets(LS101274);
      const lsRaw = (await owner.query(
        'SELECT catalog.read_product_shipment_in_transit($1) AS r', [LS101274])).rows[0].r;
      evidence.ls101274 = lsRaw;
      evidence.ls101274Expected = lsExpected;
      check(results, 'LS101274：返回票数 = 当前快照里含该商品的票数',
        Array.isArray(lsRaw?.tickets) && lsRaw.tickets.length === lsExpected.length,
        { returned: lsRaw?.tickets?.length ?? null, expected: lsExpected.length });
      check(results, 'LS101274：productId/latestReadAt/snapshotId 与最近成功快照一致',
        lsRaw?.productId === LS101274 && Boolean(lsRaw?.latestReadAt)
        && lsRaw?.snapshotId === latestId,
        { productId: lsRaw?.productId, latestReadAt: lsRaw?.latestReadAt, snapshotId: lsRaw?.snapshotId });
      check(results, 'LS101274：每票票级字段与 items[] 逐条与独立重算一致',
        compareTickets(lsExpected, lsRaw?.tickets).length === 0,
        compareTickets(lsExpected, lsRaw?.tickets));

      const row027388 = (lsRaw?.tickets ?? []).find((entry) => entry.ticketNo === 'POKNZX027388');
      evidence.row027388 = row027388 ?? null;
      check(results, '027388：items 一条 30000/0、3 个运单、有效状态 arrived_pending_shelving',
        Array.isArray(row027388?.items) && row027388.items.length === 1
        && Number(row027388.items[0].shippedQuantity) === 30000
        && Number(row027388.items[0].receivedQuantity) === 0
        && row027388.items[0].manualConflict === false
        && (row027388.waybillsText ?? '').split(/[\r\n]+/).filter((part) => part.trim() !== '').length === 3
        && row027388.effectiveStatusClass === 'arrived_pending_shelving',
        row027388 ?? null);

      const row027084 = (lsRaw?.tickets ?? []).find((entry) => entry.ticketNo === 'POKNZX027084');
      evidence.row027084 = row027084 ?? null;
      check(results, '027084：items 一条 80000/NULL（未知如实为 null）',
        Array.isArray(row027084?.items) && row027084.items.length === 1
        && Number(row027084.items[0].shippedQuantity) === 80000
        && row027084.items[0].receivedQuantity === null,
        row027084 ?? null);

      const row027577 = (lsRaw?.tickets ?? []).find((entry) => entry.ticketNo === 'POKNZX027577');
      check(results, '027577：items 只含本品一条 56000（同票其它商品不混入）',
        Array.isArray(row027577?.items) && row027577.items.length === 1
        && Number(row027577.items[0].shippedQuantity) === 56000
        && row027577.ticketItemCount === 2,
        row027577 ?? null);

      const wmExpected = await expectedTickets(WM0098);
      const wmRaw = (await owner.query(
        'SELECT catalog.read_product_shipment_in_transit($1) AS r', [WM0098])).rows[0].r;
      evidence.wm0098 = wmRaw;
      evidence.wm0098Expected = wmExpected;
      check(results, 'WM0098：票数与逐票 items[] 与独立重算一致',
        Array.isArray(wmRaw?.tickets) && wmRaw.tickets.length === wmExpected.length
        && compareTickets(wmExpected, wmRaw?.tickets).length === 0,
        { returned: wmRaw?.tickets?.length ?? null, expected: wmExpected.length });
      const wm026710 = (wmRaw?.tickets ?? []).find((entry) => entry.ticketNo === 'POKNZX026710');
      check(results, 'WM0098 026710：items 只含本品 14000/14000，同票爽肤水不混入',
        Array.isArray(wm026710?.items) && wm026710.items.length === 1
        && Number(wm026710.items[0].shippedQuantity) === 14000
        && Number(wm026710.items[0].receivedQuantity) === 14000
        && wm026710.ticketItemCount === 2,
        wm026710 ?? null);

      check(results, '每票行字段齐全（票级 11 键 + 明细 5 键）',
        (lsRaw?.tickets ?? []).concat(wmRaw?.tickets ?? []).every((entry) =>
          TICKET_KEYS.every((key) => Object.prototype.hasOwnProperty.call(entry, key))
          && (entry.items ?? []).every((item) =>
            ITEM_KEYS.every((key) => Object.prototype.hasOwnProperty.call(item, key)))),
        { ticketKeys: TICKET_KEYS, itemKeys: ITEM_KEYS });

      const absent = (await owner.query(
        'SELECT catalog.read_product_shipment_in_transit($1) AS r',
        ['00000000-0000-0000-0000-0000000000ff'])).rows[0].r;
      evidence.absentProduct = absent;
      check(results, '当前快照没有该商品明细时返回空票列表（不伪造）',
        Array.isArray(absent?.tickets) && absent.tickets.length === 0
        && absent.productId === '00000000-0000-0000-0000-0000000000ff'
        && Boolean(absent.latestReadAt),
        absent);

      // ---- 5. 同票同商品多条明细：只在 rollback 事务里插探针 --------------
      if (rollback) {
        await owner.query('SAVEPOINT agg_probe');
        await owner.query(
          `INSERT INTO catalog.shipment_item(
             shipment_id, source_key, item_key, product_name_raw, product_name_norm,
             shipped_quantity, received_quantity, receipt_basis,
             source_received_quantity, source_receipt_basis, product_id, sort_index, revision,
             last_seen_snapshot_id, last_seen_at)
           SELECT s.id, s.source_key, 'r11-agg-probe#0', '同票同商品待核探针', '同票同商品待核探针',
             50, NULL, 'pending', NULL, 'pending', $1, 99, 1,
             (SELECT id FROM catalog.shipment_source_snapshot WHERE status='success'
               ORDER BY read_finished_at DESC,created_at DESC,id DESC LIMIT 1), now()
           FROM catalog.shipment s WHERE s.ticket_no='POKNZX027388'`, [LS101274]);
        const probeRaw = (await owner.query(
          'SELECT catalog.read_product_shipment_in_transit($1) AS r', [LS101274])).rows[0].r;
        const probeRow = (probeRaw?.tickets ?? []).find((entry) => entry.ticketNo === 'POKNZX027388');
        evidence.aggregationProbe = probeRow ?? null;
        check(results, '同票同商品多条明细：RPC 返回 2 条 items（已知一条 + 待核一条不合并掩饰）',
          Array.isArray(probeRow?.items) && probeRow.items.length === 2
          && probeRow.items.some((item) => Number(item.shippedQuantity) === 30000
            && Number(item.receivedQuantity) === 0)
          && probeRow.items.some((item) => item.receivedQuantity === null),
          probeRow ?? null);
        // 应用层期望：已知 30000、待核 1 条（50 那条排除）——由 product-transit 单测复算。
        const probeItems = probeRow?.items ?? [];
        const known = probeItems.filter((item) => !item.manualConflict
          && item.receivedQuantity !== null
          && Number(item.receivedQuantity) <= Number(item.shippedQuantity));
        const knownRemaining = known.reduce(
          (sum, item) => sum + Number(item.shippedQuantity) - Number(item.receivedQuantity), 0);
        const pendingCount = probeItems.length - known.length;
        evidence.aggregationProbeExpected = { knownRemaining, pendingCount };
        check(results, '探针两条：已知剩余 30000、待核 1 条（只排除未知那条）',
          knownRemaining === 30000 && pendingCount === 1,
          { knownRemaining, pendingCount });
        await owner.query('ROLLBACK TO SAVEPOINT agg_probe');
      }

      // ---- 6. 结束：rollback 验证 / 提交 -------------------------------
      if (rollback) {
        await owner.query('ROLLBACK');
        const afterFn = (await owner.query(functionStateSql, [APP_ROLE, FUNCTION_NAME])).rows[0] ?? null;
        const after = (await owner.query(countsSql)).rows[0];
        evidence.afterRollback = {
          functionPresent: Boolean(afterFn),
          functionBodySameAsBefore: beforeFn
            ? Boolean(afterFn) && afterFn.body === beforeFn.body
            : afterFn === null,
          counts: after,
        };
        check(results, 'rollback 后 032 安装已撤销（函数恢复为安装前版本）',
          Boolean(afterFn) === Boolean(beforeFn)
          && (!beforeFn || afterFn.body === beforeFn.body),
          { before: Boolean(beforeFn), after: Boolean(afterFn) });
        check(results, 'rollback 后票/明细/快照/人工历史行数未变',
          after.shipments === evidence.before.shipments
          && after.items === evidence.before.items
          && after.snapshots === evidence.before.snapshots
          && after.manual_revisions === evidence.before.manual_revisions,
          { before: evidence.before, after });
      } else {
        await owner.query('COMMIT');
        const afterFn = (await owner.query(functionStateSql, [APP_ROLE, FUNCTION_NAME])).rows[0] ?? null;
        const after = (await owner.query(countsSql)).rows[0];
        evidence.afterCommit = {
          counts: after,
          functionBodyHasItems: (afterFn?.body ?? '').includes("'items'"),
        };
        check(results, '提交模式：只替换只读函数，票/明细/快照/人工历史行数未变',
          after.shipments === evidence.before.shipments
          && after.items === evidence.before.items
          && after.snapshots === evidence.before.snapshots
          && after.manual_revisions === evidence.before.manual_revisions,
          { before: evidence.before, after });
        check(results, '提交后函数体为逐条 items 版本', (afterFn?.body ?? '').includes("'items'"), null);
      }
    } catch (error) {
      try { await owner.query('ROLLBACK'); } catch { /* 事务已结束 */ }
      throw error;
    }

    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    const failed = results.filter((entry) => !entry.ok);
    evidence.summary = { total: results.length, failed: failed.length };
    fs.writeFileSync(path.join(EVIDENCE_DIR, rollback ? 'apply-032.json' : 'apply-032-commit.json'),
      `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(`\nSUMMARY checks=${results.length} pass=${results.length - failed.length} fail=${failed.length}`);
    if (failed.length > 0) process.exitCode = 1;
  } finally {
    await owner.end();
  }
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
