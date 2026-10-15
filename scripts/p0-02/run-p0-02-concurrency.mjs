import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  DEFAULT_RUN_ID,
  REPO_ROOT,
  loadInstance,
  newEvidenceSessionDir,
  pgExe,
  withHiddenWindowsSpawnOptions,
} from './common.mjs';
import { guardBeforeMutate } from './instance-guard.mjs';
import { guardP001Entry } from './entry-guard.mjs';

const runId = DEFAULT_RUN_ID;
guardP001Entry(runId);
guardBeforeMutate(runId);

const evidenceDir = newEvidenceSessionDir(runId, 'concurrency');
const instance = loadInstance(runId);
const concurrencyDb = `${instance.dbName}_concurrency`;

function psqlAdmin(sqlText) {
  return spawnSync(
    pgExe('psql', runId),
    [
      '-h',
      instance.host,
      '-p',
      String(instance.port),
      '-U',
      instance.bootstrapUser,
      '-d',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      sqlText,
    ],
    withHiddenWindowsSpawnOptions({
      encoding: 'utf8',
      env: { PGPASSWORD: instance.bootstrapPassword },
    }),
  );
}

const drop = psqlAdmin(`DROP DATABASE IF EXISTS ${concurrencyDb};`);
if (drop.status !== 0) {
  console.error(drop.stderr || drop.stdout);
  process.exit(drop.status ?? 1);
}
const create = psqlAdmin(`CREATE DATABASE ${concurrencyDb};`);
if (create.status !== 0) {
  console.error(create.stderr || create.stdout);
  process.exit(create.status ?? 1);
}

const env = {
  ...process.env,
  PGHOST: instance.host,
  PGPORT: String(instance.port),
  PGDATABASE: concurrencyDb,
  PGUSER: instance.bootstrapUser,
  PGPASSWORD: instance.bootstrapPassword,
};

const result = spawnSync(
  process.execPath,
  [path.join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs'), 'run', 'src/features/sync/concurrency.test.ts'],
  withHiddenWindowsSpawnOptions({
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
  }),
);

const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
fs.writeFileSync(path.join(evidenceDir, 'vitest.log'), output);
psqlAdmin(`DROP DATABASE IF EXISTS ${concurrencyDb};`);

if (result.status !== 0) {
  console.error(output);
  process.exit(result.status ?? 1);
}

console.log(`p0-02 concurrency passed (evidence: ${evidenceDir})`);
