import json
import tempfile
import unittest
from pathlib import Path

from p0_03_match.apply_review import apply_review_csv
from p0_03_match.models import MasterRow, SourceRow

MASTER = MasterRow(2, 'A1', '69', '资料', '').to_public()


class ApplyReviewTests(unittest.TestCase):
    def test_confirm_blocked_when_combo_flag(self):
        bundle = {
            'master_rows': [MASTER],
            'candidates': [
                {
                    'candidate_id': 'mc-1',
                    'auto_confirm_forbidden': True,
                    'flags': ['COMBO_SKU'],
                    'master_matches': [],
                }
            ]
        }
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bundle_path = root / 'match-bundle.json'
            bundle_path.write_text(json.dumps(bundle), encoding='utf-8')
            review = root / 'review.csv'
            review.write_text(
                'candidate_id,review_decision,review_notes\nmc-1,confirm,try\n',
                encoding='utf-8-sig',
            )
            out = root / 'out.json'
            outcome = apply_review_csv(bundle_path, review, out)
            c = outcome['candidates'][0]
            self.assertIsNone(c['selected_master'])
            self.assertEqual(outcome['review_summary']['pending'], 1)
            self.assertNotIn('formal_mapping_eligible', c)

    def test_confirm_allowed_when_only_many_to_one(self):
        bundle = {
            'master_rows': [MASTER],
            'candidates': [
                {
                    'candidate_id': 'mc-2',
                    'auto_confirm_forbidden': True,
                    'flags': ['MANY_TO_ONE'],
                    'master_matches': [MASTER],
                    'source': SourceRow('bigseller', 'bs:1', 'match_only', '菲律宾仓', 'A1', '资料').to_public(),
                }
            ]
        }
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bundle_path = root / 'match-bundle.json'
            bundle_path.write_text(json.dumps(bundle), encoding='utf-8')
            review = root / 'review.csv'
            review.write_text(
                'candidate_id,review_decision,review_notes\nmc-2,confirm,ok\n',
                encoding='utf-8-sig',
            )
            out = root / 'out.json'
            outcome = apply_review_csv(bundle_path, review, out)
            c = outcome['candidates'][0]
            self.assertEqual(c['selected_master'], MASTER)
            self.assertEqual(outcome['review_summary']['manual_selected'], 1)


if __name__ == '__main__':
    unittest.main()
