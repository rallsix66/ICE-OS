"""P0-02 真实 PostgreSQL 读链：仓库 → 变体/库存 → 计划 → JSON（虚构 fixture）。"""
from __future__ import annotations

import json
import os
import unittest

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
