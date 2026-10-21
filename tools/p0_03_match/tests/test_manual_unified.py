import unittest

from p0_03_match.manual_unified import augment_unified_with_manual
from p0_03_match.models import MasterRow


class ManualUnifiedTests(unittest.TestCase):
    def test_manual_partial_row_appended(self):
        master = [
            MasterRow(row_index=45, ice_code='WM0047', barcode='69', name_cn='n', spec=''),
        ]
        bundle = {
            'candidates': [
                {
                    'candidate_id': 'mc-bs1',
                    'lifecycle': 'unmatched',
                    'flags': ['UNMATCHED'],
                    'match_methods': [],
                    'master_matches': [],
                    'source': {
                        'source_system': 'bigseller',
                        'external_sku_raw': 'SKU1',
                        'external_name': 'x',
                        'warehouse': 'W',
                        'available_qty': '10',
                    },
                },
            ]
        }
        unified = {'rows': [], 'summary': {'three_way_linked': 0}}
        embedded = {'mc-bs1': {'decision': 'confirm', 'manual_master_row': '45', 'manual_master_ice': 'WM0047'}}
        out = augment_unified_with_manual(bundle, unified, embedded, master)
        self.assertEqual(len(out['rows']), 1)
        self.assertEqual(out['rows'][0]['tier'], 'manual_partial')
        self.assertEqual(out['summary']['overview_rows'], 1)


if __name__ == '__main__':
    unittest.main()
