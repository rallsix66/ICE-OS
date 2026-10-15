"""P0-02 publish verify 单元测试（无数据库）。"""
from __future__ import annotations

import unittest

from sync.p0_02_publish_verify import finalize_committed_evidence


class P002PublishVerifyTests(unittest.TestCase):
    def test_empty_evidence_not_committed(self) -> None:
        outcome = finalize_committed_evidence(
            {
                'inventory_quantity': None,
                'inventory_matches_expected': False,
                'success_log_present': False,
                'success_log_sync_run_id': None,
            },
            expected_quantity=9,
            sync_run_id='00000000-0000-4000-8000-000000000002',
        )
        self.assertFalse(outcome['committed_evidence'])
        self.assertEqual(outcome['evidence_reason'], 'inventory_row_missing')

    def test_missing_sync_run_id_not_committed(self) -> None:
        outcome = finalize_committed_evidence(
            {
                'inventory_quantity': 9,
                'inventory_matches_expected': True,
                'success_log_present': True,
                'success_log_sync_run_id': '00000000-0000-4000-8000-000000000002',
            },
            expected_quantity=9,
            sync_run_id=None,
        )
        self.assertFalse(outcome['committed_evidence'])
        self.assertEqual(outcome['evidence_reason'], 'missing_expected_quantity_or_sync_run_id')


if __name__ == '__main__':
    unittest.main()
