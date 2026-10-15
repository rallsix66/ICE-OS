import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  DEFAULT_RUN_ID,
  REPO_ROOT,
  collectP002SourceHashes,
  ensureEnvContract,
  loadInstance,
  newEvidenceSessionDir,
  runRoot,
  withHiddenWindowsSpawnOptions,
} from './common.mjs';
import { buildP001ProcessEnv } from './env-whitelist.mjs';
import { guardBeforeMutate } from './instance-guard.mjs';
import { isKnownOpt6BaselineFailure, isOpt6UnexpectedFailure } from './opt6-baseline.mjs';
import { ensureValidatedIsolatedWorkspace, writeBuildCredential, validateIsolatedWorkspaceSources } from './isolated-workspace.mjs';
import { guardP001Entry } from './entry-guard.mjs';

const runId = DEFAULT_RUN_ID;

function stripVitestSummary(output) {
  const plain = output.replace(/\u001b\[[0-9;]*m/g, '');
  const testsMatch = plain.match(/Tests\s+(\d+\s+passed|\d+\s+failed[^\n]*)/i);
  const filesMatch = plain.match(/Test Files\s+([^\n]+)/i);
  return {
    testFilesLine: filesMatch?.[1]?.trim() ?? null,
    testsLine: testsMatch?.[0]?.trim() ?? null,
  };
}

guardP001Entry(runId);

const evidenceDir = newEvidenceSessionDir(runId, 'check');
fs.writeFileSync(
  path.join(evidenceDir, 'source-hashes.json'),
  `${JSON.stringify(collectP002SourceHashes(), null, 2)}\n`,
);

guardBeforeMutate(runId);
const instance = loadInstance(runId);
const envPath = path.join(runRoot(runId), 'env.p0-02.json');
const envJson = ensureEnvContract(instance, envPath);

const baseEnv = {
  PATH: process.env.PATH,
  PATHEXT: process.env.PATHEXT,
  SystemRoot: process.env.SystemRoot,
  ComSpec: process.env.ComSpec,
  WINDIR: process.env.WINDIR,
  TEMP: process.env.TEMP,
  TMP: process.env.TMP,
  NODE_ENV: process.env.NODE_ENV ?? 'test',
  P0_02_ENABLED: 'false',
  NEXT_TELEMETRY_DISABLED: '1',
};

const p002TestEnv = buildP001ProcessEnv({ P0_02_POOL_MAX: '1' }, envJson);

const { workspace, validation: workspaceValidation } = ensureValidatedIsolatedWorkspace(runId, {
  resync: true,
});
fs.writeFileSync(
  path.join(evidenceDir, 'workspace-validation.json'),
  `${JSON.stringify(workspaceValidation, null, 2)}\n`,
);

const buildEnv = buildP001ProcessEnv(
  {
    NODE_ENV: 'production',
    NEXT_TELEMETRY_DISABLED: '1',
    NODE_PATH: path.join(REPO_ROOT, 'node_modules'),
  },
  envJson,
);

const steps = [
  {
    name: 'vitest-default',
    cmd: process.execPath,
    args: [
      path.join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs'),
      'run',
      '--exclude',
      '**/concurrency.test.ts',
      '--exclude',
      '**/*.postgres.test.ts',
      '--exclude',
      '**/*.live.test.ts',
      '--exclude',
      'src/features/database/opt6-production-apply.test.ts',
      '--exclude',
      'tests/p0-02/**',
      '--exclude',
      '**/*.postgres.test.ts',
    ],
    cwd: REPO_ROOT,
    env: baseEnv,
  },
  {
    name: 'lint',
    cmd: 'npm',
    args: ['run', 'lint', '--', '--max-warnings', '0'],
    cwd: REPO_ROOT,
    env: baseEnv,
    shell: true,
  },
  {
    name: 'build-isolated',
    cmd: 'npm',
    args: ['run', 'build', '--', '--webpack'],
    cwd: workspace,
    env: buildEnv,
    shell: true,
  },
  {
    name: 'p0-02-postgres',
    cmd: process.execPath,
    args: [path.join(REPO_ROOT, 'scripts', 'p0-02', 'run-postgres-tests.mjs')],
    cwd: REPO_ROOT,
    env: p002TestEnv,
  },
  {
    name: 'p0-02-http',
    cmd: process.execPath,
    args: [path.join(REPO_ROOT, 'scripts', 'p0-02', 'run-http-tests.mjs')],
    cwd: REPO_ROOT,
    env: p002TestEnv,
  },
  {
    name: 'p0-02-browser',
    cmd: process.execPath,
    args: [path.join(REPO_ROOT, 'scripts', 'p0-02', 'run-browser-tests.mjs')],
    cwd: REPO_ROOT,
    env: p002TestEnv,
  },
  {
    name: 'p0-02-fixture-restore-negative',
    cmd: process.execPath,
    args: [path.join(REPO_ROOT, 'scripts', 'p0-02', 'run-fixture-restore-negative.mjs')],
    cwd: REPO_ROOT,
    env: p002TestEnv,
  },
  {
    name: 'p0-02-migrate-auth-negative',
    cmd: process.execPath,
    args: [path.join(REPO_ROOT, 'scripts', 'p0-02', 'run-migrate-auth-negative.mjs')],
    cwd: REPO_ROOT,
    env: p002TestEnv,
  },
  {
    name: 'p0-02-sync',
    cmd: process.execPath,
    args: [path.join(REPO_ROOT, 'scripts', 'p0-02', 'run-sync-tests.mjs')],
    cwd: REPO_ROOT,
    env: p002TestEnv,
  },
  {
    name: 'p0-02-repeat-schema-apply',
    cmd: process.execPath,
    args: [path.join(REPO_ROOT, 'scripts', 'p0-02', 'run-repeat-schema-apply.mjs')],
    cwd: REPO_ROOT,
    env: p002TestEnv,
  },
  {
    name: 'p0-02-aux-failure-negative',
    cmd: process.execPath,
    args: [path.join(REPO_ROOT, 'scripts', 'p0-02', 'run-aux-failure-negative.mjs')],
    cwd: REPO_ROOT,
    env: p002TestEnv,
  },
  {
    name: 'p0-02-restore-contract-negative',
    cmd: process.execPath,
    args: [path.join(REPO_ROOT, 'scripts', 'p0-02', 'run-restore-contract-negative.mjs')],
    cwd: REPO_ROOT,
    env: p002TestEnv,
  },
  {
    name: 'p0-02-backup-restore-drill',
    cmd: process.execPath,
    args: [path.join(REPO_ROOT, 'scripts', 'p0-02', 'run-backup-restore-drill.mjs')],
    cwd: REPO_ROOT,
    env: p002TestEnv,
  },
  {
    name: 'p0-02-concurrency',
    cmd: process.execPath,
    args: [path.join(REPO_ROOT, 'scripts', 'p0-02', 'run-p0-02-concurrency.mjs')],
    cwd: REPO_ROOT,
    env: p002TestEnv,
  },
  {
    name: 'p0-02-python-connection-boundary',
    cmd: process.platform === 'win32' ? 'python' : 'python3',
    args: [
      '-m',
      'unittest',
      'sync.test_p0_02_connection_boundary',
    ],
    cwd: path.join(REPO_ROOT, 'tools', 'bigseller-scraper'),
    env: {
      ...p002TestEnv,
      PYTHONPATH: path.join(REPO_ROOT, 'tools', 'bigseller-scraper'),
      P0_02_ENABLED: 'true',
    },
  },
  {
    name: 'opt6-known-baseline',
    cmd: process.execPath,
    args: [
      path.join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs'),
      'run',
      'src/features/database/opt6-production-apply.test.ts',
    ],
    cwd: REPO_ROOT,
    env: baseEnv,
  },
  {
    name: 'git-diff-check',
    cmd: 'git',
    args: ['diff', '--check'],
    cwd: REPO_ROOT,
    env: baseEnv,
    shell: true,
  },
];

const results = [];
let collectedUnitCount = null;

for (const step of steps) {
  const result = spawnSync(
    step.cmd,
    step.args,
    withHiddenWindowsSpawnOptions({
      cwd: step.cwd,
      env: step.env,
      encoding: 'utf8',
      shell: step.shell,
    }),
  );
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const record = {
    name: step.name,
    status: result.status,
    stdoutBytes: stdout.length,
    stderrBytes: stderr.length,
    stdout,
    stderr,
  };
  results.push(record);
  fs.writeFileSync(path.join(evidenceDir, `${step.name}.log`), `${stdout}${stderr}`);
  if (step.name === 'build-isolated' && result.status === 0) {
    const afterBuild = validateIsolatedWorkspaceSources(runId);
    if (afterBuild.ok) {
      writeBuildCredential(runId, workspace, afterBuild.sourceSnapshotHash);
    }
  }
  if (step.name === 'vitest-default') {
    const match = stripVitestSummary(`${stdout}\n${stderr}`);
    collectedUnitCount = match;
  }
}

const summaryResults = results.map(({ name, status, stdoutBytes, stderrBytes }) => ({
  name,
  status,
  stdoutBytes,
  stderrBytes,
}));
fs.writeFileSync(
  path.join(evidenceDir, 'summary.json'),
  `${JSON.stringify({ evidenceDir, workspaceValidation, collectedUnitCount, results: summaryResults }, null, 2)}\n`,
);

const opt6AntiPattern = {
  name: 'opt6-anti-pattern-synthetic',
  status: isOpt6UnexpectedFailure({
    status: 1,
    stdout: '× keeps one transaction and locks history before the embedded migration body\nTests 1 failed | 5 passed (6)',
    stderr: '',
  })
    ? 0
    : 1,
};
results.push(opt6AntiPattern);
if (opt6AntiPattern.status !== 0) {
  console.error('opt6 反例检测失败：非 canonical 失败未被识别为异常');
  process.exit(11);
}

const failed = results.filter((r) => r.status !== 0);
const expectedBaseline = results.find((r) => r.name === 'opt6-known-baseline');
if (expectedBaseline && expectedBaseline.status !== 0) {
  if (!isKnownOpt6BaselineFailure(expectedBaseline)) {
    console.error('opt6 失败特征不符合已知基线');
    process.exit(expectedBaseline.status ?? 1);
  }
  console.warn('已知基线 opt6-production-apply：1 failed | 5 passed（00051 换行契约）');
}

const unexpected = failed.filter((r) => r.name !== 'opt6-known-baseline');
if (unexpected.length > 0) {
  console.error(unexpected.map((r) => r.name));
  process.exit(unexpected[0]?.status ?? 1);
}

console.log(`check 完成（证据: ${evidenceDir}）`);
process.exit(0);
