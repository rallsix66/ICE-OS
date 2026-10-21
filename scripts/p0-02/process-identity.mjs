import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { pgExe, withHiddenWindowsSpawnOptions } from './common.mjs';

function normalizePath(p) {
  return path.resolve(p).replace(/\\/g, '/').toLowerCase();
}

const MAX_PID_DIGITS = 10;

export function parseStrictPostmasterPidLine(firstLine) {
  const trimmed = (firstLine ?? '').trim();
  if (!/^[1-9]\d*$/.test(trimmed)) {
    return { ok: false, reason: 'invalid-pid-format', raw: trimmed };
  }
  if (trimmed.length > MAX_PID_DIGITS) {
    return { ok: false, reason: 'pid-out-of-range', raw: trimmed };
  }
  const pid = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return { ok: false, reason: 'pid-out-of-range', raw: trimmed };
  }
  return { ok: true, pid };
}

export function readPostmasterPidStrict(dataDir) {
  const file = path.join(dataDir, 'postmaster.pid');
  if (!fs.existsSync(file)) {
    return { kind: 'missing' };
  }
  const firstLine = fs.readFileSync(file, 'utf8').split(/\r?\n/)[0];
  const parsed = parseStrictPostmasterPidLine(firstLine);
  if (!parsed.ok) {
    return { kind: 'malformed', reason: parsed.reason, raw: parsed.raw };
  }
  return { kind: 'ok', pid: parsed.pid, file };
}

export function resolveProcessCommandLine(pid) {
  if (process.platform === 'win32') {
    const result = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue).CommandLine`,
      ],
      withHiddenWindowsSpawnOptions({ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    );
    return (result.stdout ?? '').trim();
  }
  return '';
}

export function resolveProcessCreationTimeMs(pid) {
  if (process.platform !== 'win32') {
    return null;
  }
  const result = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue; if (-not $p) { exit 1 }; ([datetime]$p.CreationDate).ToUniversalTime().ToString('o')`,
    ],
    withHiddenWindowsSpawnOptions({ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
  );
  const raw = (result.stdout ?? '').trim();
  if (!raw || result.status !== 0) {
    return null;
  }
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

function extractExecutableToken(commandLine) {
  const trimmed = (commandLine ?? '').trim();
  if (!trimmed) {
    return '';
  }
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1);
    if (end > 1) {
      return trimmed.slice(1, end);
    }
  }
  return trimmed.split(/\s+/)[0] ?? '';
}

function extractPostgresDataDirArg(commandLine) {
  if (!commandLine) {
    return null;
  }
  const match = commandLine.match(/(?:^|\s)-D\s+"([^"]+)"|(?:^|\s)-D\s+(\S+)/i);
  if (!match) {
    return null;
  }
  return match[1] ?? match[2] ?? null;
}

function extractPostgresPortArg(commandLine) {
  if (!commandLine) {
    return null;
  }
  const match = commandLine.match(/(?:^|\s)-p\s+(\d+)/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

export function postgresCommandMatchesInstance(commandLine, instance, runId) {
  if (!commandLine || !/postgres/i.test(commandLine)) {
    return false;
  }
  const expectedExe = normalizePath(pgExe('postgres', runId));
  const exeToken = extractExecutableToken(commandLine);
  if (exeToken.includes('\\') || exeToken.includes('/')) {
    if (normalizePath(exeToken) !== expectedExe) {
      return false;
    }
  } else if (exeToken && !/^postgres(\.exe)?$/i.test(exeToken)) {
    return false;
  }
  const dataArg = extractPostgresDataDirArg(commandLine);
  if (!dataArg) {
    return false;
  }
  if (normalizePath(dataArg) !== normalizePath(instance.dataDir)) {
    return false;
  }
  const portArg = extractPostgresPortArg(commandLine);
  if (portArg !== null && portArg !== instance.port) {
    return false;
  }
  return true;
}

export function nextProcessMatchesRegisteredWorkspace(commandLine, registeredWorkspaceRoot) {
  if (!commandLine || !registeredWorkspaceRoot) {
    return false;
  }
  if (!/\bnext(\.js)?\b/i.test(commandLine)) {
    return false;
  }
  const workspace = path.resolve(registeredWorkspaceRoot);
  const required = path.join(workspace, 'node_modules', 'next').replace(/\\/g, '/');
  const cmd = commandLine.replace(/\\/g, '/');
  const idx = cmd.toLowerCase().indexOf(required.toLowerCase());
  if (idx < 0) {
    return false;
  }
  const before = idx > 0 ? cmd[idx - 1] : '';
  if (before && before !== ' ' && before !== '"' && before !== "'") {
    return false;
  }
  const after = cmd.slice(idx + required.length);
  if (!after.startsWith('/')) {
    return false;
  }
  return true;
}

export function nextCommandMatchesExactWorkspace(commandLine, workspaceRoot) {
  return nextProcessMatchesRegisteredWorkspace(commandLine, workspaceRoot);
}

export function nextCommandMatchesWorkspace(commandLine, workspaceRoot) {
  return nextCommandMatchesExactWorkspace(commandLine, workspaceRoot);
}
