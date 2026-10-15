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

const runId = DEFAULT_RUN_ID;
guardP001Entry(runId);
guardBeforeMutate(runId);

const evidenceDir = newEvidenceSessionDir(runId, 'backup-restore-drill');
const instance = loadInstance(runId);
const restoreDb = `iceos_p0_02_${runId.replace(/-/g, '_')}_restore_drill`;
const dumpFile = path.join(os.tmpdir(), `p0-02-backup-${runId}-${Date.now()}.dump`);

const beforeIntegrity = captureFixtureIntegrity(instance);

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

const dropDb = spawnSync(
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
    `DROP DATABASE IF EXISTS ${restoreDb};`,
  ],
  withHiddenWindowsSpawnOptions({
    encoding: 'utf8',
    env: { PGPASSWORD: instance.bootstrapPassword },
  }),
);
if (dropDb.status !== 0) {
  console.error(dropDb.stderr || dropDb.stdout);
  process.exit(dropDb.status ?? 1);
}

const createDb = spawnSync(
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
    `CREATE DATABASE ${restoreDb};`,
  ],
  withHiddenWindowsSpawnOptions({
    encoding: 'utf8',
    env: { PGPASSWORD: instance.bootstrapPassword },
  }),
);
if (createDb.status !== 0) {
  console.error(createDb.stderr || createDb.stdout);
  process.exit(createDb.status ?? 1);
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

const restoreCount = spawnSync(
  pgExe('psql', runId),
  [
    '-h',
    instance.host,
    '-p',
    String(instance.port),
    '-U',
    instance.bootstrapUser,
    '-d',
    restoreDb,
    '-tA',
    '-c',
    'SELECT COUNT(*)::int FROM public.product_variant',
  ],
  withHiddenWindowsSpawnOptions({
    encoding: 'utf8',
    env: { PGPASSWORD: instance.bootstrapPassword },
  }),
);

const afterIntegrity = captureFixtureIntegrity(instance);

const payload = {
  dumpFile,
  dumpBytes: fs.statSync(dumpFile).size,
  restoreExit: restore.status,
  restoreVariantCount: Number((restoreCount.stdout ?? '').trim() || '0'),
  sourceIntegrityUnchanged: JSON.stringify(beforeIntegrity.rowCounts) === JSON.stringify(afterIntegrity.rowCounts),
  restoreDb,
};
fs.writeFileSync(path.join(evidenceDir, 'result.json'), `${JSON.stringify(payload, null, 2)}\n`);
fs.unlinkSync(dumpFile);

if (restore.status !== 0 && restore.status !== 1) {
  console.error('pg_restore failed', restore.stderr || restore.stdout);
  process.exit(restore.status ?? 1);
}
if (!payload.sourceIntegrityUnchanged) {
  console.error('source instance integrity changed during drill');
  process.exit(1);
}
if (payload.restoreVariantCount <= 0) {
  console.error('restore target missing fixture variants');
  process.exit(1);
}

console.log(`backup restore drill passed (evidence: ${evidenceDir})`);
