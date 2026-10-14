"""P0-02 PostgreSQL 连接契约：校验 URL、实例标记，连接后只读核验再执行业务 SQL。"""
from __future__ import annotations

import os
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Iterator
from urllib.parse import unquote, urlparse

_LOOPBACK = frozenset({'127.0.0.1', 'localhost', '::1'})
_ALLOWED_QUERY_KEYS = frozenset({'options'})
_FORBIDDEN_OPTION_FRAGMENTS = (
    'host=',
    'port=',
    'user=',
    'dbname=',
    'password=',
)

# libpq 环境变量可在 URL 合法时仍改写实际连接目标（如 PGHOSTADDR）。
_LIBPQ_TARGET_OVERRIDE_VARS = (
    'PGHOST',
    'PGHOSTADDR',
    'PGPORT',
    'PGDATABASE',
    'PGUSER',
    'PGPASSWORD',
    'PGSERVICE',
    'PGSERVICEFILE',
    'PGOPTIONS',
)


@dataclass(frozen=True)
class ParsedPgUrl:
    host: str
    port: int
    database: str
    user: str
    password: str
    raw: str


def independent_p0_02_enabled() -> bool:
    value = os.environ.get('P0_02_ENABLED', '').strip().lower()
    return value in ('1', 'true', 'yes')


def sync_database_url_from_env() -> str | None:
    for key in ('P0_02_SYNC_DATABASE_URL', 'ICE_P0_02_SYNC_DATABASE_URL'):
        value = os.environ.get(key, '').strip()
        if value:
            return value
    return None


def require_sync_database_url() -> str:
    url = sync_database_url_from_env()
    if url:
        return url
    raise RuntimeError(
        'P0-02 已启用但缺少 P0_02_SYNC_DATABASE_URL（或 ICE_P0_02_SYNC_DATABASE_URL）',
    )


def libpq_target_override_vars() -> list[str]:
    return [key for key in _LIBPQ_TARGET_OVERRIDE_VARS if os.environ.get(key, '').strip()]


def assert_no_libpq_target_overrides() -> None:
    found = libpq_target_override_vars()
    if found:
        joined = ', '.join(sorted(found))
        raise RuntimeError(f'P0-02 禁止 libpq 连接覆盖环境变量: {joined}')


@contextmanager
def isolated_libpq_environ() -> Iterator[None]:
    """连接期间临时移除 libpq 目标覆盖项，避免继承进程环境改写 host。"""
    backup = {key: os.environ.pop(key, None) for key in _LIBPQ_TARGET_OVERRIDE_VARS}
    try:
        yield
    finally:
        for key, value in backup.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def parse_postgres_url(connection_string: str, label: str) -> ParsedPgUrl:
    try:
        parsed = urlparse(connection_string)
    except Exception as exc:
        raise RuntimeError(f'{label} 不是合法 URL') from exc
    if parsed.scheme not in ('postgres', 'postgresql'):
        raise RuntimeError(f'{label} 协议无效')
    for key in parsed.query.split('&'):
        if not key:
            continue
        param = key.split('=', 1)[0]
        if param and param not in _ALLOWED_QUERY_KEYS:
            raise RuntimeError(f'{label} 含不允许的连接参数: {param}')
    options_raw = ''
    if parsed.query:
        for part in parsed.query.split('&'):
            if part.startswith('options='):
                options_raw = unquote(part.split('=', 1)[1])
                break
    lowered = options_raw.lower()
    for fragment in _FORBIDDEN_OPTION_FRAGMENTS:
        if fragment in lowered:
            raise RuntimeError(f'{label} options 含不允许的覆盖项')
    host = parsed.hostname or ''
    if host not in _LOOPBACK:
        raise RuntimeError(f'{label} 主机必须是 loopback')
    port = parsed.port or 5432
    database = unquote((parsed.path or '').lstrip('/'))
    user = unquote(parsed.username or '')
    password = unquote(parsed.password or '')
    if not database or not user:
        raise RuntimeError(f'{label} 缺少数据库名或用户')
    return ParsedPgUrl(
        host=host,
        port=port,
        database=database,
        user=user,
        password=password,
        raw=connection_string,
    )


def assert_connection_contract(url: str, label: str) -> ParsedPgUrl:
    parsed = parse_postgres_url(url, label)
    expected_host = os.environ.get('P0_02_EXPECTED_HOST', '').strip()
    expected_port_raw = os.environ.get('P0_02_EXPECTED_PORT', '').strip()
    expected_database = os.environ.get('P0_02_EXPECTED_DATABASE', '').strip()
    expected_sync_user = os.environ.get('P0_02_EXPECTED_SYNC_USER', '').strip()
    if not (expected_host and expected_port_raw and expected_database and expected_sync_user):
        raise RuntimeError('P0-02 已启用但缺少连接契约（P0_02_EXPECTED_*）')
    expected_port = int(expected_port_raw)
    if parsed.host != expected_host:
        raise RuntimeError(f'{label} host 不匹配')
    if parsed.port != expected_port:
        raise RuntimeError(f'{label} port 不匹配')
    if parsed.database.lower() != expected_database.lower():
        raise RuntimeError(f'{label} database 不匹配')
    if parsed.user != expected_sync_user:
        raise RuntimeError(f'{label} user 不匹配')
    return parsed


def verify_platform_instance(cur: Any, run_id: str) -> None:
    cur.execute(
        'SELECT run_id FROM p0_02_meta.platform_instance ORDER BY run_id LIMIT 1',
    )
    row = cur.fetchone()
    marker = row['run_id'] if isinstance(row, dict) else row[0]
    if marker != run_id:
        raise RuntimeError(
            f'platform_instance.run_id={marker!r} 与 P0_02_RUN_ID={run_id!r} 不一致',
        )


def connect_validated_sync(*, import_psycopg: Any):
    """Validate URL + instance marker; returns an open connection (caller must close)."""
    url = require_sync_database_url()
    assert_no_libpq_target_overrides()
    parsed = assert_connection_contract(url, 'P0_02_SYNC_DATABASE_URL')
    run_id = os.environ.get('P0_02_RUN_ID', '').strip()
    if not run_id:
        raise RuntimeError('P0-02 已启用但缺少 P0_02_RUN_ID')
    with isolated_libpq_environ():
        conn = import_psycopg.connect(
            host=parsed.host,
            port=parsed.port,
            dbname=parsed.database,
            user=parsed.user,
            password=parsed.password,
        )
    try:
        with conn.cursor() as cur:
            verify_platform_instance(cur, run_id)
    except Exception:
        conn.close()
        raise
    return conn
