import unittest

from p0_03_match import config as cfg
from p0_03_match.match_engine import build_match_bundle
from p0_03_match.match_policy import LIFECYCLE_OUTSIDE, looks_like_match_barcode
from p0_03_match.models import MasterRow, SourceRow


class MatchPolicyTests(unittest.TestCase):
    def test_looks_like_match_barcode(self):
        self.assertTrue(looks_like_match_barcode('6974674958025'))
        self.assertTrue(looks_like_match_barcode('757577407113'))
        self.assertTrue(looks_like_match_barcode('780103214077'))
        self.assertFalse(looks_like_match_barcode('LS101311'))
        self.assertFalse(looks_like_match_barcode('WM0005'))

    def test_non_ph_757_barcode_in_policy_and_matches(self):
        master = [MasterRow(2, 'WM1', '757577407113', '防晒', '150ML')]
        sources = [
            SourceRow(
                cfg.SOURCE_BIGSELLER,
                'bs:vn-bar',
                cfg.SCOPE_MATCH_ONLY,
                '越南青林湾仓库',
                '757577407113',
                '喷雾',
                sheet_name=cfg.BIGSELLER_SHEET_SINGLE,
                extra={'is_combo': False, 'sku_type': None},
            )
        ]
        bundle = build_match_bundle(master, sources)
        c = bundle['candidates'][0]
        self.assertNotEqual(c['lifecycle'], LIFECYCLE_OUTSIDE)
        self.assertEqual(len(c['master_matches']), 1)

    def test_combo_goes_outside(self):
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
        self.assertEqual(c['lifecycle'], LIFECYCLE_OUTSIDE)
        self.assertEqual(len(c['master_matches']), 0)

    def test_non_ph_ice_sku_outside_not_unmatched(self):
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
        self.assertEqual(c['lifecycle'], LIFECYCLE_OUTSIDE)
        self.assertNotEqual(c['lifecycle'], 'unmatched')


if __name__ == '__main__':
    unittest.main()
