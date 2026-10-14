import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { DEFAULT_RUN_ID, withHiddenWindowsSpawnOptions } from './common.mjs';
import { stopRegisteredProcesses } from './managed-processes.mjs';
import { loadAndGuardInstance, probePidAlive } from './instance-guard.mjs';
import {
  postgresCommandMatchesInstance,
  readPostmasterPidStrict,
  resolveProcessCommandLine,
} from './process-identity.mjs';
import { guardP001Entry } from './entry-guard.mjs';

const runId = DEFAULT_RUN_ID;

function stopVerifiedPid(pid, label, verifyFn) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return { ok: false, reason: 'invalid-pid', pid };
  }
  const aliveBefore = probePidAlive(pid);
  if (aliveBefore.alive === null) {
    return { ok: false, reason: 'pid-probe-uncertain', pid };
  }
  if (aliveBefore.alive === false) {
    return { ok: true, alreadyStopped: true };
  }
  if (verifyFn && !verifyFn(pid)) {
    return { ok: false, reason: 'pid-identity-mismatch', pid };
  }
  if (process.platform === 'win32') {
    const result = spawnSync(
      'taskkill',
      ['/PID', String(pid), '/T', '/F'],
      withHiddenWindowsSpawnOptions({ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    );
    if (result.status !== 0) {
      return { ok: false, reason: 'taskkill-failed', pid, detail: result.stderr };
    }
  } else {
    try {
      process.kill(pid);
    } catch (error) {
      return { ok: false, reason: 'kill-failed', pid, detail: String(error) };
    }
  }
  const aliveAfter = probePidAlive(pid);
  if (aliveAfter.alive === true) {
    return { ok: false, reason: 'still-running', pid };
  }
  if (aliveAfter.alive === null) {
    return { ok: false, reason: 'post-stop-probe-uncertain', pid };
  }
  console.log(`已停止 ${label} pid=${pid}`);
  return { ok: true };
}

function main() {
  guardP001Entry(runId);
  let instance;
  try {
    instance = loadAndGuardInstance(runId);
  } catch (error) {
    console.error(JSON.stringify({ status: 'stop-failed', phase: 'guard', error: String(error) }));
    process.exit(2);
  }

  const pidParsed = readPostmasterPidStrict(instance.dataDir);
  if (pidParsed.kind === 'malformed') {
    console.error(JSON.stringify({ status: 'stop-refused', reason: 'malformed-pid-file', detail: pidParsed }));
    process.exit(9);
  }

  const pidFile = path.join(instance.dataDir, 'postmaster.pid');
  const postmasterPid = pidParsed.kind === 'ok' ? pidParsed.pid : null;
  const targetPid = postmasterPid ?? instance.pid;

  const stopResult = stopVerifiedPid(targetPid, 'PostgreSQL', (pid) => {
    const cmd = resolveProcessCommandLine(pid);
    return postgresCommandMatchesInstance(cmd, instance, runId);
  });

  if (!stopResult.ok) {
    console.error(JSON.stringify({ status: 'stop-refused', ...stopResult }));
    process.exit(stopResult.reason === 'pid-identity-mismatch' ? 3 : 4);
  }

  if (stopResult.alreadyStopped) {
    console.log(JSON.stringify({ status: 'not-running' }));
    process.exit(0);
  }

  if (fs.existsSync(pidFile)) {
    const pidStillParsed = readPostmasterPidStrict(instance.dataDir);
    if (pidStillParsed.kind === 'malformed') {
      console.error(JSON.stringify({ status: 'stop-refused', reason: 'malformed-pid-file-after-stop' }));
      process.exit(9);
    }
    const pidStill = pidStillParsed.kind === 'ok' ? pidStillParsed.pid : null;
    const alive = pidStill ? probePidAlive(pidStill) : { alive: false };
    if (alive.alive === true) {
      console.error(JSON.stringify({ status: 'stop-failed', reason: 'pid-file-still-live' }));
      process.exit(5);
    }
    if (alive.alive === null) {
      console.error(JSON.stringify({ status: 'stop-refused', reason: 'cannot-verify-pid-file' }));
      process.exit(6);
    }
    try {
      fs.unlinkSync(pidFile);
    } catch (error) {
      console.error(JSON.stringify({ status: 'stop-failed', reason: 'pid-file-unlink', error: String(error) }));
      process.exit(7);
    }
  }

  try {
    stopRegisteredProcesses(runId, { kinds: ['next'], instance });
  } catch (error) {
    console.error(JSON.stringify({ status: 'stop-refused', phase: 'next', error: String(error) }));
    process.exit(8);
  }

  console.log(JSON.stringify({ status: 'stopped' }));
}

main();
