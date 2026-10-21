import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCE_IDENTITY_REPO_ROOT, openSourceIdentityRun, assertSourceIdentityLive, newRunId, runSourceIdentityGuardNegatives, stopExactCatalogInstance } from './prepare-source-identity.mjs';

export async function runSourceIdentityCheck(argv = process.argv.slice(2)) {
  const run = await openSourceIdentityRun(argv), h = run.helper;
  if (['source-identity-postgres-started.json', 'source-identity-browser-started.json', 'source-identity-check-started.json'].some((file) => fs.existsSync(path.join(run.root, file)))) throw new Error('N1A_CHECK_REQUIRES_UNTESTED_INSTANCE');
  const evidenceDirectory = h.newEvidence(run.root, 'source-identity-check');
  fs.writeFileSync(path.join(run.root, 'source-identity-check-started.json'), JSON.stringify({ runId: run.runId, processId: process.pid, parentProcessId: process.ppid, startedAt: new Date().toISOString() }), { flag: 'wx' });
  const phases = [{ phase: 'source-identity-postgres', runId: run.runId, n1Installed: true }];
  const register = (phase, runId, n1Installed) => { phases.push({ phase, runId, n1Installed }); h.writeJson(path.join(evidenceDirectory, 'phase-runs.json'), { phases }); };
  let failed;
  const discoverBaselineChildren = () => {
    for (const parent of phases.filter((p) => p.phase === 'catalog-base-regression')) {
      const directory = path.join(SOURCE_IDENTITY_REPO_ROOT, '.local/catalog', parent.runId, 'evidence');
      if (!fs.existsSync(directory)) continue;
      for (const name of fs.readdirSync(directory).filter((n) => n.startsWith('check-'))) {
        const phaseFile = path.join(directory, name, 'phase-runs.json'), commandFile = path.join(directory, name, 'browser-prepare.json');
        let child;
        if (fs.existsSync(phaseFile)) child = JSON.parse(fs.readFileSync(phaseFile, 'utf8')).browserRunId;
        else if (fs.existsSync(commandFile)) { const args = JSON.parse(fs.readFileSync(commandFile, 'utf8')).args; child = args[args.indexOf('--run-id') + 1]; }
        if (child && !phases.some((p) => p.runId === child)) register('catalog-base-regression-browser', child, false);
      }
    }
  };
  try {
    h.writeJson(path.join(evidenceDirectory, 'target.json'), await assertSourceIdentityLive(run));
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: run.env.P0_02_APP_DATABASE_URL, max: 1 });
    try {
      await pool.query('BEGIN'); await pool.query(`SELECT set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111101',true)`);
      if ((await pool.query('SELECT count(*)::int AS n FROM catalog.baseline_release')).rows[0].n !== 0) throw new Error('N1A_CHECK_REQUIRES_UNTESTED_INSTANCE');
      await pool.query('ROLLBACK');
    } finally { await pool.end(); }
    const i = run.instance;
    const fixtureOwner = new pg.Pool({ connectionString: `postgres://${i.bootstrapUser}:${i.bootstrapPassword}@${i.host}:${i.port}/${i.dbName}`, max: 1 });
    try {
      const state = (await fixtureOwner.query(`SELECT (SELECT count(*)::int FROM catalog.source_record) AS records,(SELECT count(*)::int FROM catalog.identity_observation) AS observations,(SELECT count(*)::int FROM catalog.observation_record_link) AS links,(SELECT count(*)::int FROM catalog.source_identity_request) AS requests`)).rows[0];
      if (Object.values(state).some((value) => value !== 0)) throw new Error('N1A_CHECK_REQUIRES_UNTESTED_INSTANCE');
    } finally { await fixtureOwner.end(); }
    await runSourceIdentityGuardNegatives(evidenceDirectory);
    const env = h.safeEnv({ ...run.env, CATALOG_TEST_ENV_PATH: run.envFile, CATALOG_TEST_EVIDENCE_DIR: evidenceDirectory });
    h.runCommand(process.execPath, [path.join(SOURCE_IDENTITY_REPO_ROOT, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'vitest.config.catalog-source-identity.mts', 'tests/catalog/source-identity.test.ts'], { env, evidenceDir: evidenceDirectory, name: 'source-identity-domain' });
    h.runCommand(process.execPath, [path.join(SOURCE_IDENTITY_REPO_ROOT, 'scripts/catalog/run-source-identity-postgres-tests.mjs'), '--run-id', run.runId], { env: h.safeEnv(), evidenceDir: evidenceDirectory, name: 'source-identity-postgres' });
    const browserRunId = newRunId(); register('source-identity-browser', browserRunId, true);
    h.runCommand(process.execPath, [path.join(SOURCE_IDENTITY_REPO_ROOT, 'scripts/catalog/prepare-source-identity.mjs'), '--run-id', browserRunId], { env: h.safeEnv(), evidenceDir: evidenceDirectory, name: 'source-identity-browser-prepare' });
    h.runCommand(process.execPath, [path.join(SOURCE_IDENTITY_REPO_ROOT, 'scripts/catalog/run-source-identity-browser-tests.mjs'), '--run-id', browserRunId], { env: h.safeEnv(), evidenceDir: evidenceDirectory, name: 'source-identity-browser' });
    const baseRunId = newRunId(); register('catalog-base-regression', baseRunId, false);
    h.runCommand(process.execPath, [path.join(SOURCE_IDENTITY_REPO_ROOT, 'scripts/catalog/prepare.mjs'), '--run-id', baseRunId], { env: h.safeEnv(), evidenceDir: evidenceDirectory, name: 'catalog-base-regression-prepare' });
    h.runCommand(process.execPath, [path.join(SOURCE_IDENTITY_REPO_ROOT, 'scripts/catalog/run-check.mjs'), '--run-id', baseRunId], { env: h.safeEnv(), evidenceDir: evidenceDirectory, name: 'catalog-base-regression-check' });
  } catch (error) { failed = error; }
  finally {
    discoverBaselineChildren();
    h.writeJson(path.join(evidenceDirectory, 'phase-runs.json'), { phases });
    for (const [index, phase] of phases.entries()) {
      try { await stopExactCatalogInstance(phase.runId, evidenceDirectory, `phase-${index}-stop`); }
      catch (error) { h.writeJson(path.join(evidenceDirectory, `phase-${index}-stop-failure.json`), { runId: phase.runId, code: error.message, dataPreserved: true }); failed ??= error; }
    }
  }
  h.writeJson(path.join(evidenceDirectory, 'result.json'), { pass: !failed, runId: run.runId, phases, error: failed?.message, completedAt: new Date().toISOString() });
  if (failed) throw failed;
  console.log(`source identity check complete: ${evidenceDirectory}`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runSourceIdentityCheck().catch((error) => { console.error(error.message); process.exitCode = 1; });
