"""Legacy Python 测试隔离：禁止读取真实 .env.local 与 P0-02 PG 凭据。"""
from __future__ import annotations

import builtins
import os
from typing import Callable

_FICTITIAL_ENV = {
    'NEXT_PUBLIC_SUPABASE_URL': 'https://legacy-test.invalid',
    'SUPABASE_SERVICE_ROLE_KEY': 'legacy-test-fictional-key-not-real',
}

_P0_02_PREFIXES = ('P0_02_', 'DATABASE_URL', 'PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE')


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
        text = str(path).replace('\\', '/')
        if '.env.local' in text and os.environ.get('SYNC_LEGACY_TEST_ISOLATED') == '1':
            env_read_attempts['count'] += 1
            raise OSError('LEGACY_TEST_BLOCKED_ENV_LOCAL')
        return real_open(path, *args, **kwargs)

    builtins.open = guarded_open  # type: ignore[assignment]

    os.environ['_LEGACY_TEST_ENV_READ_ATTEMPTS'] = '0'

    def _sync_counters() -> None:
        os.environ['_LEGACY_TEST_ENV_READ_ATTEMPTS'] = str(env_read_attempts['count'])

    apply_legacy_test_isolation._sync_counters = _sync_counters  # type: ignore[attr-defined]


def assert_legacy_isolation_self_test() -> None:
    apply_legacy_test_isolation()
    try:
        builtins.open('D:/fake/.env.local', encoding='utf-8')
    except OSError as exc:
        if 'LEGACY_TEST_BLOCKED_ENV_LOCAL' not in str(exc):
            raise RuntimeError(f'legacy isolation self-test: unexpected open error: {exc}') from exc
    else:
        raise RuntimeError('legacy isolation self-test: .env.local read not blocked')
    sync = getattr(apply_legacy_test_isolation, '_sync_counters', None)
    if sync:
        sync()
    if os.environ.get('_LEGACY_TEST_ENV_READ_ATTEMPTS', '0') == '0':
        raise RuntimeError('legacy isolation self-test: env read guard did not trigger')
