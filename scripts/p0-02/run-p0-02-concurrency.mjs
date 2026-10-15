import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  DEFAULT_RUN_ID,
  REPO_ROOT,
  loadInstance,
  newEvidenceSessionDir,
  withHiddenWindowsSpawnOptions,
} from './common.mjs';
import { guardBeforeMutate } from './instance-guard.mjs';
import { guardP001Entry } from './entry-guard.mjs';
import { allocateAuxiliaryDatabase, dropAuxiliaryDatabase } from './auxiliary-database.mjs';

const runId = DEFAULT_RUN_ID;
guardP001Entry(runId);
guardBeforeMutate(runId);

const evidenceDir = newEvidenceSessionDir(runId, 'concurrency');
const instance = { ...loadInstance(runId), runId };
const { dbName: concurrencyDb } = allocateAuxiliaryDatabase(runId, 'concurrency', instance);

let cleanupFailed = false;
try {
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

  if (result.status !== 0) {
    console.error(output);
    process.exit(result.status ?? 1);
  }

  console.log(`p0-02 concurrency passed (evidence: ${evidenceDir})`);
} finally {
  try {
    dropAuxiliaryDatabase(runId, instance, concurrencyDb);
  } catch (error) {
    cleanupFailed = true;
    fs.writeFileSync(path.join(evidenceDir, 'cleanup-error.log'), `${String(error)}\n`);
    console.error(error);
  }
  if (cleanupFailed) {
    process.exit(2);
  }
}
