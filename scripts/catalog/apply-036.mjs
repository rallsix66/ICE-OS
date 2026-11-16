/**
 * 把 036「飞书商品资料人工核对与持续采用流程」增量应用到一个隔离的 catalog 库，并回读
 * 结构 / 权限 / 幂等 / 回滚边界；默认只做 rollback 验证，绝不在现役库提交。
 *
 * 036 只新增/替换函数与追加表/列（不改 015 文件、不写业务数据）：
 *   - catalog.product_source_issue 增加 scope / superseded_by / superseded_at（review_state
 *     允许 superseded）；
 *   - catalog.product_source_field_decision（字段级暂不处理 / 人工口径）；
 *   - catalog.product_source_duplicate_decision（同号多行人工选择，按内容指纹）；
 *   - catalog_private.item_code_correction（受控测试货号纠正证据）；
 *   - product_source_issue_key / reconcile_product_source_issues / apply_product_source_batch_v2；
 *   - set/revoke_product_source_field_decision、decide/revoke_product_source_duplicate_decision；
 *   - 替换 assign_product_source_code（禁止 TEST- 测试码 + 关闭 item 级待确认）与
 *     read_product_source_overview（issues 增加 scope/itemId/itemRevision）；
 *   - correct_test_product_code（受控纠正历史测试货号）、read_product_source_manual_decisions。
 *
 * 行为模式（重要，默认绝不改现役库）：
 *   --rollback（默认）：事务内安装两次 → 回读结构/权限/幂等 → 整体 ROLLBACK；
 *                       证据 .local/catalog/feishu-source-review-flow-20261110/apply-036.json
 *   --commit          ：事务内安装两次 → 回读 → COMMIT（只装函数/表，不写业务数据）；
 *                       证据 .../apply-036-commit.json
 *   安全闸门：若目标库名等于 env.inventory.json 的现役库名，--commit 会被拒绝，除非显式
 *   追加 --allow-live-commit（由 Lead 手动执行）。clone 库（不同库名）可直接 --commit。
 *
 * 用法：
 *   node scripts/catalog/apply-036.mjs --rollback --run-id run-20261026T211500Z-11a22b33
 *   node scripts/catalog/apply-036.mjs --commit --database-url <clone-owner-url>   # 隔离库
 *   node scripts/catalog/apply-036.mjs --commit --allow-live-commit                # 现役库（Lead 手动）
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
const SQL_FILE = 'db/catalog/036_product_source_review_flow.sql';
const OWNER_ROLE = 'ice_p0_02_owner';
const APP_ROLE = 'ice_p0_02_app_runner';
const SYNC_ROLE = 'ice_p0_02_sync_runner';
const ADMIN_PROFILE_ID = '11111111-1111-4111-8111-111111111101';
const PROFILE_KEY = 'feishu.ice-product-library.sheet1';
const EVIDENCE_DIR = path.join(REPO_ROOT, '.local', 'catalog', 'feishu-source-review-flow-20261110');

/**
 * 期望函数签名（key = proname|argtypes）。secdef/app/sync/public = 期望值；
 * argTypes 顺序与 pg_proc.proargtypes 一致（format_type：uuid/text/jsonb/integer）。
 */
const FUNCTION_SPECS = [
  { key: 'product_source_issue_key|text,text,uuid,jsonb', secdef: false, app: false, sync: false, public: false },
  { key: 'reconcile_product_source_issues|uuid,uuid', secdef: true, app: false, sync: false, public: false },
  { key: 'apply_product_source_batch_v2|uuid,text,jsonb,jsonb,jsonb', secdef: true, app: true, sync: false, public: false },
  { key: 'set_product_source_field_decision|uuid,text,uuid,text,text,text,text', secdef: true, app: true, sync: false, public: false },
  { key: 'revoke_product_source_field_decision|uuid,text,uuid,text', secdef: true, app: true, sync: false, public: false },
  { key: 'decide_product_source_duplicate_row|uuid,text,uuid,integer,text,text,text,text', secdef: true, app: true, sync: false, public: false },
  { key: 'revoke_product_source_duplicate_decision|uuid,text,uuid,text', secdef: true, app: true, sync: false, public: false },
  { key: 'correct_test_product_code|uuid,text,uuid,text,text', secdef: true, app: true, sync: false, public: false },
  { key: 'read_product_source_manual_decisions|text', secdef: true, app: true, sync: false, public: false },
  // 完整替换（权限沿用 015 的 app 授权）
  { key: 'assign_product_source_code|uuid,text,uuid,integer,text,text,text', secdef: true, app: true, sync: false, public: false },
  { key: 'read_product_source_overview|text', secdef: true, app: true, sync: false, public: false },
];
const APP_FUNCTION_KEYS = FUNCTION_SPECS.filter((spec) => spec.app).map((spec) => spec.key);
const NEW_TABLES = [
  { schema: 'catalog', table: 'product_source_field_decision' },
  { schema: 'catalog', table: 'product_source_duplicate_decision' },
  { schema: 'catalog_private', table: 'item_code_correction' },
];
const EXPECTED_REQUEST_ACTIONS = [
  'apply_product_source_batch', 'resolve_source_issue', 'assign_source_code',
  'defer_source_field', 'override_source_field', 'restore_source_field',
  'decide_duplicate_source_row', 'restore_duplicate_source_decision', 'correct_test_source_code',
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
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail === undefined ? '' : ` :: ${JSON.stringify(detail).slice(0, 700)}`}`);
}

function sha256Text(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** 把连接串的数据库名替换为 clone 库名（同实例同角色，只换库）。 */
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

const functionStateSql = `SELECT n.nspname AS schema_name, p.proname,
  ARRAY(SELECT format_type(t, NULL) FROM unnest(p.proargtypes) AS t) AS arg_types,
  pg_get_function_identity_arguments(p.oid) AS identity_args,
  pg_get_function_result(p.oid) AS result_type,
  p.prosecdef, p.proconfig, p.provolatile,
  pg_get_userbyid(p.proowner) AS owner_name,
  pg_catalog.has_function_privilege($1, p.oid, 'EXECUTE') AS app_exec,
  pg_catalog.has_function_privilege($2, p.oid, 'EXECUTE') AS sync_exec,
  pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'catalog' AND p.proname = ANY($3)
 ORDER BY p.proname, identity_args`;

const businessCountsSql = `SELECT
  (SELECT count(*) FROM catalog.product_source_issue)::int AS issues,
  (SELECT count(*) FROM catalog.product_source_issue WHERE review_state = 'open')::int AS open_issues,
  (SELECT count(*) FROM catalog.product_source_batch)::int AS batches,
  (SELECT count(*) FROM catalog.product_source_result)::int AS results,
  (SELECT count(*) FROM catalog.product_source_row)::int AS rows,
  (SELECT count(*) FROM catalog.catalog_item)::int AS items,
  (SELECT count(*) FROM catalog.item_revision)::int AS revisions,
  (SELECT count(*) FROM catalog.catalog_item_code)::int AS codes,
  (SELECT count(*) FROM catalog.shipment_item_association_revision)::int AS association_revisions`;

const columnSql = `SELECT c.relname AS table_name, n.nspname AS schema_name, a.attname AS column_name,
  format_type(a.atttypid, a.atttypmod) AS data_type, a.attnotnull,
  pg_get_expr(d.adbin, d.adrelid) AS default_expr, a.attnum
 FROM pg_attribute a
 JOIN pg_class c ON c.oid = a.attrelid
 JOIN pg_namespace n ON n.oid = c.relnamespace
 LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
 WHERE a.attnum > 0 AND NOT a.attisdropped
   AND ((n.nspname = 'catalog' AND c.relname IN ('product_source_issue',
          'product_source_field_decision', 'product_source_duplicate_decision'))
     OR (n.nspname = 'catalog_private' AND c.relname = 'item_code_correction'))
 ORDER BY n.nspname, c.relname, a.attnum`;

const constraintSql = `SELECT n.nspname AS schema_name, c.relname AS table_name, k.conname, k.contype,
  pg_get_constraintdef(k.oid) AS definition
 FROM pg_constraint k
 JOIN pg_class c ON c.oid = k.conrelid
 JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE (n.nspname = 'catalog' AND c.relname IN ('product_source_issue',
         'product_source_field_decision', 'product_source_duplicate_decision', 'product_source_request'))
    OR (n.nspname = 'catalog_private' AND c.relname = 'item_code_correction')
 ORDER BY n.nspname, c.relname, k.conname`;

const indexSql = `SELECT schemaname, tablename, indexname, indexdef
 FROM pg_indexes
 WHERE (schemaname = 'catalog' AND tablename IN
         ('product_source_issue', 'product_source_field_decision', 'product_source_duplicate_decision'))
    OR (schemaname = 'catalog_private' AND tablename = 'item_code_correction')
 ORDER BY schemaname, tablename, indexname`;

const policySql = `SELECT schemaname, tablename, policyname, cmd, qual, with_check
 FROM pg_policies
 WHERE (schemaname = 'catalog' AND tablename IN ('product_source_field_decision', 'product_source_duplicate_decision'))
    OR (schemaname = 'catalog_private' AND tablename = 'item_code_correction')
 ORDER BY schemaname, tablename, policyname`;

const triggerSql = `SELECT n.nspname AS schema_name, c.relname AS table_name, t.tgname,
  pg_get_triggerdef(t.oid) AS definition
 FROM pg_trigger t
 JOIN pg_class c ON c.oid = t.tgrelid
 JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE NOT t.tgisinternal
   AND ((n.nspname = 'catalog' AND c.relname IN ('product_source_field_decision', 'product_source_duplicate_decision'))
     OR (n.nspname = 'catalog_private' AND c.relname = 'item_code_correction'))
 ORDER BY 1, 2, 3`;

const tablePrivilegeSql = `SELECT n.nspname AS schema_name, c.relname AS table_name,
  pg_catalog.has_table_privilege($1, c.oid, 'SELECT') AS app_select,
  pg_catalog.has_table_privilege($1, c.oid, 'INSERT') AS app_insert,
  pg_catalog.has_table_privilege($1, c.oid, 'UPDATE') AS app_update,
  pg_catalog.has_table_privilege($1, c.oid, 'DELETE') AS app_delete,
  pg_catalog.has_table_privilege('public', c.oid, 'SELECT') AS public_select
 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind = 'r'
   AND ((n.nspname = 'catalog' AND c.relname IN ('product_source_field_decision', 'product_source_duplicate_decision'))
     OR (n.nspname = 'catalog_private' AND c.relname = 'item_code_correction'))
 ORDER BY n.nspname, c.relname`;

function keyOf(row) {
  return `${row.proname}|${row.arg_types.join(',')}`;
}

function publicFunctionView(row) {
  return {
    signature: `${row.proname}(${row.identity_args})`,
    prosecdef: row.prosecdef,
    proconfig: row.proconfig,
    provolatile: row.provolatile,
    owner: row.owner_name,
    app_exec: row.app_exec,
    sync_exec: row.sync_exec,
    public_exec: row.public_exec,
  };
}

async function collectMetadata(client) {
  // 同一连接上必须顺序查询：pg 的简单查询协议不支持并行（Promise.all 会串结果）。
  const functions = await client.query(functionStateSql,
    [APP_ROLE, SYNC_ROLE, FUNCTION_SPECS.map((spec) => spec.key.split('|')[0])]);
  const columns = await client.query(columnSql);
  const constraints = await client.query(constraintSql);
  const indexes = await client.query(indexSql);
  const policies = await client.query(policySql);
  const triggers = await client.query(triggerSql);
  const privileges = await client.query(tablePrivilegeSql, [APP_ROLE]);
  return {
    functions: functions.rows,
    columns: columns.rows.map((row) => ({
      schema: row.schema_name, table: row.table_name, column: row.column_name,
      type: row.data_type, notnull: row.attnotnull, default_expr: row.default_expr,
    })),
    constraints: constraints.rows.map((row) => ({
      schema: row.schema_name, table: row.table_name, name: row.conname, type: row.contype,
      definition: row.definition,
    })),
    indexes: indexes.rows.map((row) => ({
      schema: row.schemaname, table: row.tablename, name: row.indexname, definition: row.indexdef,
    })),
    policies: policies.rows.map((row) => ({
      schema: row.schemaname, table: row.tablename, name: row.policyname,
      cmd: row.cmd, qual: row.qual, with_check: row.with_check,
    })),
    triggers: triggers.rows.map((row) => ({
      schema: row.schema_name, table: row.table_name, name: row.tgname, definition: row.definition,
    })),
    tablePrivileges: privileges.rows.map((row) => ({
      schema: row.schema_name, table: row.table_name,
      app_select: row.app_select, app_insert: row.app_insert,
      app_update: row.app_update, app_delete: row.app_delete,
      public_select: row.public_select,
    })),
  };
}

const tableExistsSql = `SELECT n.nspname AS schema_name, c.relname AS table_name,
  c.relrowsecurity, c.relforcerowsecurity
 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind = 'r'
   AND ((n.nspname = 'catalog' AND c.relname IN ('product_source_issue',
          'product_source_field_decision', 'product_source_duplicate_decision'))
     OR (n.nspname = 'catalog_private' AND c.relname = 'item_code_correction'))
 ORDER BY n.nspname, c.relname`;

async function readTableState(client) {
  const result = await client.query(tableExistsSql);
  return result.rows.reduce((acc, row) => {
    acc[`${row.schema_name}.${row.table_name}`] = {
      rls: row.relrowsecurity, force_rls: row.relforcerowsecurity,
    };
    return acc;
  }, {});
}

async function readColumnState(client) {
  const result = await client.query(columnSql);
  return result.rows.reduce((acc, row) => {
    acc[`${row.schema_name}.${row.table_name}.${row.column_name}`] = {
      type: row.data_type, notnull: row.attnotnull, default_expr: row.default_expr,
    };
    return acc;
  }, {});
}

function structureEquals(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

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
  const syncUrl = isLive ? env.syncDbUrl : withDatabase(env.syncDbUrl, targetDatabase);
  const sqlText = fs.readFileSync(path.join(REPO_ROOT, SQL_FILE), 'utf8');
  const sqlSha256 = sha256Text(sqlText);

  const owner = new pg.Client({ connectionString: ownerUrl });
  await owner.connect();
  const results = [];
  const evidence = {
    runId, mode, targetDatabase, isLive, sqlFile: SQL_FILE, sqlSha256,
    at: new Date().toISOString(),
    applicationCount: 2,
    checks: results,
  };

  let app = null;
  try {
    evidence.identity = (await owner.query(
      'SELECT current_database() AS db, current_user AS user, version() AS version')).rows[0];
    evidence.before = {
      counts: (await owner.query(businessCountsSql)).rows[0],
      tables: await readTableState(owner),
      columns: await readColumnState(owner),
    };
    const beforeFunctions = (await owner.query(functionStateSql,
      [APP_ROLE, SYNC_ROLE, FUNCTION_SPECS.map((spec) => spec.key.split('|')[0])])).rows
      .filter((row) => FUNCTION_SPECS.some((spec) => spec.key === keyOf(row)));
    evidence.before.functions = beforeFunctions.map(publicFunctionView);

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
      evidence.install = { applications: 2, first: afterFirst, second: afterSecond };
      evidence.countsAfterFirst = countsAfterFirst;
      evidence.countsAfterSecond = countsAfterSecond;

      check(results, '036 安装两次均成功（幂等，无报错）', true, { applications: 2 });
      check(results, '两次安装后函数定义/权限完全一致（幂等）',
        structureEquals(afterFirst.functions, afterSecond.functions));
      check(results, '两次安装后表/列/约束/索引/策略/触发器一致（幂等）',
        structureEquals({
          columns: afterFirst.columns, constraints: afterFirst.constraints,
          indexes: afterFirst.indexes, policies: afterFirst.policies,
          triggers: afterFirst.triggers, tablePrivileges: afterFirst.tablePrivileges,
        }, {
          columns: afterSecond.columns, constraints: afterSecond.constraints,
          indexes: afterSecond.indexes, policies: afterSecond.policies,
          triggers: afterSecond.triggers, tablePrivileges: afterSecond.tablePrivileges,
        }));
      check(results, '两次安装之间业务行数未变（安装不写业务数据）',
        structureEquals(countsAfterFirst, countsAfterSecond), { countsAfterFirst, countsAfterSecond });

      // ---- 2. 结构回读：函数 ----------------------------------------------
      const rowsByKey = new Map(afterSecond.functions.map((row) => [keyOf(row), row]));
      evidence.functions = afterSecond.functions.map(publicFunctionView);
      let installed = 0;
      for (const spec of FUNCTION_SPECS) {
        const found = rowsByKey.get(spec.key);
        if (found) installed += 1;
        const row = found ? {
          prosecdef: found.prosecdef, proconfig: found.proconfig, owner: found.owner_name,
          app: found.app_exec, sync: found.sync_exec, public: found.public_exec,
        } : null;
        check(results, `函数 ${spec.key.replace('|', '(')}) 存在`, Boolean(found), row);
        check(results, `函数 ${spec.key.split('|')[0]} SECURITY DEFINER=${spec.secdef} 且 search_path 锁定`,
          Boolean(found) && found.prosecdef === spec.secdef && searchPathLocked(found.proconfig), row);
        check(results, `函数 ${spec.key.split('|')[0]} 属主为 ${OWNER_ROLE}`,
          Boolean(found) && found.owner_name === OWNER_ROLE, row ? { owner: row.owner_name } : null);
        check(results, `函数 ${spec.key.split('|')[0]} 权限 app=${spec.app} / sync=${spec.sync} / PUBLIC=${spec.public}`,
          Boolean(found) && found.app_exec === spec.app && found.sync_exec === spec.sync
          && found.public_exec === spec.public, row);
      }
      check(results, '036 相关的 11 个函数全部存在', installed === FUNCTION_SPECS.length,
        { expected: FUNCTION_SPECS.length, actual: installed });

      // ---- 3. 结构回读：表 / 列 / 约束 / 索引 / RLS -----------------------
      const tables = await readTableState(owner);
      evidence.tables = tables;
      for (const table of NEW_TABLES) {
        const name = `${table.schema}.${table.table}`;
        check(results, `表 ${name} 存在且启用 FORCE RLS`,
          Boolean(tables[name]) && tables[name].rls === true && tables[name].force_rls === true,
          tables[name] ?? null);
      }
      check(results, '原事项表 catalog.product_source_issue 仍存在',
        Boolean(tables['catalog.product_source_issue']), tables['catalog.product_source_issue'] ?? null);

      const columns = await readColumnState(owner);
      evidence.columns = columns;
      const scopeColumn = columns['catalog.product_source_issue.scope'];
      check(results, 'issue.scope 为 text NOT NULL DEFAULT \'batch\'',
        Boolean(scopeColumn) && scopeColumn.type === 'text' && scopeColumn.notnull === true
        && /^'batch'::text$/.test(String(scopeColumn.default_expr)), scopeColumn ?? null);
      check(results, 'issue.superseded_by 为可空 uuid / issue.superseded_at 为可空 timestamptz',
        columns['catalog.product_source_issue.superseded_by']?.type === 'uuid'
        && columns['catalog.product_source_issue.superseded_by']?.notnull === false
        && columns['catalog.product_source_issue.superseded_at']?.type === 'timestamp with time zone'
        && columns['catalog.product_source_issue.superseded_at']?.notnull === false,
        {
          superseded_by: columns['catalog.product_source_issue.superseded_by'] ?? null,
          superseded_at: columns['catalog.product_source_issue.superseded_at'] ?? null,
        });

      const requiredColumns = {
        'catalog.product_source_field_decision': [
          'id', 'profile_id', 'item_id', 'ice_code', 'field_key', 'action', 'value_raw', 'reason', 'note',
          'state', 'source_issue_id', 'request_id', 'decided_by', 'decided_at', 'revoked_at', 'revoked_by',
          'revoked_note', 'superseded_at',
        ],
        'catalog.product_source_duplicate_decision': [
          'id', 'profile_id', 'ice_code', 'item_id', 'chosen_row_number', 'chosen_row_sha256', 'basis_sha256',
          'evidence_row_sha256', 'chosen_fields', 'comparison', 'state', 'source_issue_id', 'request_id',
          'decided_by', 'decided_at', 'note', 'superseded_at',
        ],
        'catalog_private.item_code_correction': [
          'request_id', 'item_id', 'old_code', 'reason', 'note', 'actor_id', 'recorded_at',
        ],
      };
      for (const [tableName, needed] of Object.entries(requiredColumns)) {
        const missing = needed.filter((column) => !columns[`${tableName}.${column}`]);
        check(results, `表 ${tableName} 具备 036 约定的全部列`, missing.length === 0, { missing });
      }

      const constraints = afterSecond.constraints;
      const constraintDef = (table, name) => constraints.find(
        (row) => row.table === table && row.name === name)?.definition ?? '';
      const scopeCheck = constraintDef('product_source_issue', 'product_source_issue_scope_check');
      check(results, 'issue scope CHECK 只允许 batch/item', /'batch'/.test(scopeCheck) && /'item'/.test(scopeCheck),
        scopeCheck);
      const reviewCheck = constraintDef('product_source_issue', 'product_source_issue_review_state_check');
      check(results, 'issue review_state CHECK 允许 superseded', /'superseded'/.test(reviewCheck), reviewCheck);
      const requestCheck = constraintDef('product_source_request', 'product_source_request_action_check');
      const missingActions = EXPECTED_REQUEST_ACTIONS.filter((action) => !requestCheck.includes(`'${action}'`));
      check(results, '请求动作白名单包含 036 的 6 个新动作（defer/override/restore/decide/restore-dup/correct）',
        missingActions.length === 0, { missingActions });
      const fieldActionCheck = constraintDef('product_source_field_decision', 'product_source_field_decision_action_check');
      check(results, '字段决定 action CHECK 允许 defer/override',
        /'defer'/.test(fieldActionCheck) && /'override'/.test(fieldActionCheck), fieldActionCheck);
      const fieldStateCheck = constraintDef('product_source_field_decision', 'product_source_field_decision_state_check');
      check(results, '字段决定 state CHECK 允许 active/revoked/superseded',
        ['active', 'revoked', 'superseded'].every((state) => fieldStateCheck.includes(`'${state}'`)), fieldStateCheck);
      const dupStateCheck = constraintDef('product_source_duplicate_decision', 'product_source_duplicate_decision_state_check');
      check(results, '同号决定 state CHECK 允许 active/superseded',
        /'active'/.test(dupStateCheck) && /'superseded'/.test(dupStateCheck), dupStateCheck);
      const correctionPk = constraints.find(
        (row) => row.table === 'item_code_correction' && row.type === 'p');
      check(results, 'catalog_private.item_code_correction 以 request_id 为主键',
        Boolean(correctionPk) && /request_id/.test(correctionPk.definition), correctionPk?.definition ?? null);

      const indexes = afterSecond.indexes;
      const indexOf = (table, name) => indexes.find((row) => row.table === table && row.name === name);
      const fieldActive = indexOf('product_source_field_decision', 'product_source_field_decision_active');
      check(results, '字段决定唯一活动索引（profile+item+field, WHERE state=active）',
        Boolean(fieldActive) && /UNIQUE/.test(fieldActive.definition)
        && /state = 'active'/.test(fieldActive.definition), fieldActive?.definition ?? null);
      const dupActive = indexOf('product_source_duplicate_decision', 'product_source_duplicate_decision_active');
      check(results, '同号决定唯一活动索引（profile+code, WHERE state=active）',
        Boolean(dupActive) && /UNIQUE/.test(dupActive.definition)
        && /state = 'active'/.test(dupActive.definition), dupActive?.definition ?? null);
      const scopeOpen = indexOf('product_source_issue', 'product_source_issue_scope_open');
      check(results, 'issue scope open 索引（WHERE review_state=open）',
        Boolean(scopeOpen) && /review_state = 'open'/.test(scopeOpen.definition), scopeOpen?.definition ?? null);

      const policies = afterSecond.policies;
      for (const table of ['product_source_field_decision', 'product_source_duplicate_decision']) {
        const policy = policies.find((row) => row.table === table && row.name === 'enabled_admin');
        check(results, `新表 ${table} 的 enabled_admin 策略使用 catalog.is_admin()`,
          Boolean(policy) && /is_admin/.test(String(policy.qual)) && /is_admin/.test(String(policy.with_check)),
          policy ?? null);
      }
      const correctionPolicy = policies.find(
        (row) => row.schema === 'catalog_private' && row.table === 'item_code_correction'
          && row.name === 'enabled_admin');
      check(results, 'catalog_private.item_code_correction 的 enabled_admin 策略存在',
        Boolean(correctionPolicy), correctionPolicy ?? null);
      const correctionTrigger = afterSecond.triggers.find(
        (row) => row.table === 'item_code_correction' && row.name === 'immutable_history');
      check(results, '纠正证据表 immutable_history 触发器（不可改）',
        Boolean(correctionTrigger), correctionTrigger ?? null);

      const privileges = afterSecond.tablePrivileges;
      for (const table of ['product_source_field_decision', 'product_source_duplicate_decision']) {
        const privilege = privileges.find((row) => row.table === table);
        check(results, `新表 ${table} 只授予 app SELECT（plan 加载读活动决定），无写权限且不授予 PUBLIC`,
          Boolean(privilege) && privilege.app_select === true && privilege.app_insert === false
          && privilege.app_update === false && privilege.app_delete === false
          && privilege.public_select === false, privilege ?? null);
      }
      const correctionPrivilege = privileges.find((row) => row.table === 'item_code_correction');
      check(results, 'catalog_private.item_code_correction 未直接授予 app/PUBLIC',
        Boolean(correctionPrivilege) && correctionPrivilege.app_select === false
        && correctionPrivilege.app_insert === false && correctionPrivilege.public_select === false,
        correctionPrivilege ?? null);

      // ---- 4. 权限负向：无管理员 JWT --------------------------------------
      await owner.query('SAVEPOINT no_jwt_read');
      let anonRead = null;
      try {
        await owner.query("SELECT set_config('request.jwt.claim.sub','',true)");
        try {
          await owner.query('SELECT catalog.read_product_source_manual_decisions($1)', [PROFILE_KEY]);
        } catch (error) {
          anonRead = { code: error.code, message: String(error.message).slice(0, 200) };
        }
      } finally {
        await owner.query('ROLLBACK TO SAVEPOINT no_jwt_read');
      }
      await owner.query('SAVEPOINT no_jwt_write');
      let anonWrite = null;
      try {
        await owner.query("SELECT set_config('request.jwt.claim.sub','',true)");
        try {
          await owner.query(`SELECT catalog.set_product_source_field_decision(
            gen_random_uuid(), $1, gen_random_uuid(), 'defer', NULL, '无 JWT 探针', NULL)`,
          ['0'.repeat(64)]);
        } catch (error) {
          anonWrite = { code: error.code, message: String(error.message).slice(0, 200) };
        }
      } finally {
        await owner.query('ROLLBACK TO SAVEPOINT no_jwt_write');
      }
      evidence.anonymousProbe = { anonRead, anonWrite };
      check(results, '无管理员 JWT 时新读入口被拒（CATALOG_FORBIDDEN / 42501）',
        anonRead?.code === '42501' && /CATALOG_FORBIDDEN/.test(anonRead.message), anonRead);
      check(results, '无管理员 JWT 时新写入口被拒（CATALOG_FORBIDDEN / 42501）',
        anonWrite?.code === '42501' && /CATALOG_FORBIDDEN/.test(anonWrite.message), anonWrite);

      // ---- 5. 现有事项 scope 回填口径 -------------------------------------
      const scopeStats = (await owner.query(
        `SELECT coalesce(scope,'<null>') AS scope, count(*)::int AS n
         FROM catalog.product_source_issue GROUP BY 1 ORDER BY 1`)).rows;
      evidence.issueScopes = scopeStats;
      check(results, '既有事项 scope 全部为 batch（追加列的默认值，无需回填）',
        scopeStats.every((row) => row.scope === 'batch'),
        scopeStats);

      const newTableCounts = (await owner.query(`SELECT
        (SELECT count(*) FROM catalog.product_source_field_decision)::int AS field_decisions,
        (SELECT count(*) FROM catalog.product_source_duplicate_decision)::int AS duplicate_decisions,
        (SELECT count(*) FROM catalog_private.item_code_correction)::int AS corrections`)).rows[0];
      evidence.newTableCounts = newTableCounts;
      check(results, '安装未写入任何人工决定/纠正业务数据（新表 0 行）',
        newTableCounts.field_decisions === 0 && newTableCounts.duplicate_decisions === 0
        && newTableCounts.corrections === 0, newTableCounts);

      // ---- 6. 收尾：ROLLBACK 或 COMMIT ------------------------------------
      if (rollback) {
        await owner.query('ROLLBACK');
        const afterCounts = (await owner.query(businessCountsSql)).rows[0];
        const functionCountAfter = (await owner.query(functionStateSql,
          [APP_ROLE, SYNC_ROLE, FUNCTION_SPECS.map((spec) => spec.key.split('|')[0])])).rows
          .filter((row) => FUNCTION_SPECS.some((spec) => spec.key === keyOf(row)));
        const tablesAfter = await readTableState(owner);
        const columnsAfter = await readColumnState(owner);
        evidence.afterRollback = {
          counts: afterCounts,
          functionSignatures: functionCountAfter.map((row) => keyOf(row)).sort(),
          tables: tablesAfter,
        };
        check(results, 'rollback 后业务行数未变（issue/batch/result/row/item/revision/code/关联）',
          structureEquals(afterCounts, evidence.before.counts), { before: evidence.before.counts, after: afterCounts });
        check(results, 'rollback 后函数集合回到安装前状态',
          structureEquals(
            functionCountAfter.map((row) => publicFunctionView(row)).sort(
              (left, right) => left.signature.localeCompare(right.signature)),
            evidence.before.functions.slice().sort(
              (left, right) => left.signature.localeCompare(right.signature)),
          ), {
            before: evidence.before.functions.map((row) => row.signature),
            after: functionCountAfter.map((row) => publicFunctionView(row).signature),
          });
        check(results, 'rollback 后新表不存在（未留下半安装状态）',
          NEW_TABLES.every((table) => !tablesAfter[`${table.schema}.${table.table}`]),
          tablesAfter);
        check(results, 'rollback 后 issue 表结构回到安装前（无 scope 列）',
          structureEquals(columnsAfter, evidence.before.columns),
          { before: Object.keys(evidence.before.columns).length, after: Object.keys(columnsAfter).length });
        const goneProbe = await (async () => {
          try {
            await owner.query('SELECT catalog.read_product_source_manual_decisions($1)', [PROFILE_KEY]);
            return { ok: true };
          } catch (error) {
            return { ok: false, code: error.code, message: String(error.message).slice(0, 120) };
          }
        })();
        evidence.goneProbeAfterRollback = goneProbe;
        const wasAbsentBefore = !evidence.before.functions.some(
          (row) => row.signature.startsWith('read_product_source_manual_decisions('));
        if (wasAbsentBefore) {
          check(results, 'rollback 后新入口不可调用（42883，未留下半安装状态）',
            goneProbe.ok === false && goneProbe.code === '42883', goneProbe);
        }
      } else {
        await owner.query('COMMIT');
        const afterCounts = (await owner.query(businessCountsSql)).rows[0];
        const functionsAfterCommit = (await owner.query(functionStateSql,
          [APP_ROLE, SYNC_ROLE, FUNCTION_SPECS.map((spec) => spec.key.split('|')[0])])).rows
          .filter((row) => FUNCTION_SPECS.some((spec) => spec.key === keyOf(row)));
        const tablesAfter = await readTableState(owner);
        evidence.afterCommit = {
          counts: afterCounts,
          functionSignatures: functionsAfterCommit.map((row) => keyOf(row)).sort(),
          tables: tablesAfter,
        };
        check(results, '提交后 11 个 036 函数全部存在（提交生效）',
          functionsAfterCommit.length === FUNCTION_SPECS.length,
          { expected: FUNCTION_SPECS.length, actual: functionsAfterCommit.length });
        check(results, '提交后三张新表存在', NEW_TABLES.every(
          (table) => Boolean(tablesAfter[`${table.schema}.${table.table}`])), tablesAfter);
        check(results, '提交模式未写业务数据（issue/batch/result/row/item/revision/code/关联行数未变）',
          structureEquals(afterCounts, evidence.before.counts),
          { before: evidence.before.counts, after: afterCounts });

        // 提交后由 app runner 真实调用（证明跨连接可见 + app 授权 + 管理员 JWT 口径）。
        app = new pg.Client({ connectionString: appUrl });
        try {
          await app.connect();
          evidence.appConnection = 'ok';
          await app.query('BEGIN');
          try {
            await app.query('SELECT set_config($1,$2,true)', ['request.jwt.claim.sub', ADMIN_PROFILE_ID]);
            const appRead = (await app.query(
              'SELECT catalog.read_product_source_manual_decisions($1) AS r', [PROFILE_KEY])).rows[0].r;
            check(results, '提交后 app runner 带管理员 JWT 可执行新读入口',
              Boolean(appRead) && Array.isArray(appRead.fieldDecisions)
              && Array.isArray(appRead.duplicateDecisions),
              { fieldDecisions: appRead?.fieldDecisions?.length ?? null,
                duplicateDecisions: appRead?.duplicateDecisions?.length ?? null });
          } finally {
            await app.query('ROLLBACK');
          }
          await app.query('BEGIN');
          try {
            await app.query("SELECT set_config('request.jwt.claim.sub','',true)");
            let appAnon = null;
            try {
              await app.query('SELECT catalog.read_product_source_manual_decisions($1)', [PROFILE_KEY]);
            } catch (error) {
              appAnon = { code: error.code, message: String(error.message).slice(0, 160) };
            }
            evidence.appAnonymousProbe = appAnon;
            check(results, '提交后 app runner 无 JWT 调用新读入口被拒（42501）',
              appAnon?.code === '42501', appAnon);
          } finally {
            await app.query('ROLLBACK');
          }
        } catch (error) {
          evidence.appConnection = { error: String(error.message).slice(0, 300) };
          check(results, '提交后 app runner 可连接目标库并执行新读入口', false, evidence.appConnection);
        }
      }
    } catch (error) {
      try { await owner.query('ROLLBACK'); } catch { /* 事务可能已结束 */ }
      evidence.error = { message: error.message, code: error.code, stack: String(error.stack).slice(0, 2000) };
      throw error;
    }
  } catch (error) {
    if (!evidence.error) evidence.error = { message: error.message, code: error.code };
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    evidence.summary = { total: results.length, failed: results.filter((entry) => !entry.ok).length };
    fs.writeFileSync(path.join(EVIDENCE_DIR, commit ? 'apply-036-commit.json' : 'apply-036.json'),
      `${JSON.stringify(evidence, null, 2)}\n`);
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
    return;
  } finally {
    if (app) { try { await app.end(); } catch { /* already closed */ } }
    await owner.end();
  }

  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const failed = results.filter((entry) => !entry.ok);
  evidence.summary = { total: results.length, failed: failed.length };
  const evidencePath = path.join(EVIDENCE_DIR, commit ? 'apply-036-commit.json' : 'apply-036.json');
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
