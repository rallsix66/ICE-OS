/**
 * Inventory worker process ownership.
 *
 * A PID alone is not ownership: every instance stores `inventory-worker.json`, so a recycled PID or a
 * worker of another instance must never be reported as "this package online" nor be signalled by
 * `stop-worker.mjs`. Ownership requires, at the same time:
 *   1. the PID is alive;
 *   2. its live command line contains the exact normalized worker script path AND the exact config path;
 *   3. the process creation time matches the time recorded when the launcher started it (when recorded).
 */
import path from 'node:path';
import { resolveProcessCommandLine, resolveProcessCreationTimeMs } from '../p0-02/process-identity.mjs';
import { probePidAlive } from '../p0-02/instance-guard.mjs';

const MAX_CREATION_SKEW_MS = 5_000;

export function normalizeCmdPath(value) {
  return path.resolve(String(value ?? '')).replace(/\\/g, '/').toLowerCase();
}

export function normalizeCmd(value) {
  return String(value ?? '').replace(/\\/g, '/').toLowerCase();
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  return probePidAlive(pid).alive === true;
}

/** @param {{pid:number, configPath:string, workerScript:string, processCreatedAt?:string|null}} marker */
export function verifyWorkerOwnership(marker) {
  if (!marker || !Number.isInteger(marker.pid) || marker.pid <= 0) {
    return { ok: false, code: 'INVENTORY_WORKER_MARKER_INVALID', message: 'worker marker missing a valid pid' };
  }
  if (!marker.configPath || !marker.workerScript) {
    return {
      ok: false,
      code: 'INVENTORY_WORKER_MARKER_INCOMPLETE',
      message: 'worker marker missing configPath or workerScript (cannot prove ownership)',
    };
  }
  if (!marker.processCreatedAt) {
    return {
      ok: false,
      code: 'INVENTORY_WORKER_MARKER_INCOMPLETE',
      message: 'worker marker missing processCreatedAt (strict process identity required)',
    };
  }
  if (!pidAlive(marker.pid)) {
    return { ok: false, code: 'INVENTORY_WORKER_PID_NOT_ALIVE', message: `pid ${marker.pid} is not alive` };
  }
  const commandLine = resolveProcessCommandLine(marker.pid);
  if (!commandLine) {
    return {
      ok: false,
      code: 'INVENTORY_WORKER_CMDLINE_UNAVAILABLE',
      message: `cannot read the command line of pid ${marker.pid}`,
    };
  }
  const cmd = normalizeCmd(commandLine);
  const configExpected = normalizeCmdPath(marker.configPath);
  const scriptExpected = normalizeCmdPath(marker.workerScript);
  if (!cmd.includes(configExpected)) {
    return {
      ok: false,
      code: 'INVENTORY_WORKER_CMDLINE_MISMATCH',
      message: `pid ${marker.pid} command line does not reference this instance config (${marker.configPath})`,
    };
  }
  if (!cmd.includes(scriptExpected)) {
    return {
      ok: false,
      code: 'INVENTORY_WORKER_CMDLINE_MISMATCH',
      message: `pid ${marker.pid} command line does not reference the frozen worker script (${marker.workerScript})`,
    };
  }
  const createdMs = resolveProcessCreationTimeMs(marker.pid);
  if (createdMs == null) {
    return {
      ok: false,
      code: 'INVENTORY_WORKER_PROCESS_TIME_UNAVAILABLE',
      message: `cannot read the creation time of pid ${marker.pid}`,
    };
  }
  const recordedMs = Date.parse(marker.processCreatedAt);
  if (!Number.isFinite(recordedMs)) {
    return {
      ok: false,
      code: 'INVENTORY_WORKER_MARKER_INCOMPLETE',
      message: 'worker marker processCreatedAt is not a valid timestamp',
    };
  }
  if (Math.abs(recordedMs - createdMs) > MAX_CREATION_SKEW_MS) {
    return {
      ok: false,
      code: 'INVENTORY_WORKER_PROCESS_TIME_MISMATCH',
      message: `pid ${marker.pid} creation time does not match the recorded start (pid may have been reused)`,
    };
  }
  return { ok: true, pid: marker.pid, commandLine, processCreatedAt: new Date(createdMs).toISOString() };
}

export function readWorkerProcessCreatedAtIso(pid) {
  const ms = resolveProcessCreationTimeMs(pid);
  return ms == null ? null : new Date(ms).toISOString();
}

export function workerCommandLineReferences(marker) {
  const commandLine = resolveProcessCommandLine(marker.pid);
  if (!commandLine) return { ok: false, commandLine: null, reason: 'unavailable' };
  const cmd = normalizeCmd(commandLine);
  const matches = cmd.includes(normalizeCmdPath(marker.configPath))
    && cmd.includes(normalizeCmdPath(marker.workerScript));
  return { ok: matches, commandLine, reason: matches ? 'match' : 'mismatch' };
}
