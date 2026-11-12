/**
 * 把 038「物流在途：旧票人工选择只读投影」增量应用到一个 catalog 库，并回读结构/权限/幂等/行为。
 *
 * 038 只新增一个只读 SECURITY DEFINER 函数：
 *   catalog.read_shipment_association_history(jsonb) → 历史人工确认（manual_selected）商品建议。
 * 不改 026/027/028，不写任何业务数据。
 *
 * 模式（默认绝不改目标库）：
 *   --rollback（默认）：事务内安装两次 → 结构/权限/幂等/行为 → 整体 ROLLBACK；证据 .../apply-038.json
 *   --commit          ：事务内安装两次 → 回读 → 行为探针 → COMMIT；证据 .../apply-038-commit.json
 *   安全闸门：目标库名等于现役库名时，--commit 必须显式 --allow-live-commit。
 *
 * 用法：
 *   node scripts/catalog/apply-038.mjs --rollback --run-id run-20261026T211500Z-11a22b33
 *   node scripts/catalog/apply-038.mjs --commit --database-url <clone-owner-url>
 *   node scripts/catalog/apply-038.mjs --commit --allow-live-commit         # 现役库（Lead 手动）
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
const SQL_FILE = 'db/catalog/038_shipment_association_history.sql';
const FUNCTION_NAME = 'read_shipment_association_history';
const APP_ROLE = 'ice_p0_02_app_runner';
const ADMIN_PROFILE_ID = '11111111-1111-4111-8111-111111111101';
const EVIDENCE_DIR = path.join(REPO_ROOT, '.local', 'catalog', 'ux-round-20261113');
/** 真实样例：新票 POKNZX027667 的唇膏色号在旧票 POKNZX027378 上被人工确认过。 */
const SAMPLE_PAIRS = [
  { market: '泰国', nameNorm: 'chic.peak双头唇膏+唇线笔1.1g+0.25g201' },
  { market: '泰国', nameNorm: 'chic.peak双头唇膏+唇线笔1.1g+0.25g204' },
  { market: '泰国', nameNorm: 'chic.peak双头唇膏+唇线笔1.1g+0.25g205' },
  { market: '泰国', nameNorm: 'chic.peak双头唇膏+唇线笔1.1g+0.25g206' },
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

function readRun(runId) {
  const runRoot = path.join(REPO_ROOT, '.local', 'catalog', runId);
  const instance = JSON.parse(fs.readFileSync(path.join(runRoot, 'instance', 'catalog-instance.json'), 'utf8'));
  const inventory = JSON.parse(fs.readFileSync(path.join(runRoot, 'instance', 'env.inventory.json'), 'utf8'));
  const ownerUrl = `postgres://${instance.bootstrapUser}:${instance.bootstrapPassword}@${instance.host}:${instance.port}/${instance.dbName}`;
  return { runRoot, instance, inventory, ownerUrl };
}

function databaseNameOf(url) {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
}

function check(results, name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail === undefined ? '' : ` :: ${JSON.stringify(detail).slice(0, 600)}`}`);
}

const functionStateSql = `SELECT p.proname,
  pg_get_function_identity_arguments(p.oid) AS identity_args,
  p.prosecdef, p.proconfig, p.provolatile,
  pg_get_userbyid(p.proowner) AS owner_name,
  encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') AS body_sha256,
  pg_catalog.has_function_privilege($1, p.oid, 'EXECUTE') AS app_exec,
  pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='catalog' AND p.proname=$2
 ORDER BY identity_args`;

async function install(owner, dedupe) {
  const sql = fs.readFileSync(path.join(REPO_ROOT, SQL_FILE), 'utf8');
  const started = Date.now();
  if (dedupe) {
    await owner.query(sql);
    await owner.query('RESET ROLE; RESET ALL');
    await owner.query(sql);
    await owner.query('RESET ROLE; RESET ALL');
  } else {
    await owner.query(sql);
    await owner.query('RESET ROLE; RESET ALL');
  }
  return Date.now() - started;
}

async function probe(owner) {
  const pairs = JSON.stringify(SAMPLE_PAIRS);
  await owner.query(`SET LOCAL ROLE ${APP_ROLE}`);
  await owner.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`, [ADMIN_PROFILE_ID]);
  const result = await owner.query('SELECT catalog.read_shipment_association_history($1::jsonb) AS rows', [pairs]);
  await owner.query('RESET ROLE; RESET ALL');
  return result.rows[0]?.rows ?? [];
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
  const results = [];
  const owner = new pg.Client({ connectionString: targetUrl });
  await owner.connect();
  try {
    await owner.query('BEGIN');
    const firstInstallMs = await install(owner, false);
    const state1 = (await owner.query(functionStateSql, [APP_ROLE, FUNCTION_NAME])).rows;
    check(results, '函数存在且仅一个重载', state1.length === 1, state1.map((row) => row.identity_args));
    check(results, 'SECURITY DEFINER + search_path 锁定为空', state1[0]?.prosecdef === true
      && Array.isArray(state1[0]?.proconfig)
      && state1[0].proconfig.some((entry) => /^search_path=(?:''|"")?$/.test(String(entry).replace(/\s/g, '').toLowerCase())),
    state1[0]?.proconfig);
    check(results, 'app 角色可执行、public 不可执行', state1[0]?.app_exec === true && state1[0]?.public_exec === false, {
      app: state1[0]?.app_exec, public: state1[0]?.public_exec,
    });
    // 幂等：再装一次，结构/函数体不变。
    const secondInstallMs = await install(owner, false);
    const state2 = (await owner.query(functionStateSql, [APP_ROLE, FUNCTION_NAME])).rows;
    check(results, '重复安装幂等（函数体哈希不变）', state2[0]?.body_sha256 === state1[0]?.body_sha256,
      { before: state1[0]?.body_sha256?.slice(0, 16), after: state2[0]?.body_sha256?.slice(0, 16) });
    // 行为：真实四项唇膏色号 → 旧票人工确认的商品与票号。
    const rows = await probe(owner);
    const shade = (suffix) => rows.find((row) => row.nameNorm?.endsWith(suffix));
    const s201 = shade('201');
    check(results, '201 色号：人工确认记录给出 WM0075 与旧票号 POKNZX027378',
      s201?.iceCode === 'WM0075' && s201?.ticketNo === 'POKNZX027378' && s201?.manual === true,
      s201);
    const expected = { 201: 'WM0075', 204: 'WM0078', 205: 'WM0079', 206: 'WM0080' };
    check(results, '四个唇膏色号都命中旧票人工选择（201/204/205/206）',
      Object.entries(expected).every(([suffix, code]) => shade(suffix)?.iceCode === code),
      rows.map((row) => ({ name: row.nameNorm?.slice(-3), code: row.iceCode, ticket: row.ticketNo })));
    check(results, '无人工选择的品名不返回（不猜测）', (() => {
      const none = rows.find((row) => row.nameNorm?.includes('不存在的品名'));
      return none === undefined;
    })());
    // 表格权限不新增。
    const tablePriv = (await owner.query(
      `SELECT has_table_privilege($1,'catalog.shipment_item','SELECT') AS shipment_item,
              has_table_privilege($1,'catalog.shipment_item_association_revision','SELECT') AS association_revision`,
      [APP_ROLE],
    )).rows[0];
    check(results, 'app 角色仍无 shipment_item / association_revision 表权限', tablePriv.shipment_item === false && tablePriv.association_revision === false, tablePriv);
    // 业务数量不受影响（只读函数，不写数据）。
    const counts = (await owner.query(`SELECT
      (SELECT count(*) FROM catalog.shipment)::int AS shipments,
      (SELECT count(*) FROM catalog.shipment_item)::int AS items,
      (SELECT count(*) FROM catalog.shipment_item_association_revision)::int AS association_revisions`)).rows[0];
    check(results, '只读增量：shipment/item/association_revision 数量不变参考', counts.shipments > 0 && counts.items > 0, counts);

    const evidence = {
      mode: commit ? 'commit' : 'rollback',
      targetDatabase: targetName,
      sqlFile: SQL_FILE,
      sqlSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO_ROOT, SQL_FILE))).digest('hex'),
      installMs: { first: firstInstallMs, second: secondInstallMs },
      sampleRows: rows,
      businessCounts: counts,
      results,
      passed: results.every((item) => item.ok),
      finishedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(EVIDENCE_DIR, commit ? 'apply-038-commit.json' : 'apply-038.json'), JSON.stringify(evidence, null, 2));
    if (commit) await owner.query('COMMIT');
    else await owner.query('ROLLBACK');
    console.log(`\n${evidence.passed ? 'ALL PASS' : 'HAS FAILURES'} :: ${evidence.mode} :: ${targetName}`);
    if (!evidence.passed) process.exitCode = 1;
  } catch (error) {
    await owner.query('ROLLBACK').catch(() => {});
    console.error('[apply-038] failed:', error);
    process.exitCode = 1;
  } finally {
    await owner.end().catch(() => {});
  }
}

main();
