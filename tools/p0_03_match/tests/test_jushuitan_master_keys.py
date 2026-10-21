import unittest

from p0_03_match import config as cfg
from p0_03_match.jushuitan_master_keys import (
    is_jushuitan_finished_goods,
    jushuitan_master_lookup_keys,
)
from p0_03_match.match_engine import build_match_bundle
from p0_03_match.models import MasterRow, SourceRow


class JushuitanMasterKeysTests(unittest.TestCase):
    def test_dotted_code_not_finished(self):
        self.assertFalse(is_jushuitan_finished_goods('CH.WM0027', 'CH.WM0027'))
        self.assertEqual(jushuitan_master_lookup_keys('CH.WM0027', 'CH.WM0027'), [])

    def test_wm0027_whole_product(self):
        self.assertTrue(
            is_jushuitan_finished_goods(
                'WM0027',
                'WM0027',
                'ICE LERSKIN 护发精油 (无花果) 80ml-粉色',
            )
        )
        self.assertEqual(jushuitan_master_lookup_keys('WM0027', 'WM0027'), ['WM0027'])

    def test_only_finished_jst_rows_match_master(self):
        master = [MasterRow(21, 'WM0027', '757577983037', '精油', '')]
        rows = [
            SourceRow(
                cfg.SOURCE_JUSHUITAN,
                'jst:whole',
                cfg.SCOPE_MATCH_ONLY,
                None,
                'WM0027',
                'ICE LERSKIN 护发精油',
                extra={'style_code': 'WM0027', 'product_code': 'WM0027'},
            ),
            SourceRow(
                cfg.SOURCE_JUSHUITAN,
                'jst:label',
                cfg.SCOPE_MATCH_ONLY,
                None,
                'BT.WM0027',
                '标贴',
                extra={'style_code': 'BT.WM0027', 'product_code': 'BT.WM0027'},
            ),
        ]
        bundle = build_match_bundle(master, rows)
        matched = [c for c in bundle['candidates'] if c.get('master_matches')]
        self.assertEqual(len(matched), 1)
        self.assertEqual(matched[0]['source']['extra']['style_code'], 'WM0027')


if __name__ == '__main__':
    unittest.main()
