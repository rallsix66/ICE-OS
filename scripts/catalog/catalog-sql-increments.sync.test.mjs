import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {
  VERIFY_013_BASELINE_AMOUNTS_BATCH_SQL,
  evaluate013CatalogRow,
  expected013FunctionSpecFromIncrementSql,
  sha256File,
  syncCatalogSqlIncrements,
} from './catalog-sql-increments.mjs';

const sqlPath = 'db/catalog/013_baseline_amounts_batch.sql';

function catalogRowFromSpec(spec, { runnerGrant = true, bodyOverride } = {}) {
  return {
    identity_args: '',
    result_type: 'jsonb',
    language: 'plpgsql',
    security_definer: true,
    proconfig: ['search_path='],
    body: bodyOverride ?? spec.body,
    runner_grant: runnerGrant,
  };
}

function fakeClient({ initialInstalled = false, applyCreatesObject = true, runnerGrant = true, bodyOverride } = {}) {
  const spec = expected013FunctionSpecFromIncrementSql(sqlPath);
  let installed = initialInstalled;
  return {
    async query(sql) {
      if (sql.includes('pg_get_function_identity_arguments')) {
        if (!installed) return { rowCount: 0, rows: [] };
        return { rowCount: 1, rows: [catalogRowFromSpec(spec, { runnerGrant, bodyOverride })] };
      }
      if (sql.includes('RESET ROLE') || sql.includes('SET ROLE') || sql.includes('CREATE FUNCTION') || sql.includes('GRANT EXECUTE')) {
        if (applyCreatesObject && sql.includes('CREATE FUNCTION')) {
          installed = true;
        }
        return { rowCount: 0, rows: [] };
      }
      throw new Error(`unexpected query: ${sql.slice(0, 120)}`);
    },
  };
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-sql-inc-'));
}

async function run() {
  const cases = [];
  const spec = expected013FunctionSpecFromIncrementSql(sqlPath);
  assert.equal(evaluate013CatalogRow(catalogRowFromSpec(spec), spec.body).verified, true);

  {
    const dir = tempDir();
    const client = fakeClient({ initialInstalled: false, applyCreatesObject: true });
    const first = await syncCatalogSqlIncrements(client, dir);
    const second = await syncCatalogSqlIncrements(client, dir);
    assert.equal(first.length, 1);
    assert.equal(second.length, 1);
    assert.equal(first[0].source, 'apply-catalog-increments');
    cases.push({ scenario: 'not-installed-then-repeat', ok: true });
  }

  {
    const dir = tempDir();
    let error = null;
    try {
      await syncCatalogSqlIncrements(fakeClient({ initialInstalled: false, applyCreatesObject: false }), dir);
    } catch (e) {
      error = e.message;
    }
    assert.match(error, /object still missing after applying/);
    cases.push({ scenario: 'apply-without-object', ok: true });
  }

  {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'catalog-sql-increments.json'), JSON.stringify({ applied: [{ path: sqlPath, sha256: 'old-hash' }] }));
    let error = null;
    try {
      await syncCatalogSqlIncrements(fakeClient({ initialInstalled: false }), dir);
    } catch (e) {
      error = e.message;
    }
    assert.match(error, /HASH_MISMATCH/);
    cases.push({ scenario: 'manifest-hash-mismatch', ok: true });
  }

  {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'catalog-sql-increments.json'), '{broken');
    let error = null;
    try {
      await syncCatalogSqlIncrements(fakeClient({ initialInstalled: true }), dir);
    } catch (e) {
      error = e.message;
    }
    assert.match(error, /MANIFEST_CORRUPT/);
    const backups = fs.readdirSync(dir).filter((name) => name.includes('.corrupt-'));
    assert.equal(backups.length, 1);
    cases.push({ scenario: 'corrupt-manifest', ok: true });
  }

  {
    const dir = tempDir();
    let error = null;
    try {
      await syncCatalogSqlIncrements(fakeClient({
        initialInstalled: true,
        bodyOverride: 'DECLARE result jsonb; BEGIN RETURN NULL::jsonb; END',
      }), dir);
    } catch (e) {
      error = e.message;
    }
    assert.match(error, /DEFINITION_MISMATCH/);
    cases.push({ scenario: 'missing-manifest-wrong-function', ok: true });
  }

  {
    const dir = tempDir();
    const result = await syncCatalogSqlIncrements(fakeClient({ initialInstalled: true }), dir);
    assert.equal(result[0].source, 'reconciled-from-database');
    assert.equal(result[0].sha256, sha256File(sqlPath));
    cases.push({ scenario: 'missing-manifest-matching-function', ok: true });
  }

  {
    const dir = tempDir();
    let error = null;
    try {
      await syncCatalogSqlIncrements(fakeClient({ initialInstalled: true, runnerGrant: false }), dir);
    } catch (e) {
      error = e.message;
    }
    assert.match(error, /GRANT_MISMATCH/);
    cases.push({ scenario: 'missing-grant', ok: true });
  }

  assert.match(VERIFY_013_BASELINE_AMOUNTS_BATCH_SQL, /prosrc/);
  console.log(JSON.stringify({ at: new Date().toISOString(), cases }, null, 2));
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
