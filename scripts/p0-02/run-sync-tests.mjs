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
import { guardBeforeMutate } from './instance-guard.mjs';
import { guardP001Entry } from './entry-guard.mjs';

const runId = DEFAULT_RUN_ID;
guardP001Entry(runId);
guardBeforeMutate(runId);
const evidenceDir = newEvidenceSessionDir(runId, 'sync');
const envJson = ensureEnvContract(loadInstance(runId), path.join(runRoot(runId), 'env.p0-02.json'));
const env = buildP001ProcessEnv({ P0_02_POOL_MAX: '1' }, envJson);

const vitestBin = path.join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const syncTestFiles = [
  'tests/p0-02/sync-overview.postgres.test.ts',
  'tests/p0-02/sync-runner-authorization.postgres.test.ts',
  'tests/p0-02/golucky-import-jsonb.postgres.test.ts',
  'tests/p0-02/golucky-sync-events.postgres.test.ts',
  'tests/p0-02/sync-run-lifecycle.postgres.test.ts',
];
const result = spawnSync(
  process.execPath,
  [vitestBin, 'run', '--config', 'vitest.config.p0-02.mts', ...syncTestFiles],
  withHiddenWindowsSpawnOptions({
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }),
);

const stdout = result.stdout ?? '';
const stderr = result.stderr ?? '';
fs.writeFileSync(path.join(evidenceDir, 'vitest.log'), `${stdout}${stderr}`);

if (result.status !== 0) {
  console.error('sync tests failed', { vitest: result.status });
  process.exit(result.status ?? 1);
}

const pythonIntegration = spawnSync(
  process.execPath,
  [path.join(REPO_ROOT, 'scripts', 'p0-02', 'run-python-gateway-integration.mjs')],
  withHiddenWindowsSpawnOptions({
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }),
);
const pyIntOut = `${pythonIntegration.stdout ?? ''}${pythonIntegration.stderr ?? ''}`;
fs.writeFileSync(path.join(evidenceDir, 'python-gateway-integration.log'), pyIntOut);
if (pythonIntegration.status !== 0) {
  console.error('python gateway integration failed', { status: pythonIntegration.status });
  process.exit(pythonIntegration.status ?? 1);
}

const pythonRealWrite = spawnSync(
  process.execPath,
  [path.join(REPO_ROOT, 'scripts', 'p0-02', 'run-python-real-write-integration.mjs')],
  withHiddenWindowsSpawnOptions({
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }),
);
const pyRwOut = `${pythonRealWrite.stdout ?? ''}${pythonRealWrite.stderr ?? ''}`;
fs.writeFileSync(path.join(evidenceDir, 'python-real-write-integration.log'), pyRwOut);
if (pythonRealWrite.status !== 0) {
  console.error('python real_write integration failed', { status: pythonRealWrite.status });
  process.exit(pythonRealWrite.status ?? 1);
}

const pythonNegative = spawnSync(
  process.execPath,
  [path.join(REPO_ROOT, 'scripts', 'p0-02', 'run-python-gateway-negative.mjs')],
  withHiddenWindowsSpawnOptions({
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }),
);
const pyOut = `${pythonNegative.stdout ?? ''}${pythonNegative.stderr ?? ''}`;
fs.writeFileSync(path.join(evidenceDir, 'python-gateway-negative.log'), pyOut);
if (pythonNegative.status !== 0) {
  console.error('python gateway negative failed', { status: pythonNegative.status });
  process.exit(pythonNegative.status ?? 1);
}

console.log(`sync tests passed (evidence: ${evidenceDir})`);
