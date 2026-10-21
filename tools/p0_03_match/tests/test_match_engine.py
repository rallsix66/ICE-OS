import unittest

from p0_03_match import config as cfg
from p0_03_match.match_engine import build_match_bundle
from p0_03_match.models import MasterRow, SourceRow


class MatchEngineTests(unittest.TestCase):
    def test_exact_ice_match_pending_review(self):
        master = [
            MasterRow(2, 'LS101311', '6974674958025', '产品A', '50g'),
        ]
        sources = [
            SourceRow(
                cfg.SOURCE_BIGSELLER,
                'bs:1',
                cfg.SCOPE_INVENTORY_PUBLISH,
                cfg.TARGET_INVENTORY_WAREHOUSE,
                '6974674958025',
                'BS名称',
                sheet_name=cfg.BIGSELLER_SHEET_SINGLE,
                available_qty='10',
                extra={'is_combo': False, 'sku_type': None},
            )
        ]
        bundle = build_match_bundle(master, sources)
        c = bundle['candidates'][0]
        self.assertEqual(c['lifecycle'], 'pending_review')
        self.assertEqual(len(c['master_matches']), 1)
        self.assertIn('BARCODE_SKU', c['match_methods'])
        self.assertTrue(c['auto_confirm_forbidden'])

    def test_one_to_many_flag(self):
        master = [
            MasterRow(2, 'LS101311', '6974674958025', '产品A', '50g'),
            MasterRow(3, 'LS101311', '6974674958025', '产品A副本', '50g'),
        ]
        sources = [
            SourceRow(
                cfg.SOURCE_JUSHUITAN,
                'jst:1',
                cfg.SCOPE_MATCH_ONLY,
                None,
                'LS101311',
                'JST',
                extra={'style_code': 'LS101311', 'product_code': 'LS101311'},
            )
        ]
        bundle = build_match_bundle(master, sources)
        c = bundle['candidates'][0]
        self.assertIn('ONE_TO_MANY', c['flags'])
        self.assertIn('DUPLICATE_ICE_CODE', {i['issue_type'] for i in bundle['master_quality_issues']})

    def test_combo_sku_flag(self):
        master = [MasterRow(2, '6974674957332', '6974674957332', '单件', '')]
        sources = [
            SourceRow(
                cfg.SOURCE_BIGSELLER,
                'bs:combo',
                cfg.SCOPE_MATCH_ONLY,
                cfg.TARGET_INVENTORY_WAREHOUSE,
                '6974674957332+6974674957356',
                '组合',
                sheet_name=cfg.BIGSELLER_SHEET_COMBO,
                extra={'is_combo': True, 'sku_type': '组合SKU'},
            )
        ]
        bundle = build_match_bundle(master, sources)
        c = bundle['candidates'][0]
        self.assertIn('COMBO_SKU', c['flags'])
        self.assertEqual(c['source']['scope'], cfg.SCOPE_MATCH_ONLY)

    def test_dee_single_scope_inventory_publish(self):
        master = [MasterRow(2, 'SKU1', '6900000000001', 'x', '')]
        sources = [
            SourceRow(
                cfg.SOURCE_BIGSELLER,
                'bs:dee',
                cfg.SCOPE_INVENTORY_PUBLISH,
                cfg.TARGET_INVENTORY_WAREHOUSE,
                '6900000000001',
                'n',
                sheet_name=cfg.BIGSELLER_SHEET_SINGLE,
                extra={'is_combo': False, 'sku_type': None},
            ),
            SourceRow(
                cfg.SOURCE_BIGSELLER,
                'bs:other',
                cfg.SCOPE_MATCH_ONLY,
                '越南青林湾仓库',
                '6900000000001',
                'n',
                sheet_name=cfg.BIGSELLER_SHEET_SINGLE,
                extra={'is_combo': False, 'sku_type': None},
            ),
        ]
        bundle = build_match_bundle(master, sources)
        scopes = {c['source']['source_row_key']: c['source']['scope'] for c in bundle['candidates']}
        self.assertEqual(scopes['bs:dee'], cfg.SCOPE_INVENTORY_PUBLISH)
        self.assertEqual(scopes['bs:other'], cfg.SCOPE_MATCH_ONLY)


    def test_ph_matches_by_ice_code_only(self):
        master = [MasterRow(2, 'WM0125', '6974674957332', '产品', '')]
        sources = [
            SourceRow(
                cfg.SOURCE_BIGSELLER,
                'bs:ph',
                cfg.SCOPE_MATCH_ONLY,
                '菲律宾-新创启辰自建仓',
                'WM0125',
                'n',
                sheet_name=cfg.BIGSELLER_SHEET_SINGLE,
                gtin_raw='6974674957332',
                extra={'is_combo': False, 'sku_type': None},
            )
        ]
        bundle = build_match_bundle(master, sources)
        c = bundle['candidates'][0]
        self.assertEqual(len(c['master_matches']), 1)
        self.assertIn('PH_ICE_CODE', c['match_methods'])
        self.assertNotIn('GTIN_BARCODE', c['match_methods'])

    def test_ph_barcode_sku_fallback(self):
        master = [MasterRow(2, 'WM0125', '6974674957332', '产品', '')]
        sources = [
            SourceRow(
                cfg.SOURCE_BIGSELLER,
                'bs:ph69',
                cfg.SCOPE_MATCH_ONLY,
                '菲律宾-新创启辰自建仓',
                '6974674957332',
                'n',
                sheet_name=cfg.BIGSELLER_SHEET_SINGLE,
                extra={'is_combo': False, 'sku_type': None},
            )
        ]
        bundle = build_match_bundle(master, sources)
        c = bundle['candidates'][0]
        self.assertEqual(len(c['master_matches']), 1)
        self.assertIn('PH_BARCODE_SKU', c['match_methods'])
        self.assertNotIn('PH_ICE_CODE', c['match_methods'])

    def test_dup_barcode_disambiguated_to_wm0012_in_ph_warehouse(self):
        bar = '6974674957349'
        master = [
            MasterRow(7, 'LS101275', bar, '氨基酸', ''),
            MasterRow(19, 'WM0012', bar, 'PH/VN', ''),
            MasterRow(116, 'WM00128', bar, '洗面奶（泰文标签版）', ''),
        ]
        sources = [
            SourceRow(
                cfg.SOURCE_BIGSELLER,
                'bs:ph',
                cfg.SCOPE_MATCH_ONLY,
                '菲律宾-新创启辰自建仓',
                bar,
                '洗面奶',
                sheet_name=cfg.BIGSELLER_SHEET_SINGLE,
                gtin_raw=bar,
                extra={'is_combo': False, 'sku_type': None},
            )
        ]
        bundle = build_match_bundle(master, sources)
        c = bundle['candidates'][0]
        self.assertEqual(len(c['master_matches']), 1)
        self.assertEqual(c['master_matches'][0]['ice_code'], 'WM0012')
        self.assertNotIn('ONE_TO_MANY', c['flags'])
        self.assertIn('MARKET_DISAMBIGUATED', c['flags'])

    def test_dup_barcode_disambiguated_to_wm00128_in_my_warehouse(self):
        bar = '6974674957349'
        master = [
            MasterRow(7, 'LS101275', bar, '氨基酸', ''),
            MasterRow(19, 'WM0012', bar, 'PH/VN', ''),
            MasterRow(116, 'WM00128', bar, '洗面奶（泰文标签版）', ''),
        ]
        sources = [
            SourceRow(
                cfg.SOURCE_BIGSELLER,
                'bs:my',
                cfg.SCOPE_MATCH_ONLY,
                '喜运达MY仓',
                bar,
                '洗面奶',
                sheet_name=cfg.BIGSELLER_SHEET_SINGLE,
                extra={'is_combo': False, 'sku_type': None},
            )
        ]
        bundle = build_match_bundle(master, sources)
        c = bundle['candidates'][0]
        self.assertEqual(c['master_matches'][0]['ice_code'], 'WM00128')

    def test_non_ph_ice_sku_is_outside_rules(self):
        master = [MasterRow(2, 'LS101311', '6974674958025', '产品A', '50g')]
        sources = [
            SourceRow(
                cfg.SOURCE_BIGSELLER,
                'bs:vn',
                cfg.SCOPE_MATCH_ONLY,
                '越南青林湾仓库',
                'LS101311',
                'n',
                sheet_name=cfg.BIGSELLER_SHEET_SINGLE,
                extra={'is_combo': False, 'sku_type': None},
            )
        ]
        bundle = build_match_bundle(master, sources)
        c = bundle['candidates'][0]
        self.assertEqual(c['lifecycle'], 'outside_rules')


if __name__ == '__main__':
    unittest.main()
