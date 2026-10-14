import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

import { detachedHiddenServerOptions, pgExe, withHiddenWindowsSpawnOptions } from './common.mjs';
import { probePidAlive } from './instance-guard.mjs';
import { readPostmasterPidStrict } from './process-identity.mjs';

function quoteCmd(value) {
  return `"${value.replace(/"/g, '""')}"`;
}

function buildHiddenVbsBody(cmdPath) {
  const escaped = cmdPath.replace(/"/g, '""');
  return `CreateObject("Wscript.Shell").Run "${'""'}${escaped}${'""'}", 0, False\r\n`;
}

export function readPostmasterPid(dataDir) {
  const parsed = readPostmasterPidStrict(dataDir);
  if (parsed.kind === 'missing') {
    return null;
  }
  if (parsed.kind === 'malformed') {
    throw new Error(`postmaster.pid 损坏（${parsed.reason ?? 'invalid'}=${parsed.raw ?? ''}）`);
  }
  return parsed.pid;
}

export function removeStalePostmasterPid(dataDir) {
  const parsed = readPostmasterPidStrict(dataDir);
  if (parsed.kind === 'missing') {
    return;
  }
  if (parsed.kind === 'malformed') {
    throw new Error(`postmaster.pid 损坏（${parsed.reason ?? 'invalid'}），拒绝删除 pid 文件`);
  }
  const pid = parsed.pid;
  const alive = probePidAlive(pid);
  if (alive.alive === true) {
    throw new Error(`PostgreSQL 已在运行 pid=${pid}`);
  }
  if (alive.alive === null) {
    throw new Error(`无法确认 postmaster pid=${pid} 状态（${alive.reason}），拒绝删除 pid 文件`);
  }
  fs.unlinkSync(path.join(dataDir, 'postmaster.pid'));
}

/**
 * Start PostgreSQL without interactive console windows on Windows.
 * @param {{ runRootDir: string, dataDir: string, port: number, host?: string, logFile: string, runId?: string }} config
 */
export function startPostgresServer(config) {
  const { runRootDir, dataDir, port, logFile, runId } = config;
  const host = config.host ?? '127.0.0.1';
  const postgresExe = pgExe('postgres', runId);

  removeStalePostmasterPid(dataDir);

  if (process.platform === 'win32') {
    const cmdPath = path.join(runRootDir, 'start-postgres.cmd');
    const cmdBody = [
      '@echo off',
      `${quoteCmd(postgresExe)} -D ${quoteCmd(dataDir)} -p ${port} -h ${host} -k "" >> ${quoteCmd(logFile)} 2>&1`,
      '',
    ].join('\r\n');
    fs.writeFileSync(cmdPath, cmdBody, 'utf8');

    const vbsPath = path.join(runRootDir, 'start-postgres-hidden.vbs');
    fs.writeFileSync(vbsPath, buildHiddenVbsBody(cmdPath), 'utf8');

    const wscript = process.env.SystemRoot
      ? path.join(process.env.SystemRoot, 'System32', 'wscript.exe')
      : 'wscript.exe';
    const launched = spawnSync(
      wscript,
      ['//B', vbsPath],
      withHiddenWindowsSpawnOptions({ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    );
    if (launched.error) {
      throw new Error(`无法无窗口启动 PostgreSQL: ${launched.error.message}`);
    }
    return { launchMode: 'wscript' };
  }

  const proc = spawn(
    postgresExe,
    ['-D', dataDir, '-p', String(port), '-h', host, '-k', ''],
    detachedHiddenServerOptions({
      stdio: ['ignore', 'ignore', fs.openSync(logFile, 'a')],
    }),
  );
  proc.unref();
  return { launchMode: 'spawn', pid: proc.pid };
}
