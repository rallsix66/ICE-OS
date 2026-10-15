"""P0-02 fixture 登记/清理负例：setup 失败与清理回滚窗口。"""
from __future__ import annotations

import json
import os
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from sync.p0_02_test_fixture import OwnedFixtureRegistry


def _load_owner_dsn() -> str:
    run_id = os.environ.get('P0_02_RUN_ID', 'run-20261014-r2')
    root = Path(__file__).resolve().parents[3]
    inst = json.loads((root / '.local/p0-02' / run_id / 'instance.json').read_text(encoding='utf-8'))
    return (
        f"host={inst['host']} port={inst['port']} dbname={inst['dbName']} "
        f"user={inst['bootstrapUser']} password={inst['bootstrapPassword']}"
    )


class P002FixtureRecoveryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if os.environ.get('P0_02_SYNC_DATABASE_URL', '').strip() == '':
            raise unittest.SkipTest('缺少 P0_02_SYNC_DATABASE_URL')

    def test_class_cleanup_runs_after_setup_snapshot_failure(self) -> None:
        wh = str(uuid.uuid4())
        registry = OwnedFixtureRegistry(_load_owner_dsn())
        registry.register_warehouse(wh)
        import psycopg

        conn = psycopg.connect(_load_owner_dsn())
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO public.warehouse (id, name, country, type, is_active)
                    VALUES (%s, %s, 'TH', 'overseas', true)
                    """,
                    (wh, f'P0-02 fixture recovery {wh[:8]}'),
                )
            conn.commit()
        finally:
            conn.close()
        with patch.object(registry, 'capture_sentinel_snapshot', side_effect=RuntimeError('snapshot fail')):
            with self.assertRaises(RuntimeError):
                registry.capture_sentinel_snapshot([wh])
        report = registry.class_cleanup(verify_counts=False)
        self.assertTrue(report.get('integrity_ok'), report)
        conn = psycopg.connect(_load_owner_dsn())
        try:
            with conn.cursor() as cur:
                cur.execute('SELECT 1 FROM public.warehouse WHERE id = %s::uuid', (wh,))
                self.assertIsNone(cur.fetchone())
        finally:
            conn.close()

    def test_cleanup_rollback_keeps_owned_registry(self) -> None:
        registry = OwnedFixtureRegistry(_load_owner_dsn())
        wh = str(uuid.uuid4())
        variant = str(uuid.uuid4())
        sku = f'FIX-REC-{variant[:8]}'
        registry.register_warehouse(wh)
        registry.register_owned_sku(sku, wh)
        import psycopg

        conn = psycopg.connect(_load_owner_dsn())
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO public.warehouse (id, name, country, type, is_active)
                    VALUES (%s, %s, 'TH', 'overseas', true)
                    """,
                    (wh, f'P0-02 cleanup rollback {wh[:8]}'),
                )
                cur.execute(
                    """
                    INSERT INTO public.product_variant (id, sku, country, name, match_status)
                    VALUES (%s, %s, 'TH', 'fixture recovery', 'unmatched')
                    """,
                    (variant, sku),
                )
                cur.execute(
                    """
                    INSERT INTO public.inventory (variant_id, warehouse_id, quantity)
                    VALUES (%s::uuid, %s::uuid, 2)
                    """,
                    (variant, wh),
                )
            conn.commit()
        finally:
            conn.close()

        real_commit = psycopg.Connection.commit

        def fail_commit(conn_self):
            real_commit(conn_self)
            raise RuntimeError('cleanup commit injected failure')

        with patch.object(psycopg.Connection, 'commit', fail_commit):
            errors = registry.cleanup_owned_skus()
        self.assertTrue(errors)
        self.assertIn((sku, wh), registry.owned_skus)

        errors = registry.cleanup_owned_skus()
        self.assertFalse(errors)
        report = registry.class_cleanup(verify_counts=False)
        self.assertTrue(report.get('integrity_ok'), report)


if __name__ == '__main__':
    unittest.main()
