"""P0-02 发布原子性：G/I 审计失败、必要 success sync_log 失败不得留下已发布库存。"""
from __future__ import annotations

import os
import unittest
import uuid
from datetime import datetime, timezone
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


import json  # noqa: E402


class P002PublishAtomicityTests(unittest.TestCase):
    registry: OwnedFixtureRegistry
    wh: str
    variant: str
    inventory_id: str
    sku: str
    sync_run_id: str
    dry_run_id: str
    admin_profile: str

    @classmethod
    def setUpClass(cls) -> None:
        if os.environ.get('P0_02_SYNC_DATABASE_URL', '').strip() == '':
            raise unittest.SkipTest('缺少 P0_02_SYNC_DATABASE_URL')
        os.environ['P0_02_ENABLED'] = 'true'
        os.environ['BS_WAREHOUSE_COUNTRY'] = 'TH'
        os.environ['BS_TARGET_WAREHOUSE_NAME'] = 'P0-02 atomic fixture wh'
        os.environ['BS_OLD_WAREHOUSE_NAME'] = 'P0-02 atomic fixture wh'
        os.environ['BS_NEW_VARIANT_COUNTRY'] = 'TH'
        import sync.config as cfg

        cfg.WAREHOUSE_COUNTRY = 'TH'
        cfg.TARGET_WAREHOUSE_NAME = 'P0-02 atomic fixture wh'
        cfg.OLD_WAREHOUSE_NAME = 'P0-02 atomic fixture wh'
        cls.admin_profile = '11111111-1111-4111-8111-111111111101'
        cls.registry = OwnedFixtureRegistry(_load_owner_dsn())
        cls.registry.capture_baseline()

        cls.wh = str(uuid.uuid4())
        cls.variant = str(uuid.uuid4())
        cls.inventory_id = str(uuid.uuid4())
        cls.sku = f'RW-AT-{cls.variant[:8]}'
        cls.sync_run_id = str(uuid.uuid4())
        cls.dry_run_id = str(uuid.uuid4())

        cls.registry.register_warehouse(cls.wh)
        cls.registry.register_variant(cls.variant)
        cls.registry.register_inventory(cls.inventory_id)
        cls.registry.register_sync_run(cls.sync_run_id)
        cls.registry.register_sync_run(cls.dry_run_id)

        import psycopg

        conn = psycopg.connect(_load_owner_dsn())
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO public.warehouse (id, name, country, type, is_active)
                    VALUES (%s, %s, 'TH', 'overseas', true)
                    """,
                    (cls.wh, 'P0-02 atomic fixture wh'),
                )
                cur.execute(
                    """
                    INSERT INTO public.product_variant (id, sku, country, name, match_status)
                    VALUES (%s, %s, 'TH', 'Atomic variant', 'unmatched')
                    """,
                    (cls.variant, cls.sku),
                )
                cur.execute(
                    """
                    INSERT INTO public.inventory (id, variant_id, warehouse_id, quantity, last_sync_at)
                    VALUES (%s, %s, %s, 5, NOW() - INTERVAL '1 day')
                    """,
                    (cls.inventory_id, cls.variant, cls.wh),
                )
                cur.execute(
                    """
                    INSERT INTO public.sync_run (
                      id, warehouse_id, mode, status, triggered_by, triggered_from,
                      input_artifact_hash, plan_artifact_hash,
                      finished_at, exit_code, result_summary,
                      plan_drift_check, plan_drift_count, plan_drift_differences
                    ) VALUES (
                      %s, %s, 'dry_run', 'completed', %s, 'web',
                      'dry-input', 'dry-plan',
                      NOW(), 0, '{}'::jsonb, 'PASS', 0, '[]'::jsonb
                    )
                    """,
                    (cls.dry_run_id, cls.wh, cls.admin_profile),
                )
                cur.execute(
                    """
                    INSERT INTO public.sync_run (
                      id, warehouse_id, mode, status, triggered_by, triggered_from,
                      input_artifact_hash, plan_artifact_hash, dry_run_run_id
                    ) VALUES (
                      %s, %s, 'real_write', 'in_progress', %s, 'web',
                      'rw-input', 'rw-plan', %s::uuid
                    )
                    """,
                    (cls.sync_run_id, cls.wh, cls.admin_profile, cls.dry_run_id),
                )
            conn.commit()
        finally:
            conn.close()

    @classmethod
    def tearDownClass(cls) -> None:
        report = cls.registry.restore(verify_counts=False)
        if report.get('errors'):
            raise AssertionError(f'fixture restore failed: {report}')

    def setUp(self) -> None:
        os.environ['BS_WAREHOUSE_COUNTRY'] = 'TH'
        os.environ['BS_TARGET_WAREHOUSE_NAME'] = 'P0-02 atomic fixture wh'
        os.environ['BS_OLD_WAREHOUSE_NAME'] = 'P0-02 atomic fixture wh'
        os.environ['BS_NEW_VARIANT_COUNTRY'] = 'TH'
        os.environ['P0_02_SYNC_RUN_ID'] = self.sync_run_id
        os.environ['P0_02_SYNC_TRIGGERED_BY'] = self.admin_profile
        import sync.config as cfg

        cfg.WAREHOUSE_COUNTRY = 'TH'
        cfg.TARGET_WAREHOUSE_NAME = 'P0-02 atomic fixture wh'
        cfg.OLD_WAREHOUSE_NAME = 'P0-02 atomic fixture wh'
        import psycopg

        conn = psycopg.connect(_load_owner_dsn())
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE public.inventory
                    SET quantity = 5, last_sync_at = NOW() - INTERVAL '1 day'
                    WHERE id = %s::uuid
                    """,
                    (self.inventory_id,),
                )
                cur.execute(
                    'DELETE FROM public.sync_log WHERE warehouse_id = %s::uuid',
                    (self.wh,),
                )
            conn.commit()
        finally:
            conn.close()

    def _plan(self, qty: int) -> dict:
        sync_at = datetime.now(timezone.utc).isoformat()
        return {
            'warehouse_rename_required': {
                'warehouse_id': self.wh,
                'action': 'none',
                'target_name': 'P0-02 atomic fixture wh',
            },
            'new_variants': [],
            'inventory_updates': [
                {
                    'sku': self.sku,
                    'warehouse_id': self.wh,
                    'quantity': qty,
                    'new_quantity': qty,
                    'last_sync_at': sync_at,
                },
            ],
            'inventory_inserts': [],
            'inventory_after_variant_create': [],
            'inventory_unchanged': [],
        }

    def _read_quantity_and_logs(self):
        import psycopg

        conn = psycopg.connect(_load_owner_dsn())
        try:
            with conn.cursor() as cur:
                cur.execute(
                    'SELECT quantity::int, last_sync_at IS NOT NULL FROM public.inventory WHERE id = %s::uuid',
                    (self.inventory_id,),
                )
                qty_row = cur.fetchone()
                cur.execute(
                    """
                    SELECT COUNT(*)::int FROM public.sync_log
                    WHERE warehouse_id = %s::uuid AND status = 'success'
                    """,
                    (self.wh,),
                )
                success_logs = int(cur.fetchone()[0])
            qty = int(qty_row[0])
            has_sync_ts = bool(qty_row[1])
            return qty, has_sync_ts, success_logs
        finally:
            conn.close()

    def test_success_publish_quantity_log_and_run_aligned(self) -> None:
        from sync.executor import execute_plan_v2

        os.environ['P0_02_SYNC_RUN_ID'] = self.sync_run_id
        os.environ['P0_02_SYNC_TRIGGERED_BY'] = self.admin_profile

        result = execute_plan_v2(
            self._plan(qty=11),
            sync_log_enabled=True,
            sync_run_id=self.sync_run_id,
            triggered_by=self.admin_profile,
        )
        self.assertTrue(result.get('publish_committed'))
        self.assertTrue(result.get('sync_log_written'))
        qty, has_sync_ts, success_logs = self._read_quantity_and_logs()
        self.assertEqual(qty, 11)
        self.assertTrue(has_sync_ts)
        self.assertGreaterEqual(success_logs, 1)

    def test_audit_failure_rolls_back_quantity(self) -> None:
        from sync.executor import execute_plan_v2

        with patch(
            'sync.executor.verify_inventory_post_write',
            return_value=['forced audit mismatch'],
        ):
            with self.assertRaises(RuntimeError):
                execute_plan_v2(self._plan(qty=17), sync_log_enabled=True)
        qty, _, success_logs = self._read_quantity_and_logs()
        self.assertEqual(qty, 5)
        self.assertEqual(success_logs, 0)

    def test_required_success_log_failure_rolls_back_publish(self) -> None:
        from sync.executor import execute_plan_v2

        with patch(
            'sync.postgres_rpc._insert_sync_log_row',
            side_effect=RuntimeError('injected sync_log failure'),
        ):
            with self.assertRaises(RuntimeError):
                execute_plan_v2(self._plan(qty=17), sync_log_enabled=True)
        qty, _, success_logs = self._read_quantity_and_logs()
        self.assertEqual(qty, 5)
        self.assertEqual(success_logs, 0)

    def test_retry_after_log_failure_can_succeed(self) -> None:
        from sync.executor import execute_plan_v2

        os.environ['P0_02_SYNC_RUN_ID'] = self.sync_run_id
        result = execute_plan_v2(
            self._plan(qty=12),
            sync_log_enabled=True,
            sync_run_id=self.sync_run_id,
            triggered_by=self.admin_profile,
        )
        self.assertTrue(result.get('publish_committed'))
        qty, _, success_logs = self._read_quantity_and_logs()
        self.assertEqual(qty, 12)
        self.assertGreaterEqual(success_logs, 1)


if __name__ == '__main__':
    unittest.main()
