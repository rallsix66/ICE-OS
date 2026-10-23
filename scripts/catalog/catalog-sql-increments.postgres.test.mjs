/**
 * Real PostgreSQL increment sync scenarios on an isolated test database only.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { sha256File, syncCatalogSqlIncrements } from './catalog-sql-increments.mjs';
import {
  INCREMENT_TEST_DB_PREFIX,
  assertIncrementTestTargetAllowed,
  connectIncrementTestOwner,
} from './catalog-sql-increment-test-target.mjs';
import {
  adminPostgresUrlFromOwnerUrl,
  bootstrapIncrementTestSchema,
  createIncrementTestDatabase,
} from './catalog-sql-increment-test-bootstrap.mjs';

const sqlPath = 'db/catalog/013_baseline_amounts_batch.sql';

function tempManifestDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-sql-pg-'));
}

async function withFreshTestDb(fn) {
  const ownerUrl = process.env.CATALOG_SQL_INCREMENT_TEST_OWNER_URL?.trim();
  assert.ok(ownerUrl, 'CATALOG_SQL_INCREMENT_TEST_OWNER_URL required');
  const target = assertIncrementTestTargetAllowed({ connectionString: ownerUrl });
  const adminUrl = adminPostgresUrlFromOwnerUrl(ownerUrl);
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await createIncrementTestDatabase(admin, target.database);
  } finally {
    await admin.end();
  }
  const owner = await connectIncrementTestOwner();
  try {
    return await fn(owner, target);
  } finally {
    await owner.end();
  }
}

async function runGuardCases() {
  const cases = [];
  const liveRunId = 'run-20261021T100700Z-b3c4d5e6';

  {
    const prev = process.env.CATALOG_SQL_INCREMENT_TEST_RUN_ID;
    process.env.CATALOG_SQL_INCREMENT_TEST_RUN_ID = liveRunId;
    delete process.env.CATALOG_SQL_INCREMENT_TEST_OWNER_URL;
    try {
      assert.throws(() => assertIncrementTestTargetAllowed({ connectionString: 'postgres://u:p@127.0.0.1:5432/postgres' }), /CATALOG_SQL_INCREMENT_TEST_FORBIDDEN_ENV:CATALOG_SQL_INCREMENT_TEST_RUN_ID/);
      cases.push({ scenario: 'guard-forbidden-run-id-env', ok: true });
    } finally {
      if (prev === undefined) delete process.env.CATALOG_SQL_INCREMENT_TEST_RUN_ID;
      else process.env.CATALOG_SQL_INCREMENT_TEST_RUN_ID = prev;
    }
  }

  {
    const prevUrl = process.env.CATALOG_SQL_INCREMENT_TEST_OWNER_URL;
    process.env.CATALOG_SQL_INCREMENT_TEST_OWNER_URL = 'postgres://postgres:secret@127.0.0.1:65466/iceos_catalog_run_20261021T100700Z_b3c4d5e6';
    try {
      assert.throws(() => assertIncrementTestTargetAllowed({ connectionString: process.env.CATALOG_SQL_INCREMENT_TEST_OWNER_URL }), /PREFIX_REQUIRED|LIVE_PREVIEW/);
      cases.push({ scenario: 'guard-live-preview-db-name', ok: true });
    } finally {
      if (prevUrl === undefined) delete process.env.CATALOG_SQL_INCREMENT_TEST_OWNER_URL;
      else process.env.CATALOG_SQL_INCREMENT_TEST_OWNER_URL = prevUrl;
    }
  }

  return cases;
}

async function runMutationCases() {
  const cases = [];
  await withFreshTestDb(async (client, target) => {
    await bootstrapIncrementTestSchema(client, { with013Installed: true });

    {
      const dir = tempManifestDir();
      await client.query('BEGIN READ ONLY');
      try {
        const applied = await syncCatalogSqlIncrements(client, dir);
        assert.equal(applied.length, 1);
        assert.equal(applied[0].source, 'reconciled-from-database');
        assert.equal(applied[0].sha256, sha256File(sqlPath));
        cases.push({ scenario: 'real-installed-missing-manifest', ok: true, target: target.database });
      } finally {
        await client.query('ROLLBACK');
      }
    }
  });

  await withFreshTestDb(async (client, target) => {
    await bootstrapIncrementTestSchema(client, { with013Installed: false });
    const dir = tempManifestDir();
    await client.query('BEGIN');
    try {
      const first = await syncCatalogSqlIncrements(client, dir);
      const second = await syncCatalogSqlIncrements(client, dir);
      assert.equal(first[0].source, 'apply-catalog-increments');
      assert.equal(second.length, 1);
      cases.push({ scenario: 'real-not-installed-apply-repeat', ok: true, target: target.database });
    } finally {
      await client.query('ROLLBACK');
    }
  });

  await withFreshTestDb(async (client, target) => {
    await bootstrapIncrementTestSchema(client, { with013Installed: true });
    const dir = tempManifestDir();
    await client.query('BEGIN');
    try {
      await client.query(`
          CREATE OR REPLACE FUNCTION catalog.read_baseline_item_amounts_map() RETURNS jsonb
          LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$ SELECT NULL::jsonb $$`);
      await client.query(`GRANT EXECUTE ON FUNCTION catalog.read_baseline_item_amounts_map() TO ice_p0_02_app_runner`);
      let error = null;
      try {
        await syncCatalogSqlIncrements(client, dir);
      } catch (e) {
        error = e.message;
      }
      assert.match(error, /DEFINITION_MISMATCH/);
      cases.push({ scenario: 'real-wrong-definition', ok: true, target: target.database });
    } finally {
      await client.query('ROLLBACK');
    }
  });

  await withFreshTestDb(async (client, target) => {
    await bootstrapIncrementTestSchema(client, { with013Installed: true });
    const dir = tempManifestDir();
    await client.query('BEGIN');
    try {
      await client.query('REVOKE EXECUTE ON FUNCTION catalog.read_baseline_item_amounts_map() FROM PUBLIC');
      await client.query('REVOKE EXECUTE ON FUNCTION catalog.read_baseline_item_amounts_map() FROM ice_p0_02_app_runner');
      let error = null;
      try {
        await syncCatalogSqlIncrements(client, dir);
      } catch (e) {
        error = e.message;
      }
      assert.match(error, /GRANT_MISMATCH/);
      cases.push({ scenario: 'real-missing-grant', ok: true, target: target.database });
    } finally {
      await client.query('ROLLBACK');
    }
  });

  return cases;
}

async function run() {
  const savedOwnerUrl = process.env.CATALOG_SQL_INCREMENT_TEST_OWNER_URL?.trim();
  if (!savedOwnerUrl) {
    throw new Error('CATALOG_SQL_INCREMENT_TEST_OWNER_URL_REQUIRED');
  }
  const target = assertIncrementTestTargetAllowed({ connectionString: savedOwnerUrl });
  const guardCases = await runGuardCases();
  process.env.CATALOG_SQL_INCREMENT_TEST_OWNER_URL = savedOwnerUrl;
  const mutationCases = await runMutationCases();
  console.log(JSON.stringify({
    at: new Date().toISOString(),
    target: { database: target.database, prefix: INCREMENT_TEST_DB_PREFIX },
    cases: [...guardCases, ...mutationCases],
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
