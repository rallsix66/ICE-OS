import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { DEFAULT_RUN_ID, REPO_ROOT, ensureEnvContract, newEvidenceSessionDir, runRoot } from './common.mjs';
import { buildP001ProcessEnv } from './env-whitelist.mjs';
import {
  assertFixtureIntegrityUnchanged,
  assertMinimumSeedFixture,
  captureFixtureIntegrity,
} from './fixture-integrity.mjs';
import { guardBeforeMutate } from './instance-guard.mjs';
import { guardP001Entry } from './entry-guard.mjs';

const runId = DEFAULT_RUN_ID;
guardP001Entry(runId);
const { instance } = guardBeforeMutate(runId);
const envFile = path.join(runRoot(runId), 'env.p0-02.json');
const envJson = ensureEnvContract(instance, envFile);
const evidenceDir = newEvidenceSessionDir(runId, 'postgres');
fs.writeFileSync(path.join(evidenceDir, 'run.json'), `${JSON.stringify({ runId, dbName: instance.dbName }, null, 2)}\n`);

const integrityBefore = captureFixtureIntegrity(instance, { includeSync: true });
assertMinimumSeedFixture(instance, integrityBefore);
fs.writeFileSync(path.join(evidenceDir, 'fixture-integrity-before.json'), `${JSON.stringify(integrityBefore, null, 2)}\n`);

const env = buildP001ProcessEnv({ P0_02_POOL_MAX: '1' }, envJson);

const discovery = spawnSync(
  process.execPath,
  [path.join(REPO_ROOT, 'scripts', 'p0-02', 'validate-postgres-test-discovery.mjs')],
  { cwd: REPO_ROOT, encoding: 'utf8' },
);
if (discovery.status !== 0) {
  console.error(discovery.stderr || discovery.stdout);
  process.exit(discovery.status ?? 1);
}
fs.writeFileSync(path.join(evidenceDir, 'postgres-test-discovery.json'), `${discovery.stdout}\n`);

const vitestBin = path.join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const vitestBaseArgs = ['run', '--config', 'vitest.config.p0-02.mts'];
const vitestPhases = [
  ['tests/p0-02/config-target.test.ts'],
  [
    'tests/p0-02/effective-acl.postgres.test.ts',
    'tests/p0-02/identity-chain.postgres.test.ts',
    'tests/p0-02/sync-overview.postgres.test.ts',
    'tests/p0-02/sync-runner-authorization.postgres.test.ts',
    'tests/p0-02/golucky-import-jsonb.postgres.test.ts',
    'tests/p0-02/golucky-sync-events.postgres.test.ts',
    'tests/p0-02/sync-run-lifecycle.postgres.test.ts',
    'tests/p0-02/sync-read-visibility.postgres.test.ts',
    'tests/p0-02/auth-directory-boundary.postgres.test.ts',
    'tests/p0-02/rpc-dependency.postgres.test.ts',
    'tests/p0-02/warehouse-replenishment-numeric.postgres.test.ts',
    'tests/p0-02/delivery-rework.postgres.test.ts',
    'tests/p0-02/sync-node-real-write-chain.postgres.test.ts',
    'tests/p0-02/sync-node-real-write-chain-cleanup.postgres.test.ts',
    'tests/p0-02/sync-publish-unknown.postgres.test.ts',
    'tests/p0-02/sync-expiry-authorization.postgres.test.ts',
    'tests/p0-02/sync-expiry-lock-concurrency.postgres.test.ts',
  ],
];

let integrityFailed = false;
let exitCode = 0;
try {
  for (const phaseFiles of vitestPhases) {
    const result = spawnSync(process.execPath, [vitestBin, ...vitestBaseArgs, ...phaseFiles], {
      stdio: 'inherit',
      env,
      cwd: REPO_ROOT,
    });
    if (result.status !== 0) {
      exitCode = result.status ?? 1;
      break;
    }
  }
} finally {
  try {
    const integrityAfter = captureFixtureIntegrity(instance, { includeSync: true });
    fs.writeFileSync(
      path.join(evidenceDir, 'fixture-integrity-after.json'),
      `${JSON.stringify(integrityAfter, null, 2)}\n`,
    );
    assertFixtureIntegrityUnchanged(integrityBefore, integrityAfter);
  } catch (error) {
    integrityFailed = true;
    fs.writeFileSync(path.join(evidenceDir, 'fixture-integrity-error.log'), `${String(error)}\n`);
  }
}

if (integrityFailed) {
  console.error('postgres fixture 完整性校验失败');
  process.exit(2);
}
if (exitCode !== 0) {
  process.exit(exitCode);
}

console.log(`postgres tests complete for ${instance.dbName}`);
