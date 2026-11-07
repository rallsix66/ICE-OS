/**
 * 把 033「拆票/合票复核 + 人工分组覆盖」增量应用到实例，并回读结构/权限/功能。
 *
 * 033 只新增（不改 026–032 文件）：两张复核/覆盖表 + 读取、登记、决定、恢复、
 * 重新入库快照读取、绑定沿用 RPC（app 角色与受限 sync 角色分开授权）。
 *
 * 本脚本：
 *   1) owner 执行 033 两次（证明幂等）；
 *   2) 结构回读：表 / FORCE RLS / 表权限收回 / 函数签名 / SECURITY DEFINER / search_path='' / 授权；
 *   3) 权限负向：无管理员 JWT 时 app 读函数被 catalog.require_admin() 拒绝；
 *      sync 角色 worker 函数可用，app 角色不可用；
 *   4) 功能回读（全部在 SAVEPOINT 内，结束 ROLLBACK TO SAVEPOINT，不写业务数据）：
 *      当前分组 / 待复核 / 生效覆盖 / 最新快照原始网格 / 登记复核 / 决定（含覆盖）/ 恢复；
 *   5) 默认提交；`--rollback` 整体事务验证后 ROLLBACK（只验证、不安装）。
 *
 * 用法：
 *   node scripts/shipment/apply-033.mjs --rollback --run-id run-20261026T211500Z-11a22b33
 *   node scripts/shipment/apply-033.mjs --run-id <run-id>          # 提交模式（Lead 执行）
 * 证据：.local/shipment-v1-r12-20261106/apply-033.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_RUN_ID = 'run-20261026T211500Z-11a22b33';
const SQL_FILE = 'db/catalog/033_shipment_grouping_review.sql';
const APP_ROLE = 'ice_p0_02_app_runner';
const SYNC_ROLE = 'ice_p0_02_sync_runner';
const ADMIN_PROFILE_ID = '11111111-1111-4111-8111-111111111101';
const EVIDENCE_DIR = path.join(REPO_ROOT, '.local', 'shipment-v1-r12-20261106');

const APP_FUNCTIONS = [
  'read_shipment_grouping_state()',
  'record_shipment_grouping_reviews(p_reviews jsonb)',
  'read_shipment_grouping_reviews()',
  'resolve_shipment_grouping_review(p_review_id uuid, p_decision text, p_override jsonb, p_note text)',
  'restore_shipment_grouping_judgement(p_review_id uuid, p_note text)',
  'read_shipment_latest_snapshot_raw()',
  'adopt_shipment_item_associations(p_snapshot_id uuid)',
];
const SYNC_FUNCTIONS = [
  'worker_read_shipment_grouping_state()',
  'worker_record_shipment_grouping_reviews(p_reviews jsonb)',
  'worker_adopt_shipment_item_associations(p_snapshot_id uuid)',
];
const READ_FUNCTIONS = new Set([
  'read_shipment_grouping_state()',
  'read_shipment_grouping_reviews()',
  'read_shipment_latest_snapshot_raw()',
  'worker_read_shipment_grouping_state()',
]);

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
    (SELECT count(*) FROM catalog.shipment_source_snapshot)::int AS snapshots`;
  const countsSql = `SELECT (SELECT count(*) FROM catalog.shipment)::int AS shipments,
    (SELECT count(*) FROM catalog.shipment_item)::int AS items,
    (SELECT count(*) FROM catalog.shipment_source_snapshot)::int AS snapshots,
    (SELECT count(*) FROM catalog.shipment_grouping_review)::int AS reviews,
    (SELECT count(*) FROM catalog.shipment_grouping_override)::int AS overrides`;
  const tableStateSql = `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
     pg_catalog.has_table_privilege($1, c.oid, 'SELECT,INSERT,UPDATE,DELETE') AS app_dml
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='catalog' AND c.relname = ANY($2) ORDER BY c.relname`;
  const functionStateSql = `SELECT p.oid::text AS oid, p.prosrc AS body,
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

    await owner.query('BEGIN');
    try {
      const sqlText = fs.readFileSync(path.join(REPO_ROOT, SQL_FILE), 'utf8');
      for (let round = 1; round <= 2; round += 1) {
        await owner.query(sqlText);
        await owner.query('RESET ROLE');
      }
      evidence.applied = { file: SQL_FILE, applications: 2 };

      // ---- 1. 结构 -------------------------------------------------------
      const tables = (await owner.query(tableStateSql,
        [APP_ROLE, ['shipment_grouping_review', 'shipment_grouping_override']])).rows;
      evidence.tables = tables;
      check(results, '两张新表已创建', tables.length === 2, tables.map((row) => row.relname));
      check(results, '两张表启用并强制 RLS',
        tables.length === 2 && tables.every((row) => row.relrowsecurity && row.relforcerowsecurity),
        tables);
      check(results, 'app/sync 角色没有表级 DML 权限',
        tables.every((row) => row.app_dml === false), tables.map((row) => row.app_dml));

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
        if (READ_FUNCTIONS.has(signature)) {
          check(results, `读函数 ${signature} 为 STABLE`, row?.provolatile === 's', row?.provolatile);
        }
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
        await owner.query('SELECT catalog.read_shipment_grouping_reviews()');
      } catch (error) {
        anonRejected = String(error.message).slice(0, 200);
      }
      await owner.query('ROLLBACK TO SAVEPOINT no_jwt');
      check(results, '无管理员 JWT 时 read_shipment_grouping_reviews 被拒绝',
        typeof anonRejected === 'string' && /CATALOG_FORBIDDEN|require_admin/.test(anonRejected),
        anonRejected);

      // ---- 3. 功能（全部在 SAVEPOINT 内，最后回滚） ----------------------
      await owner.query('SAVEPOINT grouping_probe');
      await owner.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`, [ADMIN_PROFILE_ID]);
      const state = (await owner.query('SELECT catalog.read_shipment_grouping_state() AS r')).rows[0].r;
      const expectedTickets = (await owner.query(
        `SELECT count(*)::int AS n FROM catalog.shipment s
         WHERE s.source_key=catalog.shipment_current_source_key()
           AND s.last_seen_snapshot_id=catalog.shipment_latest_success_snapshot(
             catalog.shipment_current_source_key())`)).rows[0].n;
      evidence.groupingState = { ...state, tickets: `count=${state?.tickets?.length ?? null}` };
      check(results, '分组上下文：快照与当前票数正确、没有覆盖、没有复核签名',
        Boolean(state?.snapshotId) && state.tickets.length === expectedTickets
        && state.overrides.length === 0 && state.reviewSignatures.length === 0,
        { snapshotId: state?.snapshotId, tickets: state?.tickets?.length, expectedTickets });

      const reviewsBefore = (await owner.query('SELECT catalog.read_shipment_grouping_reviews() AS r')).rows[0].r;
      check(results, '页面复核读取：初始 pending=0、activeOverrides=0',
        reviewsBefore.pending.length === 0 && reviewsBefore.activeOverrides.length === 0, reviewsBefore);

      const raw = (await owner.query('SELECT catalog.read_shipment_latest_snapshot_raw() AS r')).rows[0].r;
      const storedRaw = (await owner.query(
        `SELECT raw FROM catalog.shipment_source_snapshot s
         WHERE s.id=catalog.shipment_latest_success_snapshot(catalog.shipment_current_source_key())`)).rows[0].raw;
      check(results, '最新成功快照原始网格可读取（用于人工决定后重新解释）',
        Boolean(raw?.snapshotId) && Array.isArray(raw.values)
        && raw.values.length === (storedRaw?.values?.length ?? -1)
        && Array.isArray(raw.merges) && Boolean(raw.collection?.sourceKey),
        { snapshotId: raw?.snapshotId, rows: raw?.values?.length, merges: raw?.merges?.length });

      const tickets = state.tickets.filter((ticket) => ticket.items.length > 0);
      check(results, '当前分组至少有两张有明细的票可用于复核探针', tickets.length >= 2, tickets.length);
      const probeSignature = 'a'.repeat(64);
      const probeEvidence = {
        kind: 'split',
        previous: { snapshotId: state.snapshotId, tickets: [tickets[0]] },
        current: { snapshotId: state.snapshotId, tickets: [tickets[0], tickets[1]] },
        affectedProducts: ['探针商品'],
      };
      const recorded = (await owner.query(
        'SELECT catalog.record_shipment_grouping_reviews($1) AS r',
        [JSON.stringify([{ kind: 'split', signature: probeSignature, evidence: probeEvidence }])],
      )).rows[0].r;
      const duplicate = (await owner.query(
        'SELECT catalog.record_shipment_grouping_reviews($1) AS r',
        [JSON.stringify([{ kind: 'split', signature: probeSignature, evidence: probeEvidence }])],
      )).rows[0].r;
      evidence.recordProbe = { recorded, duplicate };
      check(results, '登记复核：首次创建 1 条、同签名重复登记不重复创建',
        recorded.created === 1 && duplicate.created === 0, { recorded, duplicate });

      const reviewsAfter = (await owner.query('SELECT catalog.read_shipment_grouping_reviews() AS r')).rows[0].r;
      const pendingReview = reviewsAfter.pending[0];
      check(results, '页面复核读取：pending=1 且包含上次/本次两侧对照',
        reviewsAfter.pending.length === 1
        && pendingReview.evidence.previous.tickets.length === 1
        && pendingReview.evidence.current.tickets.length === 2,
        { pending: reviewsAfter.pending.length });

      const wrongDecision = (await owner.query(
        'SELECT catalog.resolve_shipment_grouping_review($1,$2,NULL,NULL) AS r',
        [pendingReview.id, 'merge_confirmed'])).rows[0].r;
      check(results, '结论类型不匹配时拒绝（拆票只能用拆票结论）',
        wrongDecision.ok === false && wrongDecision.errorCode === 'SHIPMENT_INVALID_INPUT', wrongDecision);

      const mergeOverride = {
        kind: 'merge',
        spec: { kind: 'merge', targetKey: tickets[0].ticketKey, absorbedKeys: [tickets[1].ticketKey] },
      };
      const resolved = (await owner.query(
        'SELECT catalog.resolve_shipment_grouping_review($1,$2,$3,$4) AS r',
        [pendingReview.id, 'keep_one', JSON.stringify(mergeOverride), '受控探针：仍是一票'],
      )).rows[0].r;
      const afterResolve = (await owner.query('SELECT catalog.read_shipment_grouping_reviews() AS r')).rows[0].r;
      const stateAfter = (await owner.query('SELECT catalog.read_shipment_grouping_state() AS r')).rows[0].r;
      evidence.resolveProbe = { resolved, afterResolve: {
        pending: afterResolve.pending.length,
        activeOverrides: afterResolve.activeOverrides,
      } };
      check(results, '决定「仍是一票」：复核结束并写入 1 条生效合并覆盖',
        resolved.ok === true && afterResolve.pending.length === 0
        && afterResolve.activeOverrides.length === 1
        && stateAfter.overrides.length === 1
        && stateAfter.overrides[0].spec.kind === 'merge',
        evidence.resolveProbe);

      const restored = (await owner.query(
        'SELECT catalog.restore_shipment_grouping_judgement($1,$2) AS r',
        [pendingReview.id, '受控探针：恢复'])).rows[0].r;
      const afterRestore = (await owner.query('SELECT catalog.read_shipment_grouping_reviews() AS r')).rows[0].r;
      const stateRestored = (await owner.query('SELECT catalog.read_shipment_grouping_state() AS r')).rows[0].r;
      evidence.restoreProbe = { restored, activeOverrides: afterRestore.activeOverrides.length };
      check(results, '恢复按飞书判断：没有生效覆盖，复核记为 restored',
        restored.ok === true && restored.decision === 'restored'
        && afterRestore.activeOverrides.length === 0 && stateRestored.overrides.length === 0,
        evidence.restoreProbe);
      await owner.query('ROLLBACK TO SAVEPOINT grouping_probe');

      // ---- 4. 结束 -------------------------------------------------------
      if (rollback) {
        await owner.query('ROLLBACK');
        const tablesAfter = (await owner.query(
          `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
           WHERE n.nspname='catalog' AND c.relname IN('shipment_grouping_review','shipment_grouping_override')`)).rows[0].n;
        const functionsAfter = (await owner.query(functionStateSql, [APP_ROLE, SYNC_ROLE, fnNames])).rows;
        const after = (await owner.query(baseCountsSql)).rows[0];
        evidence.afterRollback = { tablesPresent: tablesAfter, functionCount: functionsAfter.length, counts: after };
        evidence.worker = { skipped: true, reason: 'rollback 模式下 DDL 未提交，另一个连接看不到新函数（提交模式验证）' };
        check(results, 'rollback 后 033 安装已撤销（表/函数不存在）',
          tablesAfter === 0 && functionsAfter.length === 0,
          { tables: tablesAfter, functions: functionsAfter.length });
        check(results, 'rollback 后票/明细/快照行数未变',
          after.shipments === evidence.before.shipments
          && after.items === evidence.before.items
          && after.snapshots === evidence.before.snapshots,
          { before: evidence.before, after });
      } else {
        await owner.query('COMMIT');
        // 4.1 sync 角色 worker 路径（提交后另一个连接可见；自己回滚，不写业务数据）
        await sync.query('BEGIN');
        try {
          const workerState = (await sync.query(
            'SELECT catalog.worker_read_shipment_grouping_state() AS r')).rows[0].r;
          const workerRecord = (await sync.query(
            'SELECT catalog.worker_record_shipment_grouping_reviews($1) AS r',
            [JSON.stringify([{ kind: 'merge', signature: 'b'.repeat(64), evidence: probeEvidence }])],
          )).rows[0].r;
          const workerAdopt = (await sync.query(
            'SELECT catalog.worker_adopt_shipment_item_associations($1) AS r',
            [state.snapshotId])).rows[0].r;
          evidence.worker = { workerStateTickets: workerState.tickets.length, workerRecord, workerAdopt };
          check(results, 'sync 角色：worker 读取分组上下文 / 登记复核 / 绑定沿用 均可执行',
            workerState.tickets.length === expectedTickets
            && workerRecord.created === 1
            && typeof workerAdopt.adopted === 'number',
            evidence.worker);
        } finally {
          await sync.query('ROLLBACK');
        }
        await sync.query('BEGIN');
        let syncAppRejected = null;
        try {
          await sync.query('SELECT catalog.read_shipment_grouping_reviews()');
        } catch (error) {
          syncAppRejected = String(error.message).slice(0, 200);
        }
        await sync.query('ROLLBACK');
        check(results, 'sync 角色不能调用页面 app 函数',
          typeof syncAppRejected === 'string' && /permission denied|CATALOG_FORBIDDEN/i.test(syncAppRejected),
          syncAppRejected);
        const tablesAfter = (await owner.query(
          `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
           WHERE n.nspname='catalog' AND c.relname IN('shipment_grouping_review','shipment_grouping_override')`)).rows[0].n;
        const functionsAfter = (await owner.query(functionStateSql, [APP_ROLE, SYNC_ROLE, fnNames])).rows;
        const after = (await owner.query(countsSql)).rows[0];
        evidence.afterCommit = { tablesPresent: tablesAfter, functionCount: functionsAfter.length, counts: after };
        check(results, '提交后两张表与 10 个函数存在',
          tablesAfter === 2 && functionsAfter.length === 10,
          { tables: tablesAfter, functions: functionsAfter.length });
        check(results, '提交模式未写业务数据（票/明细/快照/复核/覆盖行数未变）',
          after.shipments === evidence.before.shipments
          && after.items === evidence.before.items
          && after.snapshots === evidence.before.snapshots
          && after.reviews === 0 && after.overrides === 0,
          { before: evidence.before, after });
      }
    } catch (error) {
      try { await owner.query('ROLLBACK'); } catch { /* 事务已结束 */ }
      throw error;
    }

    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    const failed = results.filter((entry) => !entry.ok);
    evidence.summary = { total: results.length, failed: failed.length };
    fs.writeFileSync(path.join(EVIDENCE_DIR, rollback ? 'apply-033.json' : 'apply-033-commit.json'),
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
