const ALLOWED = new Set([
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
  'P0_01_DISABLE_AUTH_RATE_LIMIT',
  'NODE_PATH',
  'P0_01_ALLOWED_PORTS',
  'P0_01_NETWORK_GUARD_SELF_TEST',
  'P0_01_NETWORK_GUARD_INSTALLED',
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

const ALLOWED_PREFIX = ['P0_01_', 'npm_'];

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
    if (key.startsWith('P0_01_')) {
      merged[key] = value;
    }
  }
  for (const key of Object.keys(source)) {
    if (ALLOWED.has(key) || ALLOWED_PREFIX.some((prefix) => key.startsWith(prefix))) {
      merged[key] ??= source[key];
    }
  }
  if (merged.P0_01_ENABLED !== 'true') {
    throw new Error('P0-01 验收环境必须显式设置 P0_01_ENABLED=true');
  }
  for (const key of Object.keys(source)) {
    if (key.startsWith('SUPABASE_') || key === 'DATABASE_URL' || key.startsWith('PG')) {
      throw new Error(`禁止继承环境变量 ${key}`);
    }
  }
  return merged;
}
