import unittest

from p0_03_match.bigseller_centric import build_workbench_queue_summary


class WorkbenchQueueTests(unittest.TestCase):
    def test_manual_master_excluded_from_queue(self):
        bundle = {
            'candidates': [
                {
                    'candidate_id': 'bs-a',
                    'lifecycle': 'unmatched',
                    'master_matches': [],
                    'source': {
                        'source_system': 'bigseller',
                        'external_sku_raw': 'A',
                        'warehouse': '菲律宾仓',
                        'available_qty': '5',
                    },
                },
                {
                    'candidate_id': 'bs-b',
                    'lifecycle': 'unmatched',
                    'master_matches': [],
                    'source': {
                        'source_system': 'bigseller',
                        'external_sku_raw': 'B',
                        'warehouse': '菲律宾仓',
                        'available_qty': '3',
                    },
                },
            ]
        }
        embedded = {'bs-a': {'manual_master_row': '10', 'decision': 'confirm'}}
        out = build_workbench_queue_summary(bundle, embedded)
        self.assertEqual(out['workbench_in_stock_queue_count'], 1)
        self.assertEqual(out['workbench_in_stock_queue_ids'], ['bs-b'])
        self.assertIn('bs-a', out['workbench_resolved_manual_ids'])


if __name__ == '__main__':
    unittest.main()
