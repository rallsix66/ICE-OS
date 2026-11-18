/**
 * 把 047「成员经营总览 v1」的物流市场汇总范围补丁应用到一个 catalog 库。
 *
 * 047 只改一个函数：
 *   catalog.read_shipment_market_summary(text) 的入口守卫改为 require_shipment_read()，
 *   并在非管理员时追加 s.market = ANY(access_member_markets())；管理员口径不变。
 *
 * 模式（默认绝不改目标库）：
 *   --rollback（默认）：事务内安装两次 → 结构/行为探针 → ROLLBACK
 *   --commit          ：安装 → 回读 → 事务内探针 → COMMIT
 *   安全闸门：目标库名等于现役库名时 --commit 必须显式 --allow-live-commit。
 *
 * 用法：
 *   node scripts/catalog/apply-047.mjs --rollback --run-id run-20261026T211500Z-11a22b33
 *   node scripts/catalog/apply-047.mjs --commit --allow-live-commit --run-id run-20261026T211500Z-11a22b33
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(path.join(REPO_ROOT, 'package.json'));
const pg = require('pg');

const DEFAULT_RUN_ID = 'run-20261026T211500Z-11a22b33';
const SQL_FILE = 'db/catalog/047_member_overview.sql';
const APP_ROLE = 'ice_p0_02_app_runner';
const ADMIN_PROFILE_ID = '11111111-1111-4111-8111-111111111101';
const MEMBER_PROFILE_ID = 'b6c8c63b-ad58-42f7-97f7-baa0b7e79b90';
const EVIDENCE_DIR = path.join(REPO_ROOT, '.local', 'catalog', 'member-overview-v1-20261118');

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

function readRun(runId) {
  const runRoot = path.join(REPO_ROOT, '.local', 'catalog', runId);
  const instance = JSON.parse(fs.readFileSync(path.join(runRoot, 'instance', 'catalog-instance.json'), 'utf8'));
  const ownerUrl = `postgres://${instance.bootstrapUser}:${instance.bootstrapPassword}@${instance.host}:${instance.port}/${instance.dbName}`;
  return { runRoot, instance, ownerUrl };
}

function databaseNameOf(url) {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
}

function check(results, name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail === undefined ? '' : ` :: ${JSON.stringify(detail).slice(0, 400)}`}`);
}

function searchPathLocked(proconfig) {
  return Array.isArray(proconfig)
    && proconfig.some((entry) => /^search_path=(?:''|"")?$/.test(String(entry).replace(/\s/g, '').toLowerCase()));
}

const functionStateSql = `SELECT p.proname,
  pg_get_function_identity_arguments(p.oid) AS identity_args,
  p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner_name,
  position('require_shipment_read()' in p.prosrc) AS shipment_guard,
  position('access_member_markets()' in p.prosrc) AS market_filter,
  position('v_markets text[]' in p.prosrc) AS market_decl,
  position('require_admin()' in p.prosrc) AS admin_guard,
  pg_catalog.has_function_privilege($1, p.oid, 'EXECUTE') AS app_exec,
  pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='catalog' AND p.proname=$2
 ORDER BY identity_args`;

const countsSql = `SELECT
  (SELECT count(*) FROM catalog.shipment)::int AS shipments,
  (SELECT count(*) FROM catalog.shipment_item)::int AS shipment_items,
  (SELECT count(*) FROM catalog.account_access_market)::int AS access_markets`;

async function install(owner, sql) {
  await owner.query(sql);
  await owner.query('RESET ROLE; RESET ALL');
}

async function callJson(owner, spec, params = []) {
  const placeholders = params.map((_, index) => `$${index + 1}`).join(', ');
  const sql = params.length > 0 ? `SELECT ${spec}(${placeholders}) AS r` : `SELECT ${spec}() AS r`;
  const rows = (await owner.query(sql, params)).rows;
  return rows[0]?.r ?? null;
}

async function asRole(owner, role, profileId, fn) {
  await owner.query(`SET LOCAL ROLE ${role}`);
  if (profileId) await owner.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [profileId]);
  try {
    return await fn();
  } finally {
    await owner.query('RESET ROLE; RESET ALL');
  }
}

async function expectFailureAs(owner, role, profileId, spec, params = []) {
  await owner.query('SAVEPOINT probe_fail');
  await owner.query(`SET LOCAL ROLE ${role}`);
  if (profileId) await owner.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [profileId]);
  let message = null;
  try {
    await callJson(owner, spec, params);
  } catch (error) {
    message = error.message;
  } finally {
    await owner.query('ROLLBACK TO SAVEPOINT probe_fail');
    await owner.query('RELEASE SAVEPOINT probe_fail');
    await owner.query('RESET ROLE; RESET ALL');
  }
  return message;
}

function summaryShape(summary) {
  const markets = new Map();
  for (const item of summary?.items ?? []) {
    const key = item.market ?? '(null)';
    const row = markets.get(key) ?? { tickets: new Set(), items: 0 };
    row.tickets.add(item.shipmentId);
    row.items += 1;
    markets.set(key, row);
  }
  return {
    latestReadAt: summary?.latestReadAt ?? null,
    snapshotId: summary?.snapshotId ?? null,
    ticketCount: summary?.ticketCount ?? 0,
    itemCount: summary?.itemCount ?? 0,
    markets: Object.fromEntries([...markets.entries()].map(([key, row]) => [key, { tickets: row.tickets.size, items: row.items }])),
  };
}

function summaryFor(summary, markets) {
  const allowed = new Set(markets);
  const items = (summary?.items ?? []).filter((item) => allowed.has(item.market));
  return {
    tickets: new Set(items.map((item) => item.shipmentId)).size,
    items: items.length,
    markets: [...new Set(items.map((item) => item.market))].sort(),
  };
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  const run = readRun(args['run-id'] ?? DEFAULT_RUN_ID);
  const targetUrl = args['database-url'] ?? run.ownerUrl;
  const liveName = run.instance.dbName;
  const targetName = databaseNameOf(targetUrl);
  const commit = args.commit === true;
  if (commit && targetName === liveName && args['allow-live-commit'] !== true) {
    throw new Error('CATALOG_SQL_INCREMENT_LIVE_COMMIT_DENIED: add --allow-live-commit for the live database');
  }
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const sql = fs.readFileSync(path.join(REPO_ROOT, SQL_FILE), 'utf8');
  const results = [];
  const owner = new pg.Client({ connectionString: targetUrl });
  await owner.connect();
  const evidence = {
    mode: commit ? 'commit' : 'rollback',
    targetDatabase: targetName,
    sqlFile: SQL_FILE,
    sqlSha256: crypto.createHash('sha256').update(sql).digest('hex'),
    finishedAt: null,
  };
  try {
    const countsBefore = (await owner.query(countsSql)).rows[0];
    evidence.countsBefore = countsBefore;

    await owner.query('BEGIN');
    const adminBefore = await asRole(owner, APP_ROLE, ADMIN_PROFILE_ID,
      async () => callJson(owner, 'catalog.read_shipment_market_summary', ['all']));
    evidence.adminBefore = summaryShape(adminBefore);

    await install(owner, sql);
    await install(owner, sql);
    check(results, '047 安装两次均成功（幂等，无报错）', true, { applications: 2 });

    const fn = (await owner.query(functionStateSql, [APP_ROLE, 'read_shipment_market_summary'])).rows[0];
    check(results, '函数改为成员守卫并带授权市场过滤，仍 SECURITY DEFINER / search_path 锁定 / 仅 app 可执行',
      fn?.shipment_guard > 0 && fn?.market_filter > 0 && fn?.market_decl > 0
      && fn?.admin_guard === 0 && fn?.prosecdef === true && searchPathLocked(fn?.proconfig)
      && fn?.owner_name === 'ice_p0_02_owner' && fn?.app_exec === true && fn?.public_exec === false,
      {
        guard: fn?.shipment_guard,
        marketFilter: fn?.market_filter,
        marketDecl: fn?.market_decl,
        adminGuard: fn?.admin_guard,
        owner: fn?.owner_name,
      });

    const adminAfter = await asRole(owner, APP_ROLE, ADMIN_PROFILE_ID,
      async () => callJson(owner, 'catalog.read_shipment_market_summary', ['all']));
    const beforeShape = summaryShape(adminBefore);
    const afterShape = summaryShape(adminAfter);
    check(results, '管理员口径未变：票/明细/各市场计数与最近成功读取时间一致',
      JSON.stringify(beforeShape) === JSON.stringify(afterShape),
      { before: beforeShape, after: afterShape });

    const grants = (await owner.query(
      `SELECT coalesce(array_agg(market ORDER BY market),'{}'::text[]) AS markets
       FROM catalog.account_access_market WHERE profile_id=$1`, [MEMBER_PROFILE_ID])).rows[0].markets;
    const memberSummary = await asRole(owner, APP_ROLE, MEMBER_PROFILE_ID,
      async () => callJson(owner, 'catalog.read_shipment_market_summary', ['all']));
    const memberShape = summaryShape(memberSummary);
    const expected = summaryFor(adminBefore, grants);
    check(results, '成员只拿到获授市场：票/明细/市场集合与管理员同市场切片一致',
      memberShape.ticketCount === expected.tickets && memberShape.itemCount === expected.items
      && JSON.stringify(Object.keys(memberShape.markets).sort()) === JSON.stringify(expected.markets)
      && Object.keys(memberShape.markets).every((market) => grants.includes(market)),
      { grants, member: memberShape, expected });

    const forbidden = await expectFailureAs(owner, APP_ROLE, MEMBER_PROFILE_ID,
      'catalog.read_shipment_market_summary', ['all']);
    // 上面的调用仍带现有授权，不会失败；真正无授权在下一个 savepoint 内删除后验证。
    check(results, '现有授权下成员可读取汇总（无拒绝）', forbidden === null, { error: forbidden });

    await owner.query('SAVEPOINT no_grant');
    await owner.query('DELETE FROM catalog.account_access_market WHERE profile_id=$1', [MEMBER_PROFILE_ID]);
    const denied = await expectFailureAs(owner, APP_ROLE, MEMBER_PROFILE_ID,
      'catalog.read_shipment_market_summary', ['all']);
    await owner.query('ROLLBACK TO SAVEPOINT no_grant');
    await owner.query('RELEASE SAVEPOINT no_grant');
    check(results, '没有物流授权时成员被拒绝（CATALOG_FORBIDDEN）', denied === 'CATALOG_FORBIDDEN', { error: denied });

    await owner.query('SAVEPOINT cross_market');
    await owner.query('DELETE FROM catalog.account_access_market WHERE profile_id=$1', [MEMBER_PROFILE_ID]);
    await owner.query(
      `INSERT INTO catalog.account_access_market(profile_id,market) VALUES($1,'泰国')
       ON CONFLICT DO NOTHING`, [MEMBER_PROFILE_ID]);
    const cross = await asRole(owner, APP_ROLE, MEMBER_PROFILE_ID,
      async () => callJson(owner, 'catalog.read_shipment_market_summary', ['all']));
    const crossShape = summaryShape(cross);
    const thaiExpected = summaryFor(adminBefore, ['泰国']);
    await owner.query('ROLLBACK TO SAVEPOINT cross_market');
    await owner.query('RELEASE SAVEPOINT cross_market');
    check(results, '换成泰国授权后只返回泰国：不能借汇总读取越南/菲律宾/马来西亚',
      JSON.stringify(Object.keys(crossShape.markets)) === JSON.stringify(['泰国'])
      && crossShape.ticketCount === thaiExpected.tickets && crossShape.itemCount === thaiExpected.items,
      { thai: crossShape, expected: thaiExpected });

    const grantsAfter = (await owner.query(
      `SELECT coalesce(array_agg(market ORDER BY market),'{}'::text[]) AS markets
       FROM catalog.account_access_market WHERE profile_id=$1`, [MEMBER_PROFILE_ID])).rows[0].markets;
    check(results, '探针结束后成员原授权未变', JSON.stringify(grantsAfter) === JSON.stringify(grants),
      { before: grants, after: grantsAfter });

    const countsAfterProbe = (await owner.query(countsSql)).rows[0];
    evidence.countsAfterProbe = countsAfterProbe;
    check(results, '探针回滚后业务行数与安装前一致',
      JSON.stringify(countsBefore) === JSON.stringify(countsAfterProbe),
      { before: countsBefore, after: countsAfterProbe });

    if (commit) {
      await owner.query('COMMIT');
      await owner.query('BEGIN');
      const postFn = (await owner.query(functionStateSql, [APP_ROLE, 'read_shipment_market_summary'])).rows[0];
      const postMember = await asRole(owner, APP_ROLE, MEMBER_PROFILE_ID,
        async () => callJson(owner, 'catalog.read_shipment_market_summary', ['all']));
      await owner.query('ROLLBACK');
      const postShape = summaryShape(postMember);
      evidence.afterCommit = {
        guard: postFn?.shipment_guard > 0,
        marketFilter: postFn?.market_filter > 0,
        markets: Object.keys(postShape.markets),
        tickets: postShape.ticketCount,
        items: postShape.itemCount,
      };
      check(results, '提交后回读：成员守卫/市场过滤在位，成员只得到授权市场',
        postFn?.shipment_guard > 0 && postFn?.market_filter > 0
        && Object.keys(postShape.markets).every((market) => grants.includes(market)),
        evidence.afterCommit);
    } else {
      await owner.query('ROLLBACK');
      const countsAfterRollback = (await owner.query(countsSql)).rows[0];
      check(results, 'rollback 后业务行数不变', JSON.stringify(countsBefore) === JSON.stringify(countsAfterRollback));
    }

    evidence.results = results;
    evidence.passed = results.every((item) => item.ok);
    evidence.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(EVIDENCE_DIR, commit ? 'apply-047-commit.json' : 'apply-047.json'),
      `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(`\n${evidence.passed ? 'ALL PASS' : 'HAS FAILURES'} :: ${evidence.mode} :: ${targetName}`
      + ` :: checks=${results.length} fail=${results.filter((item) => !item.ok).length}`);
    if (!evidence.passed) process.exitCode = 1;
  } catch (error) {
    try { await owner.query('ROLLBACK'); } catch { /* ignore */ }
    evidence.error = { message: error.message, code: error.code, stack: String(error.stack).slice(0, 2000) };
    evidence.results = results;
    evidence.passed = false;
    evidence.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(EVIDENCE_DIR, commit ? 'apply-047-commit.json' : 'apply-047.json'),
      `${JSON.stringify(evidence, null, 2)}\n`);
    console.error('[apply-047] failed:', error.message);
    process.exitCode = 1;
  } finally {
    await owner.end().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
