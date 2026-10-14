import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { DEFAULT_RUN_ID, REPO_ROOT, ensureEnvContract, newEvidenceSessionDir, runRoot } from './common.mjs';
import { buildP001ProcessEnv } from './env-whitelist.mjs';
import { captureBizFixture, restoreBizFixture } from './fixture-snapshot.mjs';
import { guardBeforeMutate } from './instance-guard.mjs';
import { guardP001Entry } from './entry-guard.mjs';

const runId = DEFAULT_RUN_ID;
guardP001Entry(runId);
const { instance } = guardBeforeMutate(runId);
const envFile = path.join(runRoot(runId), 'env.p0-01.json');
const envJson = ensureEnvContract(instance, envFile);
const evidenceDir = newEvidenceSessionDir(runId, 'postgres');
fs.writeFileSync(path.join(evidenceDir, 'run.json'), `${JSON.stringify({ runId, dbName: instance.dbName }, null, 2)}\n`);

const fixtureSnapshot = captureBizFixture(instance);
fs.writeFileSync(path.join(evidenceDir, 'fixture-before.json'), `${JSON.stringify(fixtureSnapshot, null, 2)}\n`);

const env = buildP001ProcessEnv({ P0_01_POOL_MAX: '1' }, envJson);

const vitestBin = path.join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const vitestBaseArgs = ['run', '--config', 'vitest.config.p0-01.mts'];
const vitestPhases = [
  ['tests/p0-01/access.postgres.test.ts', 'tests/p0-01/pool.postgres.test.ts'],
  ['tests/p0-01/seed-idempotency.postgres.test.ts'],
];

let restoreFailed = false;
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
    restoreBizFixture(instance, fixtureSnapshot);
    fs.writeFileSync(
      path.join(evidenceDir, 'fixture-after.json'),
      `${JSON.stringify(captureBizFixture(instance), null, 2)}\n`,
    );
  } catch (error) {
    restoreFailed = true;
    fs.writeFileSync(path.join(evidenceDir, 'fixture-restore-error.log'), `${String(error)}\n`);
  }
}

if (restoreFailed) {
  console.error('postgres fixture 恢复失败');
  process.exit(2);
}
if (exitCode !== 0) {
  process.exit(exitCode);
}

console.log(`postgres tests complete for ${instance.dbName}`);
