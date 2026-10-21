import path from 'node:path';
import fs from 'node:fs';
import { REPO_ROOT, readArgs, openRun, assertLiveInstance, newEvidence, writeJson, safeEnv, runCommand } from './prepare.mjs';

export async function runPostgresTests(argv = process.argv.slice(2)) {
  const run = openRun(readArgs(argv));
  const evidenceDir = newEvidence(run.root, 'postgres');
  writeJson(path.join(evidenceDir, 'target.json'), await assertLiveInstance(run));
  const { default: pg } = await import('pg');
  const instance = run.instance;
  const owner = new pg.Pool({ connectionString: `postgres://${instance.bootstrapUser}:${instance.bootstrapPassword}@${instance.host}:${instance.port}/${instance.dbName}`, max: 1 });
  let result;
  try {
    const before = {};
    for (const table of ['product', 'product_variant', 'inventory']) before[table] = (await owner.query(`SELECT * FROM public.${table} ORDER BY id`)).rows;
    writeJson(path.join(evidenceDir, 'public-before.json'), before);
    const env = safeEnv({ ...run.env, CATALOG_RUN_ROOT: run.root, CATALOG_SOURCE_ROOT: REPO_ROOT, CATALOG_TEST_EVIDENCE_DIR: evidenceDir });
    const preload = path.join(REPO_ROOT, 'scripts/p0-02/loopback-network-preload.cjs');
    env.NODE_OPTIONS = `--require="${preload.replace(/\\/g, '/')}"`;
    env.P0_02_ALLOWED_PORTS = String(instance.port);
    try {
      result = runCommand(process.execPath, [path.join(REPO_ROOT, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'vitest.config.catalog.mts', 'tests/catalog/catalog.postgres.test.ts'], { env, evidenceDir, name: 'vitest-postgres' });
    } finally {
      const after = {};
      for (const table of ['product', 'product_variant', 'inventory']) after[table] = (await owner.query(`SELECT * FROM public.${table} ORDER BY id`)).rows;
      const baseline = JSON.parse(fs.readFileSync(path.join(run.root, 'public-three-tables-before.json'), 'utf8'));
      const unchanged = JSON.stringify(before) === JSON.stringify(after) && JSON.stringify(baseline) === JSON.stringify(after);
      writeJson(path.join(evidenceDir, 'public-after.json'), { rows: after, unchanged });
      const schemaFile = path.join(evidenceDir, 'schema-after-catalog.sql');
      runCommand(path.join(instance.pgBinDir, 'pg_dump.exe'), ['--host', instance.host, '--port', String(instance.port), '--username', instance.bootstrapUser, '--dbname', instance.dbName, '--schema-only', '--schema=catalog', '--schema=catalog_private', '--no-password', '--file', schemaFile], { env: safeEnv({ PGPASSWORD: instance.bootstrapPassword }), evidenceDir, name: 'schema-only-dump' });
      if (!unchanged) throw new Error('CATALOG_OLD_PUBLIC_CHANGED');
    }
  } finally { await owner.end(); }
  console.log(`catalog PostgreSQL evidence: ${evidenceDir}`);
  return result;
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.join(REPO_ROOT, 'scripts/catalog/run-postgres-tests.mjs')) runPostgresTests().catch((error) => { console.error(error.message); process.exitCode = 1; });
