"""Legacy Python 测试隔离：禁止读取真实 .env.local 与 P0-02 PG 凭据；阻断外联。"""
from __future__ import annotations

import builtins
import io
import os
import socket
import sys
import tempfile
import urllib.request
from pathlib import Path
from typing import Callable
from unittest.mock import patch

_FICTITIAL_ENV = {
    'NEXT_PUBLIC_SUPABASE_URL': 'https://legacy-test.invalid',
    'SUPABASE_SERVICE_ROLE_KEY': 'legacy-test-fictional-key-not-real',
}

_P0_02_PREFIXES = ('P0_02_', 'DATABASE_URL', 'PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE')
_ENV_LOCAL_MARKER = '.env.local'

# 固定边界：不依赖可被测试清空的 os.environ 标志。
_BOUNDARY_ARMED = False
_AUDIT_HOOK_INSTALLED = False
_REAL_BUILTIN_OPEN: Callable | None = None
_REAL_OS_OPEN: Callable | None = None
_ENV_READ_BLOCKS = 0


def _path_is_blocked(path: object) -> bool:
    if not _BOUNDARY_ARMED:
        return False
    text = str(path).replace('\\', '/')
    return _ENV_LOCAL_MARKER in text


def _raise_env_block() -> None:
    global _ENV_READ_BLOCKS
    _ENV_READ_BLOCKS += 1
    raise OSError('LEGACY_TEST_BLOCKED_ENV_LOCAL')


def _raise_network_block() -> None:
    raise OSError('LEGACY_TEST_BLOCKED_NETWORK')


def _legacy_audit_hook(event: str, args: tuple) -> None:
    if not _BOUNDARY_ARMED:
        return
    if event in ('open', 'os.open'):
        if args and _path_is_blocked(args[0]):
            _raise_env_block()
        return
    if event in (
        'socket.connect',
        'socket.create_connection',
        'socket.getaddrinfo',
        'socket.gethostbyname',
        'socket.gethostbyname_ex',
        'socket.getaddrinfo',
    ):
        _raise_network_block()
    if event.startswith('http.client.'):
        _raise_network_block()


def apply_legacy_test_isolation() -> None:
    global _BOUNDARY_ARMED, _AUDIT_HOOK_INSTALLED, _REAL_BUILTIN_OPEN, _REAL_OS_OPEN

    _BOUNDARY_ARMED = True
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

    if not _AUDIT_HOOK_INSTALLED:
        sys.addaudithook(_legacy_audit_hook)
        _AUDIT_HOOK_INSTALLED = True

    if _REAL_BUILTIN_OPEN is None:
        _REAL_BUILTIN_OPEN = builtins.open
    if _REAL_OS_OPEN is None:
        _REAL_OS_OPEN = os.open

    real_open = _REAL_BUILTIN_OPEN
    env_read_attempts = {'count': 0}

    def guarded_open(path, *args, **kwargs):
        if _path_is_blocked(path):
            env_read_attempts['count'] += 1
            _raise_env_block()
        return real_open(path, *args, **kwargs)

    builtins.open = guarded_open  # type: ignore[assignment]

    real_io_open = io.open

    def guarded_io_open(file, *args, **kwargs):
        if _path_is_blocked(file):
            env_read_attempts['count'] += 1
            _raise_env_block()
        return real_io_open(file, *args, **kwargs)

    io.open = guarded_io_open  # type: ignore[assignment]

    real_read_text = Path.read_text

    def guarded_read_text(self: Path, *args, **kwargs):
        if _path_is_blocked(self):
            env_read_attempts['count'] += 1
            _raise_env_block()
        return real_read_text(self, *args, **kwargs)

    Path.read_text = guarded_read_text  # type: ignore[method-assign]

    real_read_bytes = Path.read_bytes

    def guarded_read_bytes(self: Path, *args, **kwargs):
        if _path_is_blocked(self):
            env_read_attempts['count'] += 1
            _raise_env_block()
        return real_read_bytes(self, *args, **kwargs)

    Path.read_bytes = guarded_read_bytes  # type: ignore[method-assign]

    real_os_open = _REAL_OS_OPEN

    def guarded_os_open(path, flags, *args, **kwargs):
        if _path_is_blocked(path):
            env_read_attempts['count'] += 1
            _raise_env_block()
        return real_os_open(path, flags, *args, **kwargs)

    os.open = guarded_os_open  # type: ignore[assignment]

    real_connect = socket.socket.connect

    def guarded_connect(self, address):
        if _BOUNDARY_ARMED:
            _raise_network_block()
        return real_connect(self, address)

    socket.socket.connect = guarded_connect  # type: ignore[method-assign]

    real_getaddrinfo = socket.getaddrinfo

    def guarded_getaddrinfo(*args, **kwargs):
        if _BOUNDARY_ARMED:
            _raise_network_block()
        return real_getaddrinfo(*args, **kwargs)

    socket.getaddrinfo = guarded_getaddrinfo  # type: ignore[assignment]

    real_urlopen = urllib.request.urlopen

    def guarded_urlopen(*args, **kwargs):
        if _BOUNDARY_ARMED:
            _raise_network_block()
        return real_urlopen(*args, **kwargs)

    urllib.request.urlopen = guarded_urlopen  # type: ignore[assignment]

    os.environ['_LEGACY_TEST_ENV_READ_ATTEMPTS'] = '0'
    os.environ['_LEGACY_TEST_NETWORK_BLOCKED'] = '1'

    def _sync_counters() -> None:
        os.environ['_LEGACY_TEST_ENV_READ_ATTEMPTS'] = str(env_read_attempts['count'] + _ENV_READ_BLOCKS)

    apply_legacy_test_isolation._sync_counters = _sync_counters  # type: ignore[attr-defined]


def _expect_blocked(callable_obj, token: str) -> None:
    try:
        callable_obj()
    except OSError as exc:
        if token not in str(exc):
            raise RuntimeError(f'legacy isolation self-test: unexpected error: {exc}') from exc
    else:
        raise RuntimeError(f'legacy isolation self-test: expected block ({token})')


def assert_legacy_isolation_self_test() -> None:
    apply_legacy_test_isolation()
    fictional_env = 'D:/legacy-isolation-self-test/.env.local'

    for opener in (
        lambda: builtins.open(fictional_env, encoding='utf-8'),
        lambda: io.open(fictional_env, encoding='utf-8'),
        lambda: Path(fictional_env).read_text(encoding='utf-8'),
        lambda: os.close(os.open(fictional_env, os.O_RDONLY)),
    ):
        _expect_blocked(opener, 'LEGACY_TEST_BLOCKED_ENV_LOCAL')

    for network_probe in (
        lambda: socket.getaddrinfo('legacy-test.invalid', 443),
        lambda: urllib.request.urlopen('https://legacy-test.invalid/probe'),
    ):
        _expect_blocked(network_probe, 'LEGACY_TEST_BLOCKED_NETWORK')

    with patch.dict(os.environ, {}, clear=True):
        if not _BOUNDARY_ARMED:
            raise RuntimeError('legacy isolation self-test: boundary lost after env clear')
        _expect_blocked(
            lambda: builtins.open(fictional_env, encoding='utf-8'),
            'LEGACY_TEST_BLOCKED_ENV_LOCAL',
        )
        _expect_blocked(
            lambda: socket.getaddrinfo('legacy-test.invalid', 443),
            'LEGACY_TEST_BLOCKED_NETWORK',
        )

    sync = getattr(apply_legacy_test_isolation, '_sync_counters', None)
    if sync:
        sync()
    if os.environ.get('_LEGACY_TEST_ENV_READ_ATTEMPTS', '0') == '0':
        raise RuntimeError('legacy isolation self-test: env read guard did not trigger')

    assert _REAL_BUILTIN_OPEN is not None

    def delegating_open(path, *args, **kwargs):
        return _REAL_BUILTIN_OPEN(path, *args, **kwargs)

    builtins.open = delegating_open  # type: ignore[assignment]
    try:
        _expect_blocked(
            lambda: builtins.open(fictional_env, encoding='utf-8'),
            'LEGACY_TEST_BLOCKED_ENV_LOCAL',
        )
    finally:
        apply_legacy_test_isolation()

    with tempfile.NamedTemporaryFile(mode='w', suffix='.cfg', delete=False, encoding='utf-8') as tmp:
        tmp.write('legacy-ok')
        allowed_path = tmp.name
    try:
        content = builtins.open(allowed_path, encoding='utf-8').read()
        if content != 'legacy-ok':
            raise RuntimeError('legacy isolation self-test: allowed fictional config read failed')
    finally:
        os.unlink(allowed_path)
