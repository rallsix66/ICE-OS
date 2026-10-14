const ALLOWED = new Set([
  'P0_02_ENABLED',
  'P0_02_RUN_ID',
  'P0_02_APP_DATABASE_URL',
  'P0_02_SYNC_DATABASE_URL',
  'P0_02_AUTH_DATABASE_URL',
  'P0_02_EXPECTED_SYNC_USER',
  'NEXT_PUBLIC_ICE_USE_BETTER_AUTH',
  'P0_02_BETTER_AUTH_SECRET',
  'P0_02_BETTER_AUTH_URL',
  'P0_02_POOL_MAX',
  'P0_02_EXPECTED_HOST',
  'P0_02_EXPECTED_PORT',
  'P0_02_EXPECTED_DATABASE',
  'P0_02_EXPECTED_APP_USER',
  'P0_02_EXPECTED_AUTH_USER',
  'P0_02_DISABLE_AUTH_RATE_LIMIT',
  'NODE_PATH',
  'P0_02_ALLOWED_PORTS',
  'P0_02_NETWORK_GUARD_SELF_TEST',
  'P0_02_NETWORK_GUARD_INSTALLED',
  'NODE_ENV',
  'NODE_OPTIONS',
  'NEXT_TELEMETRY_DISABLED',
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'ComSpec',
  'WINDIR',
  'OS',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'VITEST',
  'VITEST_POOL_ID',
  'VITEST_WORKER_ID',
  'CI',
  'FORCE_COLOR',
  'NO_COLOR',
  'TERM',
  'PORT',
  'HOSTNAME',
  'APPDATA',
  'LOCALAPPDATA',
  'USERNAME',
  'USERDOMAIN',
  'LOGONSERVER',
  'HOMEDRIVE',
  'HOMEPATH',
  'COMPUTERNAME',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'CommonProgramFiles',
  'CommonProgramW6432',
  'SESSIONNAME',
]);

const ALLOWED_PREFIX = ['P0_02_', 'npm_'];

export function buildP001ProcessEnv(source, jsonEnv) {
  const merged = {};
  for (const key of ALLOWED) {
    if (source[key] !== undefined) {
      merged[key] = source[key];
    } else if (process.env[key] !== undefined) {
      merged[key] = process.env[key];
    }
  }
  for (const [key, value] of Object.entries(jsonEnv)) {
    if (key.startsWith('P0_02_') || key.startsWith('NEXT_PUBLIC_')) {
      merged[key] = value;
    }
  }
  for (const key of Object.keys(source)) {
    if (ALLOWED.has(key) || ALLOWED_PREFIX.some((prefix) => key.startsWith(prefix))) {
      merged[key] ??= source[key];
    }
  }
  if (merged.P0_02_ENABLED !== 'true') {
    throw new Error('p0-02 验收环境必须显式设置 P0_02_ENABLED=true');
  }
  for (const key of Object.keys(source)) {
    if (key.startsWith('SUPABASE_') || key === 'DATABASE_URL' || key.startsWith('PG')) {
      throw new Error(`禁止继承环境变量 ${key}`);
    }
  }
  return merged;
}
