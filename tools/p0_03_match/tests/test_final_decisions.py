"""Regression checks for the finite final product decisions and later revocations."""
import copy
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from p0_03_match.final_decisions import AUTHORIZED, SPECS, apply_final_decisions, cmd_finalize_sample, final_field_changes
from p0_03_match.models import MasterRow, SourceRow
from p0_03_match.review_exports import export_effective_outputs, refresh_confirmation_summary
from p0_03_match.review_result import MANUAL_FIELDS, resolve_reviews


def fixture():
    plan = json.loads((Path(__file__).resolve().parents[3]/'docs/p0-03/final-decisions-20261020.json').read_text(encoding='utf-8'))
    products = {p['target_row']: MasterRow(**p['target_master']) for p in plan['source_decisions']}
    for ice, row, spec in SPECS:
        products.setdefault(row, MasterRow(row, ice, '', ice+'产品', spec or ''))
    for p in plan['brush_preservation']:
        products[p['master_row']] = MasterRow(p['master_row'], p['ice_code'], '', p['name'], '')
    products[213] = MasterRow(213, 'WM0069', '', '已有选择', '')
    candidates, decisions = [], {}
    for p in plan['source_decisions']:
        operation = p['operation']
        decision = 'confirm' if operation == 'version_reaffirmation' else 'defer' if operation == 'resolve_defer' else ''
        old_id = 'previous-'+p['candidate_id']
        candidates.append({'candidate_id': p['candidate_id'], 'candidate_id_lineage': [old_id],
            'source': copy.deepcopy(p['source']), 'lifecycle': 'pending_review', 'flags': [],
            'master_matches': [] if operation == 'resolve_defer' else [products[p['target_row']].to_public()]})
        decisions[old_id] = {'candidate_id': old_id, 'review_decision': decision,
                            'review_notes': '旧暂缓理由' if decision == 'defer' else '', **{k: '' for k in MANUAL_FIELDS}}
    for cid, system, ice, row, decision in [('old-selected-jst', 'jushuitan', 'WM0069', 213, 'confirm'),
            ('old-selected-bs', 'bigseller', 'WM0069', 213, 'confirm'),
            ('rejected-WM0062', 'jushuitan', 'WM0062', 83, 'reject'),
            ('brush-jst', 'jushuitan', 'WM0081', 62, ''),
            ('brush-bs', 'bigseller', 'brush', 107, ''),
            ('WM0007-ignore', 'jushuitan', 'WM0007', None, 'ignore')]:
        source = SourceRow(system, cid, 'match_only', '印尼-DEE仓库' if system == 'bigseller' else None,
                           ice, ice+'来源', extra={'style_code': ice, 'product_code': ice}).to_public()
        candidates.append({'candidate_id': cid, 'source': source, 'lifecycle': 'pending_review', 'flags': [],
                           'master_matches': [products[row].to_public()] if row else []})
        decisions[cid] = {'candidate_id': cid, 'review_decision': decision, 'review_notes': '旧备注', **{k: '' for k in MANUAL_FIELDS}}
        if cid == 'old-selected-bs':
            decisions[cid].update(manual_master_row='213', manual_master_ice='WM0069',
                                  manual_jst_candidate_id='old-selected-jst', manual_jst_sku='WM0069')
    pending = {'number': 1, 'title': '菲越普通洗面奶', 'candidate_ids': [p[0] for p in AUTHORIZED[:3]],
               'status': 'pending', 'preserve_matches': True, 'instruction': '旧待决说明保留'}
    base = resolve_reviews({'candidates': candidates, 'batch_business_pending': [pending],
                           'business_confirmation_events': [], 'jst_confirmation_events': [],
                           'batch_bs_not_created': []}, decisions, list(products.values()))
    for c in base['candidates']:
        c['batch_business_pending'] = copy.deepcopy(pending) if c['candidate_id'] in pending['candidate_ids'] else None
    base['master_provenance'] = [{'row_index': m.row_index, 'ice_code': m.ice_code, 'name_cn': m.name_cn,
        'barcode': m.barcode, 'spec': m.spec, 'source_rows': [m.row_index],
        'data': {'规格': m.spec, '成本价格': '5.18', '运营价格': '5.68', '单个产品重量(kg）': '0.058'},
        'price_pending': False, 'price_versions': [{'source_row': m.row_index, 'cost': '5.18', 'operating_price': '5.68'}],
        'source_records': [{'excel_row': m.row_index, 'data': {'规格': m.spec}}], 'corrections': []}
        for m in products.values()]
    return base, decisions, plan


class FinalDecisionTests(unittest.TestCase):
    def test_recursive_filename_and_tilde_keys_produce_reconstructable_json_pointers(self):
        before = {'input_manifest': {'base_evidence_hashes': {'coverage/summary.json': 'old', 'a~b/c': 'remove'}},
                  'array': [{'nested/~key': 'old'}]}
        after = {'input_manifest': {'base_evidence_hashes': {'coverage/summary.json': 'new', 'new/~file': 'add'}},
                 'array': [{'nested/~key': 'new'}]}
        changes = final_field_changes(before, after)
        paths = {c['path'] for c in changes}
        self.assertIn('/input_manifest/base_evidence_hashes/coverage~1summary.json', paths)
        self.assertIn('/input_manifest/base_evidence_hashes/a~0b~1c', paths)
        self.assertIn('/array/0/nested~1~0key', paths)
        reconstructed = copy.deepcopy(before)
        for change in changes:
            keys = [part.replace('~1', '/').replace('~0', '~') for part in change['path'].split('/')[1:]]
            parent = reconstructed
            for key in keys[:-1]:
                parent = parent[int(key)] if isinstance(parent, list) else parent[key]
            key = int(keys[-1]) if isinstance(parent, list) else keys[-1]
            if change.get('before_present', True):
                self.assertEqual(parent[key], change['before'])
            if change.get('after_present', True):
                parent[key] = copy.deepcopy(change['after'])
            else:
                del parent[key]
        self.assertEqual(reconstructed, after)

    def test_eight_operations_have_three_new_three_reaffirmed_and_two_ignores(self):
        out, effective, events = apply_final_decisions(*fixture())
        summary = out['final_confirmation_summary']
        self.assertEqual((summary['recorded_source_decisions'], summary['new_effective_selections'],
                          summary['reaffirmed_existing_selections'], summary['effective_ignores']), (8, 3, 3, 2))
        self.assertEqual(summary['remaining_business_issues'], 0)
        self.assertEqual(len(events), 8)
        for cid, _, row, ice, decision, _ in AUTHORIZED:
            c = next(c for c in out['candidates'] if c['candidate_id'] == cid)
            self.assertEqual(c['review_decision'], decision)
            self.assertEqual(effective[cid]['review_decision'], decision)
            if decision == 'confirm':
                self.assertEqual((c['selected_master']['row_index'], c['selected_master']['ice_code']), (row, ice))

    def test_cleanser_version_clears_current_pending_and_keeps_complete_pending_history(self):
        base, decisions, plan = fixture()
        out, _, _ = apply_final_decisions(base, decisions, plan)
        self.assertEqual(out['batch_business_pending'], [])
        self.assertEqual(out['resolved_business_pending_history'][0]['previous_pending'], base['batch_business_pending'][0])
        for cid, *_ in AUTHORIZED[:3]:
            before = next(c for c in base['candidates'] if c['candidate_id'] == cid)
            after = next(c for c in out['candidates'] if c['candidate_id'] == cid)
            self.assertEqual(before['selected_master'], after['selected_master'])
            self.assertIsNone(after['batch_business_pending'])
            self.assertEqual(after['batch_version_confirmation']['confirmed_version'], '升级普通版')
            self.assertTrue(after['batch_version_confirmation']['effective_selection'])

    def test_new_ignores_keep_raw_source_candidates_and_exact_reason_without_targets(self):
        base, decisions, plan = fixture()
        out, effective, _ = apply_final_decisions(base, decisions, plan)
        for cid, *_ in AUTHORIZED[3:5]:
            a = next(c for c in base['candidates'] if c['candidate_id'] == cid)
            b = next(c for c in out['candidates'] if c['candidate_id'] == cid)
            self.assertEqual((b['review_state'], b['review_decision'], b['review_notes']), ('ignored', 'ignore', '用户要求本批忽略'))
            self.assertIsNone(b['selected_master'])
            self.assertEqual(a['source'], b['source'])
            self.assertEqual(a['master_matches'], b['master_matches'])
            self.assertEqual(effective[cid]['manual_master_row'], '')

    def test_six_spec_closures_do_not_change_master_data_prices_or_source_versions(self):
        base, decisions, plan = fixture()
        out, _, _ = apply_final_decisions(base, decisions, plan)
        self.assertEqual(out['final_confirmation_summary']['closed_specification_issues'], 6)
        for before, after in zip(base['master_provenance'], out['master_provenance']):
            for key in ('row_index', 'ice_code', 'spec', 'data', 'source_records', 'price_pending', 'price_versions'):
                self.assertEqual(before[key], after[key])
        for r in out['batch_specification_resolutions']:
            self.assertEqual(r['previous_audit_question']['id'], 'audit-spec-'+r['ice_code'])
            self.assertFalse(r['quantity_conversion_authorized'])
            if r['ice_code'] in ('WM0006', 'WM0008'):
                self.assertIsNone(r['selected_spec'])
                self.assertIsNone(r['source_column'])
            else:
                self.assertEqual(r['source_column'], 'C')

    def test_brushes_remain_two_distinct_pending_products_and_source_choices_unchanged(self):
        base, decisions, plan = fixture()
        out, _, _ = apply_final_decisions(base, decisions, plan)
        self.assertEqual([(p['ice_code'], p['master_row']) for p in out['batch_brush_preservation']], [('WM0081', 62), ('brush', 107)])
        for cid in ('brush-jst', 'brush-bs'):
            self.assertEqual(next(c for c in base['candidates'] if c['candidate_id'] == cid),
                             next(c for c in out['candidates'] if c['candidate_id'] == cid))
        for p in out['batch_brush_preservation']:
            self.assertEqual(p['status'], 'pending_confirmation')
            self.assertTrue(p['do_not_merge'])
            self.assertTrue(p['future_requirement'])

    def test_original_targets_manual_jst_refs_reject_and_ignore_are_preserved(self):
        base, decisions, plan = fixture()
        out, _, _ = apply_final_decisions(base, decisions, plan)
        acted = {x[0] for x in AUTHORIZED}
        by_id = {c['candidate_id']: c for c in out['candidates']}
        for c in base['candidates']:
            if c['candidate_id'] not in acted:
                self.assertEqual(c, by_id[c['candidate_id']])
            if c.get('selected_master'):
                self.assertEqual(c['selected_master'], by_id[c['candidate_id']]['selected_master'])
        for key in ('correction_events', 'business_confirmation_events', 'jst_confirmation_events'):
            self.assertEqual(base[key], out[key])

    def test_both_explicit_deferred_records_become_effective_with_historical_defer_retained(self):
        out, _, events = apply_final_decisions(*fixture())
        for cid, *_ in AUTHORIZED[-2:]:
            c = next(c for c in out['candidates'] if c['candidate_id'] == cid)
            e = next(e for e in events if e['explicit_decision']['candidate_id'] == cid)
            self.assertEqual(e['before_csv_records'][0]['review_decision'], 'defer')
            self.assertEqual(c['review_state'], 'manual_selected')
            self.assertEqual(c['selected_master']['ice_code'], 'WM0073')
            self.assertEqual(c['previous_review']['review_decision'], 'defer')
        self.assertEqual(len(out['batch_target_authorizations']), 2)

    def test_input_values_are_immutable_and_repeat_application_is_deterministic(self):
        base, decisions, plan = fixture()
        original = copy.deepcopy((base, decisions, plan))
        a = apply_final_decisions(base, decisions, plan)
        b = apply_final_decisions(base, decisions, plan)
        self.assertEqual(a, b)
        self.assertEqual((base, decisions, plan), original)
        with self.assertRaisesRegex(ValueError, 'Already-applied'):
            apply_final_decisions(a[0], a[1], plan)

    def test_conflicting_csv_rows_and_ambiguous_lineage_are_rejected(self):
        for conflict in ('csv', 'lineage'):
            base, decisions, plan = fixture()
            cid = AUTHORIZED[0][0]
            if conflict == 'csv':
                decisions[cid] = {**decisions['previous-'+cid], 'candidate_id': cid, 'review_decision': 'clear'}
            else:
                base['candidates'][1]['candidate_id_lineage'].append(cid)
            with self.subTest(conflict=conflict), self.assertRaises(ValueError):
                apply_final_decisions(base, decisions, plan)

    def test_wrong_source_original_row_target_or_unauthorized_operation_is_rejected(self):
        for change in ('source', 'row', 'target', 'code', 'operation', 'decision'):
            base, decisions, plan = fixture()
            p = plan['source_decisions'][0]
            if change == 'source': p['source']['warehouse'] = '另一仓'
            elif change == 'row': p['source_file']['excel_row'] = 999
            elif change == 'target': p['target_row'] = 121
            elif change == 'code': p['target_ice'] = 'WM0130'
            elif change == 'operation': p['operation'] = 'new_selection'
            else: p['decision'] = 'reject'
            with self.subTest(change=change), self.assertRaises(ValueError):
                apply_final_decisions(base, decisions, plan)

    def test_spec_cannot_use_weight_or_gram_ml_conversion_or_rewrite_empty_spec(self):
        for change in ('weight', 'convert', 'fill', 'spec'):
            base, decisions, plan = fixture()
            if change == 'weight': plan['specification_resolutions'][2]['source_column'] = 'O'
            elif change == 'convert': plan['specification_resolutions'][2]['quantity_conversion_authorized'] = True
            elif change == 'fill': plan['specification_resolutions'][0]['selected_spec'] = '120ml'
            else: plan['specification_resolutions'][4]['selected_spec'] = '120ml/瓶'
            with self.subTest(change=change), self.assertRaises(ValueError):
                apply_final_decisions(base, decisions, plan)

    def test_later_negative_decisions_never_revive_target_or_active_version_from_history(self):
        for cid in (AUTHORIZED[0][0], AUTHORIZED[5][0], AUTHORIZED[6][0]):
            for decision in ('reject', 'ignore', 'clear', 'defer'):
                out, effective, _ = apply_final_decisions(*fixture())
                effective[cid]['review_decision'] = decision
                current = resolve_reviews(out, effective, [MasterRow(**m) for m in out['master_rows']])
                refresh_confirmation_summary(current)
                c = next(c for c in current['candidates'] if c['candidate_id'] == cid)
                with self.subTest(cid=cid, decision=decision):
                    self.assertIsNone(c['selected_master'])
                    self.assertEqual(c['review_decision'], decision)
                    self.assertEqual(len(current['final_confirmation_events']), 8)
                    self.assertEqual(current['batch_business_pending'], [])
                    if cid == AUTHORIZED[0][0]:
                        self.assertFalse(c['batch_version_confirmation']['effective_selection'])
                        self.assertEqual(current['final_confirmation_summary']['current_confirmed_versions'], 2)
                    else:
                        self.assertEqual(current['final_confirmation_summary']['new_effective_selections'], 2)

    def test_saved_json_csv_and_existing_pages_show_current_decisions_and_brush_notes(self):
        out, _, _ = apply_final_decisions(*fixture())
        with tempfile.TemporaryDirectory() as td:
            path = Path(td)
            export_effective_outputs(out, path)
            saved = json.loads((path/'match-bundle.json').read_text(encoding='utf-8'))
            rows = json.loads((path/'effective-review-records.json').read_text(encoding='utf-8'))
            by_id = {r['candidate_id']: r for r in rows}
            for cid, _, row, ice, decision, _ in AUTHORIZED:
                self.assertEqual(by_id[cid]['review_decision'], decision)
                self.assertEqual(by_id[cid]['master_ice_code'], ice if decision == 'confirm' else '')
                self.assertIn(cid, (path/'match-review.html').read_text(encoding='utf-8'))
            self.assertEqual(saved['final_confirmation_summary']['closed_specification_issues'], 6)
            self.assertIn('升级普通版', (path/'match-review.html').read_text(encoding='utf-8'))
            html = (path/'master-overview.html').read_text(encoding='utf-8')
            self.assertIn('WM0081', html)
            self.assertIn('brush', html)
            self.assertIn('pending_confirmation', html)
            self.assertIn('后续正式系统也需保留两份', html)

    def test_wrong_baseline_hash_fails_before_output_creation(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td)
            plan = path/'plan.json'
            plan.write_text(json.dumps({'base_hashes': {'match-bundle.json': 'wrong'}}), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'pins'):
                cmd_finalize_sample(SimpleNamespace(evidence=str(path), decisions=str(plan), output=str(path/'out')))
            self.assertFalse((path/'out').exists())


if __name__ == '__main__':
    unittest.main()
