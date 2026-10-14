import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  DEFAULT_RUN_ID,
  pgExe,
  p0DatabaseName,
  randomSecret,
  runRoot,
  saveInstance,
  withHiddenWindowsSpawnOptions,
} from './common.mjs';
import { guardP001Entry } from './entry-guard.mjs';
import { readPostmasterPid, startPostgresServer } from './postgres-process.mjs';

const runId = DEFAULT_RUN_ID;
guardP001Entry(runId);
const root = runRoot(runId);
const dataDir = path.join(root, 'pgdata');
const logFile = path.join(root, 'postgres.log');

function pickPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('无法分配端口'));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

function rewriteHbaToScram(dataDir) {
  const hbaPath = path.join(dataDir, 'pg_hba.conf');
  const lines = fs
    .readFileSync(hbaPath, 'utf8')
    .split(/\r?\n/)
    .filter(
      (line) =>
        !line.includes('127.0.0.1/32 trust') &&
        !line.includes('::1/128 trust') &&
        !/host\s+all\s+all\s+127\.0\.0\.1\/32\s+trust/i.test(line),
    );
  lines.push('# p0-01 loopback password only');
  lines.push('host all all 127.0.0.1/32 scram-sha-256');
  lines.push('host all all ::1/128 scram-sha-256');
  fs.writeFileSync(hbaPath, `${lines.join('\n')}\n`, 'utf8');
}

function waitForPostgres(port, attempts = 60) {
  for (let i = 0; i < attempts; i += 1) {
    const probe = spawnSync(
      pgExe('psql'),
      [
        '-h',
        '127.0.0.1',
        '-p',
        String(port),
        '-U',
        'postgres',
        '-d',
        'postgres',
        '-c',
        'SELECT 1',
      ],
      withHiddenWindowsSpawnOptions({ encoding: 'utf8' }),
    );
    if (probe.status === 0) {
      return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  throw new Error('PostgreSQL 启动超时');
}

async function main() {
  fs.mkdirSync(root, { recursive: true });

  const bootstrapPassword = randomSecret(16);
  const authRunnerPassword = randomSecret(16);
  const appRunnerPassword = randomSecret(16);
  const dbName = p0DatabaseName(runId);
  const port = await pickPort();

  if (!fs.existsSync(dataDir)) {
    const init = spawnSync(
      pgExe('initdb'),
      ['-D', dataDir, '-U', 'postgres', '-A', 'trust', '--encoding=UTF8', '--locale=C'],
      withHiddenWindowsSpawnOptions({ encoding: 'utf8' }),
    );
    if (init.status !== 0) {
      console.error(init.stderr);
      throw new Error('initdb 失败');
    }
    const hbaPath = path.join(dataDir, 'pg_hba.conf');
    fs.appendFileSync(
      hbaPath,
      '\n# p0-01 bootstrap (loopback only)\nhost all all 127.0.0.1/32 trust\nhost all all ::1/128 trust\n',
    );
  }

  const pgVersion = spawnSync(
    pgExe('postgres'),
    ['--version'],
    withHiddenWindowsSpawnOptions({ encoding: 'utf8' }),
  ).stdout.trim();

  startPostgresServer({
    runRootDir: root,
    dataDir,
    port,
    host: '127.0.0.1',
    logFile,
    runId,
  });

  await waitForPostgres(port);

  const postmasterPid = readPostmasterPid(dataDir);

  const env = { ...process.env };

  spawnSync(
    pgExe('psql'),
    ['-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', 'postgres', '-c', `ALTER USER postgres PASSWORD '${bootstrapPassword}'`],
    withHiddenWindowsSpawnOptions({ encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }),
  );

  const createDb = spawnSync(
    pgExe('psql'),
    ['-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', 'postgres', '-c', `CREATE DATABASE ${dbName}`],
    withHiddenWindowsSpawnOptions({ encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }),
  );
  if (createDb.status !== 0) {
    const detail = [createDb.stderr, createDb.stdout].filter(Boolean).join('\n').trim();
    throw new Error(`CREATE DATABASE 失败: ${detail}`);
  }
  const dbExists = spawnSync(
    pgExe('psql'),
    [
      '-h',
      '127.0.0.1',
      '-p',
      String(port),
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-tA',
      '-c',
      `SELECT 1 FROM pg_database WHERE datname='${dbName}'`,
    ],
    withHiddenWindowsSpawnOptions({ encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }),
  );
  if (dbExists.stdout?.trim() !== '1') {
    throw new Error(`CREATE DATABASE 后未找到库 ${dbName}`);
  }

  rewriteHbaToScram(dataDir);
  spawnSync(
    pgExe('psql'),
    [
      '-h',
      '127.0.0.1',
      '-p',
      String(port),
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-c',
      'SELECT pg_reload_conf()',
    ],
    withHiddenWindowsSpawnOptions({
      encoding: 'utf8',
      env: { ...env, PGPASSWORD: bootstrapPassword },
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );

  const wrongPassword = spawnSync(
    pgExe('psql'),
    ['-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', 'postgres', '-c', 'SELECT 1'],
    withHiddenWindowsSpawnOptions({
      encoding: 'utf8',
      env: { ...env, PGPASSWORD: 'definitely-wrong-password' },
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
  if (wrongPassword.status === 0) {
    throw new Error('PostgreSQL 仍接受错误密码，pg_hba 未生效');
  }

  const instance = {
    runId,
    label: 'p0-01',
    pgVersion,
    port,
    host: '127.0.0.1',
    dataDir,
    logFile,
    dbName,
    pid: postmasterPid,
    bootstrapUser: 'postgres',
    bootstrapPassword,
    authRunnerUser: 'ice_p0_01_auth_runner',
    authRunnerPassword,
    appRunnerUser: 'ice_p0_01_app_runner',
    appRunnerPassword,
    betterAuthSecret: randomSecret(32),
    createdAt: new Date().toISOString(),
  };

  saveInstance(runId, instance);

  fs.writeFileSync(
    path.join(root, 'bootstrap-pending.json'),
    `${JSON.stringify({ runId, createdAt: new Date().toISOString(), phase: 'pending-first-apply' }, null, 2)}\n`,
  );

  fs.writeFileSync(
    path.join(root, 'env.p0-01.json'),
    `${JSON.stringify(
      {
        P0_01_ENABLED: 'true',
        P0_01_RUN_ID: runId,
        P0_01_APP_DATABASE_URL: `postgres://${instance.appRunnerUser}:${appRunnerPassword}@${instance.host}:${port}/${dbName}?options=${encodeURIComponent('-c search_path=p0_01_biz,public')}`,
        P0_01_AUTH_DATABASE_URL: `postgres://${instance.authRunnerUser}:${authRunnerPassword}@${instance.host}:${port}/${dbName}?options=${encodeURIComponent('-c search_path=p0_01_auth')}`,
        P0_01_BETTER_AUTH_SECRET: instance.betterAuthSecret,
        P0_01_BETTER_AUTH_URL: 'http://127.0.0.1:0',
        P0_01_POOL_MAX: '10',
        P0_01_EXPECTED_HOST: instance.host,
        P0_01_EXPECTED_PORT: String(port),
        P0_01_EXPECTED_DATABASE: dbName,
        P0_01_EXPECTED_APP_USER: instance.appRunnerUser,
        P0_01_EXPECTED_AUTH_USER: instance.authRunnerUser,
      },
      null,
      2,
    )}\n`,
  );

  console.log(JSON.stringify({ runId, port, dbName, pid: postmasterPid }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
