import path from 'node:path';
import crypto from 'node:crypto';
import { REPO_ROOT, readArgs, openRun, assertLiveInstance, newEvidence, writeJson, safeEnv, runCommand } from './prepare.mjs';

const args = readArgs();
const run = openRun(args);
const evidenceDir = newEvidence(run.root, 'check');
try {
  writeJson(path.join(evidenceDir, 'target.json'), await assertLiveInstance(run));
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: run.env.P0_02_APP_DATABASE_URL, max: 1 });
  try {
    await pool.query('BEGIN'); await pool.query(`SELECT set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111101',true)`);
    const existing = await pool.query('SELECT count(*)::int AS n FROM catalog.baseline_release');
    await pool.query('ROLLBACK');
    if (existing.rows[0].n !== 0) throw new Error('CATALOG_CHECK_REQUIRES_FRESH_PREPARE_RUN');
  } finally { await pool.end(); }
  const env = safeEnv({ ...run.env, CATALOG_RUN_ROOT: run.root, CATALOG_SOURCE_ROOT: REPO_ROOT, CATALOG_TEST_EVIDENCE_DIR: evidenceDir });
  runCommand(process.execPath, [path.join(REPO_ROOT, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'vitest.config.catalog.mts', 'tests/catalog/baseline-and-domain.test.ts'], { env, evidenceDir, name: 'domain' });
  runCommand(process.execPath, [path.join(REPO_ROOT, 'scripts/catalog/run-postgres-tests.mjs'), '--run-id', run.runId], { env: safeEnv(), evidenceDir, name: 'postgres' });
  // PG first-code tests commit immutable history. Browser gets its own fresh run,
  // never a cleanup/reset of the already tested catalog or an invented127th item.
  const browserRunId = `run-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}-${crypto.randomBytes(4).toString('hex')}`;
  runCommand(process.execPath, [path.join(REPO_ROOT, 'scripts/catalog/prepare.mjs'), '--run-id', browserRunId], { env: safeEnv(), evidenceDir, name: 'browser-prepare' });
  writeJson(path.join(evidenceDir, 'phase-runs.json'), { postgresRunId: run.runId, browserRunId, reason: 'Independent fresh fixtures preserve immutable committed first-code history' });
  runCommand(process.execPath, [path.join(REPO_ROOT, 'scripts/catalog/run-browser-tests.mjs'), '--run-id', browserRunId], { env: safeEnv(), evidenceDir, name: 'browser' });
  writeJson(path.join(evidenceDir, 'result.json'), { pass: true, runId: run.runId, browserRunId, completedAt: new Date().toISOString() });
  console.log(`catalog check complete: ${evidenceDir}`);
} catch (error) {
  writeJson(path.join(evidenceDir, 'result.json'), { pass: false, runId: run.runId, code: error.message, completedAt: new Date().toISOString() });
  console.error(error.message); process.exitCode = 1;
}
