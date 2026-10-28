/**
 * Independent demo/acceptance runner for the Feishu product-source package.
 *
 * It owns an isolated catalog run (separate database and port) and never touches
 * the live 3011 preview or its database. Steps:
 *   1. open an already-prepared isolated run (scripts/catalog/prepare.mjs)
 *   2. apply db/catalog/009..015 on the owner connection
 *   3. seed the 126 baseline items via the existing local-preview seed test
 *   4. copy product-source snapshots into <run>/source-snapshots
 *   5. optionally build/promote/start the preview on CATALOG_PREVIEW_PORT
 *
 * Usage:
 *   node scripts/catalog/feishu-source-demo.mjs --run-id run-... [--snapshot-dir <dir>] [--seed] [--start]
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, openRun, readArgs, safeEnv, runCommand } from './prepare.mjs';
import { syncCatalogSqlIncrements } from './catalog-sql-increments.mjs';

const LOCAL_SQL = [
  'db/catalog/009_local_display.sql',
  'db/catalog/010_local_display_security.sql',
  'db/catalog/011_local_display_read_rpc.sql',
  'db/catalog/012_local_display_table_rls.sql',
  'db/catalog/013_baseline_amounts_batch.sql',
  'db/catalog/014_audit_observation_pool_indexes.sql',
  'db/catalog/015_product_source_sync.sql',
];

const hash = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

async function applySequencedSql(run) {
  const { default: pg } = await import('pg');
  const instance = JSON.parse(fs.readFileSync(path.join(run.instanceRoot, 'catalog-instance.json'), 'utf8'));
  const ownerUrl = `postgres://${instance.bootstrapUser}:${instance.bootstrapPassword}@${instance.host}:${instance.port}/${instance.dbName}`;
  const owner = new pg.Client({ connectionString: ownerUrl });
  await owner.connect();
  const applied = [];
  try {
    for (const relative of LOCAL_SQL) {
      const file = path.join(REPO_ROOT, relative);
      if (!fs.existsSync(file)) throw new Error(`FEISHU_SOURCE_SQL_MISSING:${relative}`);
      const sql = fs.readFileSync(file, 'utf8');
      // Each file is expected to be idempotent only for first apply on this fresh run.
      await owner.query(sql);
      await owner.query('RESET ROLE; RESET ALL');
      applied.push({ path: relative, sha256: hash(fs.readFileSync(file)) });
    }
    await syncCatalogSqlIncrements(owner, run.instanceRoot);
  } finally {
    await owner.end();
  }
  return applied;
}

function copySnapshots(run, snapshotDir) {
  const target = path.join(run.root, 'source-snapshots');
  fs.mkdirSync(target, { recursive: true });
  if (!snapshotDir) return { target, files: [] };
  const files = [];
  for (const name of fs.readdirSync(snapshotDir)) {
    if (!name.endsWith('.json') || name === 'manifest.json') continue;
    const source = path.join(snapshotDir, name);
    const destination = path.join(target, name);
    fs.copyFileSync(source, destination);
    files.push({ name, sha256: hash(fs.readFileSync(source)), bytes: fs.statSync(source).size });
  }
  return { target, files };
}

function runSeed(run) {
  const env = safeEnv({
    ...run.env,
    CATALOG_RUN_ROOT: run.root,
    CATALOG_SOURCE_ROOT: REPO_ROOT,
    CATALOG_EVIDENCE_ROOT: path.join(run.root, 'private-evidence'),
  });
  const evidenceDir = path.join(run.root, 'evidence', `feishu-source-seed-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(evidenceDir, { recursive: true });
  runCommand(process.execPath, [path.join(REPO_ROOT, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'vitest.config.catalog.mts', 'tests/catalog/local-preview-seed.postgres.test.ts'], { env, evidenceDir, name: 'local-preview-seed' });
  return evidenceDir;
}

export async function prepareFeishuSourceRun(argv = process.argv.slice(2)) {
  const args = readArgs(argv);
  const run = openRun(args);
  const applied = await applySequencedSql(run);
  const instancePath = path.join(run.instanceRoot, 'catalog-instance.json');
  const marker = { ...JSON.parse(fs.readFileSync(instancePath, 'utf8')), label: 'catalog-local-preview-v1', previewReady: true, seededAt: new Date().toISOString() };
  fs.writeFileSync(instancePath, `${JSON.stringify(marker, null, 2)}\n`);
  if (argv.includes('--seed')) runSeed(run);
  const snapshotArg = argv.indexOf('--snapshot-dir');
  const snapshotDir = snapshotArg >= 0 ? path.resolve(argv[snapshotArg + 1]) : null;
  const snapshots = copySnapshots(run, snapshotDir);
  const evidenceDir = path.join(run.root, 'evidence', `feishu-source-prepare-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, 'prepare-receipt.json'), `${JSON.stringify({ runId: args.runId, applied, snapshots, createdAt: new Date().toISOString() }, null, 2)}\n`);
  if (argv.includes('--start')) {
    const result = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts/catalog/start-local-preview.mjs'), '--run-id', args.runId], {
      env: { ...safeEnv(), CATALOG_PREVIEW_PORT: process.env.CATALOG_PREVIEW_PORT ?? '3021' },
      encoding: 'utf8', windowsHide: true,
    });
    if (result.status !== 0) throw new Error(`FEISHU_SOURCE_PREVIEW_START_FAILED:${result.stderr || result.stdout}`);
    fs.writeFileSync(path.join(evidenceDir, 'start.json'), JSON.stringify({ stdout: result.stdout, stderr: result.stderr }, null, 2));
  }
  console.log(JSON.stringify({ runId: args.runId, applied, snapshotTarget: snapshots.target, snapshotFiles: snapshots.files.length, seeded: argv.includes('--seed'), started: argv.includes('--start') }, null, 2));
  return run;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareFeishuSourceRun().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
