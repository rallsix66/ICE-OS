/**
 * 把 029「修正在途（人工）+ 逐商品到货口径」增量应用到现役实例，并回读结构/权限/功能。
 *
 * 029 内容：shipment_item 增 source_ 与 manual_ 列（幂等回填）、manual 历史表、有效状态函数、
 * apply/restore 写入 RPC、manual index/history 只读 RPC、替换 ingest_shipment_snapshot_core。
 *
 * 本脚本（对照 apply-028.mjs 写法）：
 *   1) owner 执行增量文件两次（证明幂等），回读列/约束/历史表/RLS/触发器/函数签名与权限；
 *   2) 回填一致性：每行 source_receipt_basis 非空；无人工修正时 source_* 与生效值一致；
 *   3) 功能回读在 **事务内执行并 ROLLBACK**（不在正式库留下测试人工修正）：
 *      apply → 生效值/来源值不变/item.revision 不变/历史 1 条 → 版本冲突 → restore → 回到原表值/历史 2 条；
 *   4) 无管理员 JWT 时 RPC 被拒绝；
 *   5) 证据写 .local/shipment-v1-r8-20261104/apply-029.json。
 *
 * 用法：node scripts/shipment/apply-029.mjs [--run-id ...] [--dry-run]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_RUN_ID = 'run-20261026T211500Z-11a22b33';
const SQL_FILE = 'db/catalog/029_shipment_in_transit_correction.sql';
const APP_ROLE = 'ice_p0_02_app_runner';
const ADMIN_PROFILE_ID = '11111111-1111-4111-8111-111111111101';
const EVIDENCE_DIR = path.join(REPO_ROOT, '.local', 'shipment-v1-r8-20261104');
const MANUAL_COLUMNS = [
  'source_received_quantity', 'source_receipt_basis', 'manual_status', 'manual_shelved_quantity',
  'manual_actor_id', 'manual_actor_name', 'manual_at', 'manual_revision',
  'manual_arrival_snapshot', 'manual_review_needed', 'manual_review_note',
];
const MANUAL_CONSTRAINTS = [
  'shipment_item_receipt_basis_check',
  'shipment_item_source_receipt_basis_check',
  'shipment_item_source_received_quantity_check',
  'shipment_item_manual_status_check',
  'shipment_item_manual_empty_check',
  'shipment_item_manual_actor_check',
  'shipment_item_manual_shelved_check',
];
const FUNCTIONS = [
  ['shipment_effective_status_class', 'p_shipment_id uuid', false],
  ['apply_shipment_item_manual_correction', 'p_item_id uuid, p_status text, p_cumulative_shelved integer, p_expected_manual_revision integer, p_actor_name text', true],
  ['restore_shipment_item_source_judgement', 'p_item_id uuid, p_expected_manual_revision integer, p_actor_name text', true],
  ['read_shipment_manual_index', '', true],
  ['read_shipment_manual_history', 'p_shipment_id uuid', true],
  ['ingest_shipment_snapshot_core', 'p_snapshot jsonb, p_actor uuid', false],
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

const SYSTEM_TZ_PATTERN = /^search_path=(?:''|"")$/;

async function asAdminApp(app, fn) {
  await app.query('BEGIN');
  try {
    await app.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`, [ADMIN_PROFILE_ID]);
    const value = await fn();
    await app.query('ROLLBACK');
    return value;
  } catch (error) {
    await app.query('ROLLBACK');
    throw error;
  }
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  const runId = args['run-id'] ?? DEFAULT_RUN_ID;
  const env = JSON.parse(fs.readFileSync(
    path.join(REPO_ROOT, '.local/catalog', runId, 'instance/env.inventory.json'), 'utf8'));
  const { default: pg } = await import('pg');
  const owner = new pg.Client({ connectionString: env.ownerDbUrl });
  await owner.connect();
  const results = [];
  const evidence = { runId, database: env.database, at: new Date().toISOString(), checks: results };
  try {
    const identity = (await owner.query(
      'SELECT current_database() AS db, current_user AS user')).rows[0];
    evidence.identity = identity;
    const before = (await owner.query(
      `SELECT (SELECT count(*) FROM catalog.shipment)::int AS shipments,
              (SELECT count(*) FROM catalog.shipment_item)::int AS items,
              (SELECT count(*) FROM catalog.shipment_source_snapshot)::int AS snapshots`)).rows[0];
    evidence.before = before;

    if (!args['dry-run']) {
      const sqlText = fs.readFileSync(path.join(REPO_ROOT, SQL_FILE), 'utf8');
      for (let round = 1; round <= 2; round += 1) {
        await owner.query(sqlText);
        await owner.query('RESET ROLE; RESET ALL');
      }
      evidence.applied = { file: SQL_FILE, applications: 2 };
    }

    // ---- 1. 结构回读 ------------------------------------------------------
    const columns = (await owner.query(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema='catalog' AND table_name='shipment_item'
         AND column_name = ANY($1::text[]) ORDER BY column_name`, [MANUAL_COLUMNS])).rows;
    evidence.columns = columns;
    check(results, 'shipment_item 新增 11 个人工/原表判断列',
      columns.length === MANUAL_COLUMNS.length, columns.map((row) => row.column_name));
    check(results, 'source_receipt_basis 已回填且 NOT NULL',
      columns.some((row) => row.column_name === 'source_receipt_basis' && row.is_nullable === 'NO'),
      columns.find((row) => row.column_name === 'source_receipt_basis') ?? null);

    const constraints = (await owner.query(
      `SELECT conname FROM pg_constraint
       WHERE conrelid='catalog.shipment_item'::regclass AND contype='c' ORDER BY conname`)).rows
      .map((row) => row.conname);
    evidence.constraints = constraints;
    check(results, '7 个新/改约束存在',
      MANUAL_CONSTRAINTS.every((name) => constraints.includes(name)), constraints);

    const historyTable = (await owner.query(
      `SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS force_rls
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='catalog' AND c.relname='shipment_item_manual_revision'`)).rows[0];
    const historyTrigger = (await owner.query(
      `SELECT 1 FROM pg_trigger WHERE tgname='immutable_history'
       AND tgrelid='catalog.shipment_item_manual_revision'::regclass`)).rowCount;
    const historyPolicies = (await owner.query(
      `SELECT policyname FROM pg_policies WHERE schemaname='catalog'
       AND tablename='shipment_item_manual_revision' ORDER BY policyname`)).rows
      .map((row) => row.policyname);
    const historyAppSelect = (await owner.query(
      `SELECT pg_catalog.has_table_privilege($1,'catalog.shipment_item_manual_revision','SELECT') AS ok`,
      [APP_ROLE])).rows[0].ok;
    evidence.historyTable = { historyTable, historyTrigger, historyPolicies, historyAppSelect };
    check(results, '人工修正历史表 FORCE RLS + 不可变触发器 + 两条策略',
      historyTable?.rls === true && historyTable?.force_rls === true
      && historyTrigger === 1
      && historyPolicies.includes('enabled_admin')
      && historyPolicies.includes('shipment_definer_owner'),
      { historyTable, historyTrigger, historyPolicies });
    check(results, 'app 不能直接 SELECT 人工修正历史表', historyAppSelect === false, historyAppSelect);

    const functions = (await owner.query(
      `SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args, p.prosecdef,
              p.proconfig,
              pg_catalog.has_function_privilege($1, p.oid, 'EXECUTE') AS app_exec,
              pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
       FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='catalog' AND p.proname = ANY($2::text[])
       ORDER BY p.proname`, [APP_ROLE, FUNCTIONS.map(([name]) => name)])).rows;
    evidence.functions = functions;
    for (const [name, signature, appGranted] of FUNCTIONS) {
      const row = functions.find((entry) => entry.proname === name && entry.args === signature);
      check(results, `${name} 存在且签名一致`, Boolean(row), row?.args ?? null);
      if (!row) continue;
      check(results, `${name} SECURITY DEFINER`, row.prosecdef === true, row.prosecdef);
      check(results, `${name} search_path 锁定`,
        Array.isArray(row.proconfig)
        && row.proconfig.some((entry) => SYSTEM_TZ_PATTERN.test(String(entry).replace(/\s/g, '').toLowerCase())),
        row.proconfig);
      check(results, `${name} ${appGranted ? 'app 可 EXECUTE' : '不对 app 授权'}`,
        appGranted ? row.app_exec === true : row.app_exec === false, row.app_exec);
      check(results, `${name} PUBLIC 不可 EXECUTE`, row.public_exec === false, row.public_exec);
    }

    // ---- 2. 回填一致性 ----------------------------------------------------
    const backfill = (await owner.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE source_receipt_basis IS NULL)::int AS missing_basis,
              count(*) FILTER (WHERE manual_status IS NULL AND source_received_quantity IS DISTINCT FROM received_quantity)::int AS rcvd_mismatch,
              count(*) FILTER (WHERE manual_status IS NULL AND source_receipt_basis IS DISTINCT FROM receipt_basis)::int AS basis_mismatch,
              count(*) FILTER (WHERE manual_status IS NOT NULL)::int AS manual_rows
       FROM catalog.shipment_item`)).rows[0];
    evidence.backfill = backfill;
    check(results, '每行都有 source_receipt_basis', backfill.missing_basis === 0, backfill);
    check(results, '无人工修正时 source_* 与生效值一致',
      backfill.rcvd_mismatch === 0 && backfill.basis_mismatch === 0, backfill);

    // ---- 3. 功能回读（事务内，结束 ROLLBACK，不写正式库） -----------------
    const app = new pg.Client({ connectionString: env.appDbUrl });
    await app.connect();
    try {
      const target = (await owner.query(
        `WITH latest AS (
           SELECT id FROM catalog.shipment_source_snapshot WHERE status='success'
           ORDER BY read_finished_at DESC,created_at DESC,id DESC LIMIT 1)
         SELECT i.id, i.shipment_id, i.shipped_quantity, i.received_quantity,
                i.receipt_basis, i.source_received_quantity, i.source_receipt_basis,
                i.revision, i.manual_revision
         FROM catalog.shipment_item i JOIN catalog.shipment s ON s.id=i.shipment_id
         WHERE i.last_seen_snapshot_id=(SELECT id FROM latest)
           AND s.last_seen_snapshot_id=(SELECT id FROM latest)
           AND i.manual_status IS NULL AND i.received_quantity IS NOT NULL
           AND i.received_quantity=0
         ORDER BY i.shipped_quantity LIMIT 1`)).rows[0];
      evidence.functionalTarget = target ?? null;
      check(results, '找到可用于功能回读的当前明细（未人工修正、累计到货 0）', Boolean(target), target ?? null);

      const manualIndexBefore = await asAdminApp(app, async () => (
        await app.query('SELECT catalog.read_shipment_manual_index() AS r')).rows[0].r);
      check(results, 'read_shipment_manual_index 返回全部票的有效状态',
        Array.isArray(manualIndexBefore?.shipments)
        && manualIndexBefore.shipments.length === before.shipments
        && manualIndexBefore.shipments.every((row) => typeof row.effectiveStatusClass === 'string'),
        { shipments: manualIndexBefore?.shipments?.length ?? null, items: manualIndexBefore?.items?.length ?? null });

      // 事务内的写入只能通过同一个 app 连接观察：用 026 详情（生效值/revision）+
      // 029 manual index（人工字段/原表值）读回，不跨连接读未提交数据。
      async function readManualItemState(itemId) {
        const detailRaw = (await app.query(
          'SELECT catalog.read_shipment_detail($1) AS r', [target.shipment_id])).rows[0].r;
        const indexRaw = (await app.query(
          'SELECT catalog.read_shipment_manual_index() AS r')).rows[0].r;
        const item = (detailRaw?.items ?? []).find((row) => row.itemId === itemId) ?? null;
        const manual = (indexRaw?.items ?? []).find((row) => row.itemId === itemId) ?? null;
        return {
          receivedQuantity: item?.receivedQuantity ?? null,
          receiptBasis: item?.receiptBasis ?? null,
          remainingQuantity: item?.remainingQuantity ?? null,
          revision: item?.revision ?? null,
          manualStatus: manual?.manualStatus ?? null,
          manualRevision: manual?.manualRevision ?? null,
          manualActorName: manual?.manualActorName ?? null,
          manualReviewNeeded: manual?.manualReviewNeeded ?? null,
          sourceReceivedQuantity: manual?.sourceReceivedQuantity ?? null,
          sourceReceiptBasis: manual?.sourceReceiptBasis ?? null,
        };
      }

      const cycle = await asAdminApp(app, async () => {
        const applied = (await app.query(
          'SELECT catalog.apply_shipment_item_manual_correction($1,$2,$3,$4,$5) AS r',
          [target.id, 'fully_shelved', null, 0, 'apply-029 回读'])).rows[0].r;
        const afterApply = await readManualItemState(target.id);
        const historyAfterApply = (await app.query(
          'SELECT catalog.read_shipment_manual_history($1) AS r', [target.shipment_id])).rows[0].r;
        const conflict = (await app.query(
          'SELECT catalog.apply_shipment_item_manual_correction($1,$2,$3,$4,$5) AS r',
          [target.id, 'in_transit', null, 0, 'apply-029 回读'])).rows[0].r;
        const invalidQuantity = (await app.query(
          'SELECT catalog.apply_shipment_item_manual_correction($1,$2,$3,$4,$5) AS r',
          [target.id, 'partial_shelved', target.shipped_quantity + 1, 1, 'apply-029 回读'])).rows[0].r;
        const restored = (await app.query(
          'SELECT catalog.restore_shipment_item_source_judgement($1,$2,$3) AS r',
          [target.id, 1, 'apply-029 回读'])).rows[0].r;
        const afterRestore = await readManualItemState(target.id);
        const historyAfterRestore = (await app.query(
          'SELECT catalog.read_shipment_manual_history($1) AS r', [target.shipment_id])).rows[0].r;
        const indexAfterRestore = (await app.query(
          'SELECT catalog.read_shipment_manual_index() AS r')).rows[0].r;
        return {
          applied, afterApply, historyAfterApply, conflict, invalidQuantity,
          restored, afterRestore, historyAfterRestore, indexAfterRestore,
        };
      });
      evidence.cycle = cycle;

      check(results, 'apply 生效：fully_shelved → 累计到货=发货量、依据 manual_correction',
        cycle.applied?.ok === true && cycle.afterApply.receivedQuantity === target.shipped_quantity
        && cycle.afterApply.receiptBasis === 'manual_correction'
        && cycle.afterApply.remainingQuantity === 0,
        { applied: cycle.applied, row: cycle.afterApply });
      check(results, 'apply 不改原表判断值、不改 item.revision',
        cycle.afterApply.sourceReceivedQuantity === target.source_received_quantity
        && cycle.afterApply.sourceReceiptBasis === target.source_receipt_basis
        && cycle.afterApply.revision === target.revision,
        { source: cycle.afterApply, before: target });
      check(results, 'apply 记录修改人与 manual_revision=1、历史 +1',
        cycle.afterApply.manualRevision === 1
        && cycle.afterApply.manualActorName === 'apply-029 回读'
        && Array.isArray(cycle.historyAfterApply)
        && cycle.historyAfterApply.length === 1
        && cycle.historyAfterApply[0].action === 'apply'
        && cycle.historyAfterApply[0].receivedQuantity === target.shipped_quantity,
        cycle.historyAfterApply);
      check(results, '版本冲突返回 SHIPMENT_MANUAL_CONFLICT（不抛错、不改数据）',
        cycle.conflict?.ok === false && cycle.conflict?.errorCode === 'SHIPMENT_MANUAL_CONFLICT',
        cycle.conflict);
      check(results, '累计已上架超出发货量被拒绝',
        cycle.invalidQuantity?.ok === false
        && cycle.invalidQuantity?.errorCode === 'SHIPMENT_MANUAL_INVALID_QUANTITY',
        cycle.invalidQuantity);
      check(results, 'restore 回到原表判断值并清空人工字段（版本号保留，供下次乐观并发）',
        cycle.restored?.ok === true
        && cycle.afterRestore.receivedQuantity === target.source_received_quantity
        && cycle.afterRestore.receiptBasis === target.source_receipt_basis
        && cycle.afterRestore.manualStatus === null
        && cycle.afterRestore.manualActorName === null
        && cycle.afterRestore.manualRevision === 2,
        { restored: cycle.restored, row: cycle.afterRestore });
      check(results, 'restore 后历史 2 条且最新为 restore',
        Array.isArray(cycle.historyAfterRestore) && cycle.historyAfterRestore.length === 2
        && cycle.historyAfterRestore[0].action === 'restore',
        cycle.historyAfterRestore?.map((row) => row.action));
      check(results, 'restore 后 manual index 不再有生效人工状态',
        Array.isArray(cycle.indexAfterRestore?.items)
        && cycle.indexAfterRestore.items.every((row) => row.manualStatus === null),
        { before: manualIndexBefore?.items?.length ?? null, after: cycle.indexAfterRestore?.items?.length ?? null });

      // 无管理员 JWT：写入与只读都被 require_admin 拒绝。
      let anonymousRejected = false;
      await app.query('BEGIN');
      try {
        await app.query(`SELECT set_config('request.jwt.claim.sub','',true)`);
        await app.query('SELECT catalog.read_shipment_manual_index()');
        await app.query('ROLLBACK');
      } catch {
        anonymousRejected = true;
        await app.query('ROLLBACK');
      }
      check(results, '无管理员 JWT 时 manual RPC 被拒绝', anonymousRejected, anonymousRejected);
    } finally {
      await app.end();
    }

    // ---- 4. 应用后数据未变 ------------------------------------------------
    const after = (await owner.query(
      `SELECT (SELECT count(*) FROM catalog.shipment)::int AS shipments,
              (SELECT count(*) FROM catalog.shipment_item)::int AS items,
              (SELECT count(*) FROM catalog.shipment_source_snapshot)::int AS snapshots,
              (SELECT count(*) FROM catalog.shipment_item_manual_revision)::int AS manual_revisions`)).rows[0];
    evidence.after = after;
    check(results, '029 不改变票/明细/快照行数（功能回读已回滚）',
      after.shipments === before.shipments && after.items === before.items
      && after.snapshots === before.snapshots && after.manual_revisions === 0,
      { before, after });

    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    const failed = results.filter((row) => !row.ok);
    evidence.summary = { total: results.length, failed: failed.length };
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'apply-029.json'),
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
