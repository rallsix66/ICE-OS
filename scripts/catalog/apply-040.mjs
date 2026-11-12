/**
 * 把 040「按所选商品的沿用规则预告 + 本条规则实际影响条数」应用到一个 catalog 库。
 *
 * 040 只新增/替换只读函数与一个写函数（同签名）：
 *   A. catalog.read_shipment_association_rule_preview_for_product(uuid,uuid)  ← 新增只读
 *   B. catalog.save_shipment_item_association_with_mapping(...)               ← CREATE OR REPLACE，
 *      行为不变，返回 jsonb 增加 ruleAdoptedCount（本条规则实际改动条数）。
 * 不新增表、不改 026/028、不写任何业务数据。
 *
 * 模式（默认绝不改目标库）：
 *   --rollback（默认）：事务内安装两次 → 结构/权限/行为探针 → ROLLBACK
 *   --commit          ：安装 → 回读 → 行为探针 → COMMIT
 *   安全闸门：目标库名等于现役库名时 --commit 必须显式 --allow-live-commit。
 *
 * 用法：
 *   node scripts/catalog/apply-040.mjs --rollback --run-id run-20261026T211500Z-11a22b33
 *   node scripts/catalog/apply-040.mjs --commit --database-url <clone-owner-url>
 *   node scripts/catalog/apply-040.mjs --commit --allow-live-commit
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
const SQL_FILE = 'db/catalog/040_shipment_association_rule_impact.sql';
const PREVIEW_FUNCTION = 'read_shipment_association_rule_preview_for_product';
const SAVE_FUNCTION = 'save_shipment_item_association_with_mapping';
const APP_ROLE = 'ice_p0_02_app_runner';
const ADMIN_PROFILE_ID = '11111111-1111-4111-8111-111111111101';
const EVIDENCE_DIR = path.join(REPO_ROOT, '.local', 'catalog', 'ux-round-20261112b');
const PREVIEW_FIELDS = ['ok', 'itemId', 'market', 'nameNorm', 'productNameRaw', 'selectedProductId',
  'matchingCount', 'ticketCount', 'sampleTickets', 'unboundCount', 'reassignCount', 'note'];

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
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail === undefined ? '' : ` :: ${JSON.stringify(detail).slice(0, 700)}`}`);
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
  (SELECT count(*) FROM catalog.shipment_source_snapshot)::int AS snapshots,
  (SELECT count(*) FROM catalog.product_source_issue)::int AS source_issues`;

/** 独立复刻 040 预告口径（owner 只读），用于和函数结果对账。 */
async function expectedPreview(owner, itemId, productId) {
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
          AND i.product_id IS DISTINCT FROM $6) AS is_reassign
      FROM catalog.shipment_item i JOIN catalog.shipment s ON s.id=i.shipment_id
      WHERE i.source_key=$1 AND i.product_name_norm=$2 AND s.market=$3
        AND i.last_seen_snapshot_id=$4 AND i.id<>$5
        AND i.product_id IS DISTINCT FROM $6
        AND ((i.product_id IS NULL AND i.association_method IS NULL)
          OR (i.product_id IS NOT NULL AND i.association_method='normalized_name_exact'
            AND i.product_id IS DISTINCT FROM $6))
    )
    SELECT count(*)::int AS matching, count(DISTINCT ticket_no)::int AS tickets,
      count(*) FILTER (WHERE is_unbound)::int AS unbound,
      count(*) FILTER (WHERE is_reassign)::int AS reassign FROM hits`,
  [item.source_key, item.product_name_norm, item.market, latest, itemId, productId])).rows[0];
  return { ok: true, market: item.market, nameNorm: item.product_name_norm,
    productNameRaw: item.product_name_raw, matchingCount: row.matching,
    ticketCount: row.tickets, unboundCount: row.unbound, reassignCount: row.reassign };
}

async function install(owner, sql) {
  await owner.query(sql);
  await owner.query('RESET ROLE; RESET ALL');
}

async function probeAsApp(owner, itemId, productId) {
  await owner.query(`SET LOCAL ROLE ${APP_ROLE}`);
  await owner.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [ADMIN_PROFILE_ID]);
  const result = (await owner.query(
    'SELECT catalog.read_shipment_association_rule_preview_for_product($1::uuid,$2::uuid) AS r',
    [itemId, productId])).rows[0]?.r ?? null;
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
    await install(owner, sql);
    const preview1 = (await owner.query(functionStateSql, [APP_ROLE, PREVIEW_FUNCTION])).rows;
    const save1 = (await owner.query(functionStateSql, [APP_ROLE, SAVE_FUNCTION])).rows;
    await install(owner, sql);
    const preview2 = (await owner.query(functionStateSql, [APP_ROLE, PREVIEW_FUNCTION])).rows;
    const save2 = (await owner.query(functionStateSql, [APP_ROLE, SAVE_FUNCTION])).rows;
    evidence.install = {
      applications: 2,
      preview: preview2[0] ? {
        identityArgs: preview2[0].identity_args, prosecdef: preview2[0].prosecdef,
        proconfig: preview2[0].proconfig, provolatile: preview2[0].provolatile,
        owner: preview2[0].owner_name, bodySha256: preview2[0].body_sha256,
        appExec: preview2[0].app_exec, publicExec: preview2[0].public_exec,
      } : null,
      save: save2[0] ? {
        identityArgs: save2[0].identity_args, bodySha256: save2[0].body_sha256,
        appExec: save2[0].app_exec, publicExec: save2[0].public_exec,
      } : null,
    };
    check(results, '040 安装两次均成功（幂等，无报错）', true, { applications: 2 });
    check(results, '新增预告函数仅一个重载（uuid,uuid）',
      preview2.length === 1 && preview2[0].identity_args === 'p_item_id uuid, p_product_id uuid',
      preview2.map((row) => row.identity_args));
    check(results, '预告函数 SECURITY DEFINER + search_path 锁定为空 + STABLE',
      preview2[0]?.prosecdef === true && searchPathLocked(preview2[0]?.proconfig)
      && preview2[0]?.provolatile === 's',
      { proconfig: preview2[0]?.proconfig ?? null, volatility: preview2[0]?.provolatile });
    check(results, '预告函数属主 ice_p0_02_owner / app 可执行 / PUBLIC 不可执行',
      preview2[0]?.owner_name === 'ice_p0_02_owner' && preview2[0]?.app_exec === true
      && preview2[0]?.public_exec === false,
      { owner: preview2[0]?.owner_name, app: preview2[0]?.app_exec, public: preview2[0]?.public_exec });
    check(results, '两次安装预告函数体哈希一致（幂等）',
      preview1[0]?.body_sha256 === preview2[0]?.body_sha256,
      { first: preview1[0]?.body_sha256?.slice(0, 16), second: preview2[0]?.body_sha256?.slice(0, 16) });
    const body = preview2[0]?.prosrc ?? '';
    check(results, '预告函数体体现按商品口径（require_admin / last_seen / distinct from product / 排除自身）',
      /catalog\.require_admin\(\)/.test(body) && /i\.last_seen_snapshot_id=v_latest/.test(body)
      && /i\.product_id IS DISTINCT FROM p_product_id/.test(body) && /i\.id<>p_item_id/.test(body));
    const saveBody = save2[0]?.prosrc ?? '';
    check(results, '保存函数保留原行为并新增 ruleAdoptedCount（仅统计本条规则）',
      /ruleAdoptedCount/.test(saveBody) && /shipment_mapping_apply_core/.test(saveBody)
      && /i\.product_name_norm=v_item\.product_name_norm/.test(saveBody)
      && /s\.market=v_market/.test(saveBody) && /jsonb_array_elements\(v_applied->'items'\)/.test(saveBody),
      { saveSha: save2[0]?.body_sha256?.slice(0, 16) });
    check(results, '保存函数 app 可执行 / PUBLIC 不可执行',
      save2[0]?.app_exec === true && save2[0]?.public_exec === false,
      { app: save2[0]?.app_exec, public: save2[0]?.public_exec });
    check(results, '两次安装保存函数体哈希一致（幂等）',
      save1[0]?.body_sha256 === save2[0]?.body_sha256);
    const tablePriv = (await owner.query(
      `SELECT has_table_privilege($1,'catalog.shipment_item','SELECT') AS shipment_item,
              has_table_privilege($1,'catalog.shipment_product_mapping','SELECT') AS mapping`,
      [APP_ROLE])).rows[0];
    check(results, 'app 角色仍无 shipment_item / shipment_product_mapping 表权限（只经函数）',
      tablePriv.shipment_item === false && tablePriv.mapping === false, tablePriv);

    // 行为探针：POKNZX027385 的 P04 唇泥 + WM0046（当前已自动关联同一商品）。
    const target = (await owner.query(`SELECT i.id, i.product_id
      FROM catalog.shipment_item i JOIN catalog.shipment s ON s.id=i.shipment_id
      WHERE s.ticket_no='POKNZX027385' AND i.product_name_raw LIKE 'CHIC PEAK %P04-%'
      ORDER BY i.sort_index LIMIT 1`)).rows[0];
    const wm0046 = (await owner.query(
      "SELECT item_id FROM catalog.catalog_item_code WHERE ice_code='WM0046'")).rows[0]?.item_id ?? null;
    const other = (await owner.query(`SELECT item_id FROM catalog.catalog_item_code
      WHERE ice_code<>'WM0046' ORDER BY ice_code LIMIT 1`)).rows[0]?.item_id ?? null;
    evidence.target = { itemId: target?.id ?? null, currentProductId: target?.product_id ?? null, wm0046, other };
    if (target && wm0046) {
      const preview = await probeAsApp(owner, target.id, wm0046);
      const expected = await expectedPreview(owner, target.id, wm0046);
      evidence.previewWm0046 = { preview, expected };
      const keys = preview && typeof preview === 'object' ? Object.keys(preview) : [];
      const missing = PREVIEW_FIELDS.filter((field) => !keys.includes(field));
      check(results, '行为探针：WM0046 预告返回字段齐全（含 selectedProductId）',
        Boolean(preview) && preview.ok === true && missing.length === 0, { missing, preview });
      check(results, '行为探针：WM0046 已关联同一商品，其他明细计 0 条',
        Boolean(preview) && preview.matchingCount === 0 && preview.unboundCount === 0
        && preview.reassignCount === 0 && preview.ticketCount === 0,
        preview);
      check(results, '行为探针：WM0046 与独立复刻 040 口径一致（0 条）',
        JSON.stringify({
          matching: preview.matchingCount, tickets: preview.ticketCount,
          unbound: preview.unboundCount, reassign: preview.reassignCount,
        }) === JSON.stringify({
          matching: expected.matchingCount, tickets: expected.ticketCount,
          unbound: expected.unboundCount, reassign: expected.reassignCount,
        }), { preview, expected });
      if (other) {
        const previewOther = await probeAsApp(owner, target.id, other);
        const expectedOther = await expectedPreview(owner, target.id, other);
        evidence.previewOther = { productId: other, preview: previewOther, expected: expectedOther };
        check(results, '行为探针：换选其他商品后预告按新商品重算且与独立复刻一致（>0）',
          Boolean(previewOther) && previewOther.matchingCount > 0
          && previewOther.matchingCount === expectedOther.matchingCount
          && previewOther.unboundCount === expectedOther.unboundCount
          && previewOther.reassignCount === expectedOther.reassignCount
          && previewOther.ticketCount === expectedOther.ticketCount,
          { preview: previewOther, expected: expectedOther });
      }
    } else {
      check(results, '行为探针：未找到 POKNZX027385/P04/WM0046 样本（跳过，不伪造）', false,
        { target: target?.id, wm0046 });
    }
    const missingProbe = await probeAsApp(owner, '00000000-0000-4000-8000-000000000000', wm0046);
    check(results, '行为探针：明细不存在返回 ok=false', missingProbe?.ok === false, missingProbe);

    const countsAfterProbe = (await owner.query(countsSql)).rows[0];
    evidence.countsAfterProbe = countsAfterProbe;
    check(results, '只读：shipment/item/association_revision/mapping/snapshot/source_issue 数量前后不变',
      JSON.stringify(countsBefore) === JSON.stringify(countsAfterProbe),
      { before: countsBefore, after: countsAfterProbe });

    if (commit) {
      await owner.query('COMMIT');
      const afterPreview = (await owner.query(functionStateSql, [APP_ROLE, PREVIEW_FUNCTION])).rows;
      const afterSave = (await owner.query(functionStateSql, [APP_ROLE, SAVE_FUNCTION])).rows;
      check(results, '提交后两个函数均存在且 app 可执行',
        afterPreview.length === 1 && afterPreview[0].app_exec === true
        && afterSave.length === 1 && afterSave[0].app_exec === true);
    } else {
      await owner.query('ROLLBACK');
      const afterPreview = (await owner.query(functionStateSql, [APP_ROLE, PREVIEW_FUNCTION])).rows;
      const countsAfterRollback = (await owner.query(countsSql)).rows[0];
      evidence.countsAfterRollback = countsAfterRollback;
      check(results, 'rollback 后新预告函数不存在（未留下半安装状态）', afterPreview.length === 0);
      check(results, 'rollback 后业务行数不变',
        JSON.stringify(countsBefore) === JSON.stringify(countsAfterRollback));
    }
    evidence.results = results;
    evidence.passed = results.every((item) => item.ok);
    evidence.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(EVIDENCE_DIR, commit ? 'apply-040-commit.json' : 'apply-040.json'),
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
    fs.writeFileSync(path.join(EVIDENCE_DIR, commit ? 'apply-040-commit.json' : 'apply-040.json'),
      `${JSON.stringify(evidence, null, 2)}\n`);
    console.error('[apply-040] failed:', error.message);
    process.exitCode = 1;
  } finally {
    await owner.end().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
