import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  DEFAULT_RUN_ID,
  REPO_ROOT,
  ensureEnvContract,
  loadInstance,
  newEvidenceSessionDir,
  runRoot,
  withHiddenWindowsSpawnOptions,
} from './common.mjs';
import { buildP001ProcessEnv } from './env-whitelist.mjs';
import { guardP001Entry } from './entry-guard.mjs';

const runId = DEFAULT_RUN_ID;
guardP001Entry(runId);
const evidenceDir = newEvidenceSessionDir(runId, 'python-real-write-integration');
const scraperRoot = path.join(REPO_ROOT, 'tools', 'bigseller-scraper');
const instance = loadInstance(runId);
const envJson = ensureEnvContract(instance, path.join(runRoot(runId), 'env.p0-02.json'));
const env = buildP001ProcessEnv(
  {
    P0_02_ENABLED: 'true',
    BS_WAREHOUSE_COUNTRY: 'TH',
    BS_TARGET_WAREHOUSE_NAME: '泰国海外仓',
    BS_OLD_WAREHOUSE_NAME: '泰国海外仓',
    BS_NEW_VARIANT_COUNTRY: 'TH',
  },
  envJson,
);

const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
const pythonEnv = {
  ...env,
  PYTHONPATH: scraperRoot,
  P0_02_ENABLED: 'true',
};

const modules = [
  'sync.test_p0_02_publish_verify',
  'sync.test_p0_02_web_bridge_commit_outcome',
  'sync.test_p0_02_publish_atomicity',
  'sync.test_p0_02_postgres_real_write_chain',
  'sync.test_p0_02_fixture_recovery',
];
let combinedOutput = '';
let exitCode = 0;
for (const moduleName of modules) {
  const result = spawnSync(
    pythonCmd,
    ['-m', 'unittest', moduleName],
    withHiddenWindowsSpawnOptions({
      cwd: scraperRoot,
      env: pythonEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    }),
  );
  combinedOutput += `\n=== ${moduleName} ===\n${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.status !== 0) {
    exitCode = result.status ?? 1;
    break;
  }
}
fs.writeFileSync(path.join(evidenceDir, 'unittest.log'), combinedOutput);

if (exitCode !== 0) {
  console.error('python real_write integration failed', { status: exitCode });
  console.error(combinedOutput);
  process.exit(exitCode);
}

console.log(`python real_write integration passed (evidence: ${evidenceDir})`);
