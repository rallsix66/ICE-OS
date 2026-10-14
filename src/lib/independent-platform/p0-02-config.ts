import 'server-only';

import {
  assertP001ConnectionContract,
  assertP001DatabaseUrlMatches,
  parseP001PostgresUrl,
} from './p0-01-database-url';

const ALLOWED_ENV_KEYS = [
  'P0_02_ENABLED',
  'P0_02_RUN_ID',
  'P0_02_APP_DATABASE_URL',
  'P0_02_SYNC_DATABASE_URL',
  'P0_02_AUTH_DATABASE_URL',
  'P0_02_BETTER_AUTH_SECRET',
  'P0_02_BETTER_AUTH_URL',
  'P0_02_POOL_MAX',
  'P0_02_EXPECTED_HOST',
  'P0_02_EXPECTED_PORT',
  'P0_02_EXPECTED_DATABASE',
  'P0_02_EXPECTED_APP_USER',
  'P0_02_EXPECTED_AUTH_USER',
  'P0_02_EXPECTED_SYNC_USER',
  'NODE_ENV',
] as const;

export type P002RuntimeConfig = {
  enabled: true;
  runId: string;
  appDatabaseUrl: string;
  syncDatabaseUrl: string;
  authDatabaseUrl: string;
  betterAuthSecret: string;
  betterAuthUrl: string;
  poolMax: number;
};

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === '' ? undefined : value;
}

export function assertP002EnvWhitelist(extraKeys: string[] = []): void {
  const allowed = new Set<string>([...ALLOWED_ENV_KEYS, ...extraKeys]);
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('SUPABASE_') || key === 'DATABASE_URL' || key.startsWith('NEXT_PUBLIC_SUPABASE')) {
      throw new Error(`P0-02 隔离环境禁止加载 ${key}`);
    }
    if (!allowed.has(key) && !key.startsWith('P0_02_')) {
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
        key === 'HOSTNAME' ||
        key === 'NEXT_TELEMETRY_DISABLED'
      ) {
        continue;
      }
    }
  }
}

export function validateP002ConnectionContract(
  runId: string,
  appDatabaseUrl: string,
  authDatabaseUrl: string,
  syncDatabaseUrl: string,
): void {
  const expectedHost = readEnv('P0_02_EXPECTED_HOST');
  const expectedPortRaw = readEnv('P0_02_EXPECTED_PORT');
  const expectedDatabase = readEnv('P0_02_EXPECTED_DATABASE');
  const expectedAppUser = readEnv('P0_02_EXPECTED_APP_USER');
  const expectedAuthUser = readEnv('P0_02_EXPECTED_AUTH_USER');
  const expectedSyncUser = readEnv('P0_02_EXPECTED_SYNC_USER');

  if (
    !expectedHost ||
    !expectedPortRaw ||
    !expectedDatabase ||
    !expectedAppUser ||
    !expectedAuthUser ||
    !expectedSyncUser
  ) {
    throw new Error('P0-02 已启用但缺少连接契约（P0_02_EXPECTED_*）');
  }

  const expectedPort = Number.parseInt(expectedPortRaw, 10);
  if (!Number.isFinite(expectedPort)) {
    throw new Error('P0_02_EXPECTED_PORT 无效');
  }

  assertP001ConnectionContract(appDatabaseUrl, authDatabaseUrl, {
    host: expectedHost,
    port: expectedPort,
    database: expectedDatabase,
    appUser: expectedAppUser,
    authUser: expectedAuthUser,
    runId,
  });

  assertP001DatabaseUrlMatches(
    syncDatabaseUrl,
    {
      host: expectedHost,
      port: expectedPort,
      database: expectedDatabase,
      user: expectedSyncUser,
    },
    'P0_02_SYNC_DATABASE_URL',
  );

  const canonicalRunToken = runId.replace(/[^a-z0-9]+/gi, '_').toLowerCase();
  if (!expectedDatabase.toLowerCase().includes(canonicalRunToken)) {
    throw new Error('P0_02 数据库名与 run ID 不一致');
  }
}

export function loadP002Config(): P002RuntimeConfig | null {
  const enabled = readEnv('P0_02_ENABLED');
  if (enabled !== 'true') {
    return null;
  }

  try {
    assertP002EnvWhitelist([
      'NEXT_TELEMETRY_DISABLED',
      'P0_02_NETWORK_GUARD_SELF_TEST',
      'P0_02_DISABLE_AUTH_RATE_LIMIT',
      'P0_02_ALLOWED_PORTS',
      'P0_02_NETWORK_GUARD_INSTALLED',
    ]);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : 'P0-02 环境白名单校验失败');
  }

  const runId = readEnv('P0_02_RUN_ID');
  const appDatabaseUrl = readEnv('P0_02_APP_DATABASE_URL');
  const syncDatabaseUrl = readEnv('P0_02_SYNC_DATABASE_URL');
  const authDatabaseUrl = readEnv('P0_02_AUTH_DATABASE_URL');
  const betterAuthSecret = readEnv('P0_02_BETTER_AUTH_SECRET');
  const betterAuthUrl = readEnv('P0_02_BETTER_AUTH_URL');
  const poolMaxRaw = readEnv('P0_02_POOL_MAX') ?? '10';

  if (!runId || !appDatabaseUrl || !syncDatabaseUrl || !authDatabaseUrl || !betterAuthSecret || !betterAuthUrl) {
    throw new Error('P0-02 已启用但缺少必需配置项');
  }

  if (!runId.startsWith('run-')) {
    throw new Error('P0_02_RUN_ID 无效');
  }

  parseP001PostgresUrl(appDatabaseUrl, 'P0_02_APP_DATABASE_URL');
  parseP001PostgresUrl(authDatabaseUrl, 'P0_02_AUTH_DATABASE_URL');
  validateP002ConnectionContract(runId, appDatabaseUrl, authDatabaseUrl, syncDatabaseUrl);

  let authBase: URL;
  try {
    authBase = new URL(betterAuthUrl);
  } catch {
    throw new Error('P0_02_BETTER_AUTH_URL 无效');
  }
  if (authBase.protocol !== 'http:' && authBase.protocol !== 'https:') {
    throw new Error('P0_02_BETTER_AUTH_URL 协议无效');
  }
  if (authBase.hostname !== '127.0.0.1' && authBase.hostname !== 'localhost' && authBase.hostname !== '::1') {
    throw new Error('P0_02_BETTER_AUTH_URL 必须指向本机');
  }

  const poolMax = Number.parseInt(poolMaxRaw, 10);
  if (!Number.isFinite(poolMax) || poolMax < 1) {
    throw new Error('P0_02_POOL_MAX 无效');
  }

  return {
    enabled: true,
    runId,
    appDatabaseUrl,
    syncDatabaseUrl,
    authDatabaseUrl,
    betterAuthSecret,
    betterAuthUrl,
    poolMax,
  };
}

export function requireP002Config(): P002RuntimeConfig {
  const config = loadP002Config();
  if (!config) {
    throw new Error('P0-02 未启用');
  }
  return config;
}
