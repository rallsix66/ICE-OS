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
const evidenceDir = newEvidenceSessionDir(runId, 'python-gateway-integration');
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
  BS_WAREHOUSE_COUNTRY: 'TH',
  BS_TARGET_WAREHOUSE_NAME: '泰国海外仓',
  BS_OLD_WAREHOUSE_NAME: '泰国海外仓',
  BS_NEW_VARIANT_COUNTRY: 'TH',
};

const result = spawnSync(
  pythonCmd,
  ['-m', 'unittest', 'sync.test_p0_02_postgres_gateway_chain'],
  withHiddenWindowsSpawnOptions({
    cwd: scraperRoot,
    env: pythonEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  }),
);

const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
fs.writeFileSync(path.join(evidenceDir, 'unittest.log'), output);

if (result.status !== 0) {
  console.error('python gateway integration tests failed', { status: result.status });
  console.error(output);
  process.exit(result.status ?? 1);
}

console.log(`python gateway integration tests passed (evidence: ${evidenceDir})`);
