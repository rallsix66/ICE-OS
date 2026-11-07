/**
 * 把 035「拆合票原始分组检测 + 人工确认后才沿用绑定」增量应用到实例，并回读结构/权限/功能。
 *
 * 035 只新增/替换函数（不改 026–034 文件、不改表结构）：
 *   - worker_read_shipment_latest_snapshot_raw()：sync 角色读最近成功快照原始网格（拆/合票检测用）；
 *   - read_shipment_latest_snapshot_raw_core()（不授权）+ app 版本改为调用同一核心；
 *   - read_shipment_grouping_review(uuid)：单条复核（含 evidence，任意状态）；
 *   - deactivate_shipment_grouping_overrides(uuid,jsonb)：接受飞书分组时停用本次复核涉及的覆盖；
 *   - apply_shipment_item_association_carryover_manual(uuid,jsonb,uuid,text)：复核后按明确对应
 *     沿用绑定（manual_selected + 管理员 actor + reason 含复核 id/决定，限定复核 evidence 票范围）；
 *   - read_shipment_grouping_reviews()：activeOverrides 增加 market/ticketNo/waybillsText。
 *
 * 本脚本：
 *   1) owner 执行 035 两次（证明幂等）；
 *   2) 结构回读：函数签名/SECURITY DEFINER/search_path/PUBLIC 不可 + app/sync 分别授权；
 *   3) 权限负向：无管理员 JWT 时 app 读函数被拒绝；
 *   4) 功能回读（SAVEPOINT 内，结束 ROLLBACK TO SAVEPOINT，不写业务数据）：
 *      app/sync 读原始快照一致、单条复核含 evidence、人工决定后 activeOverrides 带市场/票号/运单号、
 *      接受飞书分组停用本次复核覆盖、手工沿用只按复核范围内明确计划补写（伪造条目 skipped）。
 *   5) 默认提交；`--rollback` 整体事务验证后 ROLLBACK（只验证、不安装）。
 *
 * 用法：
 *   node scripts/shipment/apply-035.mjs --rollback --run-id run-20261026T211500Z-11a22b33
 *   node scripts/shipment/apply-035.mjs --run-id <run-id>          # 提交模式（Lead 执行）
 * 证据：.local/shipment-v1-r14-20261107/apply-035.json / apply-035-commit.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_RUN_ID = 'run-20261026T211500Z-11a22b33';
const SQL_FILE = 'db/catalog/035_shipment_grouping_raw.sql';
const APP_ROLE = 'ice_p0_02_app_runner';
const SYNC_ROLE = 'ice_p0_02_sync_runner';
const ADMIN_PROFILE_ID = '11111111-1111-4111-8111-111111111101';
const EVIDENCE_DIR = path.join(REPO_ROOT, '.local', 'shipment-v1-r14-20261107');
const APP_FUNCTIONS = [
  'read_shipment_latest_snapshot_raw()',
  'read_shipment_grouping_review(p_review_id uuid)',
  'deactivate_shipment_grouping_overrides(p_review_id uuid, p_ticket_keys jsonb)',
  'apply_shipment_item_association_carryover_manual(p_snapshot_id uuid, p_plan jsonb, p_review_id uuid, p_decision text)',
  'read_shipment_grouping_reviews()',
];
const SYNC_FUNCTIONS = [
  'worker_read_shipment_latest_snapshot_raw()',
];
const UNAUTHORIZED_FUNCTIONS = [
  'read_shipment_latest_snapshot_raw_core()',
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

  const countsSql = `SELECT (SELECT count(*) FROM catalog.shipment)::int AS shipments,
    (SELECT count(*) FROM catalog.shipment_item)::int AS items,
    (SELECT count(*) FROM catalog.shipment_source_snapshot)::int AS snapshots,
    (SELECT count(*) FROM catalog.shipment_grouping_review)::int AS reviews,
    (SELECT count(*) FROM catalog.shipment_grouping_override)::int AS overrides`;
  const allFunctionNames = [...APP_FUNCTIONS, ...SYNC_FUNCTIONS, ...UNAUTHORIZED_FUNCTIONS]
    .map((entry) => entry.slice(0, entry.indexOf('(')));
  const functionStateSql = `SELECT p.prosrc AS body,
     pg_get_function_identity_arguments(p.oid) AS args,
     p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS signature,
     p.prosecdef, p.proconfig, p.provolatile,
     pg_catalog.has_function_privilege($1, p.oid, 'EXECUTE') AS app_exec,
     pg_catalog.has_function_privilege($2, p.oid, 'EXECUTE') AS sync_exec,
     pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='catalog' AND p.proname = ANY($3) ORDER BY 3`;
  const searchPathLocked = (proconfig) => Array.isArray(proconfig)
    && proconfig.some((entry) => /^search_path=(?:''|"")$/.test(String(entry).replace(/\s/g, '').toLowerCase()));

  try {
    evidence.identity = (await owner.query(
      'SELECT current_database() AS db, current_user AS user')).rows[0];
    evidence.before = (await owner.query(countsSql)).rows[0];
    const functionCountBefore = (await owner.query(functionStateSql,
      [APP_ROLE, SYNC_ROLE, allFunctionNames])).rows.length;
    evidence.functionCountBefore = functionCountBefore;

    await owner.query('BEGIN');
    try {
      const sqlText = fs.readFileSync(path.join(REPO_ROOT, SQL_FILE), 'utf8');
      for (let round = 1; round <= 2; round += 1) {
        await owner.query(sqlText);
        await owner.query('RESET ROLE');
      }
      evidence.applied = { file: SQL_FILE, applications: 2 };

      // ---- 1. 结构/权限 --------------------------------------------------
      const functions = (await owner.query(functionStateSql,
        [APP_ROLE, SYNC_ROLE, allFunctionNames])).rows;
      evidence.functions = functions.map((row) => ({
        signature: row.signature, prosecdef: row.prosecdef, proconfig: row.proconfig,
        provolatile: row.provolatile, app_exec: row.app_exec, sync_exec: row.sync_exec,
        public_exec: row.public_exec,
      }));
      const bySignature = new Map(functions.map((row) => [row.signature, row]));
      for (const signature of APP_FUNCTIONS) {
        const row = bySignature.get(signature);
        check(results, `app 函数 ${signature} 存在且 SECURITY DEFINER/search_path 锁定`,
          Boolean(row) && row.prosecdef === true && searchPathLocked(row.proconfig),
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
      for (const signature of UNAUTHORIZED_FUNCTIONS) {
        const row = bySignature.get(signature);
        check(results, `核心函数 ${signature} 存在但不对 app/sync/PUBLIC 授权`,
          Boolean(row) && row.app_exec === false && row.sync_exec === false && row.public_exec === false,
          row ? { app: row.app_exec, sync: row.sync_exec, public: row.public_exec } : null);
      }

      // ---- 2. 权限负向：无管理员 JWT --------------------------------------
      await owner.query('SAVEPOINT no_jwt');
      let anonRejected = null;
      try {
        await owner.query("SELECT set_config('request.jwt.claim.sub','',true)");
        await owner.query('SELECT catalog.read_shipment_grouping_review(NULL)');
      } catch (error) {
        anonRejected = String(error.message).slice(0, 200);
      }
      await owner.query('ROLLBACK TO SAVEPOINT no_jwt');
      check(results, '无管理员 JWT 时 read_shipment_grouping_review 被拒绝',
        typeof anonRejected === 'string' && /CATALOG_FORBIDDEN|require_admin/.test(anonRejected),
        anonRejected);

      // ---- 3. 功能（SAVEPOINT 内，最后回滚） -----------------------------
      // 说明：本事务内的 DDL 对其他连接（app/sync 会话）不可见，因此语义探针一律走 owner 连接；
      // app/sync 的「可执行/不可执行」已在结构回读用 has_function_privilege 核过，
      // 提交模式会在 COMMIT 之后再真实调用 sync 入口。
      await owner.query('SAVEPOINT raw_probe');
      await owner.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`, [ADMIN_PROFILE_ID]);
      const appRaw = (await owner.query(
        'SELECT catalog.read_shipment_latest_snapshot_raw() AS r')).rows[0].r;
      const coreRaw = (await owner.query(
        'SELECT catalog.read_shipment_latest_snapshot_raw_core() AS r')).rows[0].r;
      evidence.rawProbe = {
        appSnapshotId: appRaw?.snapshotId ?? null,
        coreSnapshotId: coreRaw?.snapshotId ?? null,
        appRows: appRaw?.values?.length ?? 0,
        coreRows: coreRaw?.values?.length ?? 0,
      };
      check(results, 'app 入口与核心实现返回同一最近成功原始快照（同一 snapshotId/网格行数）',
        Boolean(appRaw?.snapshotId) && appRaw.snapshotId === coreRaw?.snapshotId
        && appRaw.values.length === coreRaw.values.length, evidence.rawProbe);

      // 用当前分组构造一条受控拆票复核 + 人工覆盖，验证读取/停用/沿用口径。
      const state = (await owner.query(
        'SELECT catalog.read_shipment_grouping_state() AS r')).rows[0].r;
      const tickets = (state?.tickets ?? []).filter((ticket) => ticket.items.length > 0);
      evidence.groupingState = {
        snapshotId: state?.snapshotId, tickets: state?.tickets?.length ?? null,
        usableTickets: tickets.length,
      };
      check(results, '当前分组至少有两张可对照的票（构造拆票复核用）', tickets.length >= 2, evidence.groupingState);

      const evidenceJson = {
        kind: 'split',
        previous: { snapshotId: state.snapshotId, tickets: [tickets[0]] },
        current: { snapshotId: state.snapshotId, tickets: [tickets[0], tickets[1]] },
        affectedProducts: ['探针商品'],
      };
      const signature = 'd'.repeat(64);
      const recorded = (await owner.query(
        'SELECT catalog.record_shipment_grouping_reviews($1) AS r',
        [JSON.stringify([{ kind: 'split', signature, evidence: evidenceJson, fromSnapshotId: state.snapshotId }])],
      )).rows[0].r;
      const reviewId = recorded.ids?.[0] ?? null;
      check(results, '受控拆票复核已登记（事务内）', recorded.created === 1 && Boolean(reviewId), recorded);

      const detail = (await owner.query(
        'SELECT catalog.read_shipment_grouping_review($1) AS r', [reviewId])).rows[0].r;
      evidence.reviewDetail = detail;
      check(results, '单条复核读取含 kind/status/evidence（两侧票数与登记一致）',
        detail?.id === reviewId && detail.kind === 'split' && detail.status === 'pending'
        && detail.evidence?.previous?.tickets?.length === 1
        && detail.evidence?.current?.tickets?.length === 2, detail ? {
          id: detail.id, kind: detail.kind, status: detail.status,
          previous: detail.evidence?.previous?.tickets?.length,
          current: detail.evidence?.current?.tickets?.length,
        } : null);

      const overrideSpec = {
        kind: 'merge',
        spec: { kind: 'merge', targetKey: tickets[0].ticketKey, absorbedKeys: [tickets[1].ticketKey] },
      };
      const resolved = (await owner.query(
        'SELECT catalog.resolve_shipment_grouping_review($1,$2,$3,$4) AS r',
        [reviewId, 'keep_one', JSON.stringify(overrideSpec), '受控：仍是一票'])).rows[0].r;
      check(results, '复核选「仍是一票」写入人工覆盖', resolved.ok === true && resolved.decision === 'keep_one', resolved);

      const reviewsWithOverride = (await owner.query(
        'SELECT catalog.read_shipment_grouping_reviews() AS r')).rows[0].r;
      const active = (reviewsWithOverride.activeOverrides ?? [])
        .find((override) => override.reviewId === reviewId);
      evidence.activeOverride = active ?? null;
      check(results, '已有人工决定带市场/票号/运单号（来自复核 evidence 的票）',
        Boolean(active) && Object.hasOwn(active, 'market') && Object.hasOwn(active, 'ticketNo')
        && Object.hasOwn(active, 'waybillsText')
        && active.ticketNo !== null && active.ticketNo !== ''
        && active.market === tickets[0].market,
        active ?? null);

      const deactivated = (await owner.query(
        'SELECT catalog.deactivate_shipment_grouping_overrides($1,$2) AS r',
        [reviewId, '[]'])).rows[0].r;
      const reviewsAfterDeactivate = (await owner.query(
        'SELECT catalog.read_shipment_grouping_reviews() AS r')).rows[0].r;
      evidence.deactivate = { deactivated, activeCount: (reviewsAfterDeactivate.activeOverrides ?? []).length };
      check(results, '接受飞书分组时停用本复核涉及票的生效覆盖',
        deactivated.deactivated === 1
        && (reviewsAfterDeactivate.activeOverrides ?? []).length === 0, evidence.deactivate);

      // 手工沿用：复核范围内但明细不存在 → skipped；范围外票键 → skipped（不猜）。
      const inScopeEntry = {
        ticketKey: tickets[0].ticketKey, itemKey: '__no_such_item__', productId: ADMIN_PROFILE_ID,
      };
      const outScopeEntry = {
        ticketKey: '__outside_scope_ticket__', itemKey: '__no_such_item__', productId: ADMIN_PROFILE_ID,
      };
      const carryInScope = (await owner.query(
        'SELECT catalog.apply_shipment_item_association_carryover_manual($1,$2,$3,$4) AS r',
        [state.snapshotId, JSON.stringify([inScopeEntry]), reviewId, 'keep_one'])).rows[0].r;
      const carryOutScope = (await owner.query(
        'SELECT catalog.apply_shipment_item_association_carryover_manual($1,$2,$3,$4) AS r',
        [state.snapshotId, JSON.stringify([outScopeEntry]), reviewId, 'keep_one'])).rows[0].r;
      evidence.carryoverProbe = { carryInScope, carryOutScope };
      check(results, '手工沿用只处理复核范围内明确对应条目：范围外/不存在一律 skipped、不写数据',
        carryInScope.adopted === 0 && carryInScope.skipped === 1
        && carryOutScope.adopted === 0 && carryOutScope.skipped === 1
        && carryInScope.reviewId === reviewId && carryInScope.decision === 'keep_one',
        evidence.carryoverProbe);

      await owner.query('ROLLBACK TO SAVEPOINT raw_probe');

      // ---- 4. 结束 -------------------------------------------------------
      if (rollback) {
        await owner.query('ROLLBACK');
        const after = (await owner.query(countsSql)).rows[0];
        const functionCountAfter = (await owner.query(functionStateSql,
          [APP_ROLE, SYNC_ROLE, allFunctionNames])).rows.length;
        evidence.afterRollback = { counts: after, functionCount: functionCountAfter };
        check(results, 'rollback 后 035 安装已撤销（函数数量与事务开始前一致）',
          functionCountAfter === functionCountBefore, {
            before: functionCountBefore, after: functionCountAfter,
          });
        check(results, 'rollback 后票/明细/快照/复核/覆盖行数未变',
          after.shipments === evidence.before.shipments
          && after.items === evidence.before.items
          && after.snapshots === evidence.before.snapshots
          && after.reviews === evidence.before.reviews
          && after.overrides === evidence.before.overrides,
          { before: evidence.before, after });
        // 回滚后 sync 角色入口也应随之消失（证明没有留下半安装状态）。
        const syncProbe = await (async () => {
          await sync.query('BEGIN');
          try {
            await sync.query('SELECT catalog.worker_read_shipment_latest_snapshot_raw() AS r');
            return { ok: true };
          } catch (error) {
            return { ok: false, code: error.code, message: String(error.message).slice(0, 120) };
          } finally {
            await sync.query('ROLLBACK');
          }
        })();
        evidence.syncProbeAfterRollback = syncProbe;
        check(results, 'rollback 后 sync 角色入口不可调用（不存在，未留半安装状态）',
          syncProbe.ok === false && syncProbe.code === '42883', syncProbe);
      } else {
        await owner.query('COMMIT');
        const after = (await owner.query(countsSql)).rows[0];
        const functionCountAfter = (await owner.query(functionStateSql,
          [APP_ROLE, SYNC_ROLE, allFunctionNames])).rows.length;
        evidence.afterCommit = { counts: after, functionCount: functionCountAfter };
        check(results, '提交后 6 个新/替换函数全部存在',
          functionCountAfter === allFunctionNames.length, {
            expected: allFunctionNames.length, actual: functionCountAfter,
          });
        check(results, '提交模式未写业务数据（票/明细/快照/复核/覆盖行数未变）',
          after.shipments === evidence.before.shipments
          && after.items === evidence.before.items
          && after.snapshots === evidence.before.snapshots
          && after.reviews === evidence.before.reviews
          && after.overrides === evidence.before.overrides,
          { before: evidence.before, after });
        // 提交后：sync 角色真实调用读原始快照（与 app 版本同一 snapshotId/网格行数）。
        const syncProbe = await (async () => {
          await sync.query('BEGIN');
          try {
            return { ok: true, value: (await sync.query(
              'SELECT catalog.worker_read_shipment_latest_snapshot_raw() AS r')).rows[0].r };
          } catch (error) {
            return { ok: false, code: error.code, message: String(error.message).slice(0, 200) };
          } finally {
            await sync.query('ROLLBACK');
          }
        })();
        evidence.syncProbeAfterCommit = {
          ok: syncProbe.ok,
          snapshotId: syncProbe.value?.snapshotId ?? null,
          rows: syncProbe.value?.values?.length ?? 0,
        };
        check(results, '提交后 sync 角色可读最近成功原始快照（与 app 版本同一快照/行数）',
          syncProbe.ok === true
          && syncProbe.value?.snapshotId === evidence.rawProbe?.appSnapshotId
          && syncProbe.value?.values?.length === evidence.rawProbe?.appRows,
          evidence.syncProbeAfterCommit);
      }
    } catch (error) {
      try { await owner.query('ROLLBACK'); } catch { /* 事务已结束 */ }
      throw error;
    }

    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    const failed = results.filter((entry) => !entry.ok);
    evidence.summary = { total: results.length, failed: failed.length };
    fs.writeFileSync(
      path.join(EVIDENCE_DIR, rollback ? 'apply-035.json' : 'apply-035-commit.json'),
      `${JSON.stringify(evidence, null, 2)}\n`,
    );
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
