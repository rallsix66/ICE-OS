"""web_bridge commit_outcome 判定单元测试。"""
from __future__ import annotations

import unittest

from sync.web_bridge import evaluate_real_write_bridge_outcome


class P002WebBridgeCommitOutcomeTests(unittest.TestCase):
    def _base_result(self) -> dict:
        return {
            'success': False,
            'exit_code': 1,
            'errors': [],
            'summary': {},
        }

    def test_committed_ack_lost_is_success_with_outcome(self) -> None:
        result = self._base_result()
        receipt = {
            'phase_g_verified': True,
            'phase_i_verified': True,
            'publish_committed': True,
            'commit_outcome': 'committed_ack_lost',
            'sync_log_enabled': True,
            'sync_log_written': True,
            'rpc_summary': {'variants_updated': 1},
            'errors': ['发布事务已在数据库提交，但 commit 回执丢失: CONTROLLED'],
        }
        evaluate_real_write_bridge_outcome(result, receipt)
        self.assertTrue(result['success'])
        self.assertEqual(result['exit_code'], 0)
        self.assertEqual(result['commit_outcome'], 'committed_ack_lost')

    def test_unknown_commit_outcome_fails_with_exit_2(self) -> None:
        result = self._base_result()
        receipt = {
            'phase_g_verified': True,
            'phase_i_verified': True,
            'publish_committed': False,
            'commit_outcome': 'unknown',
            'sync_log_enabled': True,
            'sync_log_written': False,
            'rpc_summary': {},
            'errors': ['发布 commit 结果未知'],
        }
        evaluate_real_write_bridge_outcome(result, receipt)
        self.assertFalse(result['success'])
        self.assertEqual(result['exit_code'], 2)
        self.assertEqual(result['commit_outcome'], 'unknown')


if __name__ == '__main__':
    unittest.main()
