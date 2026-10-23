import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REPO_ROOT, readArgs, openRun, newEvidence, writeJson, safeEnv, runCommand, assertLiveInstance,
} from './prepare.mjs';
import { CATALOG_SQL_INCREMENT_PATHS, sha256File, syncCatalogSqlIncrements } from './catalog-sql-increments.mjs';

const LOCAL_SQL = [
  'db/catalog/009_local_display.sql',
  'db/catalog/010_local_display_security.sql',
  'db/catalog/011_local_display_read_rpc.sql',
  'db/catalog/012_local_display_table_rls.sql',
  'db/catalog/013_baseline_amounts_batch.sql',
];

async function applyCatalogSql(run) {
  const instance = JSON.parse(fs.readFileSync(path.join(run.instanceRoot, 'catalog-instance.json'), 'utf8'));
  const ownerUrl = `postgres://${instance.bootstrapUser}:${instance.bootstrapPassword}@${instance.host}:${instance.port}/${instance.dbName}`;
  const { default: pg } = await import('pg');
  const owner = new pg.Client({ connectionString: ownerUrl });
  await owner.connect();
  const applied = [];
  try {
    for (const relative of LOCAL_SQL) {
      const file = path.join(REPO_ROOT, relative);
      const sql = fs.readFileSync(file, 'utf8');
      await owner.query(sql);
      await owner.query('RESET ROLE; RESET ALL');
      applied.push({ path: relative, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') });
    }
  } finally {
    await owner.end();
  }
  return applied;
}

export async function prepareLocalPreview(argv = process.argv.slice(2)) {
  const args = readArgs(argv);
  const evidenceDir = newEvidence(args.root, 'prepare-local-preview');
  runCommand(process.execPath, [path.join(REPO_ROOT, 'scripts/catalog/prepare.mjs'), '--run-id', args.runId], { env: safeEnv(), evidenceDir, name: 'catalog-base-prepare' });
  const run = openRun(args);
  const applied = await applyCatalogSql(run);
  const instance = JSON.parse(fs.readFileSync(path.join(run.instanceRoot, 'catalog-instance.json'), 'utf8'));
  const ownerUrl = `postgres://${instance.bootstrapUser}:${instance.bootstrapPassword}@${instance.host}:${instance.port}/${instance.dbName}`;
  const { default: pg } = await import('pg');
  const owner = new pg.Client({ connectionString: ownerUrl });
  await owner.connect();
  try {
    await syncCatalogSqlIncrements(owner, run.instanceRoot, {
      recordOnly: CATALOG_SQL_INCREMENT_PATHS.map((relative) => ({ path: relative, sha256: sha256File(relative) })),
    });
  } finally {
    await owner.end();
  }
  writeJson(path.join(evidenceDir, 'local-display-sql.json'), { applied, runId: args.runId });
  const env = safeEnv({
    ...run.env,
    CATALOG_RUN_ROOT: run.root,
    CATALOG_SOURCE_ROOT: REPO_ROOT,
    CATALOG_EVIDENCE_ROOT: path.join(run.root, 'private-evidence'),
  });
  runCommand(process.execPath, [path.join(REPO_ROOT, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'vitest.config.catalog.mts', 'tests/catalog/local-preview-seed.postgres.test.ts'], { env, evidenceDir, name: 'local-preview-seed' });
  const marker = { ...JSON.parse(fs.readFileSync(path.join(run.instanceRoot, 'catalog-instance.json'), 'utf8')), label: 'catalog-local-preview-v1', previewReady: true, seededAt: new Date().toISOString() };
  fs.writeFileSync(path.join(run.instanceRoot, 'catalog-instance.json'), `${JSON.stringify(marker, null, 2)}\n`);
  writeJson(path.join(run.root, 'local-preview-manifest.json'), { runId: args.runId, host: marker.host, port: marker.port, database: marker.dbName, applied, login: { email: 'admin@catalog.test', note: '密码写入 instance/login.local-preview.txt（不入库）' } });
  fs.writeFileSync(path.join(run.instanceRoot, 'login.local-preview.txt'), 'admin@catalog.test / CatalogAdmin123!\n', 'utf8');
  await assertLiveInstance(run);
  console.log(`catalog local preview ready: ${args.runId} @ ${marker.host}:${marker.port}`);
  return run;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareLocalPreview().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
