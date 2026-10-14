import 'server-only';

import {
  assertP001ConnectionContract,
  parseP001PostgresUrl,
} from './p0-01-database-url';

const ALLOWED_ENV_KEYS = [
  'P0_01_ENABLED',
  'P0_01_RUN_ID',
  'P0_01_APP_DATABASE_URL',
  'P0_01_AUTH_DATABASE_URL',
  'P0_01_BETTER_AUTH_SECRET',
  'P0_01_BETTER_AUTH_URL',
  'P0_01_POOL_MAX',
  'P0_01_EXPECTED_HOST',
  'P0_01_EXPECTED_PORT',
  'P0_01_EXPECTED_DATABASE',
  'P0_01_EXPECTED_APP_USER',
  'P0_01_EXPECTED_AUTH_USER',
  'NODE_ENV',
] as const;

export type P001RuntimeConfig = {
  enabled: true;
  runId: string;
  appDatabaseUrl: string;
  authDatabaseUrl: string;
  betterAuthSecret: string;
  betterAuthUrl: string;
  poolMax: number;
};

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === '' ? undefined : value;
}

export function assertP001EnvWhitelist(extraKeys: string[] = []): void {
  const allowed = new Set<string>([...ALLOWED_ENV_KEYS, ...extraKeys]);
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('SUPABASE_') || key === 'DATABASE_URL' || key.startsWith('PG')) {
      throw new Error(`P0-01 隔离环境禁止加载 ${key}`);
    }
    if (!allowed.has(key) && !key.startsWith('P0_01_')) {
      if (
        key.startsWith('npm_') ||
        key.startsWith('NODE_') ||
        key === 'PATH' ||
        key === 'PATHEXT' ||
        key === 'SystemRoot' ||
        key === 'TEMP' ||
        key === 'TMP' ||
        key === 'USERPROFILE' ||
        key === 'HOMEDRIVE' ||
        key === 'HOMEPATH' ||
        key === 'COMPUTERNAME' ||
        key === 'NUMBER_OF_PROCESSORS' ||
        key === 'OS' ||
        key === 'PROCESSOR_ARCHITECTURE' ||
        key === 'WINDIR' ||
        key === 'ComSpec' ||
        key === 'ProgramFiles' ||
        key === 'ProgramFiles(x86)' ||
        key === 'ProgramW6432' ||
        key === 'CommonProgramFiles' ||
        key === 'CommonProgramW6432' ||
        key === 'APPDATA' ||
        key === 'LOCALAPPDATA' ||
        key === 'SESSIONNAME' ||
        key === 'USERNAME' ||
        key === 'USERDOMAIN' ||
        key === 'LOGONSERVER' ||
        key === 'VITEST' ||
        key === 'VITEST_POOL_ID' ||
        key === 'VITEST_WORKER_ID' ||
        key === 'CI' ||
        key === 'FORCE_COLOR' ||
        key === 'NO_COLOR' ||
        key === 'TERM' ||
        key === 'PORT' ||
        key === 'HOSTNAME'
      ) {
        continue;
      }
    }
  }
}

function validateConnectionContract(
  runId: string,
  appDatabaseUrl: string,
  authDatabaseUrl: string,
): void {
  const expectedHost = readEnv('P0_01_EXPECTED_HOST');
  const expectedPortRaw = readEnv('P0_01_EXPECTED_PORT');
  const expectedDatabase = readEnv('P0_01_EXPECTED_DATABASE');
  const expectedAppUser = readEnv('P0_01_EXPECTED_APP_USER');
  const expectedAuthUser = readEnv('P0_01_EXPECTED_AUTH_USER');

  if (
    !expectedHost ||
    !expectedPortRaw ||
    !expectedDatabase ||
    !expectedAppUser ||
    !expectedAuthUser
  ) {
    throw new Error('P0-01 已启用但缺少连接契约（P0_01_EXPECTED_*）');
  }

  const expectedPort = Number.parseInt(expectedPortRaw, 10);
  if (!Number.isFinite(expectedPort)) {
    throw new Error('P0_01_EXPECTED_PORT 无效');
  }

  assertP001ConnectionContract(appDatabaseUrl, authDatabaseUrl, {
    host: expectedHost,
    port: expectedPort,
    database: expectedDatabase,
    appUser: expectedAppUser,
    authUser: expectedAuthUser,
    runId,
  });
}

export function loadP001Config(): P001RuntimeConfig | null {
  const enabled = readEnv('P0_01_ENABLED');
  if (enabled !== 'true') {
    return null;
  }

  try {
    assertP001EnvWhitelist([
      'NEXT_TELEMETRY_DISABLED',
      'P0_01_NETWORK_GUARD_SELF_TEST',
      'P0_01_GUARD_PROBE',
      'P0_01_DISABLE_AUTH_RATE_LIMIT',
      'P0_01_ALLOWED_PORTS',
      'P0_01_NETWORK_GUARD_INSTALLED',
    ]);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : 'P0-01 环境白名单校验失败');
  }

  const runId = readEnv('P0_01_RUN_ID');
  const appDatabaseUrl = readEnv('P0_01_APP_DATABASE_URL');
  const authDatabaseUrl = readEnv('P0_01_AUTH_DATABASE_URL');
  const betterAuthSecret = readEnv('P0_01_BETTER_AUTH_SECRET');
  const betterAuthUrl = readEnv('P0_01_BETTER_AUTH_URL');
  const poolMaxRaw = readEnv('P0_01_POOL_MAX') ?? '10';

  if (!runId || !appDatabaseUrl || !authDatabaseUrl || !betterAuthSecret || !betterAuthUrl) {
    throw new Error('P0-01 已启用但缺少必需配置项');
  }

  if (!runId.startsWith('run-')) {
    throw new Error('P0_01_RUN_ID 无效');
  }

  parseP001PostgresUrl(appDatabaseUrl, 'P0_01_APP_DATABASE_URL');
  parseP001PostgresUrl(authDatabaseUrl, 'P0_01_AUTH_DATABASE_URL');
  validateConnectionContract(runId, appDatabaseUrl, authDatabaseUrl);

  let authBase: URL;
  try {
    authBase = new URL(betterAuthUrl);
  } catch {
    throw new Error('P0_01_BETTER_AUTH_URL 无效');
  }
  if (authBase.protocol !== 'http:' && authBase.protocol !== 'https:') {
    throw new Error('P0_01_BETTER_AUTH_URL 协议无效');
  }
  if (authBase.hostname !== '127.0.0.1' && authBase.hostname !== 'localhost' && authBase.hostname !== '::1') {
    throw new Error('P0_01_BETTER_AUTH_URL 必须指向本机');
  }

  const poolMax = Number.parseInt(poolMaxRaw, 10);
  if (!Number.isFinite(poolMax) || poolMax < 1) {
    throw new Error('P0_01_POOL_MAX 无效');
  }

  return {
    enabled: true,
    runId,
    appDatabaseUrl,
    authDatabaseUrl,
    betterAuthSecret,
    betterAuthUrl,
    poolMax,
  };
}

export function requireP001Config(): P001RuntimeConfig {
  const config = loadP001Config();
  if (!config) {
    throw new Error('P0-01 未启用');
  }
  return config;
}
