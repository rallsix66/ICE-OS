"""P0-02 真实 PostgreSQL 读链：仓库 → 变体/库存 → 计划 → JSON（虚构 fixture）。"""
from __future__ import annotations

import json
import os
import unittest
from pathlib import Path

from sync.config import WAREHOUSE_COUNTRY
from sync.db_read_gateway import (
    fetch_inventory_by_warehouse,
    fetch_variants,
    fetch_warehouse,
)
from sync.plan_generator import generate_plan


class P002PostgresGatewayChainTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if os.environ.get('P0_02_SYNC_DATABASE_URL', '').strip() == '':
            raise unittest.SkipTest('缺少 P0_02_SYNC_DATABASE_URL，跳过真实 PG 链测试')
        os.environ['P0_02_ENABLED'] = 'true'
        os.environ.setdefault('BS_WAREHOUSE_COUNTRY', 'TH')
        os.environ.setdefault('BS_NEW_VARIANT_COUNTRY', 'TH')
        if not os.environ.get('P0_02_TARGET_WAREHOUSE_ID', '').strip():
            run_id = os.environ.get('P0_02_RUN_ID', 'run-20261014-r2')
            inst = json.loads(
                (Path(__file__).resolve().parents[3] / '.local/p0-02' / run_id / 'instance.json').read_text(
                    encoding='utf-8',
                ),
            )
            owner_dsn = (
                f"host={inst['host']} port={inst['port']} dbname={inst['dbName']} "
                f"user={inst['bootstrapUser']} password={inst['bootstrapPassword']}"
            )
            import psycopg

            conn = psycopg.connect(owner_dsn)
            try:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        SELECT w.id::text
                        FROM public.warehouse w
                        JOIN public.inventory i ON i.warehouse_id = w.id
                        WHERE w.country = 'TH' AND w.type = 'overseas' AND w.is_active = true
                        ORDER BY w.name
                        LIMIT 1
                        """,
                    )
                    row = cur.fetchone()
                    if row is None:
                        raise unittest.SkipTest('fixture 缺少 TH 库存仓')
                    os.environ['P0_02_TARGET_WAREHOUSE_ID'] = row[0]
            finally:
                conn.close()

    def test_read_plan_json_roundtrip(self) -> None:
        warehouse = fetch_warehouse()
        self.assertIsInstance(warehouse['id'], str)
        variants = fetch_variants()
        self.assertGreater(len(variants), 0)
        self.assertIsInstance(variants[0]['id'], str)

        inventories = fetch_inventory_by_warehouse(warehouse['id'])
        self.assertGreaterEqual(len(inventories), 0)
        for row in inventories:
            self.assertIsInstance(row.get('warehouse_id'), str)
            self.assertIsInstance(row.get('variant_id'), str)

        sku = variants[0]['sku']
        input_rows = [
            {
                'sku': sku,
                'product_name': variants[0].get('name') or 'P0-02 fixture',
                'available_quantity': 1,
            },
        ]
        plan = generate_plan(input_rows, {
            'warehouse': warehouse,
            'variants': variants,
            'inventories': inventories,
        })
        encoded = json.dumps(plan)
        self.assertIn('inventory_', encoded)
        self.assertIn(WAREHOUSE_COUNTRY, warehouse.get('country', ''))


if __name__ == '__main__':
    unittest.main()
