import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  DEFAULT_RUN_ID,
  PG_ZIP_URL,
  pgExe,
  runRoot,
  sha256File,
  withHiddenWindowsSpawnOptions,
} from './common.mjs';

const runId = DEFAULT_RUN_ID;
const root = runRoot(runId);
const zipPath = path.join(root, 'postgresql-17.11-1-windows-x64-binaries.zip');
const metaPath = path.join(root, 'pg-download.json');

if (fs.existsSync(pgExe('postgres', runId))) {
  console.log('PostgreSQL 17.11 二进制已存在，跳过下载');
  process.exit(0);
}

fs.mkdirSync(root, { recursive: true });

console.log('下载 PostgreSQL 17.11 Windows x64 二进制…');
const curl = spawnSync(
  'curl.exe',
  ['-L', '--fail', '-o', zipPath, PG_ZIP_URL],
  { stdio: 'inherit' },
);
if (curl.status !== 0) {
  console.error('BLOCKED: 无法下载 PostgreSQL 17.11');
  process.exit(curl.status ?? 1);
}

const zipHash = sha256File(zipPath);
fs.writeFileSync(
  metaPath,
  `${JSON.stringify({ url: PG_ZIP_URL, version: '17.11', sha256: zipHash, downloadedAt: new Date().toISOString() }, null, 2)}\n`,
);

console.log('解压…');
fs.mkdirSync(path.join(root, 'pg'), { recursive: true });
const tar = spawnSync(
  'tar',
  ['-xf', zipPath, '-C', path.join(root, 'pg')],
  { stdio: 'inherit' },
);
if (tar.status !== 0) {
  console.error('BLOCKED: 解压失败');
  process.exit(tar.status ?? 1);
}

if (!fs.existsSync(pgExe('postgres', runId))) {
  console.error('BLOCKED: 解压后未找到 postgres.exe');
  process.exit(1);
}

const version = spawnSync(
  pgExe('postgres', runId),
  ['--version'],
  withHiddenWindowsSpawnOptions({ encoding: 'utf8' }),
);
console.log(version.stdout.trim());
console.log(`SHA-256(zip)=${zipHash}`);
