/**
 * 把 039「物流关联规则命中预告」只读增量应用到一个 catalog 库，并回读结构/权限/幂等/行为。
 *
 * 039 只新增一个只读 SECURITY DEFINER 函数：
 *   catalog.read_shipment_association_rule_preview(uuid)
 *   → 精确复刻 027 catalog.shipment_mapping_apply_core 的命中条件，返回保存「以后同市场同品名
 *     沿用」规则前的影响预告（当前会命中的明细数/票数/未关联数/将改关联数/样例票号）。
 * 不改 026/027/028，不写任何业务数据，不新增表。
 *
 * 模式（默认绝不改目标库）：
 *   --rollback（默认）：事务内安装两次 → 结构/权限/幂等/只读行为探针 → 整体 ROLLBACK；
 *                       证据 .../apply-039.json
 *   --commit          ：事务内安装两次 → 回读 → 行为探针 → COMMIT；证据 .../apply-039-commit.json
 *   安全闸门：目标库名等于现役库名时 --commit 必须显式 --allow-live-commit（Lead 执行）。
 *
 * 用法：
 *   node scripts/catalog/apply-039.mjs --rollback --run-id run-20261026T211500Z-11a22b33
 *   node scripts/catalog/apply-039.mjs --commit --database-url <clone-owner-url>
 *   node scripts/catalog/apply-039.mjs --commit --allow-live-commit        # 现役库（Lead 手动）
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
const SQL_FILE = 'db/catalog/039_shipment_association_rule_preview.sql';
const FUNCTION_NAME = 'read_shipment_association_rule_preview';
const APP_ROLE = 'ice_p0_02_app_runner';
const ADMIN_PROFILE_ID = '11111111-1111-4111-8111-111111111101';
const EVIDENCE_DIR = path.join(REPO_ROOT, '.local', 'catalog', 'ux-round-20261114');
const EXPECTED_FIELDS = ['ok', 'itemId', 'market', 'nameNorm', 'productNameRaw', 'matchingCount',
  'ticketCount', 'sampleTickets', 'unboundCount', 'reassignCount', 'note'];

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

function searchPathLocked(proconfig) {
  return Array.isArray(proconfig)
    && proconfig.some((entry) => /^search_path=(?:''|"")?$/.test(String(entry).replace(/\s/g, '').toLowerCase()));
}

const functionStateSql = `SELECT p.proname,
  pg_get_function_identity_arguments(p.oid) AS identity_args,
  p.prosecdef, p.proconfig, p.provolatile,
  pg_get_userbyid(p.proowner) AS owner_name,
  encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') AS body_sha256,
  p.prosrc,
  pg_catalog.has_function_privilege($1, p.oid, 'EXECUTE') AS app_exec,
  pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='catalog' AND p.proname=$2
 ORDER BY identity_args`;

const countsSql = `SELECT
  (SELECT count(*) FROM catalog.shipment)::int AS shipments,
  (SELECT count(*) FROM catalog.shipment_item)::int AS items,
  (SELECT count(*) FROM catalog.shipment_item_association_revision)::int AS association_revisions,
  (SELECT count(*) FROM catalog.shipment_product_mapping)::int AS mappings,
  (SELECT count(*) FROM catalog.shipment_source_snapshot)::int AS snapshots`;

/** 独立复刻 027 apply_core 命中条件，用于和函数结果对账（owner 连接，只读）。 */
async function expectedPreview(owner, itemId) {
  const item = (await owner.query(`SELECT i.id,i.source_key,i.product_name_norm,i.product_name_raw,
      i.shipment_id,s.market
    FROM catalog.shipment_item i JOIN catalog.shipment s ON s.id=i.shipment_id WHERE i.id=$1`, [itemId])).rows[0];
  if (!item) return { ok: false };
  if (item.market === null) {
    return { ok: true, market: null, matchingCount: 0, ticketCount: 0, unboundCount: 0, reassignCount: 0 };
  }
  const latest = (await owner.query(
    'SELECT catalog.shipment_latest_success_snapshot_id($1) AS snap', [item.source_key])).rows[0].snap;
  const row = (await owner.query(`WITH hits AS (
      SELECT i.id,s.ticket_no,
        (i.product_id IS NULL AND i.association_method IS NULL) AS is_unbound,
        (i.product_id IS NOT NULL AND i.association_method='normalized_name_exact'
          AND catalog.shipment_mapping_lookup(i.source_key,i.product_name_norm,s.market)
            IS DISTINCT FROM i.product_id) AS is_reassign
      FROM catalog.shipment_item i JOIN catalog.shipment s ON s.id=i.shipment_id
      WHERE i.source_key=$1 AND i.product_name_norm=$2 AND s.market=$3
        AND i.last_seen_snapshot_id=$4 AND i.id<>$5
        AND ((i.product_id IS NULL AND i.association_method IS NULL)
          OR (i.product_id IS NOT NULL AND i.association_method='normalized_name_exact'
            AND catalog.shipment_mapping_lookup(i.source_key,i.product_name_norm,s.market)
              IS DISTINCT FROM i.product_id))
    )
    SELECT count(*)::int AS matching, count(DISTINCT ticket_no)::int AS tickets,
      count(*) FILTER (WHERE is_unbound)::int AS unbound,
      count(*) FILTER (WHERE is_reassign)::int AS reassign FROM hits`,
  [item.source_key, item.product_name_norm, item.market, latest, itemId])).rows[0];
  return { ok: true, market: item.market, nameNorm: item.product_name_norm,
    productNameRaw: item.product_name_raw, matchingCount: row.matching,
    ticketCount: row.tickets, unboundCount: row.unbound, reassignCount: row.reassign };
}

async function install(owner, sql) {
  await owner.query(sql);
  await owner.query('RESET ROLE; RESET ALL');
}

async function probeAsApp(owner, itemId) {
  await owner.query(`SET LOCAL ROLE ${APP_ROLE}`);
  await owner.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [ADMIN_PROFILE_ID]);
  const result = (await owner.query(
    'SELECT catalog.read_shipment_association_rule_preview($1::uuid) AS r', [itemId])).rows[0]?.r ?? null;
  await owner.query('RESET ROLE; RESET ALL');
  return result;
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
    // 1) 安装两次（幂等）
    await install(owner, sql);
    const state1 = (await owner.query(functionStateSql, [APP_ROLE, FUNCTION_NAME])).rows;
    await install(owner, sql);
    const state2 = (await owner.query(functionStateSql, [APP_ROLE, FUNCTION_NAME])).rows;
    evidence.install = { applications: 2, function: state2[0] ? {
      identityArgs: state2[0].identity_args, prosecdef: state2[0].prosecdef,
      proconfig: state2[0].proconfig, provolatile: state2[0].provolatile,
      owner: state2[0].owner_name, bodySha256: state2[0].body_sha256,
      appExec: state2[0].app_exec, publicExec: state2[0].public_exec,
    } : null };

    check(results, '039 安装两次均成功（幂等，无报错）', true, { applications: 2 });
    check(results, '函数存在且仅一个重载（uuid）', state2.length === 1
      && state2[0].identity_args === 'p_item_id uuid', state2.map((row) => row.identity_args));
    check(results, 'SECURITY DEFINER + search_path 锁定为空',
      state2[0]?.prosecdef === true && searchPathLocked(state2[0]?.proconfig), state2[0]?.proconfig ?? null);
    check(results, 'STABLE（只读投影）', state2[0]?.provolatile === 's', state2[0]?.provolatile ?? null);
    check(results, '属主为 ice_p0_02_owner', state2[0]?.owner_name === 'ice_p0_02_owner',
      state2[0]?.owner_name ?? null);
    check(results, 'app 可执行 / PUBLIC 不可执行',
      state2[0]?.app_exec === true && state2[0]?.public_exec === false,
      { app: state2[0]?.app_exec, public: state2[0]?.public_exec });
    check(results, '两次安装函数体哈希一致（幂等）',
      state1[0]?.body_sha256 === state2[0]?.body_sha256,
      { first: state1[0]?.body_sha256?.slice(0, 16), second: state2[0]?.body_sha256?.slice(0, 16) });
    const body = state2[0]?.prosrc ?? '';
    check(results, '函数体包含 027 命中条件语义（require_admin / last_seen_snapshot_id / '
      + 'normalized_name_exact / shipment_mapping_lookup / 排除自身）',
    /catalog\.require_admin\(\)/.test(body)
      && /i\.last_seen_snapshot_id=v_latest/.test(body)
      && /normalized_name_exact/.test(body)
      && /catalog\.shipment_mapping_lookup/.test(body)
      && /i\.id<>p_item_id/.test(body));
    const tablePriv = (await owner.query(
      `SELECT has_table_privilege($1,'catalog.shipment_item','SELECT') AS shipment_item,
              has_table_privilege($1,'catalog.shipment_item_association_revision','SELECT') AS association_revision`,
      [APP_ROLE])).rows[0];
    check(results, 'app 角色仍无 shipment_item / association_revision 表权限（只经函数读取）',
      tablePriv.shipment_item === false && tablePriv.association_revision === false, tablePriv);

    // 2) 行为探针：任取一条当前明细（确定性：市场非空、id 最小）只读预览。
    const target = (await owner.query(`SELECT i.id FROM catalog.shipment_item i
      JOIN catalog.shipment s ON s.id=i.shipment_id
      WHERE s.market IS NOT NULL ORDER BY i.id LIMIT 1`)).rows[0];
    evidence.targetItemId = target?.id ?? null;
    const preview = target ? await probeAsApp(owner, target.id) : null;
    evidence.samplePreview = preview;
    const expected = target ? await expectedPreview(owner, target.id) : null;
    evidence.expectedPreview = expected;
    const keys = preview && typeof preview === 'object' ? Object.keys(preview) : [];
    const missingFields = EXPECTED_FIELDS.filter((field) => !keys.includes(field));
    check(results, '行为探针：返回字段齐全（ok/itemId/market/nameNorm/productNameRaw/'
      + 'matchingCount/ticketCount/sampleTickets/unboundCount/reassignCount/note）',
    Boolean(preview) && preview.ok === true && missingFields.length === 0,
    { itemId: target?.id, missingFields, preview });
    check(results, '行为探针：matchingCount>=0 且 matchingCount = unboundCount + reassignCount',
      Boolean(preview) && Number.isInteger(preview.matchingCount) && preview.matchingCount >= 0
      && preview.matchingCount === preview.unboundCount + preview.reassignCount,
      preview ? { matching: preview.matchingCount, unbound: preview.unboundCount,
        reassign: preview.reassignCount } : null);
    check(results, '行为探针：ticketCount<=matchingCount 且 sampleTickets 最多 3 个票号',
      Boolean(preview) && preview.ticketCount <= preview.matchingCount
      && Array.isArray(preview.sampleTickets)
      && preview.sampleTickets.length === Math.min(3, preview.ticketCount),
      preview ? { tickets: preview.ticketCount, samples: preview.sampleTickets } : null);
    check(results, '行为探针：market/nameNorm/productNameRaw 与目标明细（含票市场）一致',
      Boolean(preview) && preview.itemId === target.id && preview.market === expected.market
      && preview.nameNorm === expected.nameNorm && preview.productNameRaw === expected.productNameRaw,
      { preview: { market: preview?.market, name: preview?.nameNorm },
        expected: { market: expected?.market, name: expected?.nameNorm } });
    check(results, '行为探针：与独立复刻的 027 命中集合完全一致（count/tickets/unbound/reassign）',
      Boolean(preview) && preview.matchingCount === expected.matchingCount
      && preview.ticketCount === expected.ticketCount
      && preview.unboundCount === expected.unboundCount
      && preview.reassignCount === expected.reassignCount,
      { preview: { matching: preview?.matchingCount, tickets: preview?.ticketCount,
        unbound: preview?.unboundCount, reassign: preview?.reassignCount },
        expected });
    const missing = await probeAsApp(owner, '00000000-0000-4000-8000-000000000000');
    evidence.missingPreview = missing;
    check(results, '行为探针：明细不存在返回 ok=false', missing?.ok === false, missing);

    // 2b) 非零命中样本：优先找“组内还有未关联明细”的当前明细，再用独立复刻结果挑第一条第
    // matchingCount>0 的（目标本身可能正是唯一未关联那条，排除自身后为 0）。
    const candidateRows = (await owner.query(`WITH latest AS (
        SELECT DISTINCT i.source_key, catalog.shipment_latest_success_snapshot_id(i.source_key) AS snap
        FROM catalog.shipment_item i
      ), groups AS (
        SELECT i.source_key,i.product_name_norm,s.market,
          count(*) FILTER (WHERE i.product_id IS NULL AND i.association_method IS NULL)::int AS unbound
        FROM catalog.shipment_item i JOIN catalog.shipment s ON s.id=i.shipment_id
        JOIN latest l ON l.source_key=i.source_key
        WHERE i.last_seen_snapshot_id=l.snap AND s.market IS NOT NULL
        GROUP BY i.source_key,i.product_name_norm,s.market
        HAVING count(*) FILTER (WHERE i.product_id IS NULL AND i.association_method IS NULL)>0
      )
      SELECT DISTINCT i.id FROM catalog.shipment_item i
      JOIN catalog.shipment s ON s.id=i.shipment_id
      JOIN groups g ON g.source_key=i.source_key AND g.product_name_norm=i.product_name_norm
        AND g.market=s.market
      WHERE s.market IS NOT NULL ORDER BY i.id LIMIT 40`)).rows;
    let nonZeroTarget = null;
    let nonZeroExpected = null;
    for (const row of candidateRows) {
      const expectedRow = await expectedPreview(owner, row.id);
      if (expectedRow.matchingCount > 0) { nonZeroTarget = row; nonZeroExpected = expectedRow; break; }
    }
    if (nonZeroTarget) {
      const nonZeroPreview = await probeAsApp(owner, nonZeroTarget.id);
      evidence.nonZeroPreview = { itemId: nonZeroTarget.id, preview: nonZeroPreview, expected: nonZeroExpected };
      check(results, '行为探针（非零样本）：matchingCount>0 且与独立复刻的 027 命中集合一致',
        Boolean(nonZeroPreview) && nonZeroPreview.matchingCount > 0
        && nonZeroPreview.matchingCount === nonZeroExpected.matchingCount
        && nonZeroPreview.unboundCount === nonZeroExpected.unboundCount
        && nonZeroPreview.reassignCount === nonZeroExpected.reassignCount
        && nonZeroPreview.ticketCount === nonZeroExpected.ticketCount,
        { preview: nonZeroPreview, expected: nonZeroExpected });
    } else {
      evidence.nonZeroPreview = '当前没有命中数 >0 的样本（所有同市场同品名组都已关联/无未关联）';
      check(results, '行为探针（非零样本）：当前数据没有可命中的另一条明细（跳过，不伪造）', true,
        evidence.nonZeroPreview);
    }
    const marketNullProbe = (await owner.query(`SELECT count(*)::int AS n FROM catalog.shipment_item i
      JOIN catalog.shipment s ON s.id=i.shipment_id WHERE s.market IS NULL`)).rows[0].n;
    evidence.marketNullItems = marketNullProbe;
    if (marketNullProbe === 0) {
      evidence.marketNullBranch = '当前没有市场为空的明细，未在现役数据上触发该分支（SQL 分支已回读，'
        + '克隆库可由 verify-039.mjs 用合成数据覆盖）';
    }

    // 3) 只读核对：业务数量前后不变。
    const countsAfterProbe = (await owner.query(countsSql)).rows[0];
    evidence.countsAfterProbe = countsAfterProbe;
    check(results, '只读：shipment/item/association_revision/mapping/snapshot 数量前后不变',
      JSON.stringify(countsBefore) === JSON.stringify(countsAfterProbe),
      { before: countsBefore, after: countsAfterProbe });

    // 4) 收尾：ROLLBACK / COMMIT（函数已在事务内安装）
    if (commit) {
      await owner.query('COMMIT');
      const after = (await owner.query(functionStateSql, [APP_ROLE, FUNCTION_NAME])).rows;
      check(results, '提交后函数存在（提交生效）', after.length === 1 && after[0].app_exec === true,
        after.map((row) => row.identity_args));
    } else {
      await owner.query('ROLLBACK');
      const after = (await owner.query(functionStateSql, [APP_ROLE, FUNCTION_NAME])).rows;
      const countsAfterRollback = (await owner.query(countsSql)).rows[0];
      evidence.countsAfterRollback = countsAfterRollback;
      check(results, 'rollback 后函数不存在（未留下半安装状态）', after.length === 0,
        after.map((row) => row.identity_args));
      check(results, 'rollback 后业务行数不变', JSON.stringify(countsBefore) === JSON.stringify(countsAfterRollback),
        { before: countsBefore, after: countsAfterRollback });
      const goneProbe = await (async () => {
        try {
          await probeAsApp(owner, target?.id ?? '00000000-0000-4000-8000-000000000000');
          return { ok: true };
        } catch (error) {
          return { ok: false, code: error.code, message: String(error.message).slice(0, 120) };
        }
      })();
      evidence.goneProbeAfterRollback = goneProbe;
      check(results, 'rollback 后新入口不可调用（42883）', goneProbe.ok === false && goneProbe.code === '42883',
        goneProbe);
    }
    evidence.results = results;
    evidence.passed = results.every((item) => item.ok);
    evidence.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(EVIDENCE_DIR, commit ? 'apply-039-commit.json' : 'apply-039.json'),
      `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(`\n${evidence.passed ? 'ALL PASS' : 'HAS FAILURES'} :: ${evidence.mode} :: ${targetName}`
      + ` :: checks=${results.length} fail=${results.filter((item) => !item.ok).length}`);
    console.log(`EVIDENCE ${path.join(EVIDENCE_DIR, commit ? 'apply-039-commit.json' : 'apply-039.json')}`);
    if (!evidence.passed) process.exitCode = 1;
  } catch (error) {
    try { await owner.query('ROLLBACK'); } catch { /* 事务可能已结束 */ }
    evidence.error = { message: error.message, code: error.code, stack: String(error.stack).slice(0, 2000) };
    evidence.results = results;
    evidence.passed = false;
    evidence.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(EVIDENCE_DIR, commit ? 'apply-039-commit.json' : 'apply-039.json'),
      `${JSON.stringify(evidence, null, 2)}\n`);
    console.error('[apply-039] failed:', error.message);
    process.exitCode = 1;
  } finally {
    await owner.end().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
