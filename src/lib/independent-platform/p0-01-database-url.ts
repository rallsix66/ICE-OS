import 'server-only';

export type ParsedP001DatabaseUrl = {
  host: string;
  port: number;
  database: string;
  user: string;
  optionsRaw: string | null;
};

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const ALLOWED_URL_PARAMS = new Set(['options']);

const FORBIDDEN_OPTION_PATTERNS = [
  /\bhost\s*=/i,
  /\bport\s*=/i,
  /\buser\s*=/i,
  /\bdbname\s*=/i,
  /\bpassword\s*=/i,
];

export function parseP001PostgresUrl(connectionString: string, label: string): ParsedP001DatabaseUrl {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error(`${label} 不是合法的 PostgreSQL 连接 URL`);
  }

  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(`${label} 协议必须是 postgres/postgresql`);
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
    throw new Error(`${label} 必须指向本机 loopback（127.0.0.1 / localhost / ::1）`);
  }

  const port = url.port ? Number.parseInt(url.port, 10) : 5432;
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error(`${label} 端口无效`);
  }

  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!database) {
    throw new Error(`${label} 缺少数据库名`);
  }

  const user = decodeURIComponent(url.username);
  if (!user) {
    throw new Error(`${label} 缺少数据库用户`);
  }

  return { host, port, database, user, optionsRaw };
}

export function assertP001DatabaseUrlMatches(
  connectionString: string,
  expected: {
    host: string;
    port: number;
    database: string;
    user: string;
  },
  label: string,
): ParsedP001DatabaseUrl {
  const parsed = parseP001PostgresUrl(connectionString, label);
  if (parsed.host !== expected.host) {
    throw new Error(`${label} 主机不匹配`);
  }
  if (parsed.port !== expected.port) {
    throw new Error(`${label} 端口不匹配`);
  }
  if (parsed.database !== expected.database) {
    throw new Error(`${label} 数据库名不匹配`);
  }
  if (parsed.user !== expected.user) {
    throw new Error(`${label} 角色不匹配`);
  }
  return parsed;
}

export function assertP001ConnectionContract(
  appDatabaseUrl: string,
  authDatabaseUrl: string,
  contract: {
    host: string;
    port: number;
    database: string;
    appUser: string;
    authUser: string;
    runId: string;
  },
): void {
  assertP001DatabaseUrlMatches(
    appDatabaseUrl,
    {
      host: contract.host,
      port: contract.port,
      database: contract.database,
      user: contract.appUser,
    },
    'P0_01_APP_DATABASE_URL',
  );
  assertP001DatabaseUrlMatches(
    authDatabaseUrl,
    {
      host: contract.host,
      port: contract.port,
      database: contract.database,
      user: contract.authUser,
    },
    'P0_01_AUTH_DATABASE_URL',
  );
  if (!contract.runId.startsWith('run-')) {
    throw new Error('P0_01_RUN_ID 无效');
  }
  if (!contract.database.includes(contract.runId.replace(/[^a-z0-9]+/gi, '_'))) {
    throw new Error('P0_01 数据库名与 run ID 不一致');
  }
}
