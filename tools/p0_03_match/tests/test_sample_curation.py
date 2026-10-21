"""New batch authorization must not change the original 80-test contract."""
import copy
import json
import unittest
from pathlib import Path

from p0_03_match.cli import preserve_sample_ids
from p0_03_match.jushuitan_master_keys import is_jushuitan_finished_goods
from p0_03_match.models import MasterRow, SourceRow
from p0_03_match.review_result import resolve_reviews, source_identity
from p0_03_match.sample_curation import curate_master, apply_explicit_corrections


MS = [MasterRow(27, 'WM0039', '757577407076', '普通版', ''),
      MasterRow(28, 'WM0093', '757577407076', '泰国特供版', '')]


def candidate(cid='ph', sku='ICEWM0039', warehouse='菲律宾-新创启辰自建仓'):
    return {'candidate_id': cid, 'source': SourceRow('bigseller', cid, 'match_only', warehouse, sku, '商品').to_public(),
            'lifecycle': 'pending_review', 'flags': [], 'master_matches': []}


def choice(cid='ph', decision='confirm', row=27, ice='WM0039'):
    return {'candidate_id': cid, 'review_decision': decision, 'manual_master_row': str(row), 'manual_master_ice': ice}


def authorization(c, row=27, ice='WM0039'):
    return {'candidate_id': c['candidate_id'], 'source_identity': list(source_identity(c)),
            'target_row': row, 'target_ice': ice, 'decision': 'confirm', 'reason': '本批明确授权'}


class SampleCurationTests(unittest.TestCase):
    def bundle(self):
        c = candidate()
        old = resolve_reviews({'candidates': [c]}, {'ph': choice(row=28, ice='WM0093')}, MS)
        old['batch_target_authorizations'] = [authorization(c)]
        return old

    def test_five_digit_finished_goods_and_component_exclusions(self):
        for sku in ('WM10012', 'WM10013', 'WM0012'):
            self.assertTrue(is_jushuitan_finished_goods(sku, sku, '整品'))
        for sku in ('WM10013.1', 'BCP.WM10013', 'BT.WM10012', 'WM100123'):
            self.assertFalse(is_jushuitan_finished_goods(sku, sku, '整品'))
        for name in ('标贴', '内料', '彩盒', '瓶子', '半成品', '包材'):
            self.assertFalse(is_jushuitan_finished_goods('WM10013', 'WM10013', name))
        self.assertFalse(is_jushuitan_finished_goods('WM10013', 'WM10012', '整品'))

    def test_new_ph_target_selected_history_unchanged(self):
        old = self.bundle()
        out = resolve_reviews(old, {'ph': choice()}, MS)
        self.assertEqual(out['candidates'][0]['selected_master']['ice_code'], 'WM0039')
        self.assertEqual(out['correction_events'], old['correction_events'])

    def test_wrong_ph_target_not_resurrected(self):
        out = resolve_reviews(self.bundle(), {'ph': choice(row=28, ice='WM0093')}, MS)
        self.assertIsNone(out['candidates'][0]['selected_master'])
        self.assertEqual(out['candidates'][0]['review_state'], 'pending')

    def test_current_negative_decisions_override_authorized_target(self):
        for d, state in [('reject', 'rejected'), ('ignore', 'ignored'), ('clear', 'pending'), ('defer', 'pending')]:
            with self.subTest(d=d):
                old = self.bundle()
                out = resolve_reviews(old, {'ph': choice(decision=d)}, MS)
                self.assertIsNone(out['candidates'][0]['selected_master'])
                self.assertEqual(out['candidates'][0]['review_state'], state)
                self.assertEqual(out['candidates'][0]['review_decision'], d)
                self.assertEqual(out['correction_events'], old['correction_events'])

    def test_missing_authorization_still_pending(self):
        b = self.bundle()
        b.pop('batch_target_authorizations')
        self.assertIsNone(resolve_reviews(b, {'ph': choice()}, MS)['candidates'][0]['selected_master'])

    def test_indonesia_exception_is_exact_source_and_target(self):
        a = candidate('id-authorized', '757577407380', '印尼-DEE仓库')
        b = candidate('id-other', '757577407380', '印尼-DEE仓库')
        bundle = {'candidates': [a, b], 'batch_target_authorizations': [authorization(a, 28, 'WM0093')]}
        out = resolve_reviews(bundle, {c['candidate_id']: choice(c['candidate_id'], row=28, ice='WM0093') for c in [a, b]}, MS)
        self.assertIsNotNone(out['candidates'][0]['selected_master'])
        self.assertIsNone(out['candidates'][1]['selected_master'])
        out = resolve_reviews(bundle, {'id-authorized': choice('id-authorized')}, MS)
        self.assertEqual(out['candidates'][0]['selected_master']['ice_code'], 'WM0039')

    def test_jst_not_subject_to_bigseller_market(self):
        c = candidate('jst', 'WM0093', '任意仓')
        c['source']['source_system'] = 'jushuitan'
        c['source']['extra'] = {'style_code': 'WM0093', 'product_code': 'WM0093'}
        out = resolve_reviews({'candidates': [c]}, {'jst': choice('jst', row=28, ice='WM0093')}, MS)
        self.assertIsNotNone(out['candidates'][0]['selected_master'])

    def test_method_id_change_keeps_all_lineage(self):
        old = candidate('old')
        old['decision_records'] = [{'candidate_id': 'oldest', 'review_decision': 'confirm'}]
        new = copy.deepcopy(old)
        new['candidate_id'] = 'generated-new'
        new['source'] = old['source']
        bundle = preserve_sample_ids({'candidates': [new]}, {'candidates': [old]})
        self.assertEqual(bundle['candidates'][0]['candidate_id'], 'old')
        self.assertEqual(set(bundle['candidates'][0]['candidate_id_lineage']), {'old', 'oldest', 'generated-new'})
        new['master_matches'] = [MS[0].to_public()]
        # Different ID still addresses the frozen source; no confirm-vs-blank precedence.
        out = resolve_reviews(bundle, {'oldest': choice('oldest')}, MS)
        self.assertIsNone(out['candidates'][0]['selected_master'])  # PH requires new authority.
        self.assertEqual(out['candidates'][0]['review_decision'], 'confirm')

    def test_ambiguous_frozen_source_rejected(self):
        c = candidate()
        other = copy.deepcopy(c)
        other['candidate_id'] = 'other'
        with self.assertRaises(ValueError):
            preserve_sample_ids({'candidates': [c]}, {'candidates': [c, other]})

    def test_only_explicit_correction_resolves_conflicting_ids(self):
        c = candidate('source', 'sku', 'DEE')
        c['decision_records'] = [{'candidate_id': 'old', 'review_decision': ''}, {'candidate_id': 'new', 'review_decision': 'confirm'}]
        original = {r['candidate_id']: r for r in c['decision_records']}
        decisions, audit = apply_explicit_corrections({'candidates': [c]}, original,
            {'source_corrections': [authorization(c)]}, MS)
        self.assertEqual(set(decisions), {'source'})
        self.assertEqual(decisions['source']['manual_master_row'], '27')
        self.assertEqual(len(audit[0]['original_csv_records']), 2)
        self.assertEqual(original['old']['review_decision'], '')
        self.assertEqual(original['new']['review_decision'], 'confirm')

    def test_rejected_original_cannot_be_reactivated_by_batch(self):
        c = candidate('source')
        c['decision_records'] = [{'candidate_id': 'source', 'review_decision': 'reject'}]
        with self.assertRaises(ValueError):
            apply_explicit_corrections({'candidates': [c]}, {}, {'source_corrections': [authorization(c)]}, MS)

    def test_old_master_row_and_corrected_code_remain_traceable(self):
        c = candidate('bs', 'sku', 'DEE')
        old = MasterRow(116, 'WM00128', '69', '泰文', '')
        new = MasterRow(116, 'WM0128', '69', '泰文', '')
        b = {'candidates': [c], 'original_master_rows': [old.to_public()], 'master_row_aliases': {'116': 116},
             'batch_target_authorizations': [authorization(c, 116, 'WM0128')]}
        out = resolve_reviews(b, {'bs': choice('bs', row=116, ice='WM00128')}, [new])
        self.assertEqual(out['candidates'][0]['manual_master_ice'], 'WM00128')
        self.assertEqual(out['candidates'][0]['selected_master']['ice_code'], 'WM0128')
        bad = resolve_reviews(b, {'bs': choice('bs', row=116, ice='WRONG')}, [new])
        self.assertIsNone(bad['candidates'][0]['selected_master'])

    def test_price_conflict_never_selects_first_or_zero(self):
        ms = [MasterRow(n, 'WM0072', '', '桂花泰版', '') for n in (66, 216)]
        raw = {66: {'成本价格': '5', '运营价格': '5.5'}, 216: {'成本价格': '5.18', '运营价格': '5.68'}}
        plan = {'master_groups': [{'anchor_row': 66, 'source_rows': [66, 216], 'ice_code': 'WM0072', 'primary_row': None, 'price_pending': True}], 'master_corrections': []}
        masters, aliases, detail = curate_master(ms, raw, plan)
        self.assertEqual(len(masters), 1)
        self.assertEqual(aliases, {'66': 66, '216': 66})
        self.assertIsNone(detail[0]['data']['成本价格'])
        self.assertIsNone(detail[0]['data']['运营价格'])
        self.assertEqual([p['cost'] for p in detail[0]['price_versions']], ['5', '5.18'])

    def test_shared_barcodes_do_not_merge_versions_or_package_units(self):
        ms = MS + [MasterRow(12, 'WM0005', '714855625096', '单颗', ''), MasterRow(16, 'WM0004', '714855625096', '整盒7.5g×10颗', '')]
        got, aliases, _ = curate_master(ms, {m.row_index: {} for m in ms}, {'master_groups': [], 'master_corrections': []})
        self.assertEqual(len(got), 4)
        self.assertEqual(set(aliases.values()), {27, 28, 12, 16})

    def test_ten_corrections_are_exact_eight_selected_two_deferred(self):
        plan = json.loads((Path(__file__).resolve().parents[3]/'docs/p0-03/curation-decisions-20261019.json').read_text(encoding='utf-8'))
        rows = [r for r in plan['source_corrections'] if r['group'] == 'ten-id-conflicts']
        expected = {'mc-9c2ee3be35162427': 'WM0117', 'mc-cbb09eccb960868f': 'WM0117',
                    'mc-232d0ff734f3737a': 'WM0005', 'mc-7f65ab8759563748': 'WM0005',
                    'mc-4a3970c4d1c02088': 'WM0027', 'mc-698525a2da421892': 'WM0073',
                    'mc-4f4bb5bef70bd89a': 'WM0073', 'mc-c2fddfa742e2ef9d': 'WM0073',
                    'mc-c8e6e17fc25361f1': None, 'mc-44b8f0236d346bc7': None}
        self.assertEqual({r['candidate_id']: r['target_ice'] for r in rows}, expected)
        self.assertEqual(sum(r['decision'] == 'confirm' for r in rows), 8)
        self.assertEqual(sum(r['decision'] == 'defer' for r in rows), 2)

    def test_authorized_and_negative_outputs_share_effective_records(self):
        from test_review_r2 import ReviewR2Tests
        helper = ReviewR2Tests()
        for d in ('confirm', 'reject', 'ignore', 'clear', 'defer'):
            out = resolve_reviews(self.bundle(), {'ph': choice(decision=d)}, MS)
            helper.assert_outputs(out)


if __name__ == '__main__':
    unittest.main()
