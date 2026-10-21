import unittest

from p0_03_match import config as cfg
from p0_03_match.match_engine import build_match_bundle
from p0_03_match.models import MasterRow, SourceRow


class BigsellerSkuAliasTests(unittest.TestCase):
    def test_kp0001_maps_to_wm0117_non_ph(self):
        master = [MasterRow(108, 'WM0117', '', '售后卡', '')]
        sources = [
            SourceRow(
                cfg.SOURCE_BIGSELLER,
                'bs:kp-dee',
                cfg.SCOPE_MATCH_ONLY,
                cfg.TARGET_INVENTORY_WAREHOUSE,
                'KP0001',
                '泰国售后卡',
                sheet_name=cfg.BIGSELLER_SHEET_SINGLE,
            ),
        ]
        bundle = build_match_bundle(master, sources)
        c = bundle['candidates'][0]
        self.assertEqual(c['lifecycle'], 'pending_review')
        self.assertEqual(len(c['master_matches']), 1)
        self.assertEqual(c['master_matches'][0]['ice_code'], 'WM0117')
        self.assertIn('BS_SKU_ALIAS', c['match_methods'])

    def test_wm0005_dee_thailand_only(self):
        master = [MasterRow(12, 'WM0005', '714855625096', '泥膜', '7.5g')]
        dee = SourceRow(
            cfg.SOURCE_BIGSELLER,
            'bs:dee-wm5',
            cfg.SCOPE_MATCH_ONLY,
            cfg.TARGET_INVENTORY_WAREHOUSE,
            'WM0005',
            '泥膜',
            sheet_name=cfg.BIGSELLER_SHEET_SINGLE,
        )
        idn = SourceRow(
            cfg.SOURCE_BIGSELLER,
            'bs:idn-wm5',
            cfg.SCOPE_MATCH_ONLY,
            '印尼-DEE仓库',
            'WM0005',
            '泥膜',
            sheet_name=cfg.BIGSELLER_SHEET_SINGLE,
        )
        bundle = build_match_bundle(master, [dee, idn])
        by_wh = {c['source']['warehouse']: c for c in bundle['candidates']}
        self.assertEqual(by_wh[cfg.TARGET_INVENTORY_WAREHOUSE]['lifecycle'], 'pending_review')
        self.assertEqual(
            by_wh[cfg.TARGET_INVENTORY_WAREHOUSE]['master_matches'][0]['ice_code'],
            'WM0005',
        )
        self.assertEqual(by_wh['印尼-DEE仓库']['lifecycle'], 'outside_rules')

    def test_wm0005_vietnam(self):
        master = [MasterRow(12, 'WM0005', '714855625096', '泥膜', '')]
        sources = [
            SourceRow(
                cfg.SOURCE_BIGSELLER,
                'bs:vn-wm5',
                cfg.SCOPE_MATCH_ONLY,
                '越南青林湾仓库',
                'WM0005',
                '泥膜',
                sheet_name=cfg.BIGSELLER_SHEET_SINGLE,
            ),
        ]
        bundle = build_match_bundle(master, sources)
        c = bundle['candidates'][0]
        self.assertEqual(c['lifecycle'], 'pending_review')
        self.assertEqual(c['master_matches'][0]['ice_code'], 'WM0005')

    def test_icewm0027_malaysia(self):
        master = [MasterRow(21, 'WM0027', '757577983037', '护发精油', '')]
        sources = [
            SourceRow(
                cfg.SOURCE_BIGSELLER,
                'bs:my-27',
                cfg.SCOPE_MATCH_ONLY,
                '喜运达MY仓',
                'ICEWM0027',
                '无花果精油',
                sheet_name=cfg.BIGSELLER_SHEET_SINGLE,
            ),
        ]
        bundle = build_match_bundle(master, sources)
        c = bundle['candidates'][0]
        self.assertEqual(c['lifecycle'], 'pending_review')
        self.assertEqual(c['master_matches'][0]['ice_code'], 'WM0027')

    def test_barcode_757577407359_wm0073_th_my_only(self):
        master = [
            MasterRow(
                67,
                'WM0073',
                '',
                'ICE LERSKIN 护发精油套盒 20ml*4瓶-泰国特供版',
                '',
            ),
        ]
        sources = [
            SourceRow(
                cfg.SOURCE_BIGSELLER,
                'bs:dee-th-set',
                cfg.SCOPE_MATCH_ONLY,
                cfg.TARGET_INVENTORY_WAREHOUSE,
                '757577407359',
                'ICE LERSKIN 护发精油套盒20m*4瓶(泰国特供版)',
                sheet_name=cfg.BIGSELLER_SHEET_SINGLE,
                available_qty='8550',
            ),
            SourceRow(
                cfg.SOURCE_BIGSELLER,
                'bs:my-th-set',
                cfg.SCOPE_MATCH_ONLY,
                cfg.MALAYSIA_MY_WAREHOUSE,
                '757577407359',
                '泰国特供套盒',
                sheet_name=cfg.BIGSELLER_SHEET_SINGLE,
                available_qty='4094',
            ),
            SourceRow(
                cfg.SOURCE_BIGSELLER,
                'bs:ph-th-bar',
                cfg.SCOPE_MATCH_ONLY,
                '菲律宾-新创启辰自建仓',
                '757577407359',
                'ICE LERSKIN 护发精油套盒20m*4瓶(泰国特供版)',
                sheet_name=cfg.BIGSELLER_SHEET_SINGLE,
            ),
        ]
        bundle = build_match_bundle(master, sources)
        by_key = {c['source']['warehouse']: c for c in bundle['candidates']}
        for wh in (cfg.TARGET_INVENTORY_WAREHOUSE, cfg.MALAYSIA_MY_WAREHOUSE):
            c = by_key[wh]
            self.assertEqual(c['lifecycle'], 'pending_review')
            self.assertEqual(c['master_matches'][0]['ice_code'], 'WM0073')
            self.assertIn('BS_SKU_ALIAS', c['match_methods'])
        ph = by_key['菲律宾-新创启辰自建仓']
        self.assertEqual(ph['lifecycle'], 'unmatched')
        self.assertEqual(ph['master_matches'], [])


if __name__ == '__main__':
    unittest.main()
