import unittest

from p0_03_match.html_databases import build_three_databases
from p0_03_match.models import MasterRow


class HtmlDatabasesTests(unittest.TestCase):
    def test_build_three_databases_counts(self):
        master = [
            MasterRow(row_index=2, ice_code='WM1', barcode='69', name_cn='n', spec=''),
        ]
        bundle = {
            'candidates': [
                {
                    'candidate_id': 'mc-bs',
                    'lifecycle': 'unmatched',
                    'flags': [],
                    'master_matches': [],
                    'source': {
                        'source_system': 'bigseller',
                        'external_sku_raw': 'S1',
                        'external_name': 'bs',
                        'warehouse': 'W',
                        'available_qty': '1',
                    },
                },
                {
                    'candidate_id': 'mc-jst',
                    'lifecycle': 'pending_review',
                    'flags': [],
                    'master_matches': [master[0].to_public()],
                    'source': {
                        'source_system': 'jushuitan',
                        'external_sku_raw': 'J1',
                        'external_name': 'jst',
                        'available_qty': '10',
                        'extra': {'style_code': 'WM1', 'product_code': 'WM1'},
                    },
                },
            ]
        }
        db = build_three_databases(bundle, master)
        self.assertEqual(db['counts']['master'], 1)
        self.assertEqual(db['counts']['bigseller'], 1)
        self.assertEqual(db['counts']['jushuitan'], 1)
        self.assertEqual(db['jushuitan'][0]['matchedIce'], 'WM1')


if __name__ == '__main__':
    unittest.main()
