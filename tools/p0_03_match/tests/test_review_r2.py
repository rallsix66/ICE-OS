"""Negative cases from the independent CHANGES_REQUIRED review."""
import copy
import csv
import io
import json
import re
import tempfile
import unittest
from pathlib import Path

from p0_03_match.models import MasterRow, SourceRow
from p0_03_match.review_exports import export_effective_outputs, review_records
from p0_03_match.review_result import resolve_reviews


MASTERS = [MasterRow(2, 'WM0001', '6900000000001', '资料甲', ''),
           MasterRow(5, 'WM0002', '6900000000002', '资料乙', '')]


def candidate(cid='bs', *, system='bigseller', row=2, sku='BS-SKU'):
    return {'candidate_id': cid, 'lifecycle': 'pending_review', 'flags': [],
            'master_matches': [m.to_public() for m in MASTERS if m.row_index == row],
            'source': SourceRow(system, cid, 'match_only', '菲律宾仓' if system == 'bigseller' else None,
                                sku, '资料', available_qty='1',
                                extra={'style_code': sku, 'product_code': sku}).to_public()}


def decision(cid='bs', value='confirm', **kwargs):
    return {'candidate_id': cid, 'review_decision': value, 'review_notes': '本次明确决定', **kwargs}


def choices(row=5, ice='WM0002'):
    return decision(manual_master_row=str(row), manual_master_ice=ice,
                    manual_jst_candidate_id='jst', manual_jst_sku='JST-DIFFERENT-SKU')


def initial_revoke():
    c = candidate(sku='ICEWM0039')
    c['source']['warehouse'] = '菲律宾-新创启辰自建仓'
    c['previous_master_matches'] = [MasterRow(28, 'WM0093', 'ICEWM0039', '泰国特供版', '').to_public()]
    return resolve_reviews({'candidates': [c]}, {'bs': decision()}, MASTERS)


def csv_rows(path):
    return list(csv.DictReader(io.StringIO(path.read_text(encoding='utf-8-sig'))))


class ReviewR2Tests(unittest.TestCase):
    def resolve_pair(self, bs_choice=None, jst_choice=None, *, jst_row=2, reverse=False, masters=MASTERS):
        cs = [candidate(), candidate('jst', system='jushuitan', row=jst_row, sku='JST-DIFFERENT-SKU')]
        if reverse:
            cs.reverse()
        return resolve_reviews({'candidates': cs}, {'bs': bs_choice or choices(), 'jst': jst_choice or decision('jst')}, masters)

    def assert_outputs(self, bundle):
        expected = review_records(bundle)
        expected_csv = [{k: str(v) for k, v in r.items()} for r in expected]
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            export_effective_outputs(bundle, root)
            for name in ('manual-review.csv', 'review-decisions-export.csv'):
                self.assertEqual(csv_rows(root/name), expected_csv)
            for name in ('review-outcome.json', 'match-bundle.json'):
                self.assertEqual(json.loads((root/name).read_text(encoding='utf-8')), bundle)
            self.assertEqual(json.loads((root/'correction-events.json').read_text(encoding='utf-8')), bundle['correction_events'])
            self.assertEqual(json.loads((root/'effective-review-records.json').read_text(encoding='utf-8')), expected)
            for name, subset in [('pending-user-review.csv', [r for r in expected_csv if r['review_state'] in ('pending', 'candidate')]),
                                 ('manual-selections-restored.csv', [r for r in expected_csv if r['manual_master_row']]),
                                 ('outside-rules.csv', [r for r in expected_csv if r['review_state'] == 'outside_rules'])]:
                self.assertEqual(csv_rows(root/name), subset)
            for name in ('match-review.html', 'bs-warehouse-overview.html'):
                page = (root/name).read_text(encoding='utf-8')
                payload = json.loads(re.search(r'<script id="review-data" type="application/json">(.*?)</script>', page, re.S)[1])
                subset = expected if name == 'match-review.html' else [r for r in expected if r['source_system'] == 'bigseller']
                self.assertEqual(payload['rows'], subset)
                self.assertEqual(re.findall(r'<tr data-id="([^"]+)"', page), [r['candidate_id'] for r in subset])
            selected = {c['candidate_id'] for c in bundle['candidates'] if c['selected_master']}
            self.assertEqual({r['candidate_id'] for r in csv_rows(root/'matched-total-detail.csv')}, selected)
            unified = json.loads((root/'unified-view.json').read_text(encoding='utf-8'))
            self.assertEqual(unified['review_records'], expected)
            self.assertEqual({cid for u in unified['rows'] for cid in u['candidateIds']}, selected)
            grouped = {cid for r in csv_rows(root/'matched-total-by-master.csv') for cid in r['candidate_ids'].split(';')}
            self.assertEqual(grouped, selected)
            for wh in csv_rows(root/'bs-warehouse-overview.csv'):
                members = [r for r in expected if r['source_system'] == 'bigseller' and r['warehouse'] == wh['warehouse']]
                self.assertEqual(int(wh['source_rows']), len(members))
                for state in ('candidate', 'manual_selected', 'pending', 'rejected', 'ignored', 'outside_rules'):
                    self.assertEqual(int(wh[state]), sum(r['review_state'] == state for r in members))

    def test_revoke_respects_all_explicit_negative_decisions(self):
        original = initial_revoke()
        for value, state, reason in [('reject', 'rejected', 'reviewer_rejected'), ('ignore', 'ignored', 'reviewer_ignored'), ('clear', 'pending', 'cleared'), ('defer', 'pending', 'deferred')]:
            with self.subTest(value=value):
                out = resolve_reviews(original, {'bs': decision(value=value)}, MASTERS)
                c = out['candidates'][0]
                self.assertEqual(c['review_decision'], value)
                self.assertEqual(c['review_state'], state)
                self.assertEqual(c['review_reason'], reason)
                self.assertIsNone(c['selected_master'])
                self.assertEqual(out['correction_events'], original['correction_events'])

    def test_revoke_event_not_rewritten_by_new_confirm_or_notes(self):
        original = initial_revoke()
        raw = decision(review_notes='另一条当前备注')
        out = resolve_reviews(original, {'bs': raw}, MASTERS)
        self.assertEqual(out['correction_events'], original['correction_events'])
        self.assertEqual(out['candidates'][0]['review_decision'], 'confirm')
        self.assertEqual(out['candidates'][0]['review_notes'], raw['review_notes'])
        self.assertEqual(out['candidates'][0]['review_state'], 'pending')
        self.assertIsNone(out['candidates'][0]['selected_master'])

    def test_revoke_clear_with_old_wrong_target_remains_effective(self):
        original = initial_revoke()
        masters = [*MASTERS, MasterRow(28, 'WM0093', 'ICEWM0039', '泰国特供版', '')]
        raw = decision(value='clear', manual_master_row='28', manual_master_ice='WM0093')
        out = resolve_reviews(original, {'bs': raw}, masters)
        self.assertEqual(out['candidates'][0]['review_decision'], 'clear')
        self.assertEqual(out['candidates'][0]['review_reason'], 'cleared')
        self.assertIsNone(out['candidates'][0]['selected_master'])
        self.assertEqual(out['candidates'][0]['manual_master_ice'], 'WM0093')
        self.assertEqual(out['correction_events'], original['correction_events'])

    def test_revoke_still_forbids_new_target_without_authorization(self):
        out = resolve_reviews(initial_revoke(), {'bs': decision(manual_master_row='5', manual_master_ice='WM0002')}, MASTERS)
        self.assertIsNone(out['candidates'][0]['selected_master'])
        self.assertEqual(out['candidates'][0]['review_state'], 'pending')
        self.assertEqual(out['candidates'][0]['review_decision'], 'confirm')

    def test_negative_revoke_outputs_consistent(self):
        for value in ('reject', 'ignore', 'clear', 'defer'):
            with self.subTest(value=value):
                out = resolve_reviews(initial_revoke(), {'bs': decision(value=value)}, MASTERS)
                self.assertEqual(out['candidates'][0]['review_decision'], value)
                self.assert_outputs(out)

    def test_jst_conflict_marks_pending_and_keeps_all_entered_fields(self):
        raw = choices()
        out = self.resolve_pair(raw)
        c, jst = out['candidates']
        self.assertEqual(c['review_state'], 'pending')
        self.assertIsNone(c['selected_master'])
        self.assertIsNone(c['selected_jushuitan'])
        self.assertEqual(jst['selected_master']['row_index'], 2)
        self.assertIn('manual_jushuitan_master_row_conflict', c['validation_errors'])
        for field, value in raw.items():
            if field != 'candidate_id':
                self.assertEqual(c[field], value)
        self.assertEqual(c['validated_manual_target']['row_index'], 5)
        self.assertEqual(c['validated_manual_jushuitan']['candidate_id'], 'jst')
        self.assertEqual(c['manual_jushuitan_conflict']['selected_master_row'], 5)
        self.assertEqual(c['manual_jushuitan_conflict']['jst_selected_master_row'], 2)

    def test_jst_comparison_uses_row_even_when_ice_codes_equal(self):
        masters = [MASTERS[0], MasterRow(5, 'WM0001', 'other', '同货号另一资料', '')]
        out = self.resolve_pair(choices(ice='WM0001'), masters=masters)
        self.assertEqual(out['candidates'][0]['review_state'], 'pending')
        self.assertIsNone(out['candidates'][0]['selected_master'])

    def test_different_system_skus_same_selected_row_allowed(self):
        out = self.resolve_pair(jst_row=5)
        c = out['candidates'][0]
        self.assertNotEqual(c['source']['external_sku_raw'], c['selected_jushuitan']['source']['external_sku_raw'])
        self.assertEqual(c['selected_master']['row_index'], 5)
        self.assertNotIn('manual_jushuitan_master_row_conflict', c['validation_errors'])

    def test_jst_actual_manual_selection_overrides_engine_candidate(self):
        out = self.resolve_pair(jst_choice=decision('jst', manual_master_row='5', manual_master_ice='WM0002'))
        self.assertEqual(out['candidates'][0]['review_state'], 'manual_selected')
        out = self.resolve_pair(jst_row=5, jst_choice=decision('jst', manual_master_row='2', manual_master_ice='WM0001'))
        self.assertEqual(out['candidates'][0]['review_state'], 'pending')

    def test_jst_without_selected_row_does_not_invent_contradiction(self):
        for value in ('', 'defer', 'clear', 'reject', 'ignore'):
            with self.subTest(value=value):
                out = self.resolve_pair(jst_choice=decision('jst', value))
                self.assertEqual(out['candidates'][0]['review_state'], 'manual_selected')
                self.assertIsNone(out['candidates'][1]['selected_master'])
                self.assertEqual(out['candidates'][1]['review_decision'], value or None)

    def test_jst_conflict_order_and_every_output_consistent(self):
        for reverse in (False, True):
            out = self.resolve_pair(reverse=reverse)
            c = next(c for c in out['candidates'] if c['candidate_id'] == 'bs')
            self.assertEqual(c['review_state'], 'pending')
            self.assert_outputs(out)

    def test_jst_conflict_reapply_keeps_input_and_recomputes_current_state(self):
        original = self.resolve_pair()
        snapshot = copy.deepcopy(original)
        again = resolve_reviews(original, {'bs': choices(), 'jst': decision('jst')}, MASTERS)
        self.assertEqual(again['candidates'][0]['review_state'], 'pending')
        self.assertEqual(original, snapshot)
        aligned = resolve_reviews(original, {'bs': choices(), 'jst': decision('jst', manual_master_row='5', manual_master_ice='WM0002')}, MASTERS)
        self.assertEqual(aligned['candidates'][0]['review_state'], 'manual_selected')
        self.assertIsNone(aligned['candidates'][0].get('manual_jushuitan_conflict'))


if __name__ == '__main__':
    unittest.main()
