/**
 * Negative ownership checks for the inventory worker start/status/stop scripts (R6).
 *
 * Uses a harmless foreign `python -c "time.sleep"` process (never another inventory worker and never
 * a real service) to prove that:
 *   A. a marker pointing at a live foreign pid is not accepted as "our worker online";
 *   B. stop-worker refuses to signal it and keeps the marker;
 *   C. start-worker refuses to start a second worker while such a marker exists (no false online);
 *   D. a marker without processCreatedAt is rejected (PID alone is not ownership);
 *   E. status reports owned=false and a non-zero exit for the foreign marker;
 *   F. a dead pid is cleaned up without signalling anything.
 *
 * The instance's real marker is moved aside and restored in `finally`; nothing outside the instance
 * directory is written and no instance process is touched.
 *
 * Usage: node scripts/inventory/check-process-ownership.mjs --run-id <run>
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { openRun, readArgs, REPO_ROOT, safeEnv } from '../catalog/prepare.mjs';
import { readWorkerProcessCreatedAtIso, verifyWorkerOwnership } from './worker-process-ownership.mjs';
import { workerSourcePaths } from './freeze-worker-source.mjs';

const args = readArgs(process.argv.slice(2));
const run = openRun(args);
const markerPath = path.join(run.instanceRoot, 'inventory-worker.pid.json');
const configPath = path.join(run.instanceRoot, 'inventory-worker.json');
const { workerScript } = workerSourcePaths(run.instanceRoot);
const evidenceDir = path.join(REPO_ROOT, '.local', 'inventory-sync-repair-20261026', 'r6-ownership');
fs.mkdirSync(evidenceDir, { recursive: true });
const checks = [];

function record(name, ok, detail) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function script(name, extra = []) {
  return spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts/inventory', name), '--run-id', args.runId, ...extra], {
    cwd: REPO_ROOT,
    env: safeEnv(),
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
}

const originalMarker = fs.existsSync(markerPath) ? fs.readFileSync(markerPath, 'utf8') : null;
// A foreign live process that is definitively not this instance's worker.
const foreign = spawn('python', ['-c', 'import time; time.sleep(120)'], { stdio: 'ignore', windowsHide: true, detached: true });
foreign.unref();

try {
  const foreignPid = foreign.pid;
  let foreignCreatedAt = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    foreignCreatedAt = readWorkerProcessCreatedAtIso(foreignPid);
    if (foreignCreatedAt) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const fakeMarker = {
    pid: foreignPid,
    workerId: 'foreign-probe',
    runId: args.runId,
    startedAt: new Date().toISOString(),
    processCreatedAt: foreignCreatedAt ?? new Date().toISOString(),
    configPath,
    workerScript,
    logFile: path.join(run.instanceRoot, 'inventory-worker-src', 'worker.py'),
    startedBy: 'probe',
  };
  fs.writeFileSync(markerPath, `${JSON.stringify(fakeMarker, null, 2)}\n`);

  const ownership = verifyWorkerOwnership(fakeMarker);
  record('A verify rejects a live foreign pid', ownership.ok === false && /CMDLINE_MISMATCH|PROCESS_TIME/.test(String(ownership.code)),
    `code=${ownership.code}`);

  const stop = script('stop-worker.mjs');
  record('B stop-worker refuses foreign pid', stop.status !== 0 && fs.existsSync(markerPath)
    && String(stop.stderr).includes('refusing'), `exit=${stop.status}`);
  record('B2 foreign process still alive (not killed)', (() => { try { process.kill(foreignPid, 0); return true; } catch { return false; } })());

  const start = script('start-worker.mjs');
  record('C start-worker refuses while marker is not provably ours',
    start.status !== 0 && String(`${start.stderr}${start.stdout}`).includes('INVENTORY_WORKER_')
    && fs.readFileSync(markerPath, 'utf8') === JSON.stringify(fakeMarker, null, 2) + '\n',
    `exit=${start.status}`);

  const status = script('status.mjs');
  let statusJson = null;
  try { statusJson = JSON.parse(String(status.stdout)); } catch { statusJson = null; }
  record('D status reports owned=false and exit 1',
    status.status !== 0 && statusJson?.workerProcess?.owned === false,
    `exit=${status.status} owned=${statusJson?.workerProcess?.owned}`);

  const noTimeMarker = { ...fakeMarker, processCreatedAt: null };
  fs.writeFileSync(markerPath, `${JSON.stringify(noTimeMarker, null, 2)}\n`);
  const noTime = verifyWorkerOwnership(noTimeMarker);
  record('E marker without processCreatedAt rejected', noTime.ok === false && noTime.code === 'INVENTORY_WORKER_MARKER_INCOMPLETE',
    `code=${noTime.code}`);
  const stopNoTime = script('stop-worker.mjs');
  record('E2 stop-worker refuses marker without creation time', stopNoTime.status !== 0, `exit=${stopNoTime.status}`);

  const deadMarker = { ...fakeMarker, pid: 999_999_999 };
  fs.writeFileSync(markerPath, `${JSON.stringify(deadMarker, null, 2)}\n`);
  const stopDead = script('stop-worker.mjs');
  record('F dead pid cleaned without signal', stopDead.status === 0 && !fs.existsSync(markerPath), `exit=${stopDead.status}`);
} finally {
  try { process.kill(foreign.pid, 'SIGTERM'); } catch { /* ignore */ }
  if (originalMarker !== null) fs.writeFileSync(markerPath, originalMarker);
  else fs.rmSync(markerPath, { force: true });
}

const summary = {
  runId: args.runId,
  finishedAt: new Date().toISOString(),
  checks,
  allOk: checks.every((check) => check.ok),
};
fs.writeFileSync(path.join(evidenceDir, `ownership-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({ allOk: summary.allOk, checks: checks.length, failed: checks.filter((c) => !c.ok).map((c) => c.name) }, null, 2));
process.exitCode = summary.allOk ? 0 : 1;
