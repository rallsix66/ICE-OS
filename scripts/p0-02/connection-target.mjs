const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const ALLOWED_URL_PARAMS = new Set(['options']);
const FORBIDDEN_OPTION_PATTERNS = [
  /\bhost\s*=/i,
  /\bport\s*=/i,
  /\buser\s*=/i,
  /\bdbname\s*=/i,
  /\bpassword\s*=/i,
];

export function parsePostgresUrl(connectionString, label) {
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error(`${label} 不是合法 URL`);
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(`${label} 协议无效`);
  }
  for (const key of url.searchParams.keys()) {
    if (!ALLOWED_URL_PARAMS.has(key)) {
      throw new Error(`${label} 含不允许的连接参数: ${key}`);
    }
  }
  const optionsRaw = url.searchParams.get('options');
  if (optionsRaw) {
    for (const pattern of FORBIDDEN_OPTION_PATTERNS) {
      if (pattern.test(optionsRaw)) {
        throw new Error(`${label} options 含不允许的覆盖项`);
      }
    }
  }
  const host = url.hostname;
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(`${label} 主机必须是 loopback`);
  }
  const port = url.port ? Number.parseInt(url.port, 10) : 5432;
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const user = decodeURIComponent(url.username);
  if (!database || !user) {
    throw new Error(`${label} 缺少数据库名或用户`);
  }
  return { host, port, database, user, optionsRaw };
}

export function assertConnectionTarget(connectionString, expected, label) {
  const parsed = parsePostgresUrl(connectionString, label);
  if (parsed.host !== expected.host) {
    throw new Error(`${label} host 不匹配`);
  }
  if (parsed.port !== expected.port) {
    throw new Error(`${label} port 不匹配`);
  }
  if (parsed.database.toLowerCase() !== expected.database.toLowerCase()) {
    throw new Error(`${label} database 不匹配`);
  }
  if (parsed.user !== expected.user) {
    throw new Error(`${label} user 不匹配`);
  }
  return parsed;
}

export function assertInstanceMetadataContract(instance) {
  if (!instance || typeof instance !== 'object') {
    throw new Error('instance 记录无效');
  }
  if (!LOOPBACK_HOSTS.has(instance.host)) {
    throw new Error(`instance.host=${instance.host} 必须是 loopback`);
  }
  const port = Number(instance.port);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`instance.port=${instance.port} 无效`);
  }
  if (
    !instance.dbName ||
    !instance.bootstrapUser ||
    !instance.appRunnerUser ||
    !instance.authRunnerUser ||
    !instance.syncRunnerUser
  ) {
    throw new Error('instance 缺少 dbName 或 runner 用户');
  }
  parsePostgresUrl(
    `postgres://${encodeURIComponent(instance.appRunnerUser)}:x@${instance.host}:${port}/${instance.dbName}`,
    'instance-app',
  );
  parsePostgresUrl(
    `postgres://${encodeURIComponent(instance.authRunnerUser)}:x@${instance.host}:${port}/${instance.dbName}`,
    'instance-auth',
  );
  parsePostgresUrl(
    `postgres://${encodeURIComponent(instance.bootstrapUser)}:x@${instance.host}:${port}/${instance.dbName}`,
    'instance-bootstrap',
  );
}

export function assertInstanceConnectionUrls(instance, envJson) {
  const appUrl = envJson.P0_02_APP_DATABASE_URL;
  const authUrl = envJson.P0_02_AUTH_DATABASE_URL;
  const syncUrl = envJson.P0_02_SYNC_DATABASE_URL;
  if (!appUrl || !authUrl || !syncUrl) {
    throw new Error('env.p0-02.json 缺少数据库 URL');
  }
  assertConnectionTarget(
    appUrl,
    {
      host: instance.host,
      port: instance.port,
      database: instance.dbName,
      user: instance.appRunnerUser,
    },
    'P0_02_APP_DATABASE_URL',
  );
  assertConnectionTarget(
    authUrl,
    {
      host: instance.host,
      port: instance.port,
      database: instance.dbName,
      user: instance.authRunnerUser,
    },
    'P0_02_AUTH_DATABASE_URL',
  );
  assertConnectionTarget(
    syncUrl,
    {
      host: instance.host,
      port: instance.port,
      database: instance.dbName,
      user: instance.syncRunnerUser,
    },
    'P0_02_SYNC_DATABASE_URL',
  );
}
