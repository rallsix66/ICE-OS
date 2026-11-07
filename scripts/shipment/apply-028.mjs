/**
 * 把 028「在途汇总」只读函数应用到现役实例，并回读结构/权限 + 与 026 明细口径核对。
 *
 * 028 只新增一个 SECURITY DEFINER 只读函数（不建表、不改 RLS、不改 026/027、不改
 * inventory_schema_state.version），因此这里：
 *   1) owner 连接执行增量文件两次（证明幂等）；
 *   2) 回读：函数存在、SECURITY DEFINER、search_path=''、app 可 EXECUTE、PUBLIC 不可；
 *   3) 用 app 角色 + 启用中管理员 JWT 实际调用，核对每个市场的票据/明细数与 026 当前口径一致，
 *      并确认调用前后 shipment* 行数不变（只读）；
 *   4) 无 JWT 时被 require_admin 拒绝。
 *
 * 用法：node scripts/shipment/apply-028.mjs [--run-id ...] [--dry-run]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_RUN_ID = 'run-20261026T211500Z-11a22b33';
const SQL_FILE = 'db/catalog/028_shipment_market_summary.sql';
const FUNCTION_NAME = 'read_shipment_market_summary';
const APP_ROLE = 'ice_p0_02_app_runner';
const ADMIN_PROFILE_ID = '11111111-1111-4111-8111-111111111101';
const SHIPMENT_TABLES = ['shipment', 'shipment_item', 'shipment_source_snapshot'];
const MARKETS = ['泰国', '菲律宾', '越南', '马来西亚', '__unknown__', 'all'];

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
  const owner = new pg.Client({ connectionString: env.ownerDbUrl });
  await owner.connect();
  const results = [];
  const evidence = { runId, database: env.database, at: new Date().toISOString() };
  try {
    const identity = (await owner.query('SELECT current_database() AS db, current_user AS user')).rows[0];
    evidence.identity = identity;
    await owner.query('BEGIN');
    try {
      await owner.query('SELECT catalog.require_admin()');
      await owner.query('ROLLBACK');
    } catch {
      await owner.query('ROLLBACK');
    }
    const before = (await owner.query(
      `SELECT (SELECT count(*) FROM catalog.shipment)::int AS shipments,
              (SELECT count(*) FROM catalog.shipment_item)::int AS items,
              (SELECT count(*) FROM catalog.shipment_source_snapshot)::int AS snapshots`)).rows[0];
    evidence.before = before;

    if (!args['dry-run']) {
      const sqlText = fs.readFileSync(path.join(REPO_ROOT, SQL_FILE), 'utf8');
      await owner.query(sqlText);
      await owner.query('RESET ROLE; RESET ALL');
      await owner.query(sqlText);
      await owner.query('RESET ROLE; RESET ALL');
      evidence.applied = { file: SQL_FILE, applications: 2 };
    }

    const fn = (await owner.query(
      `SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args, p.prosecdef, p.proconfig,
              pg_catalog.has_function_privilege($1, p.oid, 'EXECUTE') AS app_exec,
              pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
       FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='catalog' AND p.proname=$2`, [APP_ROLE, FUNCTION_NAME])).rows;
    evidence.function = fn;
    check(results, '028 函数存在且参数为 (p_market text)', fn.length === 1 && fn[0].args === 'p_market text', fn);
    check(results, '028 为 SECURITY DEFINER', fn[0]?.prosecdef === true, fn[0]?.prosecdef);
    check(results, "028 search_path 锁定为 ''",
      Array.isArray(fn[0]?.proconfig)
        && fn[0].proconfig.some((entry) => /^search_path=(?:''|"")$/.test(String(entry).replace(/\s/g, '').toLowerCase())),
      fn[0]?.proconfig);
    check(results, 'app 角色可 EXECUTE 028', fn[0]?.app_exec === true, fn[0]?.app_exec);
    check(results, 'PUBLIC 不可 EXECUTE 028', fn[0]?.public_exec === false, fn[0]?.public_exec);
    const tableSelect = (await owner.query(
      `SELECT relname, pg_catalog.has_table_privilege($1, c.oid, 'SELECT') AS app_select
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='catalog' AND relname = ANY($2::text[])`,
      [APP_ROLE, SHIPMENT_TABLES])).rows;
    check(results, 'app 仍不能直接 SELECT shipment 表', tableSelect.every((row) => row.app_select === false),
      tableSelect);

    // 功能调用：app 角色 + 管理员 JWT；逐个市场核对 026 当前明细口径。
    const app = new pg.Client({ connectionString: env.appDbUrl });
    await app.connect();
    const calls = {};
    try {
      for (const market of MARKETS) {
        await app.query('BEGIN');
        try {
          await app.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`, [ADMIN_PROFILE_ID]);
          const raw = (await app.query('SELECT catalog.read_shipment_market_summary($1) AS result', [market])).rows[0].result;
          await app.query('COMMIT');
          calls[market] = raw;
        } catch (error) {
          await app.query('ROLLBACK');
          throw error;
        }
      }
      await app.query('BEGIN');
      try {
        await app.query(`SELECT set_config('request.jwt.claim.sub','',true)`);
        await app.query('SELECT catalog.read_shipment_market_summary(NULL)');
        await app.query('ROLLBACK');
        check(results, '无管理员 JWT 时 028 被拒绝', false, 'unexpected success');
      } catch {
        await app.query('ROLLBACK');
        check(results, '无管理员 JWT 时 028 被拒绝', true);
      }
    } finally {
      await app.end();
    }
    evidence.calls = Object.fromEntries(Object.entries(calls).map(([market, raw]) => [market, {
      market: raw?.market ?? null,
      unknownMarket: raw?.unknownMarket ?? null,
      snapshotId: raw?.snapshotId ?? null,
      ticketCount: raw?.ticketCount ?? null,
      itemCount: raw?.itemCount ?? null,
      itemStates: (raw?.items ?? []).reduce((acc, item) => {
        acc[item.remainingState] = (acc[item.remainingState] ?? 0) + 1;
        return acc;
      }, {}),
      unbound: (raw?.items ?? []).filter((item) => item.productId === null).length,
    }]));

    // 与 026 当前明细核对：当前成功快照下，按市场统计票/明细数。
    const latest = (await owner.query(
      "SELECT id FROM catalog.shipment_source_snapshot WHERE status='success' ORDER BY read_finished_at DESC,created_at DESC,id DESC LIMIT 1"
    )).rows[0]?.id ?? null;
    const expected = Object.fromEntries((await owner.query(
      `SELECT s.market, count(DISTINCT s.id)::int AS tickets, count(*)::int AS items
       FROM catalog.shipment s JOIN catalog.shipment_item i ON i.shipment_id=s.id
       WHERE s.last_seen_snapshot_id=$1 AND i.last_seen_snapshot_id=$1 GROUP BY s.market`,
      [latest])).rows.map((row) => [row.market, { tickets: row.tickets, items: row.items }]));
    for (const market of ['泰国', '菲律宾', '越南', '马来西亚']) {
      const got = calls[market];
      check(results, `${market} 汇总票据/明细与 026 当前明细一致`,
        got?.ticketCount === expected[market]?.tickets && got?.itemCount === expected[market]?.items,
        { got: { tickets: got?.ticketCount, items: got?.itemCount }, expected: expected[market] });
    }
    const allTickets = Object.values(expected).reduce((sum, row) => sum + row.tickets, 0);
    const allItems = Object.values(expected).reduce((sum, row) => sum + row.items, 0);
    check(results, 'market=all 汇总等于全部市场之和',
      calls.all?.ticketCount === allTickets && calls.all?.itemCount === allItems,
      { got: { tickets: calls.all?.ticketCount, items: calls.all?.itemCount }, expected: { tickets: allTickets, items: allItems } });
    check(results, '未提供市场（__unknown__）独立成组',
      calls['__unknown__']?.unknownMarket === true
        && calls['__unknown__']?.ticketCount === (expected[null]?.tickets ?? 0),
      { got: calls['__unknown__']?.ticketCount, expected: expected[null]?.tickets ?? 0 });

    const after = (await owner.query(
      `SELECT (SELECT count(*) FROM catalog.shipment)::int AS shipments,
              (SELECT count(*) FROM catalog.shipment_item)::int AS items,
              (SELECT count(*) FROM catalog.shipment_source_snapshot)::int AS snapshots`)).rows[0];
    evidence.after = after;
    check(results, '028 只读：调用前后 shipment* 行数不变',
      JSON.stringify(before) === JSON.stringify(after), { before, after });

    const dir = path.join(REPO_ROOT, '.local/shipment-v1-r7-20261104');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'apply-028.json'),
      `${JSON.stringify({ ...evidence, results }, null, 2)}\n`);
    const failed = results.filter((row) => !row.ok);
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
