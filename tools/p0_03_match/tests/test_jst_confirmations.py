"""Exact twelve-record authorization, inherited choices, and current-decision safety."""
import copy
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from p0_03_match.jst_confirmations import AUTHORIZED_ROWS, apply_jst_confirmations, cmd_confirm_jst_sample
from p0_03_match.models import MasterRow, SourceRow
from p0_03_match.review_exports import export_effective_outputs, refresh_confirmation_summary
from p0_03_match.review_result import MANUAL_FIELDS, resolve_reviews, source_identity


def fixture():
    masters = [MasterRow(row, ice, '', ice+'商品', '') for ice, _, row, _, _ in AUTHORIZED_ROWS]
    candidates, decisions, explicit = [], {}, []
    for ice, source_row, master_row, cid, decision in AUTHORIZED_ROWS:
        master = next(m for m in masters if m.row_index == master_row)
        source = SourceRow('jushuitan', f'jushuitan:{source_row}:{ice}:{ice}', 'match_only', None,
                           ice, ice+'来源', sheet_name='Sheet1',
                           extra={'style_code': ice, 'product_code': ice}).to_public()
        old_id = 'old-'+cid
        candidates.append({'candidate_id': cid, 'candidate_id_lineage': [old_id], 'source': source,
                           'lifecycle': 'pending_review', 'master_matches': [master.to_public()], 'flags': []})
        decisions[old_id] = {'candidate_id': old_id, 'review_decision': '', 'review_notes': '',
                             **{k: '' for k in MANUAL_FIELDS}}
        explicit.append({'decision_id': 'user-'+ice, 'candidate_id': cid, 'source_identity': list(source_identity(candidates[-1])),
                         'source': copy.deepcopy(source), 'source_file': {'excel_row': source_row},
                         'target_row': master_row, 'target_ice': ice, 'target_master': master.to_public(),
                         'decision': decision, 'reason': '用户确认' if decision == 'confirm' else '用户已不再经营，本批忽略'})
    # An existing manual selection and its JST reference are deliberately unrelated to the operations.
    extra_master = MasterRow(30, 'WMOTHER', '', '旧商品', '')
    masters.append(extra_master)
    for cid, system, wh in [('old-jst', 'jushuitan', None), ('old-bs', 'bigseller', '印尼-DEE仓库')]:
        source = SourceRow(system, cid, 'match_only', wh, 'WMOTHER', '旧商品',
                           extra={'style_code': 'WMOTHER', 'product_code': 'WMOTHER'}).to_public()
        candidates.append({'candidate_id': cid, 'source': source, 'lifecycle': 'pending_review',
                           'master_matches': [extra_master.to_public()], 'flags': []})
        decisions[cid] = {'candidate_id': cid, 'review_decision': 'confirm', 'review_notes': '旧备注',
                          'manual_master_row': '30', 'manual_master_ice': 'WMOTHER',
                          'manual_jst_candidate_id': 'old-jst' if cid == 'old-bs' else '',
                          'manual_jst_sku': 'WMOTHER' if cid == 'old-bs' else ''}
    base = resolve_reviews({'candidates': candidates, 'batch_business_pending': [],
                            'business_confirmation_events': []}, decisions, masters)
    base['master_provenance'] = [{'row_index': m.row_index, 'ice_code': m.ice_code, 'barcode': '', 'spec': '',
        'source_rows': [66, 216] if m.row_index == 66 else [m.row_index], 'source_records': [],
        'data': {'成本价格': '5.18', '运营价格': '5.68'} if m.row_index == 66 else {'产品名': m.name_cn},
        'price_pending': False, 'price_versions': [{'source_row': 66, 'cost': '5', 'operating_price': '5.5'},
            {'source_row': 216, 'cost': '5.18', 'operating_price': '5.68'}] if m.row_index == 66 else [],
        'price_decision_history': [{'earlier': 'preserved'}]} for m in masters]
    plan = {'source_decisions': explicit, 'bs_not_created': [
        {'ice_code': ice, 'master_row': row, 'source_system': 'bigseller', 'status': 'user_confirmed_not_created',
         'reason': '用户确认尚未在BigSeller建档，等待后续创建', 'basis': '还没有创建，可以先不绑定'}
        for ice, row in [('WM0070', 214), ('WM0072', 66)]]}
    return base, decisions, plan


class JstConfirmationTests(unittest.TestCase):
    def test_exact_eleven_confirmations_and_one_ignore_are_saved(self):
        out, effective, events = apply_jst_confirmations(*fixture())
        by_id = {c['candidate_id']: c for c in out['candidates']}
        self.assertEqual(len(events), 12)
        self.assertEqual(out['jst_confirmation_summary']['new_effective_selections'], 11)
        self.assertEqual(out['jst_confirmation_summary']['effective_ignores'], 1)
        for ice, _, row, cid, decision in AUTHORIZED_ROWS:
            c = by_id[cid]
            self.assertEqual(effective[cid]['review_decision'], decision)
            self.assertTrue(c['review_notes'])
            if decision == 'confirm':
                self.assertEqual((c['selected_master']['ice_code'], c['selected_master']['row_index']), (ice, row))
                self.assertEqual(c['review_state'], 'manual_selected')

    def test_ignore_retains_candidate_source_and_master_without_selected_target(self):
        base, decisions, plan = fixture()
        out, effective, _ = apply_jst_confirmations(base, decisions, plan)
        a = next(c for c in base['candidates'] if c['source']['external_sku_raw'] == 'WM0007')
        b = next(c for c in out['candidates'] if c['candidate_id'] == a['candidate_id'])
        self.assertEqual((b['review_decision'], b['review_state']), ('ignore', 'ignored'))
        self.assertIsNone(b['selected_master'])
        self.assertEqual(a['source'], b['source'])
        self.assertEqual(a['master_matches'], b['master_matches'])
        self.assertEqual(effective[b['candidate_id']]['manual_master_row'], '')
        self.assertEqual(out['master_rows'], base['master_rows'])

    def test_existing_source_dictionaries_and_manual_jst_references_are_unchanged(self):
        base, decisions, plan = fixture()
        out, _, _ = apply_jst_confirmations(base, decisions, plan)
        for cid in ('old-jst', 'old-bs'):
            self.assertEqual(next(c for c in base['candidates'] if c['candidate_id'] == cid),
                             next(c for c in out['candidates'] if c['candidate_id'] == cid))
        self.assertEqual(out['correction_events'], base['correction_events'])
        self.assertEqual(out['business_confirmation_events'], base['business_confirmation_events'])
        self.assertEqual(out['batch_business_pending'], base['batch_business_pending'])

    def test_price_identity_and_both_price_histories_are_preserved(self):
        base, decisions, plan = fixture()
        out, _, _ = apply_jst_confirmations(base, decisions, plan)
        before = next(m for m in base['master_provenance'] if m['ice_code'] == 'WM0072')
        after = next(m for m in out['master_provenance'] if m['ice_code'] == 'WM0072')
        self.assertEqual({k: v for k, v in after.items() if k != 'bs_creation_status'}, before)
        self.assertFalse(after['price_pending'])
        self.assertEqual(after['data']['成本价格'], '5.18')
        self.assertEqual(after['data']['运营价格'], '5.68')

    def test_not_created_notices_never_add_bigseller_sources_or_targets(self):
        base, decisions, plan = fixture()
        out, _, _ = apply_jst_confirmations(base, decisions, plan)
        self.assertEqual([c['source'] for c in base['candidates']], [c['source'] for c in out['candidates']])
        for notice in out['batch_bs_not_created']:
            self.assertFalse(any(c['source']['source_system'] == 'bigseller' and c.get('selected_master')
                and c['selected_master']['row_index'] == notice['master_row'] for c in out['candidates']))
            master = next(m for m in out['master_provenance'] if m['row_index'] == notice['master_row'])
            self.assertEqual(master['bs_creation_status'], notice)

    def test_changed_ids_preserve_original_csv_in_audit_and_not_input_mutation(self):
        base, decisions, plan = fixture()
        original = copy.deepcopy((base, decisions, plan))
        _, effective, events = apply_jst_confirmations(base, decisions, plan)
        self.assertEqual((base, decisions, plan), original)
        for event in events:
            cid = event['explicit_decision']['candidate_id']
            self.assertNotIn('old-'+cid, effective)
            self.assertEqual(event['before_csv_records'][0]['candidate_id'], 'old-'+cid)
            self.assertEqual(event['after_csv'], effective[cid])

    def test_conflicting_historical_csv_rows_are_rejected(self):
        base, decisions, plan = fixture()
        cid = plan['source_decisions'][0]['candidate_id']
        decisions[cid] = {**decisions['old-'+cid], 'candidate_id': cid, 'review_decision': 'confirm'}
        with self.assertRaisesRegex(ValueError, 'conflicting'):
            apply_jst_confirmations(base, decisions, plan)

    def test_ambiguous_source_lineage_is_rejected(self):
        base, decisions, plan = fixture()
        base['candidates'][1]['candidate_id_lineage'].append(base['candidates'][0]['candidate_id'])
        with self.assertRaisesRegex(ValueError, 'Ambiguous'):
            apply_jst_confirmations(base, decisions, plan)

    def test_wrong_identity_raw_source_target_code_or_original_row_is_rejected(self):
        for wrong in ('identity', 'source', 'source_row', 'target_row', 'target_code', 'target_master', 'sheet'):
            base, decisions, plan = fixture()
            p = plan['source_decisions'][0]
            if wrong == 'identity': p['source_identity'][-1] = 'WMOTHER'
            elif wrong == 'source': p['source']['external_name'] = '错误来源'
            elif wrong == 'source_row': p['source_file']['excel_row'] = 123
            elif wrong == 'target_row': p['target_row'] = 30
            elif wrong == 'target_code': p['target_ice'] = 'WMOTHER'
            elif wrong == 'target_master': p['target_master']['name_cn'] = '替换商品'
            else: p['source']['sheet_name'] = 'Other'
            with self.subTest(wrong=wrong), self.assertRaises(ValueError):
                apply_jst_confirmations(base, decisions, plan)

    def test_cannot_change_ignore_to_reject_or_expand_authorized_list(self):
        for change in ('reject', 'duplicate', 'remove'):
            base, decisions, plan = fixture()
            if change == 'reject': plan['source_decisions'][-1]['decision'] = 'reject'
            elif change == 'duplicate': plan['source_decisions'].append(copy.deepcopy(plan['source_decisions'][0]))
            else: plan['source_decisions'].pop()
            with self.subTest(change=change), self.assertRaises(ValueError):
                apply_jst_confirmations(base, decisions, plan)

    def test_existing_negative_decision_is_not_overridden(self):
        base, decisions, plan = fixture()
        base['candidates'][0]['review_decision'] = 'defer'
        with self.assertRaisesRegex(ValueError, 'override'):
            apply_jst_confirmations(base, decisions, plan)

    def test_current_negative_decisions_still_override_recorded_confirmation(self):
        for decision in ('reject', 'ignore', 'clear', 'defer'):
            out, effective, _ = apply_jst_confirmations(*fixture())
            cid = AUTHORIZED_ROWS[0][3]
            effective[cid]['review_decision'] = decision
            current = resolve_reviews(out, effective, [MasterRow(**m) for m in out['master_rows']])
            refresh_confirmation_summary(current)
            c = next(c for c in current['candidates'] if c['candidate_id'] == cid)
            with self.subTest(decision=decision):
                self.assertEqual(c['review_decision'], decision)
                self.assertIsNone(c['selected_master'])
                self.assertEqual(current['jst_confirmation_summary']['new_effective_selections'], 10)
                self.assertEqual(len(current['jst_confirmation_events']), 12)

    def test_same_inputs_produce_equal_events_and_already_applied_output_is_rejected(self):
        base, decisions, plan = fixture()
        a = apply_jst_confirmations(base, decisions, plan)
        b = apply_jst_confirmations(base, decisions, plan)
        self.assertEqual(a, b)
        with self.assertRaisesRegex(ValueError, 'already-applied'):
            apply_jst_confirmations(a[0], a[1], plan)

    def test_all_saved_projections_contain_same_eleven_choices_and_ignore(self):
        out, _, _ = apply_jst_confirmations(*fixture())
        with tempfile.TemporaryDirectory() as td:
            path = Path(td)
            export_effective_outputs(out, path)
            saved = json.loads((path/'match-bundle.json').read_text(encoding='utf-8'))
            rows = json.loads((path/'effective-review-records.json').read_text(encoding='utf-8'))
            by_id = {r['candidate_id']: r for r in rows}
            for ice, _, row, cid, decision in AUTHORIZED_ROWS:
                r = by_id[cid]
                self.assertEqual(r['review_decision'], decision)
                self.assertEqual(r['master_ice_code'], ice if decision == 'confirm' else '')
                self.assertEqual(r['master_row_index'], row if decision == 'confirm' else '')
                self.assertIn(cid, (path/'match-review.html').read_text(encoding='utf-8'))
            self.assertEqual(saved['jst_confirmation_summary']['new_effective_selections'], 11)
            for ice in ('WM0070', 'WM0072'):
                m = next(m for m in saved['master_provenance'] if m['ice_code'] == ice)
                self.assertEqual(m['bs_creation_status']['status'], 'user_confirmed_not_created')
                self.assertIn(m['bs_creation_status']['reason'], (path/'master-overview.html').read_text(encoding='utf-8'))

    def test_bad_input_pins_fail_before_creating_output(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td)
            p = path/'plan.json'
            p.write_text(json.dumps({'base_hashes': {'match-bundle.json': 'wrong'}}), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'pins'):
                cmd_confirm_jst_sample(SimpleNamespace(evidence=str(path), decisions=str(p), output=str(path/'out')))
            self.assertFalse((path/'out').exists())


if __name__ == '__main__':
    unittest.main()
