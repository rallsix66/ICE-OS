import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import pg from 'pg';

import { DEFAULT_RUN_ID, pgExe, withHiddenWindowsSpawnOptions } from './common.mjs';
import { guardP001Entry } from './entry-guard.mjs';
import { guardBeforeMutate } from './instance-guard.mjs';
import { allocateAuxiliaryDatabase, dropAuxiliaryDatabase } from './auxiliary-database.mjs';
import { loadInstance, newEvidenceSessionDir } from './common.mjs';
import { captureRestoreContract, compareRestoreContracts } from './restore-schema-contract.mjs';

const runId = DEFAULT_RUN_ID;
guardP001Entry(runId);
guardBeforeMutate(runId);
const evidenceDir = newEvidenceSessionDir(runId, 'restore-contract-negative');
const instance = loadInstance(runId);
const { dbName } = allocateAuxiliaryDatabase(runId, 'restore_contract_neg', instance);
const dumpFile = path.join(os.tmpdir(), `p0-02-restore-contract-neg-${Date.now()}.dump`);

let cleanupFailed = false;
let primaryError = null;
const probeResults = [];

try {
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
    throw new Error(dump.stderr || dump.stdout || 'pg_dump failed');
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
      dbName,
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
  if (restore.status !== 0) {
    throw new Error(restore.stderr || restore.stdout || 'pg_restore failed');
  }

  const restoredInstance = { ...instance, dbName };
  const baseline = await captureRestoreContract(restoredInstance);

  let activePool = null;

  async function terminateAuxConnections() {
    spawnSync(
      pgExe('psql', runId),
      [
        '-h',
        instance.host,
        '-p',
        String(instance.port),
        '-U',
        instance.bootstrapUser,
        '-d',
        instance.dbName,
        '-c',
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid();`,
      ],
      withHiddenWindowsSpawnOptions({
        encoding: 'utf8',
        env: { PGPASSWORD: instance.bootstrapPassword },
      }),
    );
  }

  async function restoreFreshCopy() {
    if (activePool) {
      await activePool.end();
      activePool = null;
    }
    await terminateAuxConnections();
    const drop = spawnSync(
      pgExe('dropdb', runId),
      [
        '-h',
        instance.host,
        '-p',
        String(instance.port),
        '-U',
        instance.bootstrapUser,
        '--if-exists',
        '--force',
        dbName,
      ],
      withHiddenWindowsSpawnOptions({
        encoding: 'utf8',
        env: { PGPASSWORD: instance.bootstrapPassword },
      }),
    );
    if (drop.status !== 0) {
      throw new Error(drop.stderr || drop.stdout || 'dropdb failed');
    }
    const create = spawnSync(
      pgExe('createdb', runId),
      [
        '-h',
        instance.host,
        '-p',
        String(instance.port),
        '-U',
        instance.bootstrapUser,
        dbName,
      ],
      withHiddenWindowsSpawnOptions({
        encoding: 'utf8',
        env: { PGPASSWORD: instance.bootstrapPassword },
      }),
    );
    if (create.status !== 0) {
      throw new Error(create.stderr || create.stdout || 'createdb failed');
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
        dbName,
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
    if (restore.status !== 0) {
      throw new Error(restore.stderr || restore.stdout || 'pg_restore refresh failed');
    }
  }

  async function damageAndCompare(label, sqlStatements) {
    await restoreFreshCopy();
    activePool = new pg.Pool({
      host: instance.host,
      port: instance.port,
      database: dbName,
      user: instance.bootstrapUser,
      password: instance.bootstrapPassword,
      max: 1,
    });
    const client = await activePool.connect();
    try {
      for (const sql of sqlStatements) {
        await client.query(sql);
      }
    } finally {
      client.release();
    }
    const damaged = await captureRestoreContract(restoredInstance);
    const mismatches = compareRestoreContracts(baseline, damaged);
    probeResults.push({ label, mismatches });
    if (mismatches.length === 0) {
      throw new Error(`${label}: expected contract mismatches, got none`);
    }
  }

  await damageAndCompare('disable_inventory_rls', [
    'ALTER TABLE public.inventory DISABLE ROW LEVEL SECURITY',
  ]);

  await damageAndCompare('widen_admin_select_inventory_policy', [
    `ALTER POLICY admin_select_inventory ON public.inventory USING (true)`,
  ]);

  if (activePool) {
    await activePool.end();
    activePool = null;
  }
  await terminateAuxConnections();
  fs.unlinkSync(dumpFile);
} catch (error) {
  primaryError = error;
} finally {
  try {
    if (fs.existsSync(dumpFile)) {
      fs.unlinkSync(dumpFile);
    }
    dropAuxiliaryDatabase(runId, instance, dbName);
  } catch (error) {
    cleanupFailed = true;
    fs.writeFileSync(path.join(evidenceDir, 'cleanup-error.log'), `${String(error)}\n`);
  }
}

fs.writeFileSync(
  path.join(evidenceDir, 'result.json'),
  `${JSON.stringify({ probeResults, primaryError: primaryError ? String(primaryError) : null }, null, 2)}\n`,
);

if (cleanupFailed) {
  process.exit(2);
}
if (primaryError) {
  console.error(primaryError);
  process.exit(1);
}

console.log(`restore contract negative gate passed (evidence: ${evidenceDir})`);
