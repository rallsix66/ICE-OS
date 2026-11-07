/**
 * 把 031「商品详情关联货票在途数据层」增量应用到实例，并回读结构/权限/功能。
 *
 * 031 只新增一个只读 RPC `catalog.read_product_shipment_in_transit(uuid)`（不改 026–030）。
 *
 * 本脚本（仿 apply-030.mjs）：
 *   1) owner 执行 031 两次（证明幂等）；
 *   2) 结构回读：函数签名 / SECURITY DEFINER / search_path='' / STABLE / app 可执行 / public 不可；
 *   3) 权限负向：无管理员 JWT 时被 catalog.require_admin() 拒绝；
 *   4) 功能回读（数据驱动，与库内独立重算逐票比对）：LS101274 两票已知值、027084 待核、
 *      027577 同票两条同商品相加、WM0098 只算本商品（不混入同票爽肤水）、无该商品的商品返回空；
 *      再在事务内临时人工修正 027388（partial 10000 → 剩余 20000、manualCorrected=true）与
 *      制造发货量冲突（新发货量<累计上架 → manualConflict=true）；
 *   5) 默认提交；`--rollback` 用整体事务验证后 ROLLBACK（只做验证，不真正安装）。
 *
 * 用法：
 *   node scripts/shipment/apply-031.mjs --rollback --run-id run-20261026T211500Z-11a22b33
 *   node scripts/shipment/apply-031.mjs --run-id <run-id>          # 提交模式（Lead 执行）
 *   node scripts/shipment/apply-031.mjs --database-url postgres://... [--rollback]
 * 证据：.local/shipment-v1-r10-20261105/apply-031.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_RUN_ID = 'run-20261026T211500Z-11a22b33';
const SQL_FILE = 'db/catalog/031_product_shipment_transit.sql';
const FUNCTION_NAME = 'read_product_shipment_in_transit';
const APP_ROLE = 'ice_p0_02_app_runner';
const ADMIN_PROFILE_ID = '11111111-1111-4111-8111-111111111101';
const EVIDENCE_DIR = path.join(REPO_ROOT, '.local', 'shipment-v1-r10-20261105');
/** 验收用商品（Lead 指定）：LS101274 爽肤水 / WM0098 三酸喷雾。 */
const LS101274 = 'b47da6ed-375c-48b7-b54d-9a3129f445cd';
const WM0098 = 'e9aa760e-6f6e-42c7-90f1-d664959421c0';
/** 027388 的 LS101274 明细（人工修正/冲突用例）。 */
const POKNZX027388_ITEM = '23f52c00-f116-4bfa-ae6b-fe0225444283';
const ROW_KEYS = [
  'shipmentId', 'ticketNo', 'purchaseOrder', 'market', 'waybillsText', 'statusClass',
  'effectiveStatusClass', 'transportText', 'arrivalText', 'shippedQuantity',
  'receivedQuantity', 'manualConflict', 'manualCorrected', 'itemCount', 'ticketItemCount',
];

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
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`}`);
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

  /** 独立重算：该商品在当前快照下按票聚合的期望值（不通过 031）。 */
  async function expectedTickets(client, itemId) {
    const rows = (await client.query(
      `WITH latest AS (
         SELECT id FROM catalog.shipment_source_snapshot WHERE status='success'
         ORDER BY read_finished_at DESC,created_at DESC,id DESC LIMIT 1
       ), latest_src AS (
         SELECT catalog.shipment_current_source_key() AS source_key
       )
       SELECT s.ticket_no,
              s.id::text AS shipment_id,
              sum(i.shipped_quantity)::int AS shipped_quantity,
              (count(*) FILTER (WHERE i.received_quantity IS NULL))::int AS null_received_items,
              sum(i.received_quantity)::int AS received_quantity,
              count(*)::int AS item_count,
              (SELECT count(*)::int FROM catalog.shipment_item t
                WHERE t.shipment_id=s.id AND t.last_seen_snapshot_id=(SELECT id FROM latest)) AS ticket_item_count,
              s.status_class,
              catalog.shipment_effective_status_class(s.id) AS effective_status_class
       FROM catalog.shipment_item i
       JOIN catalog.shipment s ON s.id=i.shipment_id
       WHERE i.product_id=$1
         AND i.last_seen_snapshot_id=(SELECT id FROM latest)
         AND s.last_seen_snapshot_id=(SELECT id FROM latest)
         AND s.source_key=(SELECT source_key FROM latest_src)
       GROUP BY s.id,s.ticket_no,s.status_class
       ORDER BY s.ticket_no`, [itemId])).rows;
    return rows;
  }

  try {
    evidence.identity = (await owner.query(
      'SELECT current_database() AS db, current_user AS user')).rows[0];
    evidence.before = (await owner.query(countsSql)).rows[0];
    const beforeFn = (await owner.query(functionStateSql, [APP_ROLE, FUNCTION_NAME])).rows[0] ?? null;
    evidence.functionBefore = beforeFn
      ? { oid: beforeFn.oid, args: beforeFn.args, bodySha256Length: beforeFn.body?.length ?? null }
      : null;

    // commit 与 rollback 都先开事务：savepoint 探针与“两次应用”必须在同一事务里才能回滚验证。
    await owner.query('BEGIN');
    try {
      // ---- 1. 应用 031 两次（幂等） --------------------------------------
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
      }));
      check(results, '031 函数存在且只有一个重载', fn.length === 1, fn.map((row) => row.args));
      const row = fn[0] ?? null;
      check(results, '函数签名为 (p_item_id uuid)', row?.args === 'p_item_id uuid', row?.args ?? null);
      check(results, '函数为 SECURITY DEFINER', row?.prosecdef === true, row?.prosecdef);
      check(results, "search_path 锁定为 ''", Array.isArray(row?.proconfig)
        && row.proconfig.some((entry) => /^search_path=(?:''|"")$/
          .test(String(entry).replace(/\s/g, '').toLowerCase())), row?.proconfig);
      check(results, '函数为 STABLE（只读）', row?.provolatile === 's', row?.provolatile);
      check(results, 'app 角色可 EXECUTE', row?.app_exec === true, row?.app_exec);
      check(results, 'PUBLIC 不可 EXECUTE', row?.public_exec === false, row?.public_exec);

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
      const lsExpected = await expectedTickets(owner, LS101274);
      const lsRaw = (await owner.query(
        'SELECT catalog.read_product_shipment_in_transit($1) AS r', [LS101274])).rows[0].r;
      evidence.ls101274 = lsRaw;
      evidence.ls101274Expected = lsExpected;

      check(results, 'LS101274：返回票数 = 当前快照里含该商品的票数',
        Array.isArray(lsRaw?.tickets) && lsRaw.tickets.length === lsExpected.length,
        { returned: lsRaw?.tickets?.length ?? null, expected: lsExpected.length });
      check(results, 'LS101274：返回 productId/latestReadAt/snapshotId 且与最近成功快照一致',
        lsRaw?.productId === LS101274
        && Boolean(lsRaw?.latestReadAt) && Boolean(lsRaw?.snapshotId)
        && lsRaw.snapshotId === (await owner.query(
          `WITH latest AS (SELECT id FROM catalog.shipment_source_snapshot WHERE status='success'
             ORDER BY read_finished_at DESC,created_at DESC,id DESC LIMIT 1)
           SELECT id::text FROM latest`)).rows[0].id,
        { productId: lsRaw?.productId, latestReadAt: lsRaw?.latestReadAt, snapshotId: lsRaw?.snapshotId });

      const lsMismatch = lsExpected.filter((expected) => {
        const actual = (lsRaw?.tickets ?? []).find((entry) => entry.ticketNo === expected.ticket_no);
        if (!actual) return true;
        const expectedReceived = expected.null_received_items > 0 ? null : expected.received_quantity;
        return actual.shipmentId !== expected.shipment_id
          || Number(actual.shippedQuantity) !== expected.shipped_quantity
          || (expectedReceived === null
            ? actual.receivedQuantity !== null
            : Number(actual.receivedQuantity) !== expectedReceived)
          || actual.itemCount !== expected.item_count
          || actual.ticketItemCount !== expected.ticket_item_count
          || actual.statusClass !== expected.status_class
          || actual.effectiveStatusClass !== expected.effective_status_class;
      });
      check(results, 'LS101274：每票发货/到货/明细数/状态与独立重算一致',
        lsMismatch.length === 0, lsMismatch.map((expected) => expected.ticket_no));

      const row027388 = (lsRaw?.tickets ?? []).find((entry) => entry.ticketNo === 'POKNZX027388');
      evidence.row027388 = row027388 ?? null;
      check(results, '027388：发货 30000 / 已到 0 / 剩余 30000、1 条本品明细、3 个运单、有效状态 arrived_pending_shelving',
        row027388?.shippedQuantity === 30000 && row027388?.receivedQuantity === 0
        && row027388.shippedQuantity - row027388.receivedQuantity === 30000
        && row027388.itemCount === 1
        && (row027388.waybillsText ?? '').split(/[\r\n]+/).filter((part) => part.trim() !== '').length === 3
        && row027388.effectiveStatusClass === 'arrived_pending_shelving'
        && row027388.manualConflict === false && row027388.manualCorrected === false,
        row027388 ?? null);

      const row027084 = (lsRaw?.tickets ?? []).find((entry) => entry.ticketNo === 'POKNZX027084');
      evidence.row027084 = row027084 ?? null;
      check(results, '027084：发货 80000、已到未知（NULL，待核，不写 0）',
        row027084?.shippedQuantity === 80000 && row027084?.receivedQuantity === null
        && row027084.itemCount === 1 && row027084.manualConflict === false,
        row027084 ?? null);

      const row027577 = (lsRaw?.tickets ?? []).find((entry) => entry.ticketNo === 'POKNZX027577');
      evidence.row027577 = row027577 ?? null;
      check(results, '027577：只算本品 56000（同票另一条其它商品 2 条明细不混入）',
        row027577?.itemCount === 1 && row027577?.shippedQuantity === 56000
        && row027577?.ticketItemCount === 2,
        row027577 ?? null);

      // 同票同商品多条明细相加：真实数据当前没有这种票，用事务内临时插入一条再回滚验证（不写正式库）。
      if (rollback) {
        await owner.query('SAVEPOINT agg_probe');
        await owner.query(
          `INSERT INTO catalog.shipment_item(
             shipment_id, source_key, item_key, product_name_raw, product_name_norm,
             shipped_quantity, received_quantity, receipt_basis,
             source_received_quantity, source_receipt_basis, product_id, sort_index, revision,
             last_seen_snapshot_id, last_seen_at)
           SELECT s.id, s.source_key, 'agg-probe#0', '同商品合计探针', '同商品合计探针',
             1000, 0, 'status_in_transit_zero', 0, 'status_in_transit_zero', $1, 99, 1,
             (SELECT id FROM catalog.shipment_source_snapshot WHERE status='success'
               ORDER BY read_finished_at DESC,created_at DESC,id DESC LIMIT 1), now()
           FROM catalog.shipment s WHERE s.ticket_no='POKNZX027388'`, [LS101274]);
        const aggRaw = (await owner.query(
          'SELECT catalog.read_product_shipment_in_transit($1) AS r', [LS101274])).rows[0].r;
        const aggRow = (aggRaw?.tickets ?? []).find((entry) => entry.ticketNo === 'POKNZX027388');
        evidence.aggregationProbe = aggRow ?? null;
        check(results, '同票同商品多条明细按票相加（30000+1000=31000、itemCount=2）',
          aggRow?.shippedQuantity === 31000 && aggRow?.itemCount === 2
          && aggRow?.receivedQuantity === 0,
          aggRow ?? null);
        await owner.query('ROLLBACK TO SAVEPOINT agg_probe');
      }

      const wmExpected = await expectedTickets(owner, WM0098);
      const wmRaw = (await owner.query(
        'SELECT catalog.read_product_shipment_in_transit($1) AS r', [WM0098])).rows[0].r;
      evidence.wm0098 = wmRaw;
      evidence.wm0098Expected = wmExpected;
      const wmMismatch = wmExpected.filter((expected) => {
        const actual = (wmRaw?.tickets ?? []).find((entry) => entry.ticketNo === expected.ticket_no);
        if (!actual) return true;
        const expectedReceived = expected.null_received_items > 0 ? null : expected.received_quantity;
        return Number(actual.shippedQuantity) !== expected.shipped_quantity
          || (expectedReceived === null
            ? actual.receivedQuantity !== null
            : Number(actual.receivedQuantity) !== expectedReceived)
          || actual.itemCount !== expected.item_count
          || actual.ticketItemCount !== expected.ticket_item_count;
      });
      check(results, 'WM0098：票数与逐票合计与独立重算一致',
        Array.isArray(wmRaw?.tickets) && wmRaw.tickets.length === wmExpected.length
        && wmMismatch.length === 0,
        { returned: wmRaw?.tickets?.length ?? null, expected: wmExpected.length, mismatch: wmMismatch.map((e) => e.ticket_no) });

      const wm026710 = (wmRaw?.tickets ?? []).find((entry) => entry.ticketNo === 'POKNZX026710');
      evidence.row026710 = wm026710 ?? null;
      check(results, 'WM0098 026710：本品 14000 / 已到 14000 / 剩余 0，同票爽肤水 11440 未混入',
        wm026710?.shippedQuantity === 14000 && wm026710?.receivedQuantity === 14000
        && wm026710.shippedQuantity - wm026710.receivedQuantity === 0
        && wm026710.itemCount === 1 && wm026710.ticketItemCount === 2
        && wm026710.shippedQuantity !== 25440,
        wm026710 ?? null);

      check(results, '每票行字段齐全（16 个键）',
        (lsRaw?.tickets ?? []).concat(wmRaw?.tickets ?? []).every((entry) => (
          ROW_KEYS.every((key) => Object.prototype.hasOwnProperty.call(entry, key))
        )), ROW_KEYS);

      const absent = (await owner.query(
        'SELECT catalog.read_product_shipment_in_transit($1) AS r',
        ['00000000-0000-0000-0000-0000000000ff'])).rows[0].r;
      evidence.absentProduct = absent;
      check(results, '当前快照没有该商品的明细时返回空票列表（不伪造）',
        Array.isArray(absent?.tickets) && absent.tickets.length === 0
        && absent.productId === '00000000-0000-0000-0000-0000000000ff'
        && Boolean(absent.latestReadAt),
        absent);

      // ---- 5. 事务内人工修正 / 冲突（仅 rollback 模式做“会写”的验证） ----
      if (rollback) {
        const itemBefore = (await owner.query(
          `SELECT id, shipped_quantity, received_quantity, manual_revision, manual_status
           FROM catalog.shipment_item WHERE id=$1`, [POKNZX027388_ITEM])).rows[0];
        evidence.manualBefore = itemBefore ?? null;
        check(results, '人工修正用例目标明细存在且当前未人工修正',
          Boolean(itemBefore) && itemBefore.manual_status === null, itemBefore ?? null);

        const applied = (await owner.query(
          'SELECT catalog.apply_shipment_item_manual_correction($1,$2,$3,$4,$5) AS r',
          [POKNZX027388_ITEM, 'partial_shelved', 10000, itemBefore.manual_revision, 'apply-031 回读'])).rows[0].r;
        const afterManual = (await owner.query(
          'SELECT catalog.read_product_shipment_in_transit($1) AS r', [LS101274])).rows[0].r;
        const manualRow = (afterManual?.tickets ?? []).find((entry) => entry.ticketNo === 'POKNZX027388');
        evidence.manualApplied = { applied, row: manualRow ?? null };
        check(results, '人工修正 partial 10000 后：已到 10000 / 剩余 20000 / manualCorrected=true',
          applied?.ok === true && manualRow?.receivedQuantity === 10000
          && manualRow.shippedQuantity === 30000
          && manualRow.shippedQuantity - manualRow.receivedQuantity === 20000
          && manualRow.manualCorrected === true && manualRow.manualConflict === false,
          { applied, row: manualRow ?? null });

        // 制造发货量冲突：把发货量改到小于已确认累计上架（partial 冲突口径）。
        await owner.query('UPDATE catalog.shipment_item SET shipped_quantity=$2 WHERE id=$1',
          [POKNZX027388_ITEM, 5000]);
        const conflictFlag = (await owner.query(
          'SELECT catalog.shipment_manual_quantity_conflict($1) AS c', [POKNZX027388_ITEM])).rows[0].c;
        const afterConflict = (await owner.query(
          'SELECT catalog.read_product_shipment_in_transit($1) AS r', [LS101274])).rows[0].r;
        const conflictRow = (afterConflict?.tickets ?? []).find((entry) => entry.ticketNo === 'POKNZX027388');
        evidence.conflict = { flag: conflictFlag, row: conflictRow ?? null };
        check(results, '制造发货量冲突后：manualConflict=true（调用方据此不计入货值）',
          conflictFlag === true && conflictRow?.manualConflict === true
          && conflictRow.shippedQuantity === 5000 && conflictRow.receivedQuantity === 10000,
          { flag: conflictFlag, row: conflictRow ?? null });
        check(results, '冲突时仍如实返回人工已到与当前发货量（不吞、不归零）',
          conflictRow?.manualCorrected === true
          && conflictRow.shippedQuantity - conflictRow.receivedQuantity === -5000,
          conflictRow ?? null);
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
        check(results, 'rollback 后 031 安装已撤销（与运行前状态一致）',
          Boolean(afterFn) === Boolean(beforeFn)
          && (!beforeFn || afterFn.body === beforeFn.body),
          { before: Boolean(beforeFn), after: Boolean(afterFn) });
        check(results, 'rollback 后票/明细/快照/人工历史行数未变',
          after.shipments === evidence.before.shipments
          && after.items === evidence.before.items
          && after.snapshots === evidence.before.snapshots
          && after.manual_revisions === evidence.before.manual_revisions,
          { before: evidence.before, after });
        check(results, 'rollback 后人工修正测试数据未写入（该明细仍是原状态）',
          (await owner.query(
            `SELECT manual_status, received_quantity FROM catalog.shipment_item WHERE id=$1`,
            [POKNZX027388_ITEM])).rows[0].manual_status === null,
          (await owner.query(
            `SELECT manual_status, received_quantity, manual_revision
             FROM catalog.shipment_item WHERE id=$1`, [POKNZX027388_ITEM])).rows[0]);
      } else {
        await owner.query('COMMIT');
        const after = (await owner.query(countsSql)).rows[0];
        evidence.afterCommit = { counts: after };
        check(results, '提交模式：只新增函数，票/明细/快照/人工历史行数未变',
          after.shipments === evidence.before.shipments
          && after.items === evidence.before.items
          && after.snapshots === evidence.before.snapshots
          && after.manual_revisions === evidence.before.manual_revisions,
          { before: evidence.before, after });
      }
    } catch (error) {
      if (rollback) {
        try { await owner.query('ROLLBACK'); } catch { /* 事务已结束 */ }
      } else {
        try { await owner.query('ROLLBACK'); } catch { /* 事务已结束 */ }
      }
      throw error;
    }

    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    const failed = results.filter((entry) => !entry.ok);
    evidence.summary = { total: results.length, failed: failed.length };
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'apply-031.json'),
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
