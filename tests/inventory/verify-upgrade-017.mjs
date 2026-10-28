/**
 * Verify repair v2 017 upgrade: an instance upgraded from the old 016 (sha 7f12c313...) must end up
 * with the same catalog schema, functions and table privileges as a fresh (016 + functions) instance.
 *
 * Usage:
 *   FRESH_INSTANCE_DIR=.local/catalog/<fresh>/instance \
 *   UPGRADED_INSTANCE_DIR=.local/catalog/<upgraded>/instance \
 *   node tests/inventory/verify-upgrade-017.mjs
 *
 * The fresh instance dir may also be a run root containing `instance/`. Only reads schema metadata
 * and function definitions; writes an evidence JSON next to the upgraded instance root when
 * UPGRADE_EVIDENCE_PATH is set. Never touches protected instances.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import pg from 'pg';

const TEMP_SCHEMAS = ['catalog', 'catalog_private'];

function resolveInstance(dir) {
  const resolved = path.resolve(dir);
  return fs.existsSync(path.join(resolved, 'catalog-instance.json'))
    ? resolved
    : path.join(resolved, 'instance');
}

async function connect(instanceDir) {
  const instance = JSON.parse(fs.readFileSync(path.join(instanceDir, 'catalog-instance.json'), 'utf8'));
  const env = JSON.parse(fs.readFileSync(path.join(instanceDir, 'env.catalog.json'), 'utf8'));
  const client = new pg.Client({
    host: instance.host, port: instance.port, user: instance.bootstrapUser,
    password: instance.bootstrapPassword, database: instance.dbName,
  });
  await client.connect();
  return { client, instance, env };
}

const hash = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

async function schemaFingerprint(client) {
  const columns = (await client.query(`
    SELECT table_schema,table_name,ordinal_position,column_name,data_type,udt_name,is_nullable,
      coalesce(column_default,'') AS column_default
    FROM information_schema.columns
    WHERE table_schema = ANY($1)
    ORDER BY table_schema,table_name,ordinal_position`, [TEMP_SCHEMAS])).rows;
  const constraints = (await client.query(`
    SELECT n.nspname AS table_schema,c.relname AS table_name,con.contype,
      pg_get_constraintdef(con.oid) AS def,
      coalesce((SELECT string_agg(a.attname,',' ORDER BY a.attnum)
        FROM unnest(con.conkey) k JOIN pg_attribute a ON a.attrelid=con.conrelid AND a.attnum=k),'') AS cols
    FROM pg_constraint con
    JOIN pg_class c ON c.oid=con.conrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname = ANY($1)
    ORDER BY n.nspname,c.relname,con.contype,cols,def`, [TEMP_SCHEMAS])).rows;
  const indexes = (await client.query(`
    SELECT schemaname,tablename,indexname,indexdef FROM pg_indexes
    WHERE schemaname = ANY($1) ORDER BY schemaname,tablename,indexname`, [TEMP_SCHEMAS])).rows;
  const triggers = (await client.query(`
    SELECT n.nspname AS table_schema,c.relname AS table_name,t.tgname,
      pg_get_triggerdef(t.oid) AS def
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE NOT t.tgisinternal AND n.nspname = ANY($1)
    ORDER BY n.nspname,c.relname,t.tgname`, [TEMP_SCHEMAS])).rows;
  const policies = (await client.query(`
    SELECT schemaname,tablename,policyname,cmd,roles,qual,with_check FROM pg_policies
    WHERE schemaname = ANY($1) ORDER BY schemaname,tablename,policyname`, [TEMP_SCHEMAS])).rows;
  const functions = (await client.query(`
    SELECT n.nspname AS schema,p.proname,pg_get_function_identity_arguments(p.oid) AS args,
      pg_get_function_result(p.oid) AS result,md5(p.prosrc) AS body_md5,p.provolatile,
      p.prosecdef,p.proretset,p.proconfig
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname = ANY($1)
    ORDER BY n.nspname,p.proname,args`, [TEMP_SCHEMAS])).rows;
  const privileges = (await client.query(`
    SELECT table_schema,table_name,grantee,privilege_type FROM information_schema.role_table_grants
    WHERE table_schema = ANY($1) AND grantee IN
      ('ice_p0_02_app_runner','ice_p0_02_sync_runner','ice_p0_02_auth_runner')
    ORDER BY table_schema,table_name,grantee,privilege_type`, [TEMP_SCHEMAS])).rows;
  const rls = (await client.query(`
    SELECT n.nspname AS table_schema,c.relname AS table_name,c.relrowsecurity,c.relforcerowsecurity
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind='r' AND n.nspname = ANY($1)
    ORDER BY n.nspname,c.relname`, [TEMP_SCHEMAS])).rows;
  return { columns, constraints, indexes, triggers, policies, functions, privileges, rls };
}

function normalized(fingerprint) {
  return {
    columns: fingerprint.columns.map((c) => `${c.table_schema}.${c.table_name}[${c.ordinal_position}] ${c.column_name}:${c.data_type}/${c.udt_name} null=${c.is_nullable} default=${c.column_default}`),
    constraints: fingerprint.constraints.map((c) => `${c.table_schema}.${c.table_name} ${c.contype} (${c.cols}) ${c.def}`),
    indexes: fingerprint.indexes.map((i) => `${i.schemaname}.${i.tablename} ${i.indexdef}`),
    triggers: fingerprint.triggers.map((t) => `${t.table_schema}.${t.table_name} ${t.def}`),
    policies: fingerprint.policies.map((p) => `${p.schemaname}.${p.tablename} ${p.policyname} ${p.cmd} ${p.qual ?? ''} ${p.with_check ?? ''}`),
    functions: fingerprint.functions.map((f) => `${f.schema}.${f.proname}(${f.args}) -> ${f.result} secdef=${f.prosecdef} config=${f.proconfig} body=${f.body_md5}`),
    privileges: fingerprint.privileges.map((p) => `${p.table_schema}.${p.table_name} ${p.grantee} ${p.privilege_type}`),
    rls: fingerprint.rls.map((r) => `${r.table_schema}.${r.table_name} rls=${r.relrowsecurity} force=${r.relforcerowsecurity}`),
  };
}

const freshDir = resolveInstance(process.env.FRESH_INSTANCE_DIR ?? '');
const upgradedDir = resolveInstance(process.env.UPGRADED_INSTANCE_DIR ?? '');
if (!freshDir || !upgradedDir) {
  console.error('FRESH_INSTANCE_DIR and UPGRADED_INSTANCE_DIR are required');
  process.exit(2);
}
const fresh = await connect(freshDir);
const upgraded = await connect(upgradedDir);
try {
  const freshFp = normalized(await schemaFingerprint(fresh.client));
  const upFp = normalized(await schemaFingerprint(upgraded.client));
  const groups = Object.keys(freshFp);
  const results = {};
  const diffs = [];
  for (const group of groups) {
    const a = freshFp[group];
    const b = upFp[group];
    const onlyFresh = a.filter((x) => !b.includes(x));
    const onlyUpgraded = b.filter((x) => !a.includes(x));
    results[group] = {
      freshCount: a.length, upgradedCount: b.length,
      freshHash: hash(a.join('\n')), upgradedHash: hash(b.join('\n')),
      equal: onlyFresh.length === 0 && onlyUpgraded.length === 0,
      onlyFresh: onlyFresh.slice(0, 20), onlyUpgraded: onlyUpgraded.slice(0, 20),
    };
    if (!results[group].equal) diffs.push(group);
  }
  const state = (await upgraded.client.query(
    `SELECT version,source_sha256,functions_sha256,upgraded_from FROM catalog.inventory_schema_state WHERE id`)).rows[0];
  const data = (await upgraded.client.query(`
    SELECT
      (SELECT count(*) FROM catalog.inventory_sku_mapping WHERE status='confirmed')::int AS confirmed_mappings,
      (SELECT count(*) FROM catalog.inventory_sku_mapping WHERE status='disabled')::int AS disabled_mappings,
      (SELECT count(*) FROM catalog.inventory_mapping_candidate WHERE status='pending')::int AS pending_candidates,
      (SELECT count(*) FROM catalog.inventory_sku_mapping WHERE status='disabled'
        AND note LIKE '%修复v2%')::int AS downgraded_with_note,
      (SELECT count(*) FROM catalog.inventory_batch WHERE observation_at IS NULL)::int AS batches_missing_observation,
      (SELECT count(*) FROM catalog.inventory_batch_row WHERE excel_row IS NULL)::int AS rows_missing_excel_row
  `)).rows[0];
  const allEqual = diffs.length === 0;
  const result = {
    freshInstance: fresh.instance.dbName,
    upgradedInstance: upgraded.instance.dbName,
    upgradeState: state,
    upgradedData: data,
    schemaFunctionsPrivileges: results,
    equalGroups: groups.filter((g) => results[g].equal),
    diffGroups: diffs,
    allEqual,
    generatedAt: new Date().toISOString(),
  };
  const evidencePath = process.env.UPGRADE_EVIDENCE_PATH;
  if (evidencePath) {
    fs.mkdirSync(path.dirname(path.resolve(evidencePath)), { recursive: true });
    fs.writeFileSync(path.resolve(evidencePath), JSON.stringify(result, null, 2));
  }
  console.log(JSON.stringify({ allEqual, diffGroups: diffs, state, upgradedData: data,
    counts: Object.fromEntries(groups.map((g) => [g, results[g].freshCount])) }, null, 2));
  if (!allEqual) {
    console.log(JSON.stringify(results, null, 2).slice(0, 20000));
    process.exitCode = 1;
  }
} finally {
  await fresh.client.end();
  await upgraded.client.end();
}
