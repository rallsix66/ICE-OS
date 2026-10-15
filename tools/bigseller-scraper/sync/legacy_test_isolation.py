"""Legacy Python 测试隔离：禁止读取真实 .env.local 与 P0-02 PG 凭据；阻断外联。"""
from __future__ import annotations

import builtins
import io
import os
import socket
import urllib.request
from pathlib import Path
from typing import Callable

_FICTITIAL_ENV = {
    'NEXT_PUBLIC_SUPABASE_URL': 'https://legacy-test.invalid',
    'SUPABASE_SERVICE_ROLE_KEY': 'legacy-test-fictional-key-not-real',
}

_P0_02_PREFIXES = ('P0_02_', 'DATABASE_URL', 'PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE')
_ENV_LOCAL_MARKER = '.env.local'


def _legacy_isolated() -> bool:
    return os.environ.get('SYNC_LEGACY_TEST_ISOLATED') == '1'


def _path_is_blocked(path: object) -> bool:
    if not _legacy_isolated():
        return False
    text = str(path).replace('\\', '/')
    return _ENV_LOCAL_MARKER in text


def apply_legacy_test_isolation() -> None:
    os.environ['SYNC_LEGACY_TEST_ISOLATED'] = '1'
    os.environ['P0_02_ENABLED'] = 'false'
    for key in list(os.environ):
        if key.startswith('P0_02') or key in {
            'DATABASE_URL',
            'PGHOST',
            'PGPORT',
            'PGUSER',
            'PGPASSWORD',
            'PGDATABASE',
        }:
            os.environ.pop(key, None)

    real_open: Callable = builtins.open
    env_read_attempts = {'count': 0}

    def guarded_open(path, *args, **kwargs):
        if _path_is_blocked(path):
            env_read_attempts['count'] += 1
            raise OSError('LEGACY_TEST_BLOCKED_ENV_LOCAL')
        return real_open(path, *args, **kwargs)

    builtins.open = guarded_open  # type: ignore[assignment]

    real_io_open = io.open

    def guarded_io_open(file, *args, **kwargs):
        if _path_is_blocked(file):
            env_read_attempts['count'] += 1
            raise OSError('LEGACY_TEST_BLOCKED_ENV_LOCAL')
        return real_io_open(file, *args, **kwargs)

    io.open = guarded_io_open  # type: ignore[assignment]

    real_read_text = Path.read_text

    def guarded_read_text(self: Path, *args, **kwargs):
        if _path_is_blocked(self):
            env_read_attempts['count'] += 1
            raise OSError('LEGACY_TEST_BLOCKED_ENV_LOCAL')
        return real_read_text(self, *args, **kwargs)

    Path.read_text = guarded_read_text  # type: ignore[method-assign]

    real_read_bytes = Path.read_bytes

    def guarded_read_bytes(self: Path, *args, **kwargs):
        if _path_is_blocked(self):
            env_read_attempts['count'] += 1
            raise OSError('LEGACY_TEST_BLOCKED_ENV_LOCAL')
        return real_read_bytes(self, *args, **kwargs)

    Path.read_bytes = guarded_read_bytes  # type: ignore[method-assign]

    real_connect = socket.socket.connect

    def guarded_connect(self, address):
        if _legacy_isolated():
            raise OSError('LEGACY_TEST_BLOCKED_NETWORK')
        return real_connect(self, address)

    socket.socket.connect = guarded_connect  # type: ignore[method-assign]

    real_getaddrinfo = socket.getaddrinfo

    def guarded_getaddrinfo(*args, **kwargs):
        if _legacy_isolated():
            raise OSError('LEGACY_TEST_BLOCKED_NETWORK')
        return real_getaddrinfo(*args, **kwargs)

    socket.getaddrinfo = guarded_getaddrinfo  # type: ignore[assignment]

    real_urlopen = urllib.request.urlopen

    def guarded_urlopen(*args, **kwargs):
        if _legacy_isolated():
            raise OSError('LEGACY_TEST_BLOCKED_NETWORK')
        return real_urlopen(*args, **kwargs)

    urllib.request.urlopen = guarded_urlopen  # type: ignore[assignment]

    os.environ['_LEGACY_TEST_ENV_READ_ATTEMPTS'] = '0'
    os.environ['_LEGACY_TEST_NETWORK_BLOCKED'] = '1'

    def _sync_counters() -> None:
        os.environ['_LEGACY_TEST_ENV_READ_ATTEMPTS'] = str(env_read_attempts['count'])

    apply_legacy_test_isolation._sync_counters = _sync_counters  # type: ignore[attr-defined]


def assert_legacy_isolation_self_test() -> None:
    apply_legacy_test_isolation()
    fictional_env = 'D:/legacy-isolation-self-test/.env.local'
    for opener in (
        lambda: builtins.open(fictional_env, encoding='utf-8'),
        lambda: io.open(fictional_env, encoding='utf-8'),
        lambda: Path(fictional_env).read_text(encoding='utf-8'),
    ):
        try:
            opener()
        except OSError as exc:
            if 'LEGACY_TEST_BLOCKED_ENV_LOCAL' not in str(exc):
                raise RuntimeError(f'legacy isolation self-test: unexpected file error: {exc}') from exc
        else:
            raise RuntimeError('legacy isolation self-test: .env.local read not blocked')

    for network_probe in (
        lambda: socket.getaddrinfo('legacy-test.invalid', 443),
        lambda: urllib.request.urlopen('https://legacy-test.invalid/probe'),
    ):
        try:
            network_probe()
        except OSError as exc:
            if 'LEGACY_TEST_BLOCKED_NETWORK' not in str(exc):
                raise RuntimeError(f'legacy isolation self-test: unexpected network error: {exc}') from exc
        else:
            raise RuntimeError('legacy isolation self-test: network entry not blocked')

    sync = getattr(apply_legacy_test_isolation, '_sync_counters', None)
    if sync:
        sync()
    if os.environ.get('_LEGACY_TEST_ENV_READ_ATTEMPTS', '0') == '0':
        raise RuntimeError('legacy isolation self-test: env read guard did not trigger')
