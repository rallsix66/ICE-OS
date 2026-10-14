import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { runRoot, withHiddenWindowsSpawnOptions } from './common.mjs';
import { probePidAlive } from './instance-guard.mjs';
import {
  nextProcessMatchesRegisteredWorkspace,
  postgresCommandMatchesInstance,
  resolveProcessCommandLine,
} from './process-identity.mjs';

function processesPath(runId) {
  return path.join(runRoot(runId), 'managed-processes.json');
}

export function loadManagedProcesses(runId) {
  const file = processesPath(runId);
  if (!fs.existsSync(file)) {
    return [];
  }
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(data.processes) ? data.processes : [];
}

export function saveManagedProcesses(runId, processes) {
  fs.mkdirSync(runRoot(runId), { recursive: true });
  fs.writeFileSync(
    processesPath(runId),
    `${JSON.stringify({ updatedAt: new Date().toISOString(), processes }, null, 2)}\n`,
  );
}

export function registerManagedProcess(runId, entry) {
  const pid = entry.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`无法注册非法 PID: ${entry.pid}`);
  }
  const processes = loadManagedProcesses(runId).filter((p) => p.pid !== pid);
  processes.push({
    pid,
    kind: entry.kind,
    workspaceRoot: entry.workspaceRoot ? path.resolve(entry.workspaceRoot) : null,
    registeredAt: new Date().toISOString(),
    port: entry.port ?? null,
  });
  saveManagedProcesses(runId, processes);
}

export function unregisterManagedProcess(runId, pid) {
  saveManagedProcesses(
    runId,
    loadManagedProcesses(runId).filter((p) => p.pid !== pid),
  );
}

export function verifyRegisteredProcessIdentity(entry, commandLine, { instance, runId }) {
  if (!entry || entry.pid <= 0) {
    return { ok: false, reason: 'invalid-entry' };
  }
  if (entry.kind === 'postgres' && instance) {
    if (!postgresCommandMatchesInstance(commandLine, instance, runId)) {
      return { ok: false, reason: 'postgres-identity-mismatch' };
    }
    return { ok: true };
  }
  if (entry.kind === 'next' && entry.workspaceRoot) {
    if (!nextProcessMatchesRegisteredWorkspace(commandLine, entry.workspaceRoot)) {
      return { ok: false, reason: 'next-workspace-mismatch' };
    }
    return { ok: true };
  }
  return { ok: false, reason: 'unsupported-kind' };
}

function stopVerifiedPid(pid, label, verifyFn) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return { ok: false, reason: 'invalid-pid', pid };
  }
  const aliveBefore = probePidAlive(pid);
  if (aliveBefore.alive === null) {
    return { ok: false, reason: 'pid-probe-uncertain', pid };
  }
  if (aliveBefore.alive === false) {
    return { ok: true, alreadyStopped: true };
  }
  if (verifyFn && !verifyFn()) {
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
  return { ok: true, label };
}

export function stopRegisteredProcesses(runId, { kinds = null, instance = null, strict = true } = {}) {
  const all = loadManagedProcesses(runId);
  const processes = kinds ? all.filter((entry) => kinds.includes(entry.kind)) : all;
  const removedPids = new Set();
  for (const entry of processes) {
    const alive = probePidAlive(entry.pid);
    if (alive.alive === false) {
      removedPids.add(entry.pid);
      continue;
    }
    if (alive.alive === null) {
      if (strict) {
        throw new Error(`无法确认 pid=${entry.pid} 状态，拒绝停止（保留现场）`);
      }
      continue;
    }
    const commandLine = resolveProcessCommandLine(entry.pid);
    const identity = verifyRegisteredProcessIdentity(entry, commandLine, { instance, runId });
    if (!identity.ok) {
      if (strict) {
        throw new Error(
          `拒绝停止 pid=${entry.pid}：${identity.reason}（保留现场，不调用 taskkill）`,
        );
      }
      continue;
    }
    const result = stopVerifiedPid(entry.pid, entry.kind, () => true);
    if (!result.ok && !result.alreadyStopped) {
      if (strict) {
        throw new Error(`停止已注册进程失败: ${JSON.stringify(result)}`);
      }
      continue;
    }
    removedPids.add(entry.pid);
  }
  const kept = all.filter((entry) => !removedPids.has(entry.pid));
  saveManagedProcesses(runId, kept);
}
