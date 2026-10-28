/**
 * Start the inventory-sync-v1 background worker (Python) as a detached process.
 *
 * Ownership: instance/inventory-worker.pid.json records pid + process creation time + the frozen
 * worker script path + this instance's config path. A live pid alone is never treated as "our worker":
 * start/status/stop must all pass `verifyWorkerOwnership`.
 *
 * The worker always runs the frozen copy `<instance>/inventory-worker-src/worker.py` (created by
 * prepare-instance.mjs), never the moving repository, so the background version matches the frozen
 * preview build. Refresh it explicitly with `freeze-worker-source.mjs --refresh-worker-source`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { REPO_ROOT, detachedHiddenSpawnOptions, openRun, readArgs, safeEnv } from '../catalog/prepare.mjs';
import { freezeWorkerSource, verifyFrozenWorkerSource, workerSourcePaths } from './freeze-worker-source.mjs';
import {
  pidAlive,
  readWorkerProcessCreatedAtIso,
  verifyWorkerOwnership,
} from './worker-process-ownership.mjs';

const args = readArgs(process.argv.slice(2));
const run = openRun(args);
const instanceRoot = run.instanceRoot;
const configPath = path.join(instanceRoot, 'inventory-worker.json');
const markerPath = path.join(instanceRoot, 'inventory-worker.pid.json');
if (!fs.existsSync(configPath)) throw new Error('INVENTORY_WORKER_CONFIG_MISSING: run prepare-instance.mjs first');

// Freeze only a completely uninitialized instance; an existing frozen copy is verified and a failed
// verification stops the start while preserving the files (no silent rebuild of edited code).
const frozen = freezeWorkerSource(instanceRoot, { mode: 'first-only' });
const sourceCheck = verifyFrozenWorkerSource(instanceRoot);
if (!sourceCheck.ok) throw new Error(`${sourceCheck.code}:${sourceCheck.message}`);
const { workerScript } = workerSourcePaths(instanceRoot);

if (fs.existsSync(markerPath)) {
  let prior = null;
  try {
    prior = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch {
    prior = null;
  }
  if (prior && pidAlive(prior.pid)) {
    const ownership = verifyWorkerOwnership(prior);
    if (!ownership.ok) {
      // A live pid we cannot prove is ours: do not claim online, do not overwrite with a second worker.
      throw new Error(`${ownership.code}:${ownership.message}; refusing to report or replace it`);
    }
    console.log(`inventory worker already running pid ${prior.pid} (workerId=${prior.workerId}, owned=true)`);
    process.exit(0);
  }
  fs.rmSync(markerPath, { force: true });
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
fs.mkdirSync(config.logPath, { recursive: true });
const logFile = path.join(config.logPath, `worker-${new Date().toISOString().slice(0, 10)}.jsonl`);
const out = fs.openSync(path.join(config.logPath, 'worker.stdout.log'), 'a');
// Test-only hold switch for the controlled mid-run stop/restart drill; unset in normal operation.
const testHold = {
  phase: process.env.INVENTORY_WORKER_TEST_HOLD_PHASE ?? '',
  ms: process.env.INVENTORY_WORKER_TEST_HOLD_MS ?? '',
};
if (testHold.phase && !testHold.ms) throw new Error('INVENTORY_WORKER_TEST_HOLD_MS_REQUIRED');
const child = spawn(
  'python',
  [workerScript, '--config', configPath],
  detachedHiddenSpawnOptions({
    cwd: REPO_ROOT,
    env: safeEnv({
      // The frozen worker source lives under the instance; runtime state (BigSeller browser profile,
      // session lock, evidence) is shared with the repository-level read-only collector.
      INVENTORY_BS_REPO_ROOT: REPO_ROOT,
      ...(testHold.phase
        ? { INVENTORY_WORKER_TEST_HOLD_PHASE: testHold.phase, INVENTORY_WORKER_TEST_HOLD_MS: testHold.ms }
        : {}),
    }),
    stdio: ['ignore', out, out],
  }),
);
child.unref();
await new Promise((resolve) => setTimeout(resolve, 1500));
if (!pidAlive(child.pid)) {
  throw new Error(`INVENTORY_WORKER_EXITED_IMMEDIATELY: see ${path.join(config.logPath, 'worker.stdout.log')}`);
}
let processCreatedAt = null;
for (let attempt = 0; attempt < 20; attempt += 1) {
  processCreatedAt = readWorkerProcessCreatedAtIso(child.pid);
  if (processCreatedAt) break;
  await new Promise((resolve) => setTimeout(resolve, 250));
}
if (!processCreatedAt) {
  try { process.kill(child.pid); } catch { /* ignore */ }
  throw new Error('INVENTORY_WORKER_PROCESS_TIME_UNAVAILABLE:cannot bind the worker process identity');
}
const marker = {
  pid: child.pid,
  workerId: config.workerId,
  runId: args.runId,
  startedAt: new Date().toISOString(),
  processCreatedAt,
  configPath,
  workerScript,
  workerSourceSnapshotHash: frozen.source.snapshotHash,
  workerSourceFrozenAt: frozen.source.frozenAt,
  python: 'python',
  logFile,
  testHold: testHold.phase ? testHold : null,
  startedBy: 'scripts/inventory/start-worker.mjs',
};
// Re-verify with the marker itself before reporting success.
const ownership = verifyWorkerOwnership(marker);
if (!ownership.ok) {
  try { process.kill(child.pid); } catch { /* ignore */ }
  throw new Error(`${ownership.code}:${ownership.message}`);
}
fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
console.log(
  `inventory worker started pid ${child.pid} workerId=${config.workerId} `
  + `source=${frozen.source.snapshotHash.slice(0, 12)} log=${logFile}`,
);
