import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parsePostgresUrl, assertInstanceMetadataContract, assertConnectionTarget } from './connection-target.mjs';
import { assertInstancePaths, assertRunId } from './instance-guard.mjs';
import { assertSafeRunRoot } from './entry-guard.mjs';
import {
  parseStrictPostmasterPidLine,
  postgresCommandMatchesInstance,
  nextCommandMatchesExactWorkspace,
  nextProcessMatchesRegisteredWorkspace,
} from './process-identity.mjs';
import {
  isKnownOpt6BaselineFailure,
  verifyOpt6ApprovedFileFingerprints,
  loadApprovedOpt6Baseline,
} from './opt6-baseline.mjs';
import { verifyRegisteredProcessIdentity, stopRegisteredProcesses } from './managed-processes.mjs';
import { REPO_ROOT } from './common.mjs';

const cases = [];

function expectThrow(fn, label) {
  try {
    fn();
    cases.push({ name: label, pass: false, detail: '未抛出' });
  } catch {
    cases.push({ name: label, pass: true });
  }
}

function expectFalse(value, label) {
  cases.push({ name: label, pass: value === false, detail: value === false ? undefined : 'expected false' });
}

function expectTrue(value, label) {
  cases.push({ name: label, pass: value === true, detail: value === true ? undefined : 'expected true' });
}

expectThrow(
  () =>
    parsePostgresUrl(
      'postgres://ice_P0_02_app_runner:secret@127.0.0.1:5432/iceos?host=203.0.113.1',
      'host-override',
    ),
  'reject host query param',
);

expectThrow(
  () => parsePostgresUrl('postgres://u:p@203.0.113.10:5432/db', 'remote-host'),
  'reject non-loopback host',
);

expectThrow(
  () =>
    assertInstancePaths('run-20261013-r1', {
      runId: 'run-20261013-r2',
      dataDir: 'C:\\\\temp',
    }),
  'reject runId mismatch',
);

expectThrow(() => assertRunId('run-../evil'), 'reject run id path traversal');
expectThrow(() => assertSafeRunRoot('run-../../outside'), 'reject run root path escape');

expectThrow(
  () =>
    assertInstanceMetadataContract({
      host: '203.0.113.10',
      port: 5432,
      dbName: 'iceos',
      bootstrapUser: 'postgres',
      appRunnerUser: 'ice_P0_02_app_runner',
      authRunnerUser: 'ice_P0_02_auth_runner',
    }),
  'reject instance metadata remote host',
);

const workspaceRoot = path.join(REPO_ROOT, '.local', 'p0-02', 'run-20261013-r1', 'workspace');
const nextBinInWorkspace = path.join(workspaceRoot, 'node_modules', 'next', 'dist', 'bin', 'next');

const sampleInstance = {
  runId: 'run-20261013-r1',
  host: '127.0.0.1',
  port: 55432,
  dbName: 'iceos_P0_02_run_20261013_r1',
  dataDir: 'D:\\\\try one\\\\ICEOS\\\\.local\\\\p0-02\\\\run-20261013-r1\\\\pgdata',
  bootstrapUser: 'postgres',
  appRunnerUser: 'ice_P0_02_app_runner',
  authRunnerUser: 'ice_P0_02_auth_runner',
};

expectFalse(
  postgresCommandMatchesInstance(
    'postgres.exe -D "D:\\\\try one\\\\ICEOS\\\\.local\\\\p0-02\\\\run-20261013-r1\\\\pgdata-other" -p 55432',
    sampleInstance,
    sampleInstance.runId,
  ),
  'reject postgres dataDir substring mismatch',
);

expectFalse(
  nextCommandMatchesExactWorkspace(
    `node ${workspaceRoot}-other\\\\node_modules\\\\next\\\\dist\\\\bin\\\\next start`,
    workspaceRoot,
  ),
  'reject workspace-other next path',
);

expectFalse(
  nextCommandMatchesExactWorkspace(
    `node ${workspaceRoot}.old\\\\node_modules\\\\next\\\\dist\\\\bin\\\\next start`,
    workspaceRoot,
  ),
  'reject workspace.old next path',
);

expectTrue(
  nextProcessMatchesRegisteredWorkspace(`node "${nextBinInWorkspace}" start -p 3000`, workspaceRoot),
  'accept exact workspace next path',
);

expectFalse(
  nextCommandMatchesExactWorkspace(
    'node D:\\\\try one\\\\ICEOS\\\\node_modules\\\\next\\\\dist\\\\bin\\\\next start',
    workspaceRoot,
  ),
  'reject repo-root next without workspace path',
);

expectFalse(
  verifyRegisteredProcessIdentity(
    { kind: 'next', pid: 424243, workspaceRoot },
    `node ${workspaceRoot}.old\\\\node_modules\\\\next\\\\dist\\\\bin\\\\next start`,
    { runId: sampleInstance.runId },
  ).ok,
  'stop layer rejects workspace.old registered next',
);

expectFalse(
  verifyRegisteredProcessIdentity(
    { kind: 'next', pid: 424243, workspaceRoot },
    `node D:\\\\try one\\\\ICEOS\\\\.local\\\\p0-02\\\\run-other\\\\workspace\\\\node_modules\\\\next\\\\dist\\\\bin\\\\next start`,
    { runId: sampleInstance.runId },
  ).ok,
  'stop layer rejects other-run workspace',
);

const staleRunId = 'run-guard-negative-stale-pid';
const stalePath = path.join(REPO_ROOT, '.local', 'p0-02', staleRunId, 'managed-processes.json');
fs.mkdirSync(path.dirname(stalePath), { recursive: true });
fs.writeFileSync(
  stalePath,
  `${JSON.stringify(
    {
      updatedAt: new Date().toISOString(),
      processes: [
        {
          pid: process.pid,
          kind: 'next',
          workspaceRoot,
          registeredAt: new Date().toISOString(),
        },
      ],
    },
    null,
    2,
  )}\n`,
);
let staleStopThrew = false;
try {
  stopRegisteredProcesses(staleRunId, { kinds: ['next'], strict: true });
} catch {
  staleStopThrew = true;
}
expectTrue(
  staleStopThrew,
  'stopRegisteredProcesses strict rejects live pid with workspace mismatch without taskkill',
);
try {
  fs.unlinkSync(stalePath);
} catch {
  // ignore
}

expectFalse(parseStrictPostmasterPidLine('-1').ok, 'reject negative pid token');
expectFalse(parseStrictPostmasterPidLine('0').ok, 'reject zero pid token');
expectFalse(parseStrictPostmasterPidLine('123junk').ok, 'reject junk pid token');
expectFalse(parseStrictPostmasterPidLine('').ok, 'reject empty pid token');
expectFalse(parseStrictPostmasterPidLine('9'.repeat(400)).ok, 'reject oversized pid token');

expectFalse(
  isKnownOpt6BaselineFailure({
    status: 1,
    stdout:
      '× embeds the canonical migration body byte-for-byte and repeats the old-history postcheck 3ms\nAssertionError: Target cannot be null or undefined.\nopt6-production-apply.test.ts:43:9\nUnhandled Rejection\nRangeError: boom\n Tests 1 failed | 5 passed (6)\nErrors 1 error',
    stderr: '',
  }),
  'reject opt6 baseline with extra unhandled errors',
);

expectTrue(verifyOpt6ApprovedFileFingerprints({ repoRoot: REPO_ROOT }).ok, 'accept real repo opt6 fingerprints');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'p0-02-opt6-tamper-'));
const baseline = loadApprovedOpt6Baseline();
for (const file of baseline.files) {
  const src = path.join(REPO_ROOT, file.rel);
  const dest = path.join(tmpRoot, file.rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}
fs.writeFileSync(
  path.join(tmpRoot, 'supabase/migrations/00051_optimize_role_rls_policy_overlap.sql'),
  'CREATE POLICY unrelated_broken_sql;\r\n',
);
expectFalse(
  verifyOpt6ApprovedFileFingerprints({ repoRoot: tmpRoot }).ok,
  'reject tampered migration with only CREATE POLICY keyword',
);

const syncExpected = {
  host: '127.0.0.1',
  port: 49231,
  database: 'iceos_p0_02_run_20261014_r2',
  user: 'ice_p0_02_sync_runner',
};
expectThrow(
  () =>
    assertConnectionTarget(
      'postgres://ice_p0_02_sync_runner:x@127.0.0.1:5433/iceos_p0_02_run_20261014_r2',
      syncExpected,
      'P0_02_SYNC_DATABASE_URL',
    ),
  'reject sync url wrong port',
);
expectThrow(
  () =>
    assertConnectionTarget(
      'postgres://ice_p0_02_sync_runner:x@127.0.0.1:49231/iceos_p0_02_run_20261014_r1',
      syncExpected,
      'P0_02_SYNC_DATABASE_URL',
    ),
  'reject sync url wrong database',
);
expectThrow(
  () =>
    assertConnectionTarget(
      'postgres://ice_p0_02_app_runner:x@127.0.0.1:49231/iceos_p0_02_run_20261014_r2',
      syncExpected,
      'P0_02_SYNC_DATABASE_URL',
    ),
  'reject sync url wrong user',
);

const failed = cases.filter((c) => !c.pass);
console.log(JSON.stringify({ cases }, null, 2));
if (failed.length > 0) {
  process.exit(1);
}
console.log('guard negative cases passed');
