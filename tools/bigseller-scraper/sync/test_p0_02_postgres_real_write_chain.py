"""P0-02 独占 fixture：dry-run 计划 → execute_plan_v2（事务内审计后提交）。"""
from __future__ import annotations

import json
import os
import unittest
import uuid
from unittest.mock import patch
from datetime import datetime, timezone
from pathlib import Path

from sync.p0_02_test_fixture import OwnedFixtureRegistry


def _load_owner_dsn() -> str:
    run_id = os.environ.get('P0_02_RUN_ID', 'run-20261014-r2')
    root = Path(__file__).resolve().parents[3]
    inst = json.loads((root / '.local/p0-02' / run_id / 'instance.json').read_text(encoding='utf-8'))
    return (
        f"host={inst['host']} port={inst['port']} dbname={inst['dbName']} "
        f"user={inst['bootstrapUser']} password={inst['bootstrapPassword']}"
    )


class P002PostgresRealWriteChainTests(unittest.TestCase):
    registry: OwnedFixtureRegistry
    wh: str
    sentinel_wh: str
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
        os.environ['BS_TARGET_WAREHOUSE_NAME'] = 'P0-02 RW fixture wh'
        os.environ['BS_OLD_WAREHOUSE_NAME'] = 'P0-02 RW fixture wh'
        os.environ['BS_NEW_VARIANT_COUNTRY'] = 'TH'
        import sync.config as cfg

        cfg.WAREHOUSE_COUNTRY = 'TH'
        cfg.TARGET_WAREHOUSE_NAME = 'P0-02 RW fixture wh'
        cfg.OLD_WAREHOUSE_NAME = 'P0-02 RW fixture wh'

        cls.registry = OwnedFixtureRegistry(_load_owner_dsn())
        cls.addClassCleanup(cls._class_fixture_cleanup)
        cls.registry.capture_baseline()

        cls.wh = str(uuid.uuid4())
        cls.sentinel_wh = str(uuid.uuid4())
        cls.variant = str(uuid.uuid4())
        cls.inventory_id = str(uuid.uuid4())
        cls.sku = f'RW-{cls.variant[:8]}'
        cls.sync_run_id = str(uuid.uuid4())
        cls.dry_run_id = str(uuid.uuid4())
        cls.admin_profile = '11111111-1111-4111-8111-111111111101'

        cls.registry.register_warehouse(cls.wh)
        cls.registry.register_warehouse(cls.sentinel_wh)
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
                    (cls.wh, 'P0-02 RW fixture wh'),
                )
                cur.execute(
                    """
                    INSERT INTO public.warehouse (id, name, country, type, is_active)
                    VALUES (%s, %s, 'TH', 'overseas', true)
                    """,
                    (cls.sentinel_wh, f'P0-02 RW fixture decoy {cls.sentinel_wh[:8]}'),
                )
                sentinel_variant = str(uuid.uuid4())
                cls.registry.register_variant(sentinel_variant)
                cur.execute(
                    """
                    INSERT INTO public.product_variant (id, sku, country, name, match_status)
                    VALUES (%s, %s, 'TH', 'RW sentinel variant', 'unmatched')
                    """,
                    (sentinel_variant, f'RW-SENT-{cls.sentinel_wh[:8]}'),
                )
                cur.execute(
                    """
                    INSERT INTO public.inventory (id, variant_id, warehouse_id, quantity)
                    VALUES (%s, %s, %s, 7)
                    """,
                    (str(uuid.uuid4()), sentinel_variant, cls.sentinel_wh),
                )
                cur.execute(
                    """
                    INSERT INTO public.product_variant (id, sku, country, name, match_status)
                    VALUES (%s, %s, 'TH', 'RW variant', 'unmatched')
                    """,
                    (cls.variant, cls.sku),
                )
                cur.execute(
                    """
                    INSERT INTO public.inventory (id, variant_id, warehouse_id, quantity)
                    VALUES (%s, %s, %s, 5)
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
                      'dry-input-artifact', 'dry-plan-artifact',
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
                      'test-input-artifact', 'test-plan-artifact', %s::uuid
                    )
                    """,
                    (cls.sync_run_id, cls.wh, cls.admin_profile, cls.dry_run_id),
                )
            conn.commit()
        finally:
            conn.close()
        cls.registry.capture_sentinel_snapshot([cls.sentinel_wh])

    @classmethod
    def _class_fixture_cleanup(cls) -> None:
        if not hasattr(cls, 'registry') or cls.registry is None:
            return
        report = cls.registry.class_cleanup(verify_counts=True)
        if report.get('errors'):
            raise AssertionError(f'fixture cleanup failed: {report}')

    @classmethod
    def tearDownClass(cls) -> None:
        cls._class_fixture_cleanup()

    def _new_variant_plan(self, new_sku: str, *, qty: int) -> dict:
        sync_at = datetime.now(timezone.utc).isoformat()
        self.registry.register_owned_sku(new_sku, self.wh)
        return {
            'warehouse_rename_required': {
                'warehouse_id': self.wh,
                'action': 'none',
                'target_name': 'P0-02 RW fixture wh',
            },
            'new_variants': [{'sku': new_sku, 'country': 'TH', 'name': 'Inserted by RW test'}],
            'inventory_updates': [],
            'inventory_inserts': [
                {
                    'sku': new_sku,
                    'country': 'TH',
                    'new_quantity': qty,
                    'warehouse_id': self.wh,
                    'last_sync_at': sync_at,
                },
            ],
            'inventory_after_variant_create': [],
            'inventory_unchanged': [
                {
                    'sku': self.sku,
                    'warehouse_id': self.wh,
                    'quantity': 5,
                    'new_quantity': 5,
                    'last_sync_at': sync_at,
                },
            ],
        }

    def setUp(self) -> None:
        os.environ['BS_WAREHOUSE_COUNTRY'] = 'TH'
        os.environ['BS_TARGET_WAREHOUSE_NAME'] = 'P0-02 RW fixture wh'
        os.environ['BS_OLD_WAREHOUSE_NAME'] = 'P0-02 RW fixture wh'
        os.environ['BS_NEW_VARIANT_COUNTRY'] = 'TH'
        os.environ['P0_02_SYNC_RUN_ID'] = self.sync_run_id
        os.environ['P0_02_SYNC_TRIGGERED_BY'] = self.admin_profile
        import sync.config as cfg

        cfg.WAREHOUSE_COUNTRY = 'TH'
        cfg.TARGET_WAREHOUSE_NAME = 'P0-02 RW fixture wh'
        cfg.OLD_WAREHOUSE_NAME = 'P0-02 RW fixture wh'

        import psycopg

        conn = psycopg.connect(_load_owner_dsn())
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    DELETE FROM public.inventory
                    WHERE warehouse_id = %s::uuid AND variant_id <> %s::uuid
                    """,
                    (self.wh, self.variant),
                )
                cur.execute(
                    'UPDATE public.inventory SET quantity = 5 WHERE id = %s::uuid',
                    (self.inventory_id,),
                )
                cur.execute(
                    'DELETE FROM public.sync_log WHERE warehouse_id = %s::uuid',
                    (self.wh,),
                )
            conn.commit()
        finally:
            conn.close()

    def tearDown(self) -> None:
        errors = self.registry.cleanup_owned_skus()
        if errors:
            raise AssertionError(f'owned sku cleanup failed: {errors}')
        self.registry.assert_sentinels_unchanged([self.sentinel_wh])

    def _plan(self, *, qty: int, new_variants: list | None = None) -> dict:
        sync_at = datetime.now(timezone.utc).isoformat()
        return {
            'warehouse_rename_required': {
                'warehouse_id': self.wh,
                'action': 'none',
                'target_name': 'P0-02 RW fixture wh',
            },
            'new_variants': new_variants or [],
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

    def test_quantity_update_and_sync_log_run_binding(self) -> None:
        from sync.executor import execute_plan_v2
        from sync.p0_02_connection_boundary import connect_validated_sync

        os.environ['P0_02_SYNC_RUN_ID'] = self.sync_run_id
        os.environ['P0_02_SYNC_TRIGGERED_BY'] = self.admin_profile

        result = execute_plan_v2(
            self._plan(qty=9),
            sync_log_enabled=True,
            sync_run_id=self.sync_run_id,
            triggered_by=self.admin_profile,
        )
        self.assertTrue(result.get('publish_committed'))
        self.assertTrue(result.get('phase_g_verified'))
        self.assertTrue(result.get('sync_log_written'))

        psycopg = __import__('psycopg')
        conn = connect_validated_sync(import_psycopg=psycopg)
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT set_config('p0_02.sync.mode', 'warehouse', true)")
                cur.execute(
                    "SELECT set_config('p0_02.sync.warehouse_id', %s, true)",
                    (self.wh,),
                )
                cur.execute(
                    'SELECT quantity FROM public.inventory WHERE id = %s::uuid',
                    (self.inventory_id,),
                )
                row = cur.fetchone()
                self.assertEqual(int(row[0]), 9)
                cur.execute(
                    """
                    SELECT status, sync_run_id::text, triggered_by::text
                    FROM public.sync_log
                    WHERE warehouse_id = %s::uuid AND sync_run_id = %s::uuid
                    ORDER BY finished_at DESC NULLS LAST
                    LIMIT 1
                    """,
                    (self.wh, self.sync_run_id),
                )
                log_row = cur.fetchone()
                self.assertIsNotNone(log_row)
                self.assertEqual(log_row[0], 'success')
                self.assertEqual(log_row[1], self.sync_run_id)
                self.assertEqual(log_row[2], self.admin_profile)
        finally:
            conn.close()

    def test_new_sku_insert_via_sync(self) -> None:
        from sync.executor import execute_plan_v2

        new_sku = f'RW-NEW-{uuid.uuid4().hex[:8]}'
        plan = self._new_variant_plan(new_sku, qty=3)
        result = execute_plan_v2(plan, sync_log_enabled=True)
        self.assertTrue(result.get('publish_committed'))
        summary = result.get('rpc_summary') or {}
        self.assertGreaterEqual(int(summary.get('variants_created', 0)), 1)
        created_variant_id = self.registry.resolve_and_register_variant_by_sku(new_sku, self.wh)
        self.assertIsNotNone(created_variant_id)

    def test_post_publish_assertion_failure_still_restores_new_variant(self) -> None:
        from sync.executor import execute_plan_v2

        new_sku = f'RW-NEW-{uuid.uuid4().hex[:8]}'
        plan = self._new_variant_plan(new_sku, qty=2)
        try:
            result = execute_plan_v2(plan, sync_log_enabled=True)
            self.assertTrue(result.get('publish_committed'))
            with self.assertRaises(AssertionError):
                raise AssertionError('controlled post-publish assertion failure')
        finally:
            errors = self.registry.cleanup_owned_skus()
            self.assertEqual(errors, [])
            self.registry.assert_sentinels_unchanged([self.sentinel_wh])

    def test_uuid_read_failure_still_restores_new_variant(self) -> None:
        from sync.executor import execute_plan_v2

        new_sku = f'RW-NEW-{uuid.uuid4().hex[:8]}'
        plan = self._new_variant_plan(new_sku, qty=4)
        try:
            result = execute_plan_v2(plan, sync_log_enabled=True)
            self.assertTrue(result.get('publish_committed'))
            with patch.object(
                self.registry,
                'resolve_and_register_variant_by_sku',
                side_effect=RuntimeError('controlled uuid read failure'),
            ):
                with self.assertRaises(RuntimeError):
                    self.registry.resolve_and_register_variant_by_sku(new_sku, self.wh)
        finally:
            errors = self.registry.cleanup_owned_skus()
            self.assertEqual(errors, [])
            self.registry.assert_sentinels_unchanged([self.sentinel_wh])


if __name__ == '__main__':
    unittest.main()
