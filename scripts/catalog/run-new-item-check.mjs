import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NEW_ITEM_REPO_ROOT, openNewItemRun, assertNewItemLive, newRunId, runNewItemGuardNegatives, stopExactNewItemInstance } from './prepare-new-item.mjs';

export async function runNewItemCheck(argv = process.argv.slice(2)) {
  const run = await openNewItemRun(argv), h = run.helper;
  if (['new-item-postgres-started.json', 'new-item-browser-started.json', 'new-item-check-started.json'].some((file) => fs.existsSync(path.join(run.root, file)))) throw new Error('N1C_CHECK_REQUIRES_UNTESTED_INSTANCE');
  const evidenceDirectory = h.newEvidence(run.root, 'new-item-check');
  fs.writeFileSync(path.join(run.root, 'new-item-check-started.json'), JSON.stringify({ runId: run.runId, processId: process.pid, parentProcessId: process.ppid, startedAt: new Date().toISOString() }), { flag: 'wx' });
  const phases = [{ phase: 'new-item-postgres', runId: run.runId, cInstalled: true, n1Installed: true }];
  const register = (phase, runId, cInstalled, n1Installed) => {
    if (!phases.some((entry) => entry.runId === runId)) phases.push({ phase, runId, cInstalled, n1Installed });
    h.writeJson(path.join(evidenceDirectory, 'phase-runs.json'), { phases });
  };
  const discoverChildren = () => {
    for (const parent of phases.filter((entry) => !entry.cInstalled)) {
      const directory = path.join(NEW_ITEM_REPO_ROOT, '.local/catalog', parent.runId, 'evidence');
      if (!fs.existsSync(directory)) continue;
      for (const name of fs.readdirSync(directory).filter((value) => value.startsWith('source-identity-check-') || value.startsWith('check-'))) {
        const phaseFile = path.join(directory, name, 'phase-runs.json');
        if (!fs.existsSync(phaseFile)) continue;
        const data = JSON.parse(fs.readFileSync(phaseFile, 'utf8'));
        for (const child of data.phases ?? []) register(`inherited-${child.phase}`, child.runId, false, child.n1Installed);
        if (data.browserRunId) register('inherited-catalog-browser', data.browserRunId, false, false);
      }
    }
  };
  let failed;
  try {
    h.writeJson(path.join(evidenceDirectory, 'target.json'), await assertNewItemLive(run));
    const { default: pg } = await import('pg'), i = run.instance;
    const owner = new pg.Pool({ connectionString: `postgres://${i.bootstrapUser}:${i.bootstrapPassword}@${i.host}:${i.port}/${i.dbName}`, max: 1 });
    try {
      const state = (await owner.query(`SELECT (SELECT count(*)::int FROM catalog.baseline_release) AS releases,(SELECT count(*)::int FROM catalog.product_capture) AS captures,(SELECT count(*)::int FROM catalog.new_item_request) AS requests`)).rows[0];
      if (Object.values(state).some((value) => value !== 0)) throw new Error('N1C_CHECK_REQUIRES_UNTESTED_INSTANCE');
    } finally { await owner.end(); }
    await runNewItemGuardNegatives(evidenceDirectory);
    const env = h.safeEnv({ ...run.env, CATALOG_TEST_ENV_PATH: run.envFile, CATALOG_TEST_EVIDENCE_DIR: evidenceDirectory, CATALOG_NEW_ITEM_TEST_EVIDENCE_DIR: evidenceDirectory });
    h.runCommand(process.execPath, [path.join(NEW_ITEM_REPO_ROOT, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'vitest.config.catalog-new-item.mts', 'tests/catalog/new-item.test.ts'], { env, evidenceDir: evidenceDirectory, name: 'new-item-domain' });
    h.runCommand(process.execPath, [path.join(NEW_ITEM_REPO_ROOT, 'scripts/catalog/run-new-item-postgres.mjs'), '--run-id', run.runId], { env: h.safeEnv(), evidenceDir: evidenceDirectory, name: 'new-item-postgres' });
    const browserRunId = newRunId(); register('new-item-browser', browserRunId, true, true);
    h.runCommand(process.execPath, [path.join(NEW_ITEM_REPO_ROOT, 'scripts/catalog/prepare-new-item.mjs'), '--run-id', browserRunId], { env: h.safeEnv(), evidenceDir: evidenceDirectory, name: 'new-item-browser-prepare' });
    h.runCommand(process.execPath, [path.join(NEW_ITEM_REPO_ROOT, 'scripts/catalog/run-new-item-browser.mjs'), '--run-id', browserRunId], { env: h.safeEnv(), evidenceDir: evidenceDirectory, name: 'new-item-browser' });
    const aRunId = newRunId(); register('source-identity-regression', aRunId, false, true);
    h.runCommand(process.execPath, [path.join(NEW_ITEM_REPO_ROOT, 'scripts/catalog/prepare-source-identity.mjs'), '--run-id', aRunId], { env: h.safeEnv(), evidenceDir: evidenceDirectory, name: 'source-identity-regression-prepare' });
    h.runCommand(process.execPath, [path.join(NEW_ITEM_REPO_ROOT, 'scripts/catalog/run-source-identity-check.mjs'), '--run-id', aRunId], { env: h.safeEnv(), evidenceDir: evidenceDirectory, name: 'source-identity-regression-check' });
  } catch (error) { failed = error; }
  finally {
    try { discoverChildren(); }
    catch (error) { h.writeJson(path.join(evidenceDirectory, 'child-discovery-failure.json'), { error: error.message }); failed ??= error; }
    h.writeJson(path.join(evidenceDirectory, 'phase-runs.json'), { phases });
    for (const [index, phase] of phases.entries()) {
      try { await stopExactNewItemInstance(phase.runId, evidenceDirectory, `phase-${index}-stop`); }
      catch (error) { h.writeJson(path.join(evidenceDirectory, `phase-${index}-stop-failure.json`), { runId: phase.runId, error: error.message, dataPreserved: true }); failed ??= error; }
    }
  }
  h.writeJson(path.join(evidenceDirectory, 'result.json'), { pass: !failed, runId: run.runId, phases, error: failed?.message, completedAt: new Date().toISOString() });
  if (failed) throw failed;
  console.log(`new item check complete: ${evidenceDirectory}`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runNewItemCheck().catch((error) => { console.error(error.message); process.exitCode = 1; });
