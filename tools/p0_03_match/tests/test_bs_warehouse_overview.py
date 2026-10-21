import unittest

from p0_03_match.export_bs_warehouse_overview import (
    build_bs_warehouse_detail_rows,
    build_bs_warehouse_overview_rows,
)


class BsWarehouseOverviewTests(unittest.TestCase):
    def test_aggregates_by_warehouse(self):
        bundle = {
            'candidates': [
                {
                    'candidate_id': 'a',
                    'lifecycle': 'pending_review',
                    'master_matches': [{'ice_code': 'X'}],
                    'source': {
                        'source_system': 'bigseller',
                        'warehouse': '菲律宾-新创启辰自建仓',
                        'available_qty': '5',
                        'sheet_name': '单个SKU',
                        'external_sku_raw': 'ICE1',
                    },
                },
                {
                    'candidate_id': 'b',
                    'lifecycle': 'outside_rules',
                    'master_matches': [],
                    'flags': ['OUTSIDE_MATCH_POLICY'],
                    'source': {
                        'source_system': 'bigseller',
                        'warehouse': '菲律宾-新创启辰自建仓',
                        'available_qty': '0',
                        'sheet_name': '组合SKU',
                        'external_sku_raw': 'A+B',
                    },
                },
            ]
        }
        rows = build_bs_warehouse_overview_rows(bundle)
        wh = next(r for r in rows if r['warehouse'] == '菲律宾-新创启辰自建仓')
        self.assertEqual(wh['bs_rows_total'], 2)
        self.assertEqual(wh['in_policy_rows'], 1)
        self.assertEqual(wh['linked_master_rows'], 1)
        self.assertEqual(wh['outside_rules_rows'], 1)

    def test_detail_rows_per_candidate(self):
        bundle = {
            'candidates': [
                {
                    'candidate_id': 'x',
                    'lifecycle': 'outside_rules',
                    'master_matches': [],
                    'flags': ['OUTSIDE_MATCH_POLICY'],
                    'notes': '组合 SKU',
                    'source': {
                        'source_system': 'bigseller',
                        'warehouse': '越南青林湾仓库',
                        'sheet_name': '组合SKU',
                        'external_sku_raw': 'A+B',
                        'available_qty': '1',
                    },
                },
            ]
        }
        details = build_bs_warehouse_detail_rows(bundle)
        self.assertEqual(len(details), 1)
        self.assertEqual(details[0]['warehouse'], '越南青林湾仓库')
        self.assertEqual(details[0]['policy'], '规则外')


if __name__ == '__main__':
    unittest.main()
