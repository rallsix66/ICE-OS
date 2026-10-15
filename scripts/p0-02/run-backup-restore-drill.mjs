import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  DEFAULT_RUN_ID,
  loadInstance,
  newEvidenceSessionDir,
  pgExe,
  withHiddenWindowsSpawnOptions,
} from './common.mjs';
import { guardBeforeMutate } from './instance-guard.mjs';
import { guardP001Entry } from './entry-guard.mjs';
import { captureFixtureIntegrity } from './fixture-integrity.mjs';
import { allocateAuxiliaryDatabase, dropAuxiliaryDatabase } from './auxiliary-database.mjs';

const runId = DEFAULT_RUN_ID;
guardP001Entry(runId);
guardBeforeMutate(runId);

const evidenceDir = newEvidenceSessionDir(runId, 'backup-restore-drill');
const instance = { ...loadInstance(runId), runId };
const { dbName: restoreDb } = allocateAuxiliaryDatabase(runId, 'restore_drill', instance);
const dumpFile = path.join(os.tmpdir(), `p0-02-backup-${runId}-${Date.now()}.dump`);

let cleanupFailed = false;
try {
  const beforeIntegrity = captureFixtureIntegrity(instance, { includeSync: true });

  const dump = spawnSync(
    pgExe('pg_dump', runId),
    [
      '-h',
      instance.host,
      '-p',
      String(instance.port),
      '-U',
      instance.bootstrapUser,
      '-Fc',
      '-f',
      dumpFile,
      instance.dbName,
    ],
    withHiddenWindowsSpawnOptions({
      encoding: 'utf8',
      env: { PGPASSWORD: instance.bootstrapPassword },
    }),
  );

  if (dump.status !== 0) {
    console.error(dump.stderr || dump.stdout);
    process.exit(dump.status ?? 1);
  }

  const restore = spawnSync(
    pgExe('pg_restore', runId),
    [
      '-h',
      instance.host,
      '-p',
      String(instance.port),
      '-U',
      instance.bootstrapUser,
      '-d',
      restoreDb,
      '--no-owner',
      '--role',
      instance.bootstrapUser,
      dumpFile,
    ],
    withHiddenWindowsSpawnOptions({
      encoding: 'utf8',
      env: { PGPASSWORD: instance.bootstrapPassword },
    }),
  );

  const restoreLog = `${restore.stdout ?? ''}${restore.stderr ?? ''}`;
  fs.writeFileSync(path.join(evidenceDir, 'pg_restore.log'), restoreLog);

  const restoreInstance = { ...instance, dbName: restoreDb };
  const restoredIntegrity = captureFixtureIntegrity(restoreInstance, { includeSync: true });
  const afterIntegrity = captureFixtureIntegrity(instance, { includeSync: true });

  const tablesMatch =
    JSON.stringify(beforeIntegrity.tables) === JSON.stringify(restoredIntegrity.tables);
  const sourceUnchanged =
    JSON.stringify(beforeIntegrity.rowCounts) === JSON.stringify(afterIntegrity.rowCounts) &&
    JSON.stringify(beforeIntegrity.tables) === JSON.stringify(afterIntegrity.tables);

  const payload = {
    dumpFile,
    dumpBytes: fs.statSync(dumpFile).size,
    restoreExit: restore.status,
    restoreDb,
    tablesMatch,
    sourceIntegrityUnchanged: sourceUnchanged,
  };
  fs.writeFileSync(path.join(evidenceDir, 'result.json'), `${JSON.stringify(payload, null, 2)}\n`);
  fs.unlinkSync(dumpFile);

  if (restore.status !== 0) {
    console.error('pg_restore 必须 exit 0', restoreLog);
    process.exit(restore.status ?? 1);
  }
  if (!sourceUnchanged) {
    console.error('source instance integrity changed during drill');
    process.exit(1);
  }
  if (!tablesMatch) {
    console.error('restore 目标与源库关键表内容不一致');
    process.exit(1);
  }

  console.log(`backup restore drill passed (evidence: ${evidenceDir})`);
} finally {
  try {
    dropAuxiliaryDatabase(runId, instance, restoreDb);
  } catch (error) {
    cleanupFailed = true;
    fs.writeFileSync(path.join(evidenceDir, 'cleanup-error.log'), `${String(error)}\n`);
    console.error(error);
  }
  if (cleanupFailed) {
    process.exit(2);
  }
}
