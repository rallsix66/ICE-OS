import unittest

from p0_03_match import config as cfg
from p0_03_match.unified_view import build_unified_rows


class UnifiedViewTests(unittest.TestCase):
    def test_full_chain_on_same_master(self):
        master = {
            'row_index': 2,
            'ice_code': 'A1',
            'barcode': '6901',
            'name_cn': '品',
            'spec': '',
        }
        bundle = {
            'candidates': [
                {
                    'candidate_id': 'bs1',
                    'lifecycle': 'pending_review',
                    'flags': [],
                    'match_methods': ['PH_ICE_CODE'],
                    'master_matches': [master],
                    'source': {
                        'source_system': cfg.SOURCE_BIGSELLER,
                        'external_sku_raw': 'A1',
                        'external_name': 'bs',
                        'available_qty': '3',
                        'warehouse': '菲律宾仓',
                    },
                },
                {
                    'candidate_id': 'j1',
                    'lifecycle': 'pending_review',
                    'flags': [],
                    'match_methods': ['JST_STYLE_CODE'],
                    'master_matches': [master],
                    'source': {
                        'source_system': cfg.SOURCE_JUSHUITAN,
                        'external_sku_raw': 'A1',
                        'external_name': 'jst',
                        'extra': {'style_code': 'A1', 'product_code': 'A1'},
                    },
                },
            ]
        }
        uv = build_unified_rows(bundle)
        self.assertEqual(uv['summary']['three_way_linked'], 1)
        row = uv['rows'][0]
        self.assertEqual(row['tier'], 'full')
        self.assertEqual(len(row['bigseller']), 1)
        self.assertEqual(len(row['jushuitan']), 1)


if __name__ == '__main__':
    unittest.main()
