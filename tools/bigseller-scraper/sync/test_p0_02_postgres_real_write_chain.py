"""P0-02 虚构 fixture：dry-run 计划 → execute_plan_v2（PostgreSQL RPC + sync_log）。"""
from __future__ import annotations

import json
import os
import unittest
from datetime import datetime, timezone

WH_TH = '33333333-3333-4333-8333-333333333302'
SKU = 'SKU-TH-001'


class P002PostgresRealWriteChainTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if os.environ.get('P0_02_SYNC_DATABASE_URL', '').strip() == '':
            raise unittest.SkipTest('缺少 P0_02_SYNC_DATABASE_URL')
        os.environ['P0_02_ENABLED'] = 'true'
        os.environ['BS_WAREHOUSE_COUNTRY'] = 'TH'
        os.environ['BS_TARGET_WAREHOUSE_NAME'] = '泰国海外仓'
        os.environ['BS_OLD_WAREHOUSE_NAME'] = '泰国海外仓'
        os.environ['BS_NEW_VARIANT_COUNTRY'] = 'TH'
        import sync.config as cfg

        cfg.WAREHOUSE_COUNTRY = 'TH'
        cfg.TARGET_WAREHOUSE_NAME = '泰国海外仓'
        cfg.OLD_WAREHOUSE_NAME = '泰国海外仓'

    def test_execute_plan_v2_unchanged_inventory_and_sync_log(self) -> None:
        from sync.db_read_gateway import fetch_inventory_by_warehouse, fetch_warehouse
        from sync.executor import execute_plan_v2
        from sync.p0_02_connection_boundary import connect_validated_sync

        wh = fetch_warehouse()
        self.assertEqual(wh['id'], WH_TH)
        before = fetch_inventory_by_warehouse(WH_TH)
        row = next((r for r in before if r.get('quantity') is not None), None)
        self.assertIsNotNone(row)
        qty = int(row['quantity'])

        sync_at = datetime.now(timezone.utc).isoformat()
        plan = {
            'warehouse_rename_required': {
                'warehouse_id': WH_TH,
                'action': 'none',
                'target_name': '泰国海外仓',
            },
            'new_variants': [],
            'inventory_updates': [],
            'inventory_inserts': [],
            'inventory_after_variant_create': [],
            'inventory_unchanged': [
                {
                    'sku': SKU,
                    'warehouse_id': WH_TH,
                    'quantity': qty,
                    'new_quantity': qty,
                    'last_sync_at': sync_at,
                },
            ],
        }

        result = execute_plan_v2(plan, sync_log_enabled=True)
        self.assertTrue(result.get('phase_g_verified'))
        self.assertTrue(result.get('phase_i_verified'))
        self.assertTrue(result.get('sync_log_written'))

        after = fetch_inventory_by_warehouse(WH_TH)
        after_row = next(r for r in after if str(r.get('variant_id')) == str(row.get('variant_id')))
        self.assertEqual(int(after_row['quantity']), qty)

        psycopg = __import__('psycopg')
        conn = connect_validated_sync(import_psycopg=psycopg)
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT set_config('p0_02.sync.mode', 'warehouse', true)")
                cur.execute(
                    "SELECT set_config('p0_02.sync.warehouse_id', %s, true)",
                    (WH_TH,),
                )
                cur.execute(
                    """
                    SELECT status, new_variants_count
                    FROM public.sync_log
                    WHERE warehouse_id = %s::uuid
                    ORDER BY finished_at DESC NULLS LAST
                    LIMIT 1
                    """,
                    (WH_TH,),
                )
                log_row = cur.fetchone()
                self.assertIsNotNone(log_row)
                status = log_row[0] if not isinstance(log_row, dict) else log_row['status']
                self.assertEqual(status, 'success')
        finally:
            conn.close()

        # 幂等：相同 unchanged 计划再跑一次仍应成功
        result2 = execute_plan_v2(plan, sync_log_enabled=True)
        self.assertTrue(result2.get('phase_g_verified'))
        encoded = json.dumps(result2.get('rpc_summary') or {})
        self.assertIn('inventory_unchanged', encoded)


if __name__ == '__main__':
    unittest.main()
