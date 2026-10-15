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
import { captureRestoreContract, compareRestoreContracts } from './restore-schema-contract.mjs';

const runId = DEFAULT_RUN_ID;
guardP001Entry(runId);
guardBeforeMutate(runId);

const evidenceDir = newEvidenceSessionDir(runId, 'backup-restore-drill');
const instance = { ...loadInstance(runId), runId };
const { dbName: restoreDb } = allocateAuxiliaryDatabase(runId, 'restore_drill', instance);
const dumpFile = path.join(os.tmpdir(), `p0-02-backup-${runId}-${Date.now()}.dump`);

let cleanupFailed = false;
let primaryError = null;

try {
  const beforeIntegrity = captureFixtureIntegrity(instance, { includeSync: true });
  const sourceContract = await captureRestoreContract(instance);

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
    primaryError = new Error(dump.stderr || dump.stdout || 'pg_dump failed');
  } else {
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
    const restoredContract = await captureRestoreContract(restoreInstance);

    const tablesMatch =
      JSON.stringify(beforeIntegrity.tables) === JSON.stringify(restoredIntegrity.tables);
    const sourceUnchanged =
      JSON.stringify(beforeIntegrity.rowCounts) === JSON.stringify(afterIntegrity.rowCounts) &&
      JSON.stringify(beforeIntegrity.tables) === JSON.stringify(afterIntegrity.tables);
    const contractMismatches = compareRestoreContracts(sourceContract, restoredContract);

    const payload = {
      dumpFile,
      dumpBytes: fs.statSync(dumpFile).size,
      restoreExit: restore.status,
      restoreDb,
      tablesMatch,
      sourceIntegrityUnchanged: sourceUnchanged,
      contractMismatches,
    };
    fs.writeFileSync(path.join(evidenceDir, 'result.json'), `${JSON.stringify(payload, null, 2)}\n`);
    fs.unlinkSync(dumpFile);

    if (restore.status !== 0) {
      primaryError = new Error(`pg_restore 必须 exit 0: ${restoreLog}`);
    } else if (!sourceUnchanged) {
      primaryError = new Error('source instance integrity changed during drill');
    } else if (!tablesMatch) {
      primaryError = new Error('restore 目标与源库关键表内容不一致');
    } else if (contractMismatches.length > 0) {
      primaryError = new Error(
        `restore 结构与权限合同不一致: ${contractMismatches.join(', ')}`,
      );
    } else {
      console.log(`backup restore drill passed (evidence: ${evidenceDir})`);
    }
  }
} catch (error) {
  primaryError = error;
} finally {
  try {
    dropAuxiliaryDatabase(runId, instance, restoreDb);
  } catch (error) {
    cleanupFailed = true;
    fs.writeFileSync(path.join(evidenceDir, 'cleanup-error.log'), `${String(error)}\n`);
    console.error(error);
  }
}

if (cleanupFailed) {
  process.exit(2);
}
if (primaryError) {
  console.error(primaryError);
  process.exit(1);
}
