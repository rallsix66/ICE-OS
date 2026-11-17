/**
 * CI database check: install the current P0-02 + catalog surface into an empty
 * PostgreSQL 17 database, then verify the real app role can read, save through
 * an existing business RPC, read the operation records, and is denied writes.
 *
 * This is intentionally a temporary-database entry point. It does not use
 * .local, initdb.exe, pg_dump.exe, instance markers, or live business data.
 * The target must be empty; set CI=true (GitHub Actions) or
 * CI_DATABASE_RESET=1 explicitly for a locally created scratch database.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

const ADMIN_ID = '11111111-1111-4111-8111-111111111101';
const OPERATOR_ID = '22222222-2222-4222-8222-222222222202';
const REQUEST_ID = '33333333-3333-4333-8333-333333333303';
const ITEM_ID = '44444444-4444-4444-8444-444444444404';
const RELEASE_ID = '55555555-5555-4555-8555-555555555505';

const BASE_SQL = [
  'db/p0-02/001_instance_and_roles.sql',
  'db/p0-02/002_session_identity.sql',
  'db/p0-02/003_extensions.sql',
  'db/p0-02/010_public_schema.sql',
  'db/p0-02/007_reference_data.sql',
  'db/p0-02/006_least_privilege_grants.sql',
];

const CATALOG_SQL = [
  'db/catalog/001_catalog.sql',
  'db/catalog/002_catalog_security.sql',
  'db/catalog/003_source_identity.sql',
  'db/catalog/004_source_identity_security.sql',
  'db/catalog/007_new_item_intake.sql',
  'db/catalog/008_new_item_intake_security.sql',
  'db/catalog/009_local_display.sql',
  'db/catalog/010_local_display_security.sql',
  'db/catalog/011_local_display_read_rpc.sql',
  'db/catalog/012_local_display_table_rls.sql',
  'db/catalog/013_baseline_amounts_batch.sql',
  'db/catalog/015_product_source_sync.sql',
  'db/catalog/036_product_source_review_flow.sql',
  'db/catalog/037_product_source_interpretation.sql',
  'db/catalog/016_inventory_sync.sql',
  'db/catalog/018_inventory_sync_repair_v3.sql',
  'db/catalog/019_inventory_sync_repair_v4.sql',
  'db/catalog/020_inventory_sync_repair_v4_final.sql',
  'db/catalog/021_inventory_live_intake.sql',
  'db/catalog/016_inventory_sync_functions.sql',
  'db/catalog/022_inventory_dual_view.sql',
  'db/catalog/023_inventory_domestic.sql',
  'db/catalog/024_binding_inline_edit.sql',
  'db/catalog/025_domestic_review.sql',
  'db/catalog/026_shipment_in_transit.sql',
  'db/catalog/027_shipment_auto_reader.sql',
  'db/catalog/028_shipment_market_summary.sql',
  'db/catalog/029_shipment_in_transit_correction.sql',
  'db/catalog/030_shipment_in_transit_status_conflict.sql',
  'db/catalog/031_product_shipment_transit.sql',
  'db/catalog/032_product_transit_item_rows.sql',
  'db/catalog/033_shipment_grouping_review.sql',
  'db/catalog/034_shipment_grouping_carryover.sql',
  'db/catalog/035_shipment_grouping_raw.sql',
  'db/catalog/038_shipment_association_history.sql',
  'db/catalog/039_shipment_association_rule_preview.sql',
  'db/catalog/040_shipment_association_rule_impact.sql',
  'db/catalog/041_inventory_snapshot_reads.sql',
  'db/catalog/042_operation_records.sql',
];

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`CI_DATABASE_ENV_MISSING:${name}`);
  return value;
}

function connectionString() {
  return process.env.CI_DATABASE_URL || `postgres://${encodeURIComponent(requireEnv('PGUSER'))}:${encodeURIComponent(requireEnv('PGPASSWORD'))}@${requireEnv('PGHOST')}:${requireEnv('PGPORT')}/${requireEnv('PGDATABASE')}`;
}

async function applyFile(client, relative) {
  const file = path.join(REPO_ROOT, relative);
  if (!fs.existsSync(file)) throw new Error(`CI_DATABASE_SQL_MISSING:${relative}`);
  const sql = fs.readFileSync(file, 'utf8');
  try {
    await client.query(sql);
    await client.query('RESET ROLE; RESET ALL');
  } catch (error) {
    error.message = `${relative}: ${error.message}`;
    throw error;
  }
  return { relative, sha256: crypto.createHash('sha256').update(sql).digest('hex') };
}

async function setIdentity(client, profileId) {
  await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [profileId]);
}

async function expectSqlError(client, sql, params, allowedCodes, label) {
  await client.query('SAVEPOINT ci_expect');
  try {
    await client.query(sql, params);
    throw new Error(`CI_DATABASE_EXPECTED_ERROR:${label}`);
  } catch (error) {
    if (error.message.startsWith('CI_DATABASE_EXPECTED_ERROR')) throw error;
    if (!allowedCodes.includes(error.code)) {
      error.message = `${label}: expected ${allowedCodes.join('/')}, got ${error.code}: ${error.message}`;
      throw error;
    }
    await client.query('ROLLBACK TO SAVEPOINT ci_expect');
    return { code: error.code, message: error.message };
  }
}

async function main() {
  const isCi = process.env.CI === 'true';
  if (!isCi && process.env.CI_DATABASE_RESET !== '1') {
    throw new Error('CI_DATABASE_RESET_NOT_AUTHORIZED: set CI=true or CI_DATABASE_RESET=1 for an empty scratch database');
  }

  const admin = new pg.Client({ connectionString: connectionString() });
  await admin.connect();
  const applied = [];
  try {
    const identity = (await admin.query('SELECT current_database() AS db, current_user AS usr, rolsuper FROM pg_roles WHERE rolname=current_user')).rows[0];
    if (!identity?.rolsuper) throw new Error(`CI_DATABASE_ADMIN_NOT_SUPERUSER:${identity?.usr ?? 'unknown'}`);

    const occupied = (await admin.query(`SELECT
      to_regclass('catalog.catalog_item') IS NOT NULL AS catalog,
      to_regclass('p0_02_meta.platform_instance') IS NOT NULL AS meta,
      EXISTS(SELECT 1 FROM pg_namespace WHERE nspname IN ('catalog','catalog_private','p0_02_meta','p0_02_auth')) AS any_schema`)).rows[0];
    if (occupied.catalog || occupied.meta || occupied.any_schema) {
      throw new Error(`CI_DATABASE_NOT_EMPTY:${identity.db}`);
    }

    // A fresh database still has the default public schema; install into a
    // clean owner-managed one exactly like the P0-02 bootstrap.
    await admin.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public');

    for (const relative of BASE_SQL) applied.push(await applyFile(admin, relative));
    await admin.query('ALTER SCHEMA public OWNER TO ice_p0_02_owner');
    await admin.query(`INSERT INTO p0_02_meta.platform_instance(run_id,label) VALUES('ci-database-check','ci')`);

    // Two synthetic identities: one admin (allowed) and one operator (denied).
    await admin.query(`INSERT INTO auth.users(id,email) VALUES ($1,'ci-admin@example.invalid'),($2,'ci-operator@example.invalid')`, [ADMIN_ID, OPERATOR_ID]);
    await admin.query(`INSERT INTO public.profiles(id,display_name,role_id,is_active)
      SELECT $1,'CI Admin',r.id,true FROM public.role r WHERE r.name='admin'`, [ADMIN_ID]);
    await admin.query(`INSERT INTO public.profiles(id,display_name,role_id,is_active)
      SELECT $1,'CI Operator',r.id,true FROM public.role r WHERE r.name='operator'`, [OPERATOR_ID]);

    for (const relative of CATALOG_SQL) applied.push(await applyFile(admin, relative));

    // Synthetic, local-only fixtures for the existing RPC + operation query.
    await admin.query(`INSERT INTO catalog.baseline_release
      (id,release_key,bundle_sha256,effective_csv_sha256,parser_version,adoption_sha256,manifest,published,published_at)
      VALUES ($1,'ci-baseline',$2,$3,'ci-database-check',$4,'{}'::jsonb,true,now())`,
      [RELEASE_ID, 'a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)]);
    await admin.query(`INSERT INTO catalog.catalog_item(id,first_release_id,new_product_confirmed)
      VALUES ($1,$2,false)`, [ITEM_ID, RELEASE_ID]);
    await admin.query(`INSERT INTO catalog.item_revision
      (item_id,revision,previous_revision,name_cn,fields,evidence_ref,reason,actor_id)
      VALUES ($1,1,NULL,'CI Synthetic Item','{}'::jsonb,'ci:synthetic','ci synthetic baseline',$2)`, [ITEM_ID, ADMIN_ID]);
    await admin.query(`INSERT INTO catalog.item_current(item_id,revision,financial_revision) VALUES ($1,1,NULL)`, [ITEM_ID]);

    const app = new pg.Client({ connectionString: connectionString() });
    await app.connect();
    try {
      await app.query('BEGIN');
      await app.query('SET LOCAL ROLE ice_p0_02_app_runner');
      await setIdentity(app, ADMIN_ID);

      const readable = (await app.query('SELECT id FROM catalog.catalog_item WHERE id=$1', [ITEM_ID])).rows;
      if (readable.length !== 1) throw new Error('CI_DATABASE_APP_READ_FAILED');

      const intent = crypto.createHash('sha256').update('ci-database-check:assign_initial_code').digest('hex');
      const saved = (await app.query(
        'SELECT catalog.assign_initial_code($1,$2,$3,$4,$5,$6,$7) AS r',
        [REQUEST_ID, intent, ITEM_ID, 1, 'CI-0001', 'ci synthetic initial code', 'ci:synthetic'],
      )).rows[0].r;
      if (saved?.iceCode !== 'CI-0001' || saved?.revision !== 2) {
        throw new Error(`CI_DATABASE_RPC_RESULT_INVALID:${JSON.stringify(saved)}`);
      }

      const operations = (await app.query(
        "SELECT catalog.read_operation_records('catalog',NULL,NULL,NULL,'CI-0001',50,0) AS r",
      )).rows[0].r;
      const serialized = JSON.stringify(operations);
      if (!operations || operations.total < 1 || !serialized.includes('CI-0001') || !serialized.includes('assign_initial_code')) {
        throw new Error(`CI_DATABASE_OPERATIONS_READ_FAILED:${serialized.slice(0, 400)}`);
      }

      await app.query('SAVEPOINT ci_admin');
      await setIdentity(app, OPERATOR_ID);
      const denied = await expectSqlError(
        app,
        "SELECT catalog.read_operation_records('all',NULL,NULL,NULL,NULL,50,0)",
        [],
        ['42501'],
        'CI_DATABASE_UNAUTHORIZED_IDENTITY',
      );
      await app.query('ROLLBACK TO SAVEPOINT ci_admin');
      await setIdentity(app, ADMIN_ID);
      await app.query('RELEASE SAVEPOINT ci_admin');

      // A read-only transaction must refuse business writes even for the app role.
      await app.query('COMMIT');
      await app.query('BEGIN READ ONLY');
      await app.query('SET LOCAL ROLE ice_p0_02_app_runner');
      await setIdentity(app, ADMIN_ID);
      const writeDenied = await expectSqlError(
        app,
        `INSERT INTO catalog.audit_event(request_id,intent_sha256,actor_id,action,result)
         VALUES ($1,$2,$3,'ci_forbidden_write','{}'::jsonb)`,
        [crypto.randomUUID(), '0'.repeat(64), ADMIN_ID],
        ['25006', '42501'],
        'CI_DATABASE_READ_ONLY_WRITE',
      );
      await app.query('ROLLBACK');

      const catalogTables = Number((await admin.query(`SELECT count(*) FROM information_schema.tables WHERE table_schema IN ('catalog','catalog_private')`)).rows[0].count);
      const catalogFunctions = Number((await admin.query(`SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('catalog','catalog_private')`)).rows[0].count);
      const operationFunction = (await admin.query(`SELECT to_regprocedure('catalog.read_operation_records(text,uuid,timestamp with time zone,timestamp with time zone,text,integer,integer)') IS NOT NULL AS present`)).rows[0].present;
      if (!operationFunction) throw new Error('CI_DATABASE_OPERATION_FUNCTION_MISSING');

      console.log(JSON.stringify({
        ok: true,
        database: identity.db,
        sqlFiles: applied.length,
        catalogTables,
        catalogFunctions,
        checks: {
          appRead: readable.length,
          rpcSaved: saved,
          operationsTotal: operations.total,
          unauthorizedIdentity: denied.code,
          readOnlyWrite: writeDenied.code,
        },
      }, null, 2));
    } finally {
      await app.end().catch(() => {});
    }
  } finally {
    await admin.end().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
