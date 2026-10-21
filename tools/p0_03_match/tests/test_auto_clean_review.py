import unittest

from p0_03_match import config as cfg
from p0_03_match.apply_review import apply_review_csv
from p0_03_match.auto_clean_review import (
    is_auto_clean_eligible,
    stamp_auto_clean_review,
)
from p0_03_match.unified_view import build_unified_rows


def _master(**kw):
    base = {
        'row_index': 2,
        'ice_code': 'WM0803',
        'barcode': '690123',
        'name_cn': '测试品',
        'spec': '',
    }
    base.update(kw)
    return base


def _bundle_with_full_chain(*, bs_name='测试品', jst_name='测试品', bs_flags=None):
    master = _master()
    return {
        'master_rows': [master],
        'candidates': [
            {
                'candidate_id': 'bs1',
                'lifecycle': 'pending_review',
                'flags': bs_flags or [],
                'match_methods': ['PH_ICE_CODE'],
                'master_matches': [master],
                'name_review': {'status': 'NAME_EXACT', 'detail': ''},
                'source': {
                    'source_system': cfg.SOURCE_BIGSELLER,
                    'source_row_key': 'bs:1',
                    'scope': 'match_only',
                    'external_sku_raw': 'WM0803',
                    'external_name': bs_name,
                    'available_qty': '1',
                    'warehouse': '菲律宾仓',
                    'sheet_name': cfg.BIGSELLER_SHEET_SINGLE,
                },
            },
            {
                'candidate_id': 'j1',
                'lifecycle': 'pending_review',
                'flags': [],
                'match_methods': ['JST_STYLE_CODE'],
                'master_matches': [master],
                'name_review': {'status': 'NAME_EXACT', 'detail': ''},
                'source': {
                    'source_system': cfg.SOURCE_JUSHUITAN,
                    'external_sku_raw': 'WM0803',
                    'external_name': jst_name,
                    'extra': {'style_code': 'WM0803', 'product_code': '690123'},
                },
            },
        ]
    }


class AutoCleanReviewTests(unittest.TestCase):
    def test_stamp_on_full_chain_exact_names(self):
        bundle = _bundle_with_full_chain()
        full = build_unified_rows(bundle)
        self.assertEqual(full['summary']['three_way_linked'], 1)
        stamp_auto_clean_review(bundle)
        bs = bundle['candidates'][0]
        jst = bundle['candidates'][1]
        self.assertIsNone(bs.get('review_decision'))
        self.assertIsNone(jst.get('review_decision'))
        self.assertEqual(bs['review_suggestion'], 'clean_candidate_only')
        self.assertNotIn('formal_mapping_eligible', bs)

    def test_no_stamp_on_name_mismatch(self):
        bundle = _bundle_with_full_chain(jst_name='完全不同')
        bundle['candidates'][1]['name_review'] = {
            'status': 'NAME_MISMATCH',
            'detail': '',
        }
        bundle['candidates'][1]['flags'] = ['NAME_MISMATCH']
        stamp_auto_clean_review(bundle)
        self.assertIsNone(bundle['candidates'][1].get('review_decision'))
        self.assertEqual(bundle['candidates'][0]['review_suggestion'], 'clean_candidate_only')

    def test_respect_existing_reject(self):
        bundle = _bundle_with_full_chain()
        bundle['candidates'][0]['review_decision'] = 'reject'
        stamp_auto_clean_review(bundle)
        self.assertEqual(bundle['candidates'][0]['review_decision'], 'reject')

    def test_apply_review_fills_empty_with_auto(self):
        import json
        import tempfile
        from pathlib import Path

        bundle = _bundle_with_full_chain()
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            bundle_path = root / 'bundle.json'
            bundle_path.write_text(json.dumps(bundle), encoding='utf-8')
            review_csv = root / 'review.csv'
            review_csv.write_text(
                'candidate_id,review_decision,review_notes\nbs1,confirm,人工\n',
                encoding='utf-8',
            )
            out = root / 'out.json'
            outcome = apply_review_csv(bundle_path, review_csv, out)
            self.assertEqual(outcome['review_summary']['manual_selected'], 1)
            by_id = {c['candidate_id']: c for c in outcome['candidates']}
            self.assertEqual(by_id['j1']['review_state'], 'candidate')
            self.assertIsNone(by_id['j1']['selected_master'])


if __name__ == '__main__':
    unittest.main()
