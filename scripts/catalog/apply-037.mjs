/**
 * 把 037「按来源列解释 + 候选关系补号闭环」增量应用到一个 catalog 库，并回读结构 / 权限 / 幂等。
 *
 * 037 只新增/替换（不改 001–036）：
 *   - product_source_field_decision 增加 rule 列 + action/rule 约束（interpret 白名单）；
 *   - product_source_request 动作白名单增加 interpret_source_field；
 *   - 新 RPC catalog.set_product_source_field_interpretation(uuid,text,uuid,text,text,text,text)；
 *   - 替换 read_product_source_manual_decisions（fieldDecisions 增加 rule）；
 *   - 替换 assign_product_source_code（沿用 036，追加 batch 级 missing_code/missing_code_candidate
 *     关闭与 closedCandidateIssues 计数）。
 *
 * 模式（默认绝不改现役库）：
 *   --rollback（默认）：事务内安装两次 → 结构/权限/幂等/回读 → 整体 ROLLBACK；
 *                       证据 .../apply-037.json
 *   --commit          ：事务内安装两次 → 回读 → 行为探针（构造候选事项 → assign → 断言关闭）
 *                       → ROLLBACK 探针 SAVEPOINT → COMMIT；证据 .../apply-037-commit.json
 *   安全闸门：目标库名等于 env.inventory.json 的现役库名时，--commit 必须显式 --allow-live-commit。
 *
 * 用法：
 *   node scripts/catalog/apply-037.mjs --rollback --run-id run-20261026T211500Z-11a22b33
 *   node scripts/catalog/apply-037.mjs --commit --database-url <clone-owner-url>
 *   node scripts/catalog/apply-037.mjs --commit --allow-live-commit        # 现役库（Lead 手动）
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
const SQL_FILE = 'db/catalog/037_product_source_interpretation.sql';
const OWNER_ROLE = 'ice_p0_02_owner';
const APP_ROLE = 'ice_p0_02_app_runner';
const SYNC_ROLE = 'ice_p0_02_sync_runner';
const ADMIN_PROFILE_ID = '11111111-1111-4111-8111-111111111101';
const PROFILE_KEY = 'feishu.ice-product-library.sheet1';
const TEST_ITEM = 'dfef3f23-c64e-4646-98d0-045efb4e55f2';
const EVIDENCE_DIR = path.join(REPO_ROOT, '.local', 'catalog', 'feishu-source-review-fix-20261110');

const FUNCTION_SPECS = [
  { key: 'set_product_source_field_interpretation|uuid,text,uuid,text,text,text,text', secdef: true, app: true },
  { key: 'read_product_source_manual_decisions|text', secdef: true, app: true },
  { key: 'assign_product_source_code|uuid,text,uuid,integer,text,text,text', secdef: true, app: true },
];
const FUNCTION_NAMES = FUNCTION_SPECS.map((spec) => spec.key.split('|')[0]);
const INTERPRET_RULES = [
  { field: 'unitWeight', rule: 'unit_weight_per_unit_fragment' },
  { field: 'cartonWeight', rule: 'confirmed_source_value' },
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
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail === undefined ? '' : ` :: ${JSON.stringify(detail).slice(0, 600)}`}`);
}
function sha256Text(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function newIntent() { return sha256Text(`${Date.now()}:${Math.random()}:${crypto.randomUUID()}`); }
function withDatabase(connectionString, databaseName) {
  const url = new URL(connectionString);
  url.pathname = `/${databaseName}`;
  return url.toString();
}
function databaseNameOf(connectionString) {
  const url = new URL(connectionString);
  return decodeURIComponent(url.pathname.replace(/^\//, ''));
}
function searchPathLocked(proconfig) {
  return Array.isArray(proconfig)
    && proconfig.some((entry) => /^search_path=(?:''|"")?$/.test(String(entry).replace(/\s/g, '').toLowerCase()));
}
function keyOf(row) { return `${row.proname}|${row.arg_types.join(',')}`; }
function publicFunctionView(row) {
  return {
    signature: `${row.proname}(${row.identity_args})`,
    prosecdef: row.prosecdef, proconfig: row.proconfig, provolatile: row.provolatile,
    owner: row.owner_name, body_sha256: row.body_sha256,
    app_exec: row.app_exec, sync_exec: row.sync_exec, public_exec: row.public_exec,
  };
}

const functionStateSql = `SELECT p.proname,
  ARRAY(SELECT format_type(t, NULL) FROM unnest(p.proargtypes) AS t) AS arg_types,
  pg_get_function_identity_arguments(p.oid) AS identity_args,
  p.prosecdef, p.proconfig, p.provolatile,
  pg_get_userbyid(p.proowner) AS owner_name,
  encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') AS body_sha256,
  pg_catalog.has_function_privilege($1, p.oid, 'EXECUTE') AS app_exec,
  pg_catalog.has_function_privilege($2, p.oid, 'EXECUTE') AS sync_exec,
  pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='catalog' AND p.proname = ANY($3)
 ORDER BY p.proname, identity_args`;

const businessCountsSql = `SELECT
  (SELECT count(*) FROM catalog.product_source_issue)::int AS issues,
  (SELECT count(*) FROM catalog.product_source_issue WHERE review_state='open')::int AS open_issues,
  (SELECT count(*) FROM catalog.product_source_batch)::int AS batches,
  (SELECT count(*) FROM catalog.product_source_result)::int AS results,
  (SELECT count(*) FROM catalog.catalog_item)::int AS items,
  (SELECT count(*) FROM catalog.item_revision)::int AS revisions,
  (SELECT count(*) FROM catalog.catalog_item_code)::int AS codes,
  (SELECT count(*) FROM catalog.shipment_item_association_revision)::int AS association_revisions,
  (SELECT count(*) FROM catalog.product_source_field_decision)::int AS field_decisions,
  (SELECT count(*) FROM catalog.product_source_duplicate_decision)::int AS duplicate_decisions`;

const columnSql = `SELECT a.attname AS column_name, format_type(a.atttypid,a.atttypmod) AS data_type,
  a.attnotnull, pg_get_expr(d.adbin,d.adrelid) AS default_expr
 FROM pg_attribute a
 JOIN pg_class c ON c.oid=a.attrelid
 JOIN pg_namespace n ON n.oid=c.relnamespace
 LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
 WHERE n.nspname='catalog' AND c.relname='product_source_field_decision'
   AND a.attnum>0 AND NOT a.attisdropped
 ORDER BY a.attnum`;

const constraintSql = `SELECT c.relname AS table_name, k.conname, k.contype, pg_get_constraintdef(k.oid) AS definition
 FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='catalog' AND c.relname IN('product_source_field_decision','product_source_request')
 ORDER BY c.relname, k.conname`;

const tablePrivilegeSql = `SELECT c.relname AS table_name,
  pg_catalog.has_table_privilege($1, c.oid, 'SELECT') AS app_select,
  pg_catalog.has_table_privilege($1, c.oid, 'INSERT') AS app_insert,
  pg_catalog.has_table_privilege($1, c.oid, 'UPDATE') AS app_update,
  pg_catalog.has_table_privilege($1, c.oid, 'DELETE') AS app_delete,
  pg_catalog.has_table_privilege('public', c.oid, 'SELECT') AS public_select
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE c.relkind='r' AND n.nspname='catalog'
   AND c.relname IN('product_source_field_decision','product_source_duplicate_decision')
 ORDER BY 1`;

async function collectMetadata(client) {
  const functions = await client.query(functionStateSql, [APP_ROLE, SYNC_ROLE, FUNCTION_NAMES]);
  const columns = await client.query(columnSql);
  const constraints = await client.query(constraintSql);
  const privileges = await client.query(tablePrivilegeSql, [APP_ROLE]);
  return {
    functions: functions.rows,
    columns: columns.rows.map((row) => ({
      column: row.column_name, type: row.data_type, notnull: row.attnotnull, default_expr: row.default_expr,
    })),
    constraints: constraints.rows.map((row) => ({
      table: row.table_name, name: row.conname, type: row.contype, definition: row.definition,
    })),
    tablePrivileges: privileges.rows.map((row) => ({
      table: row.table_name, app_select: row.app_select, app_insert: row.app_insert,
      app_update: row.app_update, app_delete: row.app_delete, public_select: row.public_select,
    })),
  };
}
function structureEquals(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

async function main() {
  const args = readArgs(process.argv.slice(2));
  const runId = args['run-id'] ?? DEFAULT_RUN_ID;
  const instanceDir = path.join(REPO_ROOT, '.local/catalog', runId, 'instance');
  const env = JSON.parse(fs.readFileSync(path.join(instanceDir, 'env.inventory.json'), 'utf8'));
  const ownerUrl = args['database-url'] ?? env.ownerDbUrl;
  const targetDatabase = databaseNameOf(ownerUrl);
  const isLive = targetDatabase === env.database;
  const commit = args.commit === true;
  const rollback = !commit;
  const mode = commit ? 'commit' : 'rollback';

  if (commit && isLive && args['allow-live-commit'] !== true) {
    console.error('[REFUSED] 目标是现役库（' + targetDatabase + '），--commit 默认被拒绝；'
      + '请改用隔离 clone 库，或由 Lead 显式追加 --allow-live-commit。');
    process.exitCode = 2;
    return;
  }

  const appUrl = isLive ? env.appDbUrl : withDatabase(env.appDbUrl, targetDatabase);
  const sqlText = fs.readFileSync(path.join(REPO_ROOT, SQL_FILE), 'utf8');
  const sqlSha256 = sha256Text(sqlText);

  const owner = new pg.Client({ connectionString: ownerUrl });
  await owner.connect();
  const results = [];
  const evidence = {
    runId, mode, targetDatabase, isLive, sqlFile: SQL_FILE, sqlSha256,
    at: new Date().toISOString(), applications: 2, checks: results,
  };

  let app = null;
  try {
    evidence.identity = (await owner.query(
      'SELECT current_database() AS db, current_user AS user')).rows[0];
    evidence.before = {
      counts: (await owner.query(businessCountsSql)).rows[0],
      functions: (await owner.query(functionStateSql, [APP_ROLE, SYNC_ROLE, FUNCTION_NAMES])).rows
        .map(publicFunctionView),
      hasRuleColumn: (await owner.query(
        `SELECT count(*)::int AS n FROM information_schema.columns
         WHERE table_schema='catalog' AND table_name='product_source_field_decision' AND column_name='rule'`
      )).rows[0].n === 1,
    };

    await owner.query('BEGIN');
    try {
      // ---- 1. 安装两次（幂等） -------------------------------------------
      await owner.query(sqlText);
      await owner.query('RESET ROLE');
      const afterFirst = await collectMetadata(owner);
      const countsAfterFirst = (await owner.query(businessCountsSql)).rows[0];
      await owner.query(sqlText);
      await owner.query('RESET ROLE');
      const afterSecond = await collectMetadata(owner);
      const countsAfterSecond = (await owner.query(businessCountsSql)).rows[0];
      evidence.install = afterSecond;
      check(results, '037 安装两次均成功（幂等，无报错）', true, { applications: 2 });
      check(results, '两次安装后函数/列/约束/表权限完全一致（幂等）',
        structureEquals(afterFirst, afterSecond));
      check(results, '两次安装之间业务行数未变（安装不写业务数据）',
        structureEquals(countsAfterFirst, countsAfterSecond), { countsAfterFirst, countsAfterSecond });

      // ---- 2. 结构回读 ---------------------------------------------------
      const rowsByKey = new Map(afterSecond.functions.map((row) => [keyOf(row), row]));
      evidence.functions = afterSecond.functions.map(publicFunctionView);
      for (const spec of FUNCTION_SPECS) {
        const found = rowsByKey.get(spec.key);
        const view = found ? {
          prosecdef: found.prosecdef, proconfig: found.proconfig, owner: found.owner_name,
          app: found.app_exec, sync: found.sync_exec, public: found.public_exec,
          body_sha256: found.body_sha256,
        } : null;
        check(results, `函数 ${spec.key.replace('|', '(')}) 存在`, Boolean(found), view);
        check(results, `函数 ${spec.key.split('|')[0]} SECURITY DEFINER=${spec.secdef} 且 search_path 锁定`,
          Boolean(found) && found.prosecdef === spec.secdef && searchPathLocked(found.proconfig), view);
        check(results, `函数 ${spec.key.split('|')[0]} 属主为 ${OWNER_ROLE}、app 可执行 / sync 不可 / PUBLIC 不可`,
          Boolean(found) && found.owner_name === OWNER_ROLE && found.app_exec === true
          && found.sync_exec === false && found.public_exec === false, view);
      }
      check(results, '3 个 037 相关函数全部存在', rowsByKey.size >= FUNCTION_SPECS.length,
        { expected: FUNCTION_SPECS.length, actual: rowsByKey.size });

      const ruleColumn = afterSecond.columns.find((row) => row.column === 'rule');
      evidence.ruleColumn = ruleColumn;
      check(results, 'product_source_field_decision.rule 为可空 text（无默认值）',
        Boolean(ruleColumn) && ruleColumn.type === 'text' && ruleColumn.notnull === false
        && ruleColumn.default_expr === null, ruleColumn ?? null);
      const actionCheck = afterSecond.constraints.find(
        (row) => row.table === 'product_source_field_decision' && row.name === 'product_source_field_decision_action_check');
      check(results, '字段决定 action CHECK 允许 defer/override/interpret',
        Boolean(actionCheck) && ['defer', 'override', 'interpret'].every(
          (action) => actionCheck.definition.includes(`'${action}'`)), actionCheck?.definition ?? null);
      const ruleConsistency = afterSecond.constraints.find(
        (row) => row.table === 'product_source_field_decision' && row.name === 'product_source_field_decision_rule_consistency_check');
      check(results, '字段决定 rule 一致性 CHECK（interpret 必须有 rule，其余必须 NULL）',
        Boolean(ruleConsistency) && /interpret/.test(ruleConsistency.definition)
        && /rule IS NOT NULL/.test(ruleConsistency.definition), ruleConsistency?.definition ?? null);
      const ruleAllowed = afterSecond.constraints.find(
        (row) => row.table === 'product_source_field_decision' && row.name === 'product_source_field_decision_rule_allowed_check');
      check(results, '字段决定 rule 白名单 CHECK 绑定 2 个 (field,rule) 组合',
        Boolean(ruleAllowed) && INTERPRET_RULES.every(({ field, rule }) =>
          ruleAllowed.definition.includes(`'${field}'`) && ruleAllowed.definition.includes(`'${rule}'`)),
        ruleAllowed?.definition ?? null);
      const requestCheck = afterSecond.constraints.find(
        (row) => row.table === 'product_source_request' && row.name === 'product_source_request_action_check');
      check(results, '请求动作白名单包含 interpret_source_field（且保留 036 的 9 个动作）',
        Boolean(requestCheck) && requestCheck.definition.includes("'interpret_source_field'")
        && ['apply_product_source_batch', 'resolve_source_issue', 'assign_source_code',
          'defer_source_field', 'override_source_field', 'restore_source_field',
          'decide_duplicate_source_row', 'restore_duplicate_source_decision',
          'correct_test_source_code'].every((action) => requestCheck.definition.includes(`'${action}'`)),
        requestCheck?.definition ?? null);

      const privileges = afterSecond.tablePrivileges;
      for (const table of ['product_source_field_decision', 'product_source_duplicate_decision']) {
        const privilege = privileges.find((row) => row.table === table);
        check(results, `表 ${table} 保持 036 授权：app 仅 SELECT、无写、PUBLIC 无`,
          Boolean(privilege) && privilege.app_select === true && privilege.app_insert === false
          && privilege.app_update === false && privilege.app_delete === false
          && privilege.public_select === false, privilege ?? null);
      }

      const bodyOf = (name) => rowsByKey.get(
        [...rowsByKey.keys()].find((key) => key.startsWith(`${name}|`)))?.body_sha256 ?? null;
      const functionSources = (await owner.query(
        `SELECT p.proname, p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
         WHERE n.nspname='catalog' AND p.proname = ANY($1)`, [FUNCTION_NAMES])).rows;
      const sourceOf = (name) => functionSources.find((row) => row.proname === name)?.prosrc ?? '';
      evidence.bodySha256 = Object.fromEntries(FUNCTION_NAMES.map((name) => [name, bodyOf(name)]));
      check(results, 'read_product_source_manual_decisions 返回字段决定包含 rule',
        /'rule',d\.rule/.test(sourceOf('read_product_source_manual_decisions')));
      check(results, 'assign_product_source_code 追加 closedCandidateIssues 与 batch 级候选闭环',
        /closedCandidateIssues/.test(sourceOf('assign_product_source_code'))
        && /missing_code_candidate/.test(sourceOf('assign_product_source_code'))
        && /source_key='code:'\|\|p_code/.test(sourceOf('assign_product_source_code')));
      check(results, 'set_product_source_field_interpretation 含 rule 白名单与 interpret_source_field 留痕',
        INTERPRET_RULES.every(({ field, rule }) =>
          sourceOf('set_product_source_field_interpretation').includes(`'${field}'`)
          && sourceOf('set_product_source_field_interpretation').includes(`'${rule}'`))
        && /interpret_source_field/.test(sourceOf('set_product_source_field_interpretation')));

      // ---- 3. 权限负向：无管理员 JWT --------------------------------------
      await owner.query('SAVEPOINT no_jwt');
      const noJwt = {};
      try {
        await owner.query("SELECT set_config('request.jwt.claim.sub','',true)");
        for (const [name, sql, params] of [
          ['set_interpret', `SELECT catalog.set_product_source_field_interpretation(
             gen_random_uuid(), $1, $2, 'unitWeight', 'unit_weight_per_unit_fragment', 'probe', NULL)`,
          [newIntent(), TEST_ITEM]],
          ['read_decisions', 'SELECT catalog.read_product_source_manual_decisions($1)', [PROFILE_KEY]],
          ['assign_code', 'SELECT catalog.assign_product_source_code($1,$2,$3,$4,$5,$6,$7)',
            [crypto.randomUUID(), newIntent(), TEST_ITEM, 1, 'WMX037', 'probe', 'probe']],
        ]) {
          await owner.query('SAVEPOINT no_jwt_case');
          try {
            await owner.query(sql, params);
            noJwt[name] = { ok: true };
          } catch (error) {
            noJwt[name] = { ok: false, code: error.code, message: String(error.message).slice(0, 120) };
          } finally {
            await owner.query('ROLLBACK TO SAVEPOINT no_jwt_case');
          }
        }
      } finally {
        await owner.query('ROLLBACK TO SAVEPOINT no_jwt');
      }
      evidence.noJwtProbe = noJwt;
      check(results, '无管理员 JWT 时 037 三个入口全部被拒（42501 / CATALOG_FORBIDDEN）',
        Object.values(noJwt).every((row) => row.ok === false && row.code === '42501'
          && /CATALOG_FORBIDDEN/.test(row.message)), noJwt);

      // ---- 4. 行为探针：构造 open 候选事项 → assign 关闭（仅克隆库 commit） ----
      if (commit && !isLive) {
        await owner.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [ADMIN_PROFILE_ID]);
        await owner.query('SAVEPOINT candidate_probe');
        try {
          const latestBatch = (await owner.query(
            `SELECT id FROM catalog.product_source_batch WHERE status IN('applied','partial')
             ORDER BY captured_at DESC, received_at DESC LIMIT 1`)).rows[0];
          const baseline = {
            revision: (await owner.query('SELECT revision FROM catalog.item_current WHERE item_id=$1', [TEST_ITEM])).rows[0].revision,
            revisions: (await owner.query(
              `SELECT revision, previous_revision, ice_code_snapshot, name_cn
               FROM catalog.item_revision WHERE item_id=$1 ORDER BY revision`, [TEST_ITEM])).rows,
            itemCount: (await owner.query('SELECT count(*)::int AS n FROM catalog.catalog_item')).rows[0].n,
            shipment: (await owner.query(
              `SELECT coalesce(sum(si.shipped_quantity - coalesce(si.received_quantity,0)),0)::int AS in_transit,
                      count(*)::int AS rows
               FROM catalog.shipment_item si WHERE si.product_id=$1`, [TEST_ITEM])).rows[0],
            association: (await owner.query(
              `SELECT count(*)::int AS n FROM catalog.shipment_item_association_revision WHERE product_id=$1`,
              [TEST_ITEM])).rows[0].n,
            itemScopedOpen: (await owner.query(
              `SELECT count(*)::int AS n FROM catalog.product_source_issue
               WHERE item_id=$1 AND review_state='open' AND scope='item'`, [TEST_ITEM])).rows[0].n,
          };
          await owner.query(
            `INSERT INTO catalog.product_source_issue(batch_id,source_key,issue_kind,detail,item_id,scope)
             VALUES($1,'code:WM0131','missing_code_candidate',
              jsonb_build_object('rows','[]'::jsonb,'rowNumbers','[]'::jsonb,
               'nameCn','ICE LERSKIN 烟酰胺提亮精华水150ml','candidateCode','WM0131','reason','MISSING_CODE_CANDIDATE'),
              $2,'batch')
             ON CONFLICT(batch_id,source_key,issue_kind) DO NOTHING
             RETURNING id`, [latestBatch.id, TEST_ITEM]).then(() => null);
          const candidate = (await owner.query(
            `SELECT id, review_state FROM catalog.product_source_issue
             WHERE batch_id=$1 AND source_key='code:WM0131' AND issue_kind='missing_code_candidate'`,
            [latestBatch.id])).rows[0];
          check(results, '行为探针：已构造 open batch 级 missing_code_candidate（code:WM0131）',
            Boolean(candidate) && candidate.review_state === 'open', candidate ?? null);

          const assignRes = (await owner.query(
            `SELECT catalog.assign_product_source_code($1,$2,$3,$4,$5,$6,$7) AS r`,
            [crypto.randomUUID(), newIntent(), TEST_ITEM, baseline.revision, 'WM0131',
              'WM0131 关系确认后补号', 'candidate:code:WM0131'])).rows[0].r;
          evidence.behaviorProbe = { baseline, assignResult: assignRes };
          check(results, '行为探针：assign WM0131 返回 closedCandidateIssues=1 且 closedPendingIssues>=1',
            assignRes.closedCandidateIssues === 1 && assignRes.closedPendingIssues >= 1
            && assignRes.iceCode === 'WM0131' && assignRes.revision === baseline.revision + 1, assignRes);
          const candidateAfter = (await owner.query(
            'SELECT review_state, resolution_note FROM catalog.product_source_issue WHERE id=$1', [candidate.id])).rows[0];
          check(results, '行为探针：候选事项 resolved（note 含 WM0131）',
            candidateAfter.review_state === 'resolved'
            && /已人工确认候选关系并补录正式货号 WM0131/.test(candidateAfter.resolution_note ?? ''), candidateAfter);
          const after = {
            revision: (await owner.query('SELECT revision FROM catalog.item_current WHERE item_id=$1', [TEST_ITEM])).rows[0].revision,
            revisions: (await owner.query(
              `SELECT revision, previous_revision, ice_code_snapshot, name_cn
               FROM catalog.item_revision WHERE item_id=$1 ORDER BY revision`, [TEST_ITEM])).rows,
            itemCount: (await owner.query('SELECT count(*)::int AS n FROM catalog.catalog_item')).rows[0].n,
            shipment: (await owner.query(
              `SELECT coalesce(sum(si.shipped_quantity - coalesce(si.received_quantity,0)),0)::int AS in_transit,
                      count(*)::int AS rows
               FROM catalog.shipment_item si WHERE si.product_id=$1`, [TEST_ITEM])).rows[0],
            association: (await owner.query(
              `SELECT count(*)::int AS n FROM catalog.shipment_item_association_revision WHERE product_id=$1`,
              [TEST_ITEM])).rows[0].n,
            code: (await owner.query(
              `SELECT ice_code FROM catalog.catalog_item_code WHERE item_id=$1`, [TEST_ITEM])).rows[0]?.ice_code ?? null,
            binding: (await owner.query(
              `SELECT ice_code, state FROM catalog.product_source_binding WHERE item_id=$1`, [TEST_ITEM])).rows[0] ?? null,
          };
          evidence.behaviorProbe.after = after;
          const oldRevisionsUnchanged = JSON.stringify(after.revisions.slice(0, baseline.revisions.length))
            === JSON.stringify(baseline.revisions);
          check(results, '行为探针：item UUID/商品行数/在途 3840/关联 1 条/旧修订历史全部不变',
            after.itemCount === baseline.itemCount
            && after.shipment.in_transit === baseline.shipment.in_transit
            && after.shipment.in_transit === 3840 && after.shipment.rows === baseline.shipment.rows
            && after.association === baseline.association && after.association === 1
            && oldRevisionsUnchanged && after.revisions.length === baseline.revisions.length + 1,
            { baseline: { itemCount: baseline.itemCount, shipment: baseline.shipment, association: baseline.association },
              after: { itemCount: after.itemCount, shipment: after.shipment, association: after.association } });
          check(results, '行为探针：新修订 snapshot=WM0131，且货号/绑定已写入',
            after.revisions[after.revisions.length - 1]?.ice_code_snapshot === 'WM0131'
            && after.code === 'WM0131' && after.binding?.ice_code === 'WM0131'
            && after.binding?.state === 'active', { code: after.code, binding: after.binding });
        } finally {
          await owner.query('ROLLBACK TO SAVEPOINT candidate_probe');
        }
        check(results, '行为探针在 SAVEPOINT 内回滚，commit 模式只安装函数/约束',
          (await owner.query("SELECT count(*)::int AS n FROM catalog.catalog_item_code WHERE ice_code='WM0131'")).rows[0].n === 0);
      } else {
        check(results, '行为探针仅在隔离克隆库 commit 模式执行（现役库只允许结构回读 + rollback）',
          true, { mode, isLive });
      }

      // ---- 5. 收尾：ROLLBACK 或 COMMIT ------------------------------------
      if (rollback) {
        await owner.query('ROLLBACK');
        const afterCounts = (await owner.query(businessCountsSql)).rows[0];
        const functionsAfter = (await owner.query(functionStateSql, [APP_ROLE, SYNC_ROLE, FUNCTION_NAMES])).rows
          .map(publicFunctionView);
        const hasRuleColumn = (await owner.query(
          `SELECT count(*)::int AS n FROM information_schema.columns
           WHERE table_schema='catalog' AND table_name='product_source_field_decision' AND column_name='rule'`
        )).rows[0].n === 1;
        const actionCheckAfter = (await owner.query(
          `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
           WHERE conrelid='catalog.product_source_field_decision'::regclass
             AND conname='product_source_field_decision_action_check'`)).rows[0];
        const requestCheckAfter = (await owner.query(
          `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
           WHERE conrelid='catalog.product_source_request'::regclass
             AND conname='product_source_request_action_check'`)).rows[0];
        evidence.afterRollback = {
          counts: afterCounts, functions: functionsAfter, hasRuleColumn,
          actionCheck: actionCheckAfter?.def, requestCheck: requestCheckAfter?.def,
        };
        check(results, 'rollback 后业务行数未变（issue/batch/result/item/revision/code/关联/决定）',
          structureEquals(afterCounts, evidence.before.counts),
          { before: evidence.before.counts, after: afterCounts });
        check(results, 'rollback 后 037 函数集合回到安装前（无 interpret RPC，assign/read 定义还原）',
          structureEquals(
            functionsAfter.sort((left, right) => left.signature.localeCompare(right.signature)),
            evidence.before.functions.slice().sort((left, right) => left.signature.localeCompare(right.signature)),
          ), { before: evidence.before.functions.map((row) => row.signature),
            after: functionsAfter.map((row) => row.signature) });
        check(results, 'rollback 后 rule 列与 037 约束不存在（未留下半安装状态）',
          hasRuleColumn === false && !/'interpret'/.test(actionCheckAfter?.def ?? '')
          && !/'interpret_source_field'/.test(requestCheckAfter?.def ?? ''),
          { hasRuleColumn, actionCheck: actionCheckAfter?.def, requestCheck: requestCheckAfter?.def });
        const goneProbe = await (async () => {
          try {
            await owner.query('SELECT catalog.set_product_source_field_interpretation(gen_random_uuid(),$1,$2,$3,$4,$5,NULL)',
              [newIntent(), TEST_ITEM, 'unitWeight', 'unit_weight_per_unit_fragment', 'probe']);
            return { ok: true };
          } catch (error) {
            return { ok: false, code: error.code, message: String(error.message).slice(0, 120) };
          }
        })();
        evidence.goneProbeAfterRollback = goneProbe;
        const existedBefore = evidence.before.functions.some(
          (row) => row.signature.startsWith('set_product_source_field_interpretation('));
        if (!existedBefore) {
          check(results, 'rollback 后新入口不可调用（42883，未留下半安装状态）',
            goneProbe.ok === false && goneProbe.code === '42883', goneProbe);
        }
      } else {
        await owner.query('COMMIT');
        const afterCounts = (await owner.query(businessCountsSql)).rows[0];
        const functionsAfter = (await owner.query(functionStateSql, [APP_ROLE, SYNC_ROLE, FUNCTION_NAMES])).rows
          .map(publicFunctionView);
        evidence.afterCommit = { counts: afterCounts, functions: functionsAfter };
        check(results, '提交后 3 个 037 函数全部存在（提交生效）',
          functionsAfter.length === FUNCTION_SPECS.length,
          { expected: FUNCTION_SPECS.length, actual: functionsAfter.length });
        check(results, '提交模式未写业务数据（安装前后行数一致）',
          structureEquals(afterCounts, evidence.before.counts),
          { before: evidence.before.counts, after: afterCounts });
        const hasRuleColumn = (await owner.query(
          `SELECT count(*)::int AS n FROM information_schema.columns
           WHERE table_schema='catalog' AND table_name='product_source_field_decision' AND column_name='rule'`
        )).rows[0].n === 1;
        check(results, '提交后 rule 列存在（rule 约束生效）', hasRuleColumn);
        app = new pg.Client({ connectionString: appUrl });
        try {
          await app.connect();
          await app.query('BEGIN');
          try {
            await app.query('SELECT set_config($1,$2,true)', ['request.jwt.claim.sub', ADMIN_PROFILE_ID]);
            const appRead = (await app.query(
              'SELECT catalog.read_product_source_manual_decisions($1) AS r', [PROFILE_KEY])).rows[0].r;
            check(results, '提交后 app runner 带管理员 JWT 可执行 read_product_source_manual_decisions',
              Boolean(appRead) && Array.isArray(appRead.fieldDecisions)
              && appRead.fieldDecisions.every((row) => Object.hasOwn(row, 'rule')),
              { fieldDecisions: appRead?.fieldDecisions?.length });
          } finally {
            await app.query('ROLLBACK');
          }
        } catch (error) {
          evidence.appConnection = { error: String(error.message).slice(0, 300) };
          check(results, '提交后 app runner 可连接目标库并执行读入口', false, evidence.appConnection);
        }
      }
    } catch (error) {
      try { await owner.query('ROLLBACK'); } catch { /* 事务可能已结束 */ }
      evidence.error = { message: error.message, code: error.code, where: error.where,
        stack: String(error.stack).slice(0, 2000) };
      throw error;
    }
  } catch (error) {
    if (!evidence.error) evidence.error = { message: error.message, code: error.code };
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    evidence.summary = { total: results.length, failed: results.filter((entry) => !entry.ok).length };
    fs.writeFileSync(path.join(EVIDENCE_DIR, commit ? 'apply-037-commit.json' : 'apply-037.json'),
      `${JSON.stringify(evidence, null, 2)}\n`);
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
    return;
  } finally {
    if (app) { try { await app.end(); } catch { /* 已关闭 */ } }
    await owner.end();
  }

  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const failed = results.filter((entry) => !entry.ok);
  evidence.summary = { total: results.length, failed: failed.length };
  const evidencePath = path.join(EVIDENCE_DIR, commit ? 'apply-037-commit.json' : 'apply-037.json');
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`\nSUMMARY mode=${mode} database=${targetDatabase} checks=${results.length} `
    + `pass=${results.length - failed.length} fail=${failed.length}`);
  console.log(`EVIDENCE ${evidencePath}`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
