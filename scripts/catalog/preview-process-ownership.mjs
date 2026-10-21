import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probePidAlive } from '../p0-02/instance-guard.mjs';
import {
  resolveProcessCommandLine,
  resolveProcessCreationTimeMs,
} from '../p0-02/process-identity.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PREVIEW_LAUNCHER = path.join(REPO_ROOT, 'scripts/catalog/catalog-next-preview-dev.mjs');
const MAX_STARTED_AT_SKEW_MS = 120_000;

function normalizeCmd(value) {
  return value.replace(/\\/g, '/').toLowerCase();
}

function normalizePath(value) {
  return normalizeCmd(path.resolve(value));
}

function extractFlagValue(commandLine, flag) {
  if (!commandLine) return null;
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = commandLine.match(new RegExp(`${escaped}\\s+"([^"]+)"|${escaped}\\s+(\\S+)`, 'i'));
  return match ? (match[1] ?? match[2] ?? null) : null;
}

function extractPostgresDataDirArg(commandLine) {
  if (!commandLine) return null;
  const match = commandLine.match(/(?:^|\s)-D\s+"([^"]+)"|(?:^|\s)-D\s+(\S+)/i);
  return match ? (match[1] ?? match[2] ?? null) : null;
}

function catalogPostgresMatchesInstance(commandLine, instance) {
  if (!commandLine || !/postgres/i.test(commandLine)) return false;
  const dataArg = extractPostgresDataDirArg(commandLine);
  if (!dataArg || normalizeCmd(dataArg) !== normalizeCmd(instance.dataDir)) return false;
  const portMatch = commandLine.match(/(?:^|\s)-p\s+(\d+)/i);
  if (portMatch && Number.parseInt(portMatch[1], 10) !== instance.port) return false;
  const expectedExe = normalizeCmd(path.join(instance.pgBinDir, 'postgres.exe'));
  const cmd = normalizeCmd(commandLine);
  if (expectedExe && cmd.includes(expectedExe)) return true;
  return /\bpostgres(\.exe)?\b/i.test(commandLine);
}

export function catalogPreviewLauncherPath() {
  return PREVIEW_LAUNCHER;
}

/**
 * @param {string} commandLine
 * @param {{ workspace: string, runId: string, port?: number, startedAt?: string, processCreatedAt?: string }} marker
 */
export function catalogPreviewLauncherMatchesMarker(commandLine, marker) {
  if (!commandLine || !/\bcatalog-next-preview-dev\.mjs\b/i.test(commandLine)) {
    return false;
  }
  const launcher = normalizePath(PREVIEW_LAUNCHER);
  if (!normalizeCmd(commandLine).includes(normalizeCmd(launcher))) {
    return false;
  }
  if (!/\bdev\b/i.test(commandLine)) {
    return false;
  }
  const workspaceArg = extractFlagValue(commandLine, '--catalog-workspace');
  const runIdArg = extractFlagValue(commandLine, '--catalog-run-id');
  if (!workspaceArg || !runIdArg) {
    return false;
  }
  if (normalizePath(workspaceArg) !== normalizePath(marker.workspace)) {
    return false;
  }
  if (runIdArg !== marker.runId) {
    return false;
  }
  if (marker.port != null && !new RegExp(`(?:^|\\s)-p\\s+${marker.port}(?:\\s|$)`).test(commandLine)) {
    return false;
  }
  return true;
}

function markerTimesConsistent(marker, processCreatedMs) {
  if (!marker.startedAt || !marker.processCreatedAt) {
    return false;
  }
  const startedMs = Date.parse(marker.startedAt);
  const recordedCreatedMs = Date.parse(marker.processCreatedAt);
  if (!Number.isFinite(startedMs) || !Number.isFinite(recordedCreatedMs) || processCreatedMs == null) {
    return false;
  }
  if (Math.abs(recordedCreatedMs - processCreatedMs) > 2_000) {
    return false;
  }
  if (Math.abs(startedMs - recordedCreatedMs) > MAX_STARTED_AT_SKEW_MS) {
    return false;
  }
  return true;
}

export function pidAlive(pid) {
  if (!pid || !Number.isInteger(pid)) return false;
  const probe = probePidAlive(pid);
  return probe.alive === true;
}

/**
 * @param {number} pid
 * @param {{ workspace: string, runId: string, port?: number, startedAt?: string, processCreatedAt?: string }} marker
 */
export function verifyPreviewServerOwnership(pid, marker) {
  if (!marker?.workspace || !marker?.runId) {
    return { ok: false, code: 'CATALOG_PREVIEW_MARKER_INCOMPLETE', message: 'preview-server marker missing workspace or runId' };
  }
  if (!marker.processCreatedAt) {
    return {
      ok: false,
      code: 'CATALOG_PREVIEW_MARKER_INCOMPLETE',
      message: 'preview-server marker missing processCreatedAt (strict launcher binding required)',
    };
  }
  if (!marker.startedAt) {
    return { ok: false, code: 'CATALOG_PREVIEW_MARKER_INCOMPLETE', message: 'preview-server marker missing startedAt' };
  }
  if (!pidAlive(pid)) {
    return { ok: false, code: 'CATALOG_PREVIEW_PID_NOT_ALIVE', message: `pid ${pid} is not alive` };
  }
  const commandLine = resolveProcessCommandLine(pid);
  if (!commandLine) {
    return { ok: false, code: 'CATALOG_PREVIEW_CMDLINE_UNAVAILABLE', message: `cannot read command line for pid ${pid}` };
  }
  const workspace = path.resolve(marker.workspace);
  if (!fs.existsSync(workspace)) {
    return { ok: false, code: 'CATALOG_PREVIEW_WORKSPACE_MISSING', message: `workspace missing: ${workspace}` };
  }
  if (!catalogPreviewLauncherMatchesMarker(commandLine, { ...marker, workspace })) {
    return { ok: false, code: 'CATALOG_PREVIEW_PID_MISMATCH', message: `pid ${pid} is not catalog Next dev for workspace ${workspace}` };
  }
  const processCreatedMs = resolveProcessCreationTimeMs(pid);
  if (processCreatedMs == null) {
    return { ok: false, code: 'CATALOG_PREVIEW_PROCESS_TIME_UNAVAILABLE', message: `cannot read process creation time for pid ${pid}` };
  }
  if (!markerTimesConsistent(marker, processCreatedMs)) {
    return { ok: false, code: 'CATALOG_PREVIEW_PROCESS_TIME_MISMATCH', message: `pid ${pid} creation time or marker timestamps do not match` };
  }
  return { ok: true, commandLine, workspace, pid, processCreatedMs };
}

/**
 * @param {number} pid
 * @param {object} instance
 */
export function verifyCatalogPostgresOwnership(pid, instance) {
  if (!pidAlive(pid)) {
    return { ok: false, code: 'CATALOG_POSTGRES_PID_NOT_ALIVE', message: `pid ${pid} is not alive` };
  }
  const commandLine = resolveProcessCommandLine(pid);
  if (!commandLine) {
    return { ok: false, code: 'CATALOG_POSTGRES_CMDLINE_UNAVAILABLE', message: `cannot read command line for pid ${pid}` };
  }
  if (!catalogPostgresMatchesInstance(commandLine, instance)) {
    return { ok: false, code: 'CATALOG_POSTGRES_PID_MISMATCH', message: `pid ${pid} is not postgres for dataDir ${instance.dataDir}` };
  }
  return { ok: true, commandLine, pid };
}

export function readPreviewProcessCreatedAtIso(pid) {
  const ms = resolveProcessCreationTimeMs(pid);
  if (ms == null) {
    return null;
  }
  return new Date(ms).toISOString();
}
