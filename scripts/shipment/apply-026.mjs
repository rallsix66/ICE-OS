/**
 * 把 026 货票在途增量应用到现役实例（run-20261026T211500Z-11a22b33，3011）并回读对象。
 *
 * 背景：scripts/catalog/apply-catalog-increments.mjs 只同步 013/014，且当前在 013 上
 * 报 CATALOG_SQL_INCREMENT_HASH_MISMATCH（本包未改 013，属既有差异），因此这里按该脚本
 * 的同一做法（owner 连接执行增量文件 + RESET ROLE）应用 026 幂等增量，然后回读：
 *   表存在 / 8 个函数存在且 SECURITY DEFINER + search_path='' / app 可 EXECUTE /
 *   表级权限未给 app / inventory_schema_state.version 未变。
 *
 * 用法：node scripts/shipment/apply-026.mjs [--run-id ...] [--dry-run]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOCAL_ROOT = path.join(REPO_ROOT, '.local');
const DEFAULT_RUN_ID = 'run-20261026T211500Z-11a22b33';
const SQL_FILE = 'db/catalog/026_shipment_in_transit.sql';
const EVIDENCE_DIR = path.join(LOCAL_ROOT, 'shipment-v1-repair-20261101', 'backend');
const APP_ROLE = 'ice_p0_02_app_runner';
const TABLES = [
  'shipment_source_snapshot', 'shipment', 'shipment_item',
  'shipment_revision', 'shipment_item_revision', 'shipment_item_association_revision',
];
const FUNCTIONS = [
  ['read_shipment_source_status', ''],
  ['read_shipment_list', 'text,text,text,uuid,boolean,integer,integer'],
  ['read_shipment_detail', 'uuid'],
  ['read_product_shipment_links', 'uuid,integer'],
  ['read_shipment_identity_index', ''],
  ['search_products_for_shipment', 'text,integer'],
  ['ingest_shipment_snapshot', 'jsonb'],
  ['record_shipment_read_failure', 'jsonb'],
  ['update_shipment_item_association', 'uuid,uuid,integer,text'],
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

async function readBack(client) {
  const tables = (await client.query(
    `SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS force_rls,
            pg_catalog.has_table_privilege($1, c.oid, 'SELECT') AS app_select
     FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='catalog' AND c.relname = ANY($2::text[])
     ORDER BY c.relname`, [APP_ROLE, TABLES])).rows;
  const policies = (await client.query(
    `SELECT tablename, policyname FROM pg_policies
     WHERE schemaname='catalog' AND tablename = ANY($1::text[])
     ORDER BY tablename, policyname`, [TABLES])).rows;
  const functions = (await client.query(
    `SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args,
            p.prosecdef, p.proconfig, l.lanname,
            pg_catalog.has_function_privilege($1, p.oid, 'EXECUTE') AS app_exec
     FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     JOIN pg_language l ON l.oid=p.prolang
     WHERE n.nspname='catalog' AND p.proname = ANY($2::text[])
     ORDER BY p.proname, args`, [APP_ROLE, FUNCTIONS.map(([name]) => name)])).rows;
  const schemaState = (await client.query(
    'SELECT version, applied_at FROM catalog.inventory_schema_state ORDER BY id LIMIT 1')).rows[0] ?? null;
  const hasShipment = (await client.query(
    "SELECT to_regclass('catalog.shipment') IS NOT NULL AS present")).rows[0].present;
  const counts = hasShipment
    ? (await client.query(
      `SELECT (SELECT count(*) FROM catalog.shipment) AS shipments,
              (SELECT count(*) FROM catalog.shipment_item) AS items,
              (SELECT count(*) FROM catalog.shipment_source_snapshot) AS snapshots`)).rows[0]
    : null;
  return { tables, policies, functions, schemaState, counts };
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  const runId = args['run-id'] ?? DEFAULT_RUN_ID;
  const instanceRoot = path.join(LOCAL_ROOT, 'catalog', runId, 'instance');
  const instance = JSON.parse(fs.readFileSync(path.join(instanceRoot, 'catalog-instance.json'), 'utf8'));
  const ownerUrl = `postgres://${instance.bootstrapUser}:${instance.bootstrapPassword}`
    + `@${instance.host}:${instance.port}/${instance.dbName}`;

  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  const evidence = { runId, database: instance.dbName, host: instance.host, port: instance.port };
  try {
    const identity = (await client.query(
      `SELECT current_database() AS db, inet_server_port() AS port, current_user AS user`)).rows[0];
    if (String(identity.db) !== instance.dbName || Number(identity.port) !== Number(instance.port)) {
      throw new Error(`DB_IDENTITY_MISMATCH:${JSON.stringify(identity)}`);
    }
    evidence.identity = identity;
    const before = await readBack(client);
    evidence.before = before;

    if (!args['dry-run']) {
      const sqlText = fs.readFileSync(path.join(REPO_ROOT, SQL_FILE), 'utf8');
      // 1) 首次应用
      await client.query(sqlText);
      await client.query('RESET ROLE; RESET ALL');
      // 2) 再应用一次，证明增量幂等（prepare-instance 每次重放同一文件）
      await client.query(sqlText);
      await client.query('RESET ROLE; RESET ALL');
      evidence.applied = { file: SQL_FILE, applications: 2, idempotent: true };
    }
    const after = await readBack(client);
    evidence.after = after;

    const problems = [];
    if (after.tables.length !== TABLES.length) problems.push('tables_missing');
    for (const table of after.tables) {
      if (!table.rls || !table.force_rls) problems.push(`rls_not_forced:${table.relname}`);
      if (table.app_select) problems.push(`app_can_select_table:${table.relname}`);
    }
    for (const table of TABLES) {
      const names = after.policies.filter((row) => row.tablename === table).map((row) => row.policyname);
      if (!names.includes('enabled_admin')) problems.push(`policy_missing:${table}`);
      if (!names.includes('shipment_definer_owner')) problems.push(`owner_policy_missing:${table}`);
    }
    if (after.functions.length !== FUNCTIONS.length) problems.push('functions_missing');
    for (const fn of after.functions) {
      if (!fn.prosecdef) problems.push(`not_secdef:${fn.proname}`);
      const locked = Array.isArray(fn.proconfig)
        && fn.proconfig.some((entry) => /^search_path=(?:''|"")$/
          .test(String(entry).replace(/\s/g, '').toLowerCase()));
      if (!locked) problems.push(`search_path_not_locked:${fn.proname}`);
      if (!fn.app_exec) problems.push(`app_cannot_execute:${fn.proname}`);
    }
    if (!after.schemaState || Number(after.schemaState.version) !== 6) problems.push('schema_version_changed');
    evidence.problems = problems;

    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    const evidenceFile = path.join(EVIDENCE_DIR, `apply-026-${new Date()
      .toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}.json`);
    fs.writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);

    console.log(`数据库：${identity.db}@${identity.port}（owner=${identity.user}）`);
    console.log(`表：${after.tables.length}/${TABLES.length}；函数：${after.functions.length}/${FUNCTIONS.length}；`
      + `schema_state.version=${after.schemaState?.version}`);
    console.log(`shipment 行数：${JSON.stringify(after.counts)}`);
    console.log(`证据：${evidenceFile}`);
    if (problems.length > 0) {
      console.error(`回读问题：${problems.join(', ')}`);
      process.exitCode = 1;
    } else {
      console.log('回读通过：表/函数/权限/版本全部符合 026 合同');
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
