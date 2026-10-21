import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  DEFAULT_RUN_ID,
  REPO_ROOT,
  collectP003SourceHashes,
  newEvidenceSessionDir,
} from './common.mjs';

const runId = DEFAULT_RUN_ID;
const evidenceDir = newEvidenceSessionDir(runId, 'check');

fs.writeFileSync(
  path.join(evidenceDir, 'source-hashes.json'),
  `${JSON.stringify(collectP003SourceHashes(), null, 2)}\n`,
);

const steps = [];

const unittest = spawnSync(
  process.env.PYTHON ?? 'python',
  ['-m', 'unittest', 'discover', '-s', 'p0_03_match/tests', '-p', 'test_*.py', '-v'],
  { cwd: path.join(REPO_ROOT, 'tools'), encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' } },
);
steps.push({
  name: 'p0-03-unittest',
  exitCode: unittest.status,
  stdout: unittest.stdout?.slice(-4000) ?? '',
  stderr: unittest.stderr?.slice(-2000) ?? '',
});

const compile = spawnSync(
  process.env.PYTHON ?? 'python',
  ['-X', `pycache_prefix=${path.join(evidenceDir, 'pycache')}`, '-m', 'compileall', '-q', 'p0_03_match'],
  { cwd: path.join(REPO_ROOT, 'tools'), encoding: 'utf8' },
);
steps.push({ name: 'p0-03-compileall', exitCode: compile.status, stdout: compile.stdout ?? '', stderr: compile.stderr ?? '' });

const match = spawnSync(process.execPath, ['scripts/p0-03/run-match.mjs'], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
  env: { ...process.env, P0_03_RUN_ID: runId },
});
steps.push({
  name: 'p0-03-run-match',
  exitCode: match.status,
  stdout: match.stdout?.slice(-2000) ?? '',
  stderr: match.stderr?.slice(-2000) ?? '',
});

const failed = steps.filter((s) => s.exitCode !== 0);
const report = {
  runId,
  evidenceDir,
  steps,
  ok: failed.length === 0,
  failed: failed.map((s) => s.name),
};

fs.writeFileSync(path.join(evidenceDir, 'check-report.json'), `${JSON.stringify(report, null, 2)}\n`);

if (failed.length) {
  console.error('check:p0-03 FAILED', failed.map((s) => s.name).join(', '));
  process.exit(1);
}

console.log('check:p0-03 OK', evidenceDir);
