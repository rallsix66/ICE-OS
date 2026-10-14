"""P0-02 Python 网关连接边界负例（不连接真实地址）。"""
from __future__ import annotations

import importlib
import os
import sys
import unittest
from unittest import mock


class P002ConnectionBoundaryTests(unittest.TestCase):
    def setUp(self) -> None:
        self._env_backup = os.environ.copy()
        for key in list(os.environ):
            if key.startswith('P0_02_') or key.startswith('ICE_P0_02_'):
                os.environ.pop(key, None)
            if key.startswith('PG') and key in (
                'PGHOST',
                'PGHOSTADDR',
                'PGPORT',
                'PGDATABASE',
                'PGUSER',
                'PGPASSWORD',
                'PGSERVICE',
                'PGSERVICEFILE',
                'PGOPTIONS',
            ):
                os.environ.pop(key, None)
        for mod in (
            'sync.db_read_gateway',
            'sync.postgres_gateway',
            'sync.p0_02_connection_boundary',
            'sync.supabase_gateway',
        ):
            sys.modules.pop(mod, None)

    def tearDown(self) -> None:
        os.environ.clear()
        os.environ.update(self._env_backup)
        for mod in (
            'sync.db_read_gateway',
            'sync.postgres_gateway',
            'sync.p0_02_connection_boundary',
            'sync.supabase_gateway',
        ):
            sys.modules.pop(mod, None)

    def _valid_contract_env(self) -> dict[str, str]:
        return {
            'P0_02_ENABLED': 'true',
            'P0_02_RUN_ID': 'run-test',
            'P0_02_SYNC_DATABASE_URL': 'postgres://ice_p0_02_sync_runner:secret@127.0.0.1:5432/iceos_p0_02_run_test',
            'P0_02_EXPECTED_HOST': '127.0.0.1',
            'P0_02_EXPECTED_PORT': '5432',
            'P0_02_EXPECTED_DATABASE': 'iceos_p0_02_run_test',
            'P0_02_EXPECTED_SYNC_USER': 'ice_p0_02_sync_runner',
        }

    def test_independent_mode_missing_url_never_imports_supabase(self) -> None:
        os.environ['P0_02_ENABLED'] = 'true'
        connect_calls: list[tuple] = []

        def fake_connect(*args, **kwargs):
            connect_calls.append((args, kwargs))
            raise AssertionError('不应尝试连接')

        with mock.patch.dict(sys.modules, {'psycopg': mock.MagicMock(connect=fake_connect)}):
            gateway = importlib.import_module('sync.db_read_gateway')
            with self.assertRaises(RuntimeError) as ctx:
                gateway.fetch_warehouse()
        self.assertIn('P0_02_SYNC_DATABASE_URL', str(ctx.exception))
        self.assertEqual(connect_calls, [])
        self.assertNotIn('sync.supabase_gateway', sys.modules)

    def test_bad_host_rejected_before_connect(self) -> None:
        os.environ.update(self._valid_contract_env())
        os.environ['P0_02_SYNC_DATABASE_URL'] = (
            'postgres://ice_p0_02_sync_runner:x@203.0.113.9:5432/wrongdb'
        )
        connect_calls: list[tuple] = []

        def fake_connect(*args, **kwargs):
            connect_calls.append((args, kwargs))
            raise AssertionError('不应尝试连接')

        with mock.patch.dict(sys.modules, {'psycopg': mock.MagicMock(connect=fake_connect)}):
            gateway = importlib.import_module('sync.db_read_gateway')
            with self.assertRaises(RuntimeError) as ctx:
                gateway.fetch_warehouse()
        self.assertIn('loopback', str(ctx.exception))
        self.assertEqual(connect_calls, [])

    def test_bad_port_rejected_before_connect(self) -> None:
        os.environ.update(self._valid_contract_env())
        os.environ['P0_02_SYNC_DATABASE_URL'] = (
            'postgres://ice_p0_02_sync_runner:x@127.0.0.1:5433/iceos_p0_02_run_test'
        )
        os.environ['P0_02_EXPECTED_PORT'] = '5432'
        connect_calls: list[tuple] = []

        def fake_connect(*args, **kwargs):
            connect_calls.append((args, kwargs))
            raise AssertionError('不应尝试连接')

        with mock.patch.dict(sys.modules, {'psycopg': mock.MagicMock(connect=fake_connect)}):
            gateway = importlib.import_module('sync.db_read_gateway')
            with self.assertRaises(RuntimeError) as ctx:
                gateway.fetch_warehouse()
        self.assertIn('port', str(ctx.exception))
        self.assertEqual(connect_calls, [])

    def test_bad_database_rejected_before_connect(self) -> None:
        os.environ.update(self._valid_contract_env())
        os.environ['P0_02_SYNC_DATABASE_URL'] = (
            'postgres://ice_p0_02_sync_runner:x@127.0.0.1:5432/wrong_db'
        )
        connect_calls: list[tuple] = []

        def fake_connect(*args, **kwargs):
            connect_calls.append((args, kwargs))
            raise AssertionError('不应尝试连接')

        with mock.patch.dict(sys.modules, {'psycopg': mock.MagicMock(connect=fake_connect)}):
            gateway = importlib.import_module('sync.db_read_gateway')
            with self.assertRaises(RuntimeError) as ctx:
                gateway.fetch_warehouse()
        self.assertIn('database', str(ctx.exception))
        self.assertEqual(connect_calls, [])

    def test_bad_user_rejected_before_connect(self) -> None:
        os.environ.update(self._valid_contract_env())
        os.environ['P0_02_SYNC_DATABASE_URL'] = (
            'postgres://postgres:x@127.0.0.1:5432/iceos_p0_02_run_test'
        )
        connect_calls: list[tuple] = []

        def fake_connect(*args, **kwargs):
            connect_calls.append((args, kwargs))
            raise AssertionError('不应尝试连接')

        with mock.patch.dict(sys.modules, {'psycopg': mock.MagicMock(connect=fake_connect)}):
            gateway = importlib.import_module('sync.db_read_gateway')
            with self.assertRaises(RuntimeError) as ctx:
                gateway.fetch_warehouse()
        self.assertIn('user', str(ctx.exception))
        self.assertEqual(connect_calls, [])

    def test_pghostaddr_override_rejected_before_connect(self) -> None:
        os.environ.update(self._valid_contract_env())
        os.environ['PGHOSTADDR'] = '203.0.113.10'
        connect_calls: list[tuple] = []

        def fake_connect(*args, **kwargs):
            connect_calls.append((args, kwargs))
            raise AssertionError('不应尝试连接')

        with mock.patch.dict(sys.modules, {'psycopg': mock.MagicMock(connect=fake_connect)}):
            gateway = importlib.import_module('sync.db_read_gateway')
            with self.assertRaises(RuntimeError) as ctx:
                gateway.fetch_warehouse()
        self.assertIn('PGHOSTADDR', str(ctx.exception))
        self.assertEqual(connect_calls, [])


if __name__ == '__main__':
    unittest.main()
