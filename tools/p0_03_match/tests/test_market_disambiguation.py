import unittest

from p0_03_match import config as cfg
from p0_03_match.market_disambiguation import build_barcode_market_pairs
from p0_03_match.match_engine import build_match_bundle
from p0_03_match.models import MasterRow, SourceRow


class MarketDisambiguationTests(unittest.TestCase):
    def test_build_pairs_from_thai_label_names(self):
        bar = '757577407182'
        master = [
            MasterRow(38, 'WM0050', bar, '防晒啫喱 55g', ''),
            MasterRow(212, 'WM0092', bar, '防晒啫喱 55g（泰国特供版）', ''),
        ]
        pairs = build_barcode_market_pairs(master)
        self.assertEqual(pairs[bar]['ph_vn_ice'], 'WM0050')
        self.assertEqual(pairs[bar]['th_my_ice'], 'WM0092')

    def test_vn_warehouse_picks_ph_side(self):
        bar = '6974674958025'
        master = [
            MasterRow(2, 'WM0100', bar, '标准版', ''),
            MasterRow(3, 'WM0108', bar, '标准版（泰国特供版）', ''),
        ]
        sources = [
            SourceRow(
                cfg.SOURCE_BIGSELLER,
                'bs:vn',
                cfg.SCOPE_MATCH_ONLY,
                '越南青林湾仓库',
                bar,
                'n',
                sheet_name=cfg.BIGSELLER_SHEET_SINGLE,
                extra={'is_combo': False},
            )
        ]
        c = build_match_bundle(master, sources)['candidates'][0]
        self.assertEqual(c['master_matches'][0]['ice_code'], 'WM0100')
        self.assertIn('MARKET_DISAMBIGUATED', c['flags'])

    def test_dee_warehouse_picks_thai_side(self):
        bar = '757577407182'
        master = [
            MasterRow(38, 'WM0050', bar, '防晒啫喱 55g', ''),
            MasterRow(212, 'WM0092', bar, '防晒啫喱 55g（泰国特供版）', ''),
        ]
        sources = [
            SourceRow(
                cfg.SOURCE_BIGSELLER,
                'bs:dee',
                cfg.SCOPE_MATCH_ONLY,
                cfg.TARGET_INVENTORY_WAREHOUSE,
                bar,
                'n',
                sheet_name=cfg.BIGSELLER_SHEET_SINGLE,
                extra={'is_combo': False},
            )
        ]
        c = build_match_bundle(master, sources)['candidates'][0]
        self.assertEqual(c['master_matches'][0]['ice_code'], 'WM0092')
        self.assertIn('MARKET_DISAMBIGUATED', c['flags'])


if __name__ == '__main__':
    unittest.main()
