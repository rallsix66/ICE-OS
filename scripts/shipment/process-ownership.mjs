/**
 * 定时读取进程归属校验（货票在途自动读取）。
 *
 * 只凭 PID 不算“本实例的后台读取进程”：PID 可能被复用，也可能是别的实例/别的后台进程。
 * 归属必须同时满足：
 *   1. PID 存活；
 *   2. 实际命令行包含本实例的 config 路径与 worker 脚本路径；
 *   3. 进程创建时间与启动时记录的时间一致（误差 5 秒内）。
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

export function readWorkerProcessCreatedAtIso(pid) {
  const ms = resolveProcessCreationTimeMs(pid);
  return ms == null ? null : new Date(ms).toISOString();
}

/** @param {{pid:number, configPath:string, workerScript:string, processCreatedAt?:string|null}} marker */
export function verifyWorkerOwnership(marker) {
  if (!marker || !Number.isInteger(marker.pid) || marker.pid <= 0) {
    return { ok: false, code: 'SHIPMENT_READER_MARKER_INVALID', message: 'marker missing a valid pid' };
  }
  if (!marker.configPath || !marker.workerScript || !marker.processCreatedAt) {
    return {
      ok: false,
      code: 'SHIPMENT_READER_MARKER_INCOMPLETE',
      message: 'marker missing configPath/workerScript/processCreatedAt (cannot prove ownership)',
    };
  }
  if (!pidAlive(marker.pid)) {
    return { ok: false, code: 'SHIPMENT_READER_PID_NOT_ALIVE', message: `pid ${marker.pid} is not alive` };
  }
  const commandLine = resolveProcessCommandLine(marker.pid);
  if (!commandLine) {
    return {
      ok: false,
      code: 'SHIPMENT_READER_CMDLINE_UNAVAILABLE',
      message: `cannot read the command line of pid ${marker.pid}`,
    };
  }
  const cmd = normalizeCmd(commandLine);
  if (!cmd.includes(normalizeCmdPath(marker.configPath))) {
    return {
      ok: false,
      code: 'SHIPMENT_READER_CMDLINE_MISMATCH',
      message: `pid ${marker.pid} command line does not reference this instance config (${marker.configPath})`,
    };
  }
  if (!cmd.includes(normalizeCmdPath(marker.workerScript))) {
    return {
      ok: false,
      code: 'SHIPMENT_READER_CMDLINE_MISMATCH',
      message: `pid ${marker.pid} command line does not reference the reader script (${marker.workerScript})`,
    };
  }
  const createdMs = resolveProcessCreationTimeMs(marker.pid);
  if (createdMs == null) {
    return {
      ok: false,
      code: 'SHIPMENT_READER_PROCESS_TIME_UNAVAILABLE',
      message: `cannot read the creation time of pid ${marker.pid}`,
    };
  }
  const recordedMs = Date.parse(marker.processCreatedAt);
  if (!Number.isFinite(recordedMs)) {
    return { ok: false, code: 'SHIPMENT_READER_MARKER_INCOMPLETE', message: 'processCreatedAt is not valid' };
  }
  if (Math.abs(recordedMs - createdMs) > MAX_CREATION_SKEW_MS) {
    return {
      ok: false,
      code: 'SHIPMENT_READER_PROCESS_TIME_MISMATCH',
      message: `pid ${marker.pid} creation time does not match the recorded start (pid may have been reused)`,
    };
  }
  return { ok: true, pid: marker.pid, commandLine, processCreatedAt: new Date(createdMs).toISOString() };
}
