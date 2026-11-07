/**
 * 把 034「拆票/合票复核收口 + 明确对应绑定沿用」增量应用到实例，并回读结构/权限/功能。
 *
 * 034 只新增/替换函数与唯一索引（不改 026–033 文件）：
 *   - 复核签名去重范围改为 (source_key, signature, from_snapshot_id)；
 *   - 分组上下文明细带 productId；
 *   - 新的「按明确对应计划沿用原明细商品」RPC（app / sync 分开授权）；
 *   - 旧的「全来源同品名同数量唯一即沿用」入口改为不再执行（防绕开明确对应）。
 *
 * 本脚本：
 *   1) owner 执行 034 两次（证明幂等）；
 *   2) 结构回读：旧唯一约束已移除、新唯一索引存在、函数签名/SECURITY DEFINER/search_path/授权；
 *   3) 权限负向：无管理员 JWT 时 app 读函数被拒绝；sync 角色不能调用 app 入口；
 *   4) 功能回读（SAVEPOINT 内，结束 ROLLBACK TO SAVEPOINT，不写业务数据）：
 *      分组上下文带 productId、同签名同一上次快照只登记一次、不同上次快照可再次提醒、
 *      沿用计划越权/伪造明细只返回 skipped 不写数据；
 *   5) 默认提交；`--rollback` 整体事务验证后 ROLLBACK（只验证、不安装）。
 *
 * 用法：
 *   node scripts/shipment/apply-034.mjs --rollback --run-id run-20261026T211500Z-11a22b33
 *   node scripts/shipment/apply-034.mjs --run-id <run-id>          # 提交模式（Lead 执行）
 * 证据：.local/shipment-v1-r13-20261106/apply-034.json / apply-034-commit.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_RUN_ID = 'run-20261026T211500Z-11a22b33';
const SQL_FILE = 'db/catalog/034_shipment_grouping_carryover.sql';
const APP_ROLE = 'ice_p0_02_app_runner';
const SYNC_ROLE = 'ice_p0_02_sync_runner';
const ADMIN_PROFILE_ID = '11111111-1111-4111-8111-111111111101';
const EVIDENCE_DIR = path.join(REPO_ROOT, '.local', 'shipment-v1-r13-20261106');
const APP_FUNCTIONS = [
  'apply_shipment_item_association_carryover(p_snapshot_id uuid, p_plan jsonb)',
];
const SYNC_FUNCTIONS = [
  'worker_apply_shipment_item_association_carryover(p_snapshot_id uuid, p_plan jsonb)',
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
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail === undefined ? '' : ` :: ${JSON.stringify(detail).slice(0, 900)}`}`);
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
  const sync = new pg.Client({ connectionString: env.syncDbUrl });
  await sync.connect();
  const results = [];
  const evidence = {
    runId, database: env.database, at: new Date().toISOString(),
    mode: rollback ? 'rollback' : 'commit', checks: results,
  };

  const baseCountsSql = `SELECT (SELECT count(*) FROM catalog.shipment)::int AS shipments,
    (SELECT count(*) FROM catalog.shipment_item)::int AS items,
    (SELECT count(*) FROM catalog.shipment_source_snapshot)::int AS snapshots,
    (SELECT count(*) FROM catalog.shipment_grouping_review)::int AS reviews,
    (SELECT count(*) FROM catalog.shipment_grouping_override)::int AS overrides`;
  const constraintSql = `SELECT conname, pg_get_constraintdef(oid) AS def
    FROM pg_constraint WHERE conrelid='catalog.shipment_grouping_review'::regclass
    ORDER BY conname`;
  const indexSql = `SELECT indexname, indexdef FROM pg_indexes
    WHERE schemaname='catalog' AND tablename='shipment_grouping_review' ORDER BY indexname`;
  const functionStateSql = `SELECT p.prosrc AS body,
     pg_get_function_identity_arguments(p.oid) AS args,
     p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS signature,
     p.prosecdef, p.proconfig, p.provolatile,
     pg_catalog.has_function_privilege($1, p.oid, 'EXECUTE') AS app_exec,
     pg_catalog.has_function_privilege($2, p.oid, 'EXECUTE') AS sync_exec,
     pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='catalog' AND p.proname = ANY($3) ORDER BY 3`;

  try {
    evidence.identity = (await owner.query(
      'SELECT current_database() AS db, current_user AS user')).rows[0];
    evidence.before = (await owner.query(baseCountsSql)).rows[0];
    // rollback 模式只验证「本次事务撤回后回到安装前状态」：若实例此前已经装过 034，
    // 回滚后函数仍应保留（数量与事务开始前一致），不能把既有安装当成这次没撤销。
    const installedBefore = (await owner.query(functionStateSql,
      [APP_ROLE, SYNC_ROLE, [...APP_FUNCTIONS, ...SYNC_FUNCTIONS].map((entry) => entry.slice(0, entry.indexOf('(')))])).rows.length;
    evidence.installedBefore = installedBefore;
    const constraintsBefore = (await owner.query(constraintSql)).rows.map((row) => row.conname);
    const indexesBefore = (await owner.query(indexSql)).rows.map((row) => row.indexname);
    evidence.schemaBefore = { constraints: constraintsBefore, indexes: indexesBefore };

    await owner.query('BEGIN');
    try {
      const sqlText = fs.readFileSync(path.join(REPO_ROOT, SQL_FILE), 'utf8');
      for (let round = 1; round <= 2; round += 1) {
        await owner.query(sqlText);
        await owner.query('RESET ROLE');
      }
      evidence.applied = { file: SQL_FILE, applications: 2 };

      // ---- 1. 结构 -------------------------------------------------------
      const constraints = (await owner.query(constraintSql)).rows;
      const indexes = (await owner.query(indexSql)).rows;
      evidence.constraints = constraints;
      evidence.indexes = indexes;
      check(results, '旧 (source_key,signature) 唯一约束已移除',
        constraints.every((row) => row.conname !== 'shipment_grouping_review_source_key_signature_key'),
        constraints.map((row) => row.conname));
      const occurrence = indexes.find((row) => row.indexname === 'shipment_grouping_review_occurrence');
      check(results, '新 (source_key,signature,from_snapshot_id) 唯一索引存在',
        Boolean(occurrence) && /UNIQUE/.test(occurrence.indexdef)
        && /source_key, signature, from_snapshot_id/.test(occurrence.indexdef),
        occurrence);

      const fnNames = [...APP_FUNCTIONS, ...SYNC_FUNCTIONS].map((entry) => entry.slice(0, entry.indexOf('(')));
      const functions = (await owner.query(functionStateSql, [APP_ROLE, SYNC_ROLE, fnNames])).rows;
      evidence.functions = functions.map((row) => ({
        signature: row.signature, prosecdef: row.prosecdef, proconfig: row.proconfig,
        provolatile: row.provolatile, app_exec: row.app_exec, sync_exec: row.sync_exec,
        public_exec: row.public_exec,
      }));
      const bySignature = new Map(functions.map((row) => [row.signature, row]));
      for (const signature of APP_FUNCTIONS) {
        const row = bySignature.get(signature);
        check(results, `app 函数 ${signature} 存在且 SECURITY DEFINER/search_path 锁定`,
          Boolean(row) && row.prosecdef === true
          && Array.isArray(row.proconfig)
          && row.proconfig.some((entry) => /^search_path=(?:''|"")$/.test(String(entry).replace(/\s/g, '').toLowerCase())),
          row ? { prosecdef: row.prosecdef, proconfig: row.proconfig } : null);
        check(results, `app 函数 ${signature}：app 可执行 / sync 不可 / PUBLIC 不可`,
          row?.app_exec === true && row?.sync_exec === false && row?.public_exec === false,
          row ? { app: row.app_exec, sync: row.sync_exec, public: row.public_exec } : null);
      }
      for (const signature of SYNC_FUNCTIONS) {
        const row = bySignature.get(signature);
        check(results, `sync 函数 ${signature}：sync 可执行 / app 不可 / PUBLIC 不可`,
          Boolean(row) && row.sync_exec === true && row.app_exec === false && row.public_exec === false,
          row ? { app: row.app_exec, sync: row.sync_exec, public: row.public_exec } : null);
      }

      // ---- 2. 权限负向：无管理员 JWT --------------------------------------
      await owner.query('SAVEPOINT no_jwt');
      let anonRejected = null;
      try {
        await owner.query("SELECT set_config('request.jwt.claim.sub','',true)");
        await owner.query('SELECT catalog.read_shipment_grouping_state()');
      } catch (error) {
        anonRejected = String(error.message).slice(0, 200);
      }
      await owner.query('ROLLBACK TO SAVEPOINT no_jwt');
      check(results, '无管理员 JWT 时 read_shipment_grouping_state 被拒绝',
        typeof anonRejected === 'string' && /CATALOG_FORBIDDEN|require_admin/.test(anonRejected),
        anonRejected);

      // ---- 3. 功能（全部在 SAVEPOINT 内，最后回滚） ----------------------
      await owner.query('SAVEPOINT carryover_probe');
      await owner.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`, [ADMIN_PROFILE_ID]);
      const state = (await owner.query('SELECT catalog.read_shipment_grouping_state() AS r')).rows[0].r;
      const stateItems = (state?.tickets ?? []).flatMap((ticket) => ticket.items ?? []);
      evidence.groupingState = {
        snapshotId: state?.snapshotId,
        tickets: state?.tickets?.length ?? null,
        items: stateItems.length,
        itemsWithProductIdKey: stateItems.filter((item) => Object.hasOwn(item, 'productId')).length,
        boundItems: stateItems.filter((item) => item.productId).length,
      };
      check(results, '分组上下文每条明细都带 productId 字段（可为 null）',
        stateItems.length > 0 && stateItems.every((item) => Object.hasOwn(item, 'productId')),
        evidence.groupingState);

      const snapshots = (await owner.query(
        `SELECT id FROM catalog.shipment_source_snapshot WHERE status='success'
         ORDER BY read_finished_at DESC,created_at DESC,id DESC LIMIT 2`)).rows;
      check(results, '至少有两次成功快照用于验证「同一拆法可再次提醒」', snapshots.length === 2, snapshots);
      const tickets = (state?.tickets ?? []).filter((ticket) => ticket.items.length > 0);
      const probeEvidence = {
        kind: 'split',
        previous: { snapshotId: snapshots[0]?.id ?? null, tickets: [tickets[0]] },
        current: { snapshotId: snapshots[0]?.id ?? null, tickets: [tickets[0], tickets[1]] },
        affectedProducts: ['探针商品'],
      };
      const probeSignature = 'c'.repeat(64);
      const record = (fromId) => owner.query(
        'SELECT catalog.record_shipment_grouping_reviews($1) AS r',
        [JSON.stringify([{ kind: 'split', signature: probeSignature, evidence: probeEvidence, fromSnapshotId: fromId }])],
      ).then((out) => out.rows[0].r);
      const first = await record(snapshots[0].id);
      const duplicate = await record(snapshots[0].id);
      const later = await record(snapshots[1].id);
      evidence.recordProbe = { first, duplicate, later };
      check(results, '同一上次快照只登记一次；下一次读取（不同上次快照）可再次提醒',
        first.created === 1 && duplicate.created === 0 && later.created === 1,
        evidence.recordProbe);

      const pending = (await owner.query(
        'SELECT catalog.read_shipment_grouping_reviews() AS r')).rows[0].r.pending;
      check(results, '两次提醒都在待复核里（同一归属变化再次出现）', pending.length === 2, { pending: pending.length });
      const resolved = (await owner.query(
        'SELECT catalog.resolve_shipment_grouping_review($1,$2,NULL,NULL) AS r',
        [pending[0].id, 'split_confirmed'])).rows[0].r;
      check(results, '复核可正常结束（拒绝当前分组以外不写覆盖）', resolved.ok === true, resolved);

      const planProbe = (await owner.query(
        'SELECT catalog.apply_shipment_item_association_carryover($1,$2) AS r',
        [state.snapshotId, JSON.stringify([
          { ticketKey: '__no_such_ticket__', itemKey: 'no-such-item', productId: ADMIN_PROFILE_ID },
        ])])).rows[0].r;
      const emptyProbe = (await owner.query(
        'SELECT catalog.apply_shipment_item_association_carryover($1,$2) AS r',
        [state.snapshotId, '[]'])).rows[0].r;
      check(results, '沿用计划只处理明确对应的票键/明细键，伪造目标只计 skipped、不写数据',
        planProbe.adopted === 0 && planProbe.skipped === 1
        && emptyProbe.adopted === 0 && emptyProbe.skipped === 0,
        { planProbe, emptyProbe });
      await owner.query('ROLLBACK TO SAVEPOINT carryover_probe');

      // ---- 4. 结束 -------------------------------------------------------
      if (rollback) {
        await owner.query('ROLLBACK');
        const constraintsAfter2 = (await owner.query(constraintSql)).rows.map((row) => row.conname);
        const indexesAfter2 = (await owner.query(indexSql)).rows.map((row) => row.indexname);
        const functionsAfter = (await owner.query(functionStateSql, [APP_ROLE, SYNC_ROLE, fnNames])).rows;
        const after = (await owner.query(baseCountsSql)).rows[0];
        evidence.afterRollback = {
          constraints: constraintsAfter2,
          indexes: indexesAfter2,
          functionCount: functionsAfter.length,
          counts: after,
        };
        // 回滚只承诺回到「本次事务开始前」：若实例此前已装过 034，函数与新索引会保留；
        // 关键是事务内的 DDL 没有留下额外变化（对比开始前）。
        check(results, 'rollback 后回到事务开始前的结构（旧约束/新索引/函数数量与开始前一致）',
          JSON.stringify(constraintsAfter2) === JSON.stringify(constraintsBefore)
          && JSON.stringify(indexesAfter2) === JSON.stringify(indexesBefore)
          && functionsAfter.length === installedBefore,
          {
            constraintsBefore, constraintsAfter: constraintsAfter2,
            indexesBefore, indexesAfter: indexesAfter2,
            functions: functionsAfter.length, installedBefore,
          });
        check(results, 'rollback 后票/明细/快照/复核/覆盖行数未变',
          after.shipments === evidence.before.shipments
          && after.items === evidence.before.items
          && after.snapshots === evidence.before.snapshots
          && after.reviews === evidence.before.reviews
          && after.overrides === evidence.before.overrides,
          { before: evidence.before, after });
      } else {
        await owner.query('COMMIT');
        // 4.1 sync 角色 worker 路径（提交后另一个连接可见；自己回滚，不写业务数据）
        await sync.query('BEGIN');
        try {
          const workerProbe = (await sync.query(
            'SELECT catalog.worker_apply_shipment_item_association_carryover($1,$2) AS r',
            [state.snapshotId, '[]'])).rows[0].r;
          evidence.worker = { workerProbe };
          check(results, 'sync 角色：worker 绑定沿用入口可执行（空计划 adopted=0）',
            workerProbe.adopted === 0 && workerProbe.skipped === 0, evidence.worker);
        } finally {
          await sync.query('ROLLBACK');
        }
        await sync.query('BEGIN');
        let syncAppRejected = null;
        try {
          await sync.query(
            'SELECT catalog.apply_shipment_item_association_carryover($1,$2)',
            [state.snapshotId, '[]']);
        } catch (error) {
          syncAppRejected = String(error.message).slice(0, 200);
        }
        await sync.query('ROLLBACK');
        check(results, 'sync 角色不能调用页面 app 沿用入口',
          typeof syncAppRejected === 'string' && /permission denied|CATALOG_FORBIDDEN/i.test(syncAppRejected),
          syncAppRejected);

        const constraintsAfter = (await owner.query(constraintSql)).rows;
        const indexesAfter = (await owner.query(indexSql)).rows;
        const functionsAfter = (await owner.query(functionStateSql, [APP_ROLE, SYNC_ROLE, fnNames])).rows;
        const after = (await owner.query(baseCountsSql)).rows[0];
        evidence.afterCommit = {
          constraints: constraintsAfter.map((row) => row.conname),
          occurrenceIndex: indexesAfter.find((row) => row.indexname === 'shipment_grouping_review_occurrence') ?? null,
          functionCount: functionsAfter.length,
          counts: after,
        };
        check(results, '提交后新唯一索引与 2 个新函数存在、旧唯一约束已移除',
          Boolean(evidence.afterCommit.occurrenceIndex)
          && functionsAfter.length === APP_FUNCTIONS.length + SYNC_FUNCTIONS.length
          && constraintsAfter.every((row) => row.conname !== 'shipment_grouping_review_source_key_signature_key'),
          { functions: functionsAfter.length, constraints: evidence.afterCommit.constraints });
        check(results, '提交模式未写业务数据（票/明细/快照/复核/覆盖行数未变）',
          after.shipments === evidence.before.shipments
          && after.items === evidence.before.items
          && after.snapshots === evidence.before.snapshots
          && after.reviews === evidence.before.reviews
          && after.overrides === evidence.before.overrides,
          { before: evidence.before, after });
      }
    } catch (error) {
      try { await owner.query('ROLLBACK'); } catch { /* 事务已结束 */ }
      throw error;
    }

    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    const failed = results.filter((entry) => !entry.ok);
    evidence.summary = { total: results.length, failed: failed.length };
    fs.writeFileSync(path.join(EVIDENCE_DIR, rollback ? 'apply-034.json' : 'apply-034-commit.json'),
      `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(`\nSUMMARY checks=${results.length} pass=${results.length - failed.length} fail=${failed.length}`);
    if (failed.length > 0) process.exitCode = 1;
  } finally {
    await owner.end();
    await sync.end();
  }
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
