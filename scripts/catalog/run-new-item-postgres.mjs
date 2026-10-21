import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NEW_ITEM_REPO_ROOT, openNewItemRun, assertNewItemLive, stopExactNewItemInstance } from './prepare-new-item.mjs';

export async function runNewItemPostgres(argv = process.argv.slice(2)) {
  const run = await openNewItemRun(argv), h = run.helper;
  const evidenceDirectory = h.newEvidence(run.root, 'new-item-postgres');
  const started = path.join(run.root, 'new-item-postgres-started.json');
  fs.writeFileSync(started, JSON.stringify({ runId: run.runId, processId: process.pid, parentProcessId: process.ppid, startedAt: new Date().toISOString() }), { flag: 'wx' });
  const i = run.instance;
  let owner, before, failed;
  const rows = async () => Object.fromEntries(await Promise.all(['product', 'product_variant', 'inventory'].map(async (table) => [table, (await owner.query(`SELECT * FROM public.${table} ORDER BY id`)).rows])));
  const env = h.safeEnv({ ...run.env, CATALOG_TEST_ENV_PATH: run.envFile, CATALOG_TEST_EVIDENCE_DIR: evidenceDirectory, CATALOG_NEW_ITEM_TEST_EVIDENCE_DIR: evidenceDirectory, P0_02_ALLOWED_PORTS: String(i.port), NODE_OPTIONS: `--require="${path.join(NEW_ITEM_REPO_ROOT, 'scripts/p0-02/loopback-network-preload.cjs').replace(/\\/g, '/')}"` });
  try {
    h.writeJson(path.join(evidenceDirectory, 'target.json'), await assertNewItemLive(run));
    const { default: pg } = await import('pg');
    owner = new pg.Pool({ connectionString: `postgres://${i.bootstrapUser}:${i.bootstrapPassword}@${i.host}:${i.port}/${i.dbName}`, max: 1 });
    before = await rows();
    h.writeJson(path.join(evidenceDirectory, 'public-before.json'), before);
    h.runCommand(process.execPath, [path.join(NEW_ITEM_REPO_ROOT, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'vitest.config.catalog-new-item.mts', 'tests/catalog/new-item.postgres.test.ts'], { env, evidenceDir: evidenceDirectory, name: 'new-item-vitest-postgres' });
  } catch (error) { failed = error; }
  finally {
    if (owner && before) {
      try {
        const after = await rows();
        const baseline = JSON.parse(fs.readFileSync(path.join(run.root, 'public-three-tables-before.json'), 'utf8'));
        const unchanged = JSON.stringify(before) === JSON.stringify(after) && JSON.stringify(baseline) === JSON.stringify(after);
        h.writeJson(path.join(evidenceDirectory, 'public-after.json'), { rows: after, unchanged });
        h.runCommand(path.join(i.pgBinDir, 'pg_dump.exe'), ['--host', i.host, '--port', String(i.port), '--username', i.bootstrapUser, '--dbname', i.dbName, '--schema-only', '--schema=catalog', '--schema=catalog_private', '--no-password', '--file', path.join(evidenceDirectory, 'schema-after-new-item.sql')], { env: h.safeEnv({ PGPASSWORD: i.bootstrapPassword }), evidenceDir: evidenceDirectory, name: 'new-item-schema-dump' });
        if (!unchanged) throw new Error('N1C_LEGACY_PUBLIC_ROWS_CHANGED');
      } catch (error) { failed ??= error; h.writeJson(path.join(evidenceDirectory, 'final-snapshot-failure.json'), { error: error.message }); }
    }
    try { await owner?.end(); } catch (error) { failed ??= error; }
    try { await stopExactNewItemInstance(run.runId, evidenceDirectory); }
    catch (error) { failed ??= error; h.writeJson(path.join(evidenceDirectory, 'owned-instance-stop-failure.json'), { runId: run.runId, error: error.message, dataPreserved: true }); }
  }
  if (failed) {
    h.writeJson(path.join(evidenceDirectory, 'failure.json'), { runId: run.runId, error: failed.message, code: failed.code ?? null });
    throw failed;
  }
  console.log(`new item PostgreSQL evidence: ${evidenceDirectory}`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runNewItemPostgres().catch((error) => { console.error(error.message); process.exitCode = 1; });
