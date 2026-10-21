import unittest

from p0_03_match.priority_review import build_priority_bundle, is_priority_candidate


class PriorityReviewTests(unittest.TestCase):
    def test_excludes_combo(self):
        c = {
            'lifecycle': 'pending_review',
            'flags': ['COMBO_SKU'],
            'master_matches': [{}],
            'source': {'source_system': 'bigseller', 'warehouse': '菲律宾-x', 'sheet_name': '单个SKU', 'extra': {}},
            'match_methods': ['PH_ICE_CODE'],
        }
        self.assertFalse(is_priority_candidate(c))

    def test_includes_ph_ice_match(self):
        c = {
            'lifecycle': 'pending_review',
            'flags': [],
            'master_matches': [{'ice_code': 'WM1'}],
            'source': {
                'source_system': 'bigseller',
                'warehouse': '菲律宾-新创启辰自建仓',
                'sheet_name': '单个SKU',
                'extra': {'is_combo': False},
            },
            'match_methods': ['PH_ICE_CODE'],
        }
        self.assertTrue(is_priority_candidate(c))


if __name__ == '__main__':
    unittest.main()
