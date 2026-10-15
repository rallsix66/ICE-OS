/**
 * 受控负例：backup/concurrency runner 在失败时仍执行 finally 回收。
 * 所有 DB/子进程依赖均为替身，仅保留真实 process.exit 语义。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DEFAULT_RUN_ID, newEvidenceSessionDir, REPO_ROOT } from './common.mjs';
import { guardP001Entry } from './entry-guard.mjs';

const runId = DEFAULT_RUN_ID;
guardP001Entry(runId);
const evidenceDir = newEvidenceSessionDir(runId, 'aux-failure-negative');

const cases = [
  ['backup-dump', 'run-backup-restore-drill.mjs', 'dump'],
  ['backup-restore', 'run-backup-restore-drill.mjs', 'restore'],
  ['concurrency-test', 'run-p0-02-concurrency.mjs', 'vitest'],
];

const results = [];
for (const [name, file, failure] of cases) {
  const original = fs.readFileSync(path.join(REPO_ROOT, 'scripts/p0-02', file), 'utf8');
  const body = original.slice(original.indexOf('const runId = DEFAULT_RUN_ID;'));
  const prelude = `
import path from 'node:path';
import os from 'node:os';
const trace = (event) => process.stdout.write(JSON.stringify({ event }) + '\\n');
const DEFAULT_RUN_ID = 'review-stub-only';
const REPO_ROOT = 'review-stub-only';
const guardP001Entry = () => trace('guard-entry');
const guardBeforeMutate = () => trace('guard-source');
const newEvidenceSessionDir = () => '.';
const loadInstance = () => ({
  host: '127.0.0.1',
  port: 1,
  bootstrapUser: 'fake',
  bootstrapPassword: 'fake',
  dbName: 'fake',
  appRunnerUser: 'app',
  syncRunnerUser: 'sync',
});
const allocateAuxiliaryDatabase = () => {
  trace('allocate');
  return { dbName: 'review-owned-stub' };
};
const dropAuxiliaryDatabase = () => trace('drop');
const captureFixtureIntegrity = () => ({ tables: { x: [{ id: 1 }] }, rowCounts: { x: 1 } });
const captureRestoreContract = async () => ({
  constraints: [],
  policies: [],
  owners: [],
  functionPrivileges: [],
  roleChecks: {},
});
const compareRestoreContracts = () => [];
const pgExe = (name) => name;
const withHiddenWindowsSpawnOptions = (o) => o;
const fs = {
  writeFileSync: () => trace('write-evidence'),
  statSync: () => ({ size: 1 }),
  unlinkSync: () => trace('unlink-dump'),
};
const spawnSync = (cmd, args) => {
  const stage = cmd.includes('pg_dump') ? 'dump' : cmd.includes('pg_restore') ? 'restore' : 'vitest';
  trace(stage);
  return {
    status: stage === ${JSON.stringify(failure)} ? 1 : 0,
    stdout: '',
    stderr: stage === ${JSON.stringify(failure)} ? 'CONTROLLED_FAILURE' : '',
  };
};
`;
  const target = path.join(evidenceDir, `${name}-stub.mjs`);
  fs.writeFileSync(target, `${prelude}${body}`);
  const run = spawnSync(process.execPath, [target], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000,
  });
  const events = `${run.stdout ?? ''}`
    .split(/\r?\n/)
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line).event);
  results.push({
    name,
    exit: run.status,
    events,
    finallyDropCalled: events.includes('drop'),
  });
}

fs.writeFileSync(
  path.join(evidenceDir, 'result.json'),
  `${JSON.stringify({ results }, null, 2)}\n`,
);

const pass = results.every((row) => row.finallyDropCalled && row.exit !== 0);
if (!pass) {
  console.error('aux failure finally gate failed', results);
  process.exit(1);
}
console.log(`aux failure finally gate passed (evidence: ${evidenceDir})`);
