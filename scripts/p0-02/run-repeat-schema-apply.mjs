import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { DEFAULT_RUN_ID, REPO_ROOT, loadInstance, newEvidenceSessionDir, pgExe, withHiddenWindowsSpawnOptions } from './common.mjs';
import { guardBeforeMutate } from './instance-guard.mjs';
import { guardP001Entry } from './entry-guard.mjs';

const runId = DEFAULT_RUN_ID;
guardP001Entry(runId);
guardBeforeMutate(runId);

const evidenceDir = newEvidenceSessionDir(runId, 'repeat-schema-apply');
const instance = loadInstance(runId);
const sqlPath = path.join(REPO_ROOT, 'db', 'p0-02', '011_seal_app_inventory_quantity.sql');

function psqlQuery(sqlText) {
  const result = spawnSync(
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
      '-tA',
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
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function psqlFile(filePath) {
  const result = spawnSync(
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
      '-v',
      'ON_ERROR_STOP=1',
      '-f',
      filePath,
    ],
    withHiddenWindowsSpawnOptions({
      encoding: 'utf8',
      env: { PGPASSWORD: instance.bootstrapPassword },
    }),
  );
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

const before = psqlQuery(
  `SELECT polname FROM pg_policy p
   JOIN pg_class c ON c.oid = p.polrelid
   JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'inventory'
   ORDER BY polname`,
);

const first = psqlFile(sqlPath);
const second = psqlFile(sqlPath);

const payload = {
  beforePolicies: before.stdout.trim().split('\n').filter(Boolean),
  firstApply: { status: first.status, stderr: first.stderr.trim() },
  secondApply: { status: second.status, stderr: second.stderr.trim() },
};
fs.writeFileSync(path.join(evidenceDir, 'result.json'), `${JSON.stringify(payload, null, 2)}\n`);

if (first.status !== 0 || second.status !== 0) {
  console.error(payload);
  process.exit(first.status || second.status || 1);
}

console.log(`repeat schema apply passed (evidence: ${evidenceDir})`);
