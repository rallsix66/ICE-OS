import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCE_IDENTITY_REPO_ROOT, openSourceIdentityRun, assertSourceIdentityLive, stopExactCatalogInstance } from './prepare-source-identity.mjs';

export async function runSourceIdentityPostgresTests(argv = process.argv.slice(2)) {
  const run = await openSourceIdentityRun(argv), h = run.helper;
  const evidenceDirectory = h.newEvidence(run.root, 'source-identity-postgres');
  const started = path.join(run.root, 'source-identity-postgres-started.json');
  fs.writeFileSync(started, JSON.stringify({ runId: run.runId, processId: process.pid, parentProcessId: process.ppid, startedAt: new Date().toISOString() }), { flag: 'wx' });
  h.writeJson(path.join(evidenceDirectory, 'target.json'), await assertSourceIdentityLive(run));
  const { default: pg } = await import('pg'); const i = run.instance;
  const owner = new pg.Pool({ connectionString: `postgres://${i.bootstrapUser}:${i.bootstrapPassword}@${i.host}:${i.port}/${i.dbName}`, max: 1 });
  const rows = async () => Object.fromEntries(await Promise.all(['product', 'product_variant', 'inventory'].map(async (table) => [table, (await owner.query(`SELECT * FROM public.${table} ORDER BY id`)).rows])));
  const before = await rows();
  h.writeJson(path.join(evidenceDirectory, 'public-before.json'), before);
  const env = h.safeEnv({ ...run.env, CATALOG_TEST_ENV_PATH: run.envFile, CATALOG_TEST_EVIDENCE_DIR: evidenceDirectory, CATALOG_SOURCE_IDENTITY_TEST_EVIDENCE_DIR: evidenceDirectory, P0_02_ALLOWED_PORTS: String(i.port), NODE_OPTIONS: `--require="${path.join(SOURCE_IDENTITY_REPO_ROOT, 'scripts/p0-02/loopback-network-preload.cjs').replace(/\\/g, '/')}"` });
  try {
    h.runCommand(process.execPath, [path.join(SOURCE_IDENTITY_REPO_ROOT, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'vitest.config.catalog-source-identity.mts', 'tests/catalog/source-identity.postgres.test.ts'], { env, evidenceDir: evidenceDirectory, name: 'source-identity-vitest-postgres' });
  } finally {
    try {
      const after = await rows();
      const baseline = JSON.parse(fs.readFileSync(path.join(run.root, 'public-three-tables-before.json'), 'utf8'));
      const unchanged = JSON.stringify(before) === JSON.stringify(after) && JSON.stringify(baseline) === JSON.stringify(after);
      h.writeJson(path.join(evidenceDirectory, 'public-after.json'), { rows: after, unchanged });
      h.runCommand(path.join(i.pgBinDir, 'pg_dump.exe'), ['--host', i.host, '--port', String(i.port), '--username', i.bootstrapUser, '--dbname', i.dbName, '--schema-only', '--schema=catalog', '--schema=catalog_private', '--no-password', '--file', path.join(evidenceDirectory, 'schema-after-source-identity.sql')], { env: h.safeEnv({ PGPASSWORD: i.bootstrapPassword }), evidenceDir: evidenceDirectory, name: 'source-identity-schema-dump' });
      if (!unchanged) throw new Error('N1A_LEGACY_PUBLIC_ROWS_CHANGED');
    } finally { await owner.end(); await stopExactCatalogInstance(run.runId, evidenceDirectory); }
  }
  console.log(`source identity PostgreSQL evidence: ${evidenceDirectory}`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runSourceIdentityPostgresTests().catch((error) => { console.error(error.message); process.exitCode = 1; });
