/**
 * Minimal catalog schema bootstrap for SQL increment isolation tests (no business seed data).
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './prepare.mjs';
import { INCREMENT_TEST_DB_PREFIX } from './catalog-sql-increment-test-target.mjs';

function readSql(relative) {
  return fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8');
}

async function applySql(client, relative) {
  await client.query(readSql(relative));
  await client.query('RESET ROLE; RESET ALL');
}

/**
 * @param {import('pg').Client} adminClient connected to `postgres` maintenance database
 * @param {string} databaseName
 */
export async function createIncrementTestDatabase(adminClient, databaseName) {
  if (!databaseName.startsWith(INCREMENT_TEST_DB_PREFIX)) {
    throw new Error(`CATALOG_SQL_INCREMENT_TEST_BOOTSTRAP_PREFIX:${databaseName}`);
  }
  await adminClient.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  await adminClient.query(`CREATE DATABASE "${databaseName}"`);
}

/**
 * @param {import('pg').Client} ownerClient connected to increment test database as bootstrap owner
 * @param {{ with013Installed?: boolean }} [options]
 */
export async function bootstrapIncrementTestSchema(ownerClient, options = {}) {
  await applySql(ownerClient, 'db/p0-02/001_instance_and_roles.sql');
  await applySql(ownerClient, 'db/p0-02/002_session_identity.sql');
  await ownerClient.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public AUTHORIZATION ice_p0_02_owner');
  await applySql(ownerClient, 'db/p0-02/003_extensions.sql');
  await applySql(ownerClient, 'db/p0-02/010_public_schema.sql');
  await applySql(ownerClient, 'db/p0-02/003_auth_schema_grants.sql');
  await applySql(ownerClient, 'db/catalog/001_catalog.sql');
  await applySql(ownerClient, 'db/catalog/002_catalog_security.sql');
  if (options.with013Installed) {
    await applySql(ownerClient, 'db/catalog/013_baseline_amounts_batch.sql');
  }
}

/**
 * Build admin URL pointing at postgres DB from owner URL targeting test DB.
 */
export function adminPostgresUrlFromOwnerUrl(ownerUrl) {
  const url = new URL(ownerUrl);
  url.pathname = '/postgres';
  return url.toString();
}
