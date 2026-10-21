"""Four new user decisions append to the approved effective sample."""
import copy
import json
import tempfile
import unittest
from pathlib import Path

from p0_03_match.business_confirmations import apply_business_confirmations, cmd_confirm_sample
from p0_03_match.models import MasterRow, SourceRow
from p0_03_match.review_exports import export_effective_outputs
from p0_03_match.review_result import resolve_reviews, source_identity


def fixture():
    masters = [MasterRow(19, 'WM0012', '69', '洗面奶', ''), MasterRow(27, 'WM0039', '75', '防晒乳', ''),
               MasterRow(39, 'WM10012', '', '眼部精华7.5ml', ''), MasterRow(66, 'WM0072', '', '桂花泰版', '')]
    cs = []
    for cid, system, ice, match in [('milk', 'bigseller', '69', None), ('sun', 'bigseller', '75', 27),
                                    ('eye', 'jushuitan', 'WM10012', 39), ('price-jst', 'jushuitan', 'WM0072', 66),
                                    ('ph1', 'bigseller', '69', 19), ('ph2', 'bigseller', '69', 19), ('vn', 'bigseller', '69', 19)]:
        cs.append({'candidate_id': cid, 'lifecycle': 'pending_review', 'flags': [],
            'source': SourceRow(system, cid, 'match_only', '印尼-DEE仓库' if system == 'bigseller' else None,
                                ice, '样本资料', available_qty='5', extra={'style_code': ice, 'product_code': ice}).to_public(),
            'master_matches': [m.to_public() for m in masters if m.row_index == match]})
    cs[2]['candidate_id_lineage'] = ['old-eye']
    decisions = {('old-eye' if c['candidate_id'] == 'eye' else c['candidate_id']):
                  {'candidate_id': 'old-eye' if c['candidate_id'] == 'eye' else c['candidate_id'],
                   'review_decision': '' if c['candidate_id'] in ('eye', 'price-jst') else 'confirm', 'review_notes': '旧备注'} for c in cs}
    base = resolve_reviews({'candidates': cs}, decisions, masters)
    base['batch_business_pending'] = [{'number': n, 'title': 'WM0072桂花泰版精油价格' if n == 5 else str(n),
        'candidate_ids': ids} for n, ids in [(1, ['ph1', 'ph2', 'vn']), (2, ['milk']), (3, ['sun']), (4, ['eye']), (5, ['price-jst'])]]
    for c in base['candidates']:
        c['batch_business_pending'] = next(p for p in base['batch_business_pending'] if c['candidate_id'] in p['candidate_ids'])
    base['master_provenance'] = [{'row_index': 66, 'ice_code': 'WM0072', 'barcode': '', 'name_cn': '桂花泰版', 'spec': '',
        'source_rows': [66, 216], 'primary_row': None, 'price_pending': True, 'valuation_authorized': False,
        'data': {'成本价格': None, '运营价格': None, '日期': None, '其他资料': '不改'},
        'source_records': [{'excel_row': 66, 'data': {'成本价格': '5', '运营价格': '5.5', '日期': '2025-03-14 00:00:00'}},
                           {'excel_row': 216, 'data': {'成本价格': '5.18', '运营价格': '5.68', '日期': '2026-07-13 00:00:00'}}],
        'price_versions': [{'source_row': 66, 'cost': '5', 'operating_price': '5.5'},
                           {'source_row': 216, 'cost': '5.18', 'operating_price': '5.68'}]}]
    plan = {'source_confirmations': [], 'price_confirmation': {'decision_id': 'four', 'master_anchor_row': 66,
        'ice_code': 'WM0072', 'source_row': 216, 'source_date': '2026-07-13', 'cost': '5.18',
        'operating_price': '5.68', 'resolves_pending_number': 5, 'reason': '明确价格B'}}
    for cid, row, ice, issue in [('milk', 19, 'WM0012', 2), ('sun', 27, 'WM0039', 3), ('eye', 39, 'WM10012', 4)]:
        c = next(c for c in cs if c['candidate_id'] == cid)
        plan['source_confirmations'].append({'decision_id': cid, 'candidate_id': cid, 'source_identity': list(source_identity(c)),
            'source': c['source'], 'target_row': row, 'target_ice': ice, 'resolves_pending_number': issue, 'reason': '用户本次明确确认'})
    return base, decisions, plan


class BusinessConfirmationTests(unittest.TestCase):
    def test_four_decisions_have_two_new_one_reaffirmed_one_price(self):
        out, _, audit = apply_business_confirmations(*fixture())
        self.assertEqual(len(audit), 4)
        summary = out['business_confirmation_summary']
        self.assertEqual(summary['implemented_business_decisions'], 4)
        self.assertEqual(summary['new_effective_selections'], 2)
        self.assertEqual(set(summary['new_effective_candidate_ids']), {'milk', 'eye'})
        self.assertEqual(summary['reaffirmed_existing_selections'], 1)
        self.assertEqual(summary['current_price_selections'], 1)

    def test_existing_sunscreen_target_is_not_changed_or_counted_new(self):
        base, decisions, plan = fixture()
        out, _, audit = apply_business_confirmations(base, decisions, plan)
        before = next(c for c in base['candidates'] if c['candidate_id'] == 'sun')
        after = next(c for c in out['candidates'] if c['candidate_id'] == 'sun')
        self.assertEqual(before['selected_master'], after['selected_master'])
        self.assertIsNone(after['batch_business_pending'])
        self.assertEqual(out['business_confirmation_summary']['reaffirmed_candidate_ids'], ['sun'])
        self.assertEqual(audit[1]['before_selected_master'], before['selected_master'])

    def test_eye_is_effectively_selected_not_only_label_removed(self):
        out, _, _ = apply_business_confirmations(*fixture())
        eye = next(c for c in out['candidates'] if c['candidate_id'] == 'eye')
        self.assertEqual(eye['selected_master']['row_index'], 39)
        self.assertEqual(eye['review_state'], 'manual_selected')
        self.assertEqual(eye['review_decision'], 'confirm')

    def test_price_does_not_replace_product_or_original_price_versions(self):
        base, decisions, plan = fixture()
        out, _, _ = apply_business_confirmations(base, decisions, plan)
        before, after = base['master_provenance'][0], out['master_provenance'][0]
        self.assertEqual(after['data'], {**before['data'], '成本价格': '5.18', '运营价格': '5.68'})
        for key in ('row_index', 'ice_code', 'source_rows', 'primary_row', 'source_records', 'price_versions', 'valuation_authorized'):
            self.assertEqual(before[key], after[key])
        self.assertFalse(after['price_pending'])
        self.assertEqual(after['current_price_selection']['source_row'], 216)
        self.assertEqual(after['price_decision_history'][0]['before']['cost'], None)

    def test_price_selection_does_not_confirm_jst_product(self):
        base, decisions, plan = fixture()
        out, _, _ = apply_business_confirmations(base, decisions, plan)
        c = next(c for c in out['candidates'] if c['candidate_id'] == 'price-jst')
        before = next(c for c in base['candidates'] if c['candidate_id'] == 'price-jst')
        for key in ('review_state', 'review_decision', 'selected_master', 'master_matches'):
            self.assertEqual(c[key], before[key])
        self.assertIsNone(c['batch_business_pending'])

    def test_ph_vn_three_records_keep_existing_choice_and_pending(self):
        base, decisions, plan = fixture()
        out, _, _ = apply_business_confirmations(base, decisions, plan)
        self.assertEqual(out['batch_business_pending'], [base['batch_business_pending'][0]])
        for cid in ('ph1', 'ph2', 'vn'):
            a = next(c for c in base['candidates'] if c['candidate_id'] == cid)
            b = next(c for c in out['candidates'] if c['candidate_id'] == cid)
            self.assertEqual(a, b)

    def test_inherited_old_id_is_replaced_only_with_frozen_lineage_audit(self):
        base, decisions, plan = fixture()
        original = copy.deepcopy((base, decisions, plan))
        out, effective, audit = apply_business_confirmations(base, decisions, plan)
        self.assertEqual((base, decisions, plan), original)
        self.assertNotIn('old-eye', effective)
        self.assertEqual(effective['eye']['review_decision'], 'confirm')
        self.assertEqual(audit[2]['before_csv_records'][0]['candidate_id'], 'old-eye')
        self.assertEqual(out['correction_events'], base['correction_events'])
        self.assertEqual([c['source'] for c in out['candidates']], [c['source'] for c in base['candidates']])

    def test_inconsistent_source_target_or_price_fails(self):
        for change in ('source', 'target', 'price', 'date'):
            base, decisions, plan = fixture()
            if change == 'source':
                plan['source_confirmations'][0]['source_identity'][-1] = 'not-this-record'
            elif change == 'target':
                plan['source_confirmations'][0]['target_ice'] = 'WM0128'
            elif change == 'price':
                plan['price_confirmation']['cost'] = '0'
            else:
                plan['price_confirmation']['source_date'] = '2025-03-14'
            with self.subTest(change=change), self.assertRaises(ValueError):
                apply_business_confirmations(base, decisions, plan)

    def test_negative_current_csv_still_clears_selected_targets_and_summary(self):
        from test_review_r2 import ReviewR2Tests
        for value in ('reject', 'ignore', 'clear', 'defer'):
            out, effective, _ = apply_business_confirmations(*fixture())
            effective['eye']['review_decision'] = value
            cleared = resolve_reviews(out, effective, [MasterRow(**m) for m in out['master_rows']])
            c = next(c for c in cleared['candidates'] if c['candidate_id'] == 'eye')
            self.assertIsNone(c['selected_master'])
            self.assertEqual(c['review_decision'], value)
            with tempfile.TemporaryDirectory() as td:
                export_effective_outputs(cleared, Path(td))
                saved = json.loads((Path(td)/'business-confirmation-summary.json').read_text(encoding='utf-8'))
                self.assertEqual(saved['new_effective_selections'], 1)
                self.assertEqual(saved['recorded_business_decisions'], 4)
                # Variable price metadata columns must round-trip instead of failing DictWriter.
                self.assertIn('current_price_selection', (Path(td)/'master-overview.csv').read_text(encoding='utf-8-sig'))
            ReviewR2Tests().assert_outputs(cleared)

    def test_hash_mismatch_fails_before_output_creation(self):
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root/'match-bundle.json').write_text('{}', encoding='utf-8')
            p = root/'plan.json'
            p.write_text(json.dumps({'base_hashes': {'match-bundle.json': 'wrong'}}), encoding='utf-8')
            with self.assertRaises(ValueError):
                cmd_confirm_sample(SimpleNamespace(evidence=str(root), decisions=str(p), output=str(root/'out')))
            self.assertFalse((root/'out').exists())


if __name__ == '__main__':
    unittest.main()
