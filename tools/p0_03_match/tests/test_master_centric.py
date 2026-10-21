import unittest

from p0_03_match.master_centric import (
    build_master_centric_bundle,
    is_in_stock_bigseller_candidate,
    parse_available_qty,
)
from p0_03_match.models import MasterRow


class TestMasterCentric(unittest.TestCase):
    def test_parse_qty(self):
        self.assertEqual(parse_available_qty('10'), 10.0)
        self.assertEqual(parse_available_qty('0'), 0.0)
        self.assertEqual(parse_available_qty('-'), 0.0)

    def test_in_stock_filter(self):
        c = {
            'source': {
                'source_system': 'bigseller',
                'available_qty': '3',
                'sheet_name': '单个SKU',
                'extra': {'is_combo': False},
            }
        }
        self.assertTrue(is_in_stock_bigseller_candidate(c))

    def test_likely_ok_single_link(self):
        master = MasterRow(row_index=2, ice_code='A1', barcode='69', name_cn='品', spec='')
        bundle = {
            'master_quality_issues': [],
            'candidates': [
                {
                    'candidate_id': 'x',
                    'lifecycle': 'pending_review',
                    'match_methods': ['BARCODE_SKU'],
                    'flags': [],
                    'master_matches': [master.to_public()],
                    'name_review': {'status': 'NAME_EXACT'},
                    'source': {
                        'source_system': 'bigseller',
                        'available_qty': '5',
                        'sheet_name': '单个SKU',
                        'extra': {'is_combo': False},
                        'warehouse': 'WH',
                        'external_sku_raw': '69',
                        'external_name': '品',
                    },
                }
            ],
        }
        mc = build_master_centric_bundle([master], bundle)
        self.assertEqual(mc['summary']['likely_ok_unique_in_stock'], 1)
        self.assertEqual(mc['rows'][0]['review_tier'], 'likely_ok')


if __name__ == '__main__':
    unittest.main()
