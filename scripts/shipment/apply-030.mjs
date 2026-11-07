/**
 * 把 030「手工状态真正生效 + 发货量变更待复核」增量应用到现役实例，并回读结构/权限/功能。
 *
 * 本脚本：
 *   1) owner 执行 030 两次（证明幂等），回读新列/约束/函数签名与权限；
 *   2) 回填一致性：有人工修正的行必须有 manual_shipped_quantity；
 *   3) 功能回读在事务内执行并 ROLLBACK（正式库不留测试人工修正）：
 *      apply → 快照/有效状态/列表状态筛选 → 直接改小发货量 → 冲突标记 → 重新 apply 清除 → restore；
 *   4) 证据写 .local/shipment-v1-r9-20261105/apply-030.json。
 *
 * 用法：node scripts/shipment/apply-030.mjs [--run-id ...] [--dry-run]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_RUN_ID = 'run-20261026T211500Z-11a22b33';
const SQL_FILE = 'db/catalog/030_shipment_in_transit_status_conflict.sql';
const APP_ROLE = 'ice_p0_02_app_runner';
const ADMIN_PROFILE_ID = '11111111-1111-4111-8111-111111111101';
const EVIDENCE_DIR = path.join(REPO_ROOT, '.local', 'shipment-v1-r9-20261105');
const NEW_COLUMN = 'manual_shipped_quantity';
const NEW_CONSTRAINTS = [
  'shipment_item_manual_empty_check',
  'shipment_item_manual_shipped_check',
  'shipment_item_manual_shelved_check',
];
const FUNCTIONS = [
  ['shipment_manual_quantity_conflict', 'p_item_id uuid', false],
  ['shipment_effective_status_class', 'p_shipment_id uuid', false],
  ['apply_shipment_item_manual_correction', 'p_item_id uuid, p_status text, p_cumulative_shelved integer, p_expected_manual_revision integer, p_actor_name text', true],
  ['restore_shipment_item_source_judgement', 'p_item_id uuid, p_expected_manual_revision integer, p_actor_name text', true],
  ['read_shipment_manual_index', '', true],
  ['read_shipment_market_summary', 'p_market text', true],
  ['read_shipment_list', 'p_market text, p_status text, p_search text, p_product uuid, p_include_absent boolean, p_limit integer, p_offset integer', true],
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

async function main() {
  const args = readArgs(process.argv.slice(2));
  const runId = args['run-id'] ?? DEFAULT_RUN_ID;
  const env = JSON.parse(fs.readFileSync(
    path.join(REPO_ROOT, '.local/catalog', runId, 'instance/env.inventory.json'), 'utf8'));
  const { default: pg } = await import('pg');
  const owner = new pg.Client({ connectionString: args['database-url'] ?? env.ownerDbUrl });
  await owner.connect();
  const results = [];
  const evidence = { runId, database: env.database, at: new Date().toISOString(), checks: results };
  if (args['database-url']) evidence.databaseUrlOverride = args['database-url'].replace(/:[^:@/]+@/, ':***@');
  try {
    evidence.identity = (await owner.query(
      'SELECT current_database() AS db, current_user AS user')).rows[0];
    const before = (await owner.query(
      `SELECT (SELECT count(*) FROM catalog.shipment)::int AS shipments,
              (SELECT count(*) FROM catalog.shipment_item)::int AS items,
              (SELECT count(*) FROM catalog.shipment_source_snapshot)::int AS snapshots,
              (SELECT count(*) FROM catalog.shipment_item_manual_revision)::int AS manual_revisions`)).rows[0];
    evidence.before = before;

    if (!args['dry-run']) {
      const sqlText = fs.readFileSync(path.join(REPO_ROOT, SQL_FILE), 'utf8');
      for (let round = 1; round <= 2; round += 1) {
        await owner.query(sqlText);
        await owner.query('RESET ROLE; RESET ALL');
      }
      evidence.applied = { file: SQL_FILE, applications: 2 };
    }

    const column = (await owner.query(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
       WHERE table_schema='catalog' AND table_name='shipment_item'
         AND column_name=$1`, [NEW_COLUMN])).rows[0] ?? null;
    evidence.column = column;
    check(results, 'shipment_item 新增 manual_shipped_quantity(integer, NULL)', Boolean(column)
      && column.data_type === 'integer' && column.is_nullable === 'YES', column);

    const constraints = (await owner.query(
      `SELECT conname FROM pg_constraint
       WHERE conrelid='catalog.shipment_item'::regclass AND contype='c' ORDER BY conname`)).rows
      .map((row) => row.conname);
    evidence.constraints = constraints;
    check(results, '本轮 3 个约束存在', NEW_CONSTRAINTS.every((name) => constraints.includes(name)), constraints);

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
      check(results, `${name} search_path 锁定`, Array.isArray(row.proconfig)
        && row.proconfig.some((entry) => /^search_path=(?:''|"")$/.test(String(entry).replace(/\s/g, ''))),
      row.proconfig);
      check(results, `${name} ${appGranted ? 'app 可 EXECUTE' : '不对 app 授权'}`,
        appGranted ? row.app_exec === true : row.app_exec === false, row.app_exec);
      check(results, `${name} PUBLIC 不可 EXECUTE`, row.public_exec === false, row.public_exec);
    }

    const backfill = (await owner.query(
      `SELECT count(*) FILTER (WHERE manual_status IS NOT NULL)::int AS manual_rows,
              count(*) FILTER (WHERE manual_status IS NOT NULL AND manual_shipped_quantity IS NULL)::int AS missing_snapshot,
              count(*) FILTER (WHERE manual_status IS NULL AND manual_shipped_quantity IS NOT NULL)::int AS orphan_snapshot
       FROM catalog.shipment_item`)).rows[0];
    evidence.backfill = backfill;
    check(results, '有人工修正的行都有发货量快照；无人工修正的行没有快照',
      backfill.missing_snapshot === 0 && backfill.orphan_snapshot === 0, backfill);

    // 功能回读（事务内 ROLLBACK）。
    await owner.query('BEGIN');
    try {
      await owner.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`, [ADMIN_PROFILE_ID]);
      const target = (await owner.query(
        `WITH latest AS (
           SELECT id FROM catalog.shipment_source_snapshot WHERE status='success'
           ORDER BY read_finished_at DESC,created_at DESC,id DESC LIMIT 1)
         SELECT i.id, i.shipment_id, s.ticket_no, i.shipped_quantity, i.received_quantity,
                i.manual_revision, i.revision
         FROM catalog.shipment_item i JOIN catalog.shipment s ON s.id=i.shipment_id
         WHERE i.last_seen_snapshot_id=(SELECT id FROM latest)
           AND s.last_seen_snapshot_id=(SELECT id FROM latest)
           AND i.manual_status IS NULL AND i.shipped_quantity>1
         ORDER BY i.shipped_quantity DESC LIMIT 1`)).rows[0];
      evidence.functionalTarget = target ?? null;
      check(results, '找到可用于功能回读的当前明细', Boolean(target), target ?? null);
      if (target) {
        const applied = (await owner.query(
          'SELECT catalog.apply_shipment_item_manual_correction($1,$2,$3,$4,$5) AS r',
          [target.id, 'fully_shelved', null, 0, 'apply-030 回读'])).rows[0].r;
        const afterApply = (await owner.query(
          `SELECT manual_shipped_quantity, manual_status, manual_revision, manual_review_needed,
                  shipped_quantity, received_quantity
           FROM catalog.shipment_item WHERE id=$1`, [target.id])).rows[0];
        const listAll = (await owner.query(
          'SELECT catalog.read_shipment_list(NULL,NULL,NULL,NULL,false,100,0) AS r')).rows[0].r;
        const targetRow = (listAll.rows ?? []).find((row) => row.shipmentId === target.shipment_id) ?? null;
        const effectiveStatus = targetRow?.effectiveStatusClass ?? null;
        const otherStatus = effectiveStatus === 'arrived' ? 'in_transit' : 'arrived';
        const listMatched = effectiveStatus === null ? null : (await owner.query(
          'SELECT catalog.read_shipment_list(NULL,$1,NULL,NULL,false,100,0) AS r',
          [effectiveStatus])).rows[0].r;
        const listOther = (await owner.query(
          'SELECT catalog.read_shipment_list(NULL,$1,NULL,NULL,false,100,0) AS r',
          [otherStatus])).rows[0].r;
        const indexItem = ((await owner.query(
          'SELECT catalog.read_shipment_manual_index() AS r')).rows[0].r.items ?? [])
          .find((row) => row.itemId === target.id) ?? null;
        // 直接改小发货量（模拟原表改量，未走 ingest），验证冲突判定与列表状态不变。
        const newShipped = target.shipped_quantity - 1;
        await owner.query('UPDATE catalog.shipment_item SET shipped_quantity=$2 WHERE id=$1', [target.id, newShipped]);
        const conflict = (await owner.query(
          'SELECT catalog.shipment_manual_quantity_conflict($1) AS c', [target.id])).rows[0].c;
        const conflictedIndex = ((await owner.query(
          'SELECT catalog.read_shipment_manual_index() AS r')).rows[0].r.items ?? [])
          .find((row) => row.itemId === target.id) ?? null;
        const reapplied = (await owner.query(
          'SELECT catalog.apply_shipment_item_manual_correction($1,$2,$3,$4,$5) AS r',
          [target.id, 'fully_shelved', null, 1, 'apply-030 回读'])).rows[0].r;
        const afterReapply = (await owner.query(
          `SELECT manual_shipped_quantity, manual_revision, manual_review_needed,
                  shipped_quantity, received_quantity
           FROM catalog.shipment_item WHERE id=$1`, [target.id])).rows[0];
        const conflictAfter = (await owner.query(
          'SELECT catalog.shipment_manual_quantity_conflict($1) AS c', [target.id])).rows[0].c;
        const restored = (await owner.query(
          'SELECT catalog.restore_shipment_item_source_judgement($1,$2,$3) AS r',
          [target.id, 2, 'apply-030 回读'])).rows[0].r;
        const afterRestore = (await owner.query(
          `SELECT manual_status, manual_shipped_quantity, manual_revision, received_quantity
           FROM catalog.shipment_item WHERE id=$1`, [target.id])).rows[0];
        evidence.cycle = {
          applied, afterApply, listMatched, listOther, indexItem, conflict,
          conflictedIndex, reapplied, afterReapply, conflictAfter, restored, afterRestore,
        };
        check(results, 'apply 保存旧发货量快照且冲突为 false',
          applied?.ok === true && afterApply.manual_shipped_quantity === target.shipped_quantity
          && indexItem?.manualConflict === false && indexItem?.previousConfirmedShelvedQuantity === target.shipped_quantity,
          { applied, afterApply, indexItem });
        check(results, '有效状态进入列表筛选：该票按有效状态可查到、按另一状态查不到',
          Boolean(targetRow)
          && listMatched.rows.some((row) => row.shipmentId === target.shipment_id)
          && !listOther.rows.some((row) => row.shipmentId === target.shipment_id),
          {
            effectiveStatus,
            otherStatus,
            matchedTotal: listMatched.total,
            otherTotal: listOther.total,
            ticket: target.ticket_no,
          });
        check(results, '改小发货量后冲突=true，旧发货量/新发货量/之前确认上架量可回读',
          conflict === true && conflictedIndex?.manualConflict === true
          && conflictedIndex?.manualShippedQuantity === target.shipped_quantity
          && conflictedIndex?.shippedQuantity === newShipped
          && conflictedIndex?.previousConfirmedShelvedQuantity === target.shipped_quantity,
          { conflict, conflictedIndex });
        check(results, '重新保存后快照=新发货量、冲突清除、复核标记清除',
          reapplied?.ok === true && afterReapply.manual_shipped_quantity === newShipped
          && afterReapply.manual_review_needed === false && conflictAfter === false,
          { reapplied, afterReapply, conflictAfter });
        check(results, 'restore 清空人工字段与发货量快照',
          restored?.ok === true && afterRestore.manual_status === null
          && afterRestore.manual_shipped_quantity === null && afterRestore.manual_revision === 3,
          { restored, afterRestore });
      }
    } finally {
      await owner.query('ROLLBACK');
    }

    const after = (await owner.query(
      `SELECT (SELECT count(*) FROM catalog.shipment)::int AS shipments,
              (SELECT count(*) FROM catalog.shipment_item)::int AS items,
              (SELECT count(*) FROM catalog.shipment_source_snapshot)::int AS snapshots,
              (SELECT count(*) FROM catalog.shipment_item_manual_revision)::int AS manual_revisions`)).rows[0];
    evidence.after = after;
    check(results, '030 不改变票/明细/快照行数（功能回读已回滚）',
      after.shipments === before.shipments && after.items === before.items
      && after.snapshots === before.snapshots
      && after.manual_revisions === before.manual_revisions,
      { before, after });

    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    const failed = results.filter((row) => !row.ok);
    evidence.summary = { total: results.length, failed: failed.length };
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'apply-030.json'),
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
