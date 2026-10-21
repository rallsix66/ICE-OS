"""Independent saved-output checks against the approved curation baseline."""
import copy
import importlib.util
import json
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location('curation_checks', Path(__file__).with_name('verify-curation-evidence.py'))
checks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checks)

MILK, SUN, EYE = 'mc-59f065c77b77953a', 'mc-5131dbfa1ad6207d', 'mc-0b2c37c654a967b1'
PH_VN = {'mc-e1b56fb81b0db46c', 'mc-73ac4812d7d8de64', 'mc-b7bd376e964738cd'}


def verify(root):
    b = checks.verify_outputs(root)
    manifest = checks.read(root/'input-manifest.json')
    old = checks.read(root/'baseline-match-bundle.frozen.json')
    plan = checks.read(root/'business-decisions.frozen.json')
    before = {c['candidate_id']: c for c in old['candidates']}
    after = {c['candidate_id']: c for c in b['candidates']}
    assert set(before) == set(after) and len(after) == 1417
    for key in ('baseline_bundle', 'decision_source', 'explicit_decisions', 'baseline_manifest'):
        item = manifest[key]
        assert checks.sha(root/item['frozen']) == item['sha256'] == checks.sha(Path(item['path']))
    assert manifest['baseline_bundle']['sha256'] == plan['base_hashes']['match-bundle.json'] == 'd661805b4652ee9501753512a82c9eac9896f10f5cfe57bff33965765e117d27'
    assert manifest['decision_source']['sha256'] == plan['base_hashes']['manual-decisions.effective.csv'] == '14d4d18b33af35d27d6b2d82de6d89b1c8163187217f80fafe656466a5f87316'
    for item in manifest['inherited_files']:
        assert checks.sha(root/item['frozen']) == item['sha256'] == checks.sha(Path(item['path']))
    for name, digest in manifest['base_evidence_hashes'].items():
        assert checks.sha(Path(manifest['base_evidence'])/name) == digest
    e = manifest['effective_decision_source']
    assert checks.sha(root/e['frozen']) == e['sha256']
    assert b['correction_events'] == old['correction_events']
    assert b['batch_target_authorizations'] == old['batch_target_authorizations']
    assert b['master_rows'] == old['master_rows'] and len(b['master_rows']) == 126
    assert b['master_row_aliases'] == old['master_row_aliases']
    assert b['original_master_rows'] == old['original_master_rows']
    for cid, c in after.items():
        assert c['source'] == before[cid]['source'], (cid, 'source identity/quantity')
        assert c['master_matches'] == before[cid]['master_matches'], (cid, 'candidates not rematched')
        if cid not in (MILK, SUN, EYE):
            for key in ('review_state', 'review_decision', 'review_notes', 'selected_master', 'selected_jushuitan',
                        'manual_master_row', 'manual_master_ice', 'manual_jst_candidate_id', 'manual_jst_sku',
                        'decision_records', 'validation_errors'):
                assert c[key] == before[cid][key], (cid, key)
        if before[cid]['review_state'] in ('outside_rules', 'rejected', 'ignored') or before[cid]['review_decision'] == 'defer':
            assert c['review_state'] == before[cid]['review_state'] and c['selected_master'] is None
    for cid, row, ice in [(MILK, 19, 'WM0012'), (SUN, 27, 'WM0039'), (EYE, 39, 'WM10012')]:
        c = after[cid]
        assert c['selected_master']['row_index'] == row and c['selected_master']['ice_code'] == ice
        assert c['review_state'] == 'manual_selected' and c['review_decision'] == 'confirm'
        assert c['batch_business_pending'] is None
    assert before[MILK]['selected_master'] is None and before[EYE]['review_state'] == 'candidate'
    assert before[SUN]['selected_master'] == after[SUN]['selected_master']
    assert b['review_summary'] == {'manual_selected': 534, 'outside_rules': 88, 'pending': 776, 'rejected': 3, 'candidate': 16}
    summary = checks.read(root/'business-confirmation-summary.json')
    assert b['business_confirmation_summary'] == summary
    assert summary['recorded_business_decisions'] == summary['implemented_business_decisions'] == 4
    assert summary['new_effective_selections'] == 2 and set(summary['new_effective_candidate_ids']) == {MILK, EYE}
    assert summary['reaffirmed_existing_selections'] == summary['current_price_selections'] == 1
    assert summary['reaffirmed_candidate_ids'] == [SUN]
    assert summary['remaining_business_issues'] == 1
    assert checks.read(root/'pending-business.json') == b['batch_business_pending'] == [old['batch_business_pending'][0]]
    assert set(b['batch_business_pending'][0]['candidate_ids']) == PH_VN
    for cid in PH_VN:
        assert after[cid]['selected_master']['ice_code'] == 'WM0012'
        assert after[cid]['batch_business_pending'] == before[cid]['batch_business_pending']
        assert after[cid]['decision_records'] == before[cid]['decision_records']
    old_details = {m['row_index']: m for m in old['master_provenance']}
    details = {m['row_index']: m for m in b['master_provenance']}
    for n, item in details.items():
        if n == 66:
            expected = copy.deepcopy(old_details[n])
            expected['data'].update({'成本价格': '5.18', '运营价格': '5.68'})
            expected['price_pending'] = False
            assert len(item['price_decision_history']) == 1
            assert item['price_decision_history'][0]['before'] == {'cost': None, 'operating_price': None, 'price_pending': True}
            assert item['current_price_selection']['source_row'] == 216
            assert item['current_price_selection']['source_date'] == '2026-07-13'
            for key in ('current_price_selection', 'price_decision_history'):
                expected[key] = item[key]
            assert item == expected
        else:
            a, z = copy.deepcopy(item), copy.deepcopy(old_details[n])
            if n in (19, 39):
                a.pop('selected_source_ids'); z.pop('selected_source_ids')
            assert a == z, (n, 'unapproved master data change')
    assert details[66]['source_records'] == old_details[66]['source_records']
    assert details[66]['price_versions'] == old_details[66]['price_versions']
    assert details[66]['valuation_authorized'] is False
    price_jst = next(c for c in after.values() if c['source']['source_system'] == 'jushuitan' and c['source']['external_sku_raw'] == 'WM0072')
    assert price_jst['review_state'] == 'candidate' and price_jst['review_decision'] is None and price_jst['selected_master'] is None
    assert price_jst['batch_business_pending'] is None
    price_csv = next(r for r in checks.csv_rows(root/'master-overview.csv') if r['ice_code'] == 'WM0072')
    assert price_csv['price_pending'] == 'False' and price_csv['成本价格'] == '5.18' and price_csv['运营价格'] == '5.68'
    assert json.loads(price_csv['current_price_selection']) == details[66]['current_price_selection']
    assert json.loads(price_csv['price_decision_history']) == details[66]['price_decision_history']
    audit = checks.read(root/'current-decision-audit.json')
    assert len(audit) == len(b['business_confirmation_events']) == 4
    assert checks.read(root/'business-confirmation-events.json') == b['business_confirmation_events']
    assert any(r['candidate_id'] == 'mc-adf896ec635d7a7f' for r in audit[2]['before_csv_records'])
    comparison = checks.read(root/'current-original-22-comparison.json')
    assert len(comparison) == 22
    for entry in comparison:
        assert entry['before'] == entry['after'], (entry['candidate_id'], 'entire original22 record')
        for key in ('selected_master', 'selected_jushuitan', 'manual_master_row', 'manual_master_ice', 'manual_jst_candidate_id', 'manual_jst_sku', 'review_state', 'review_decision', 'review_notes', 'decision_records'):
            assert entry['before'][key] == entry['after'][key]
    inherited10 = [a for a in checks.read(root/'explicit-correction-audit.json') if a['correction']['group'] == 'ten-id-conflicts']
    assert len(inherited10) == 10
    for entry in inherited10:
        c = after[entry['correction']['candidate_id']]
        if entry['correction']['decision'] == 'confirm':
            assert c['selected_master']['ice_code'] == entry['correction']['target_ice']
        else:
            assert c['review_decision'] == 'defer' and c['selected_master'] is None
    changes = checks.read(root/'all-correspondence-changes.json')
    assert {x['candidate_id'] for x in changes} == {MILK, SUN, EYE, price_jst['candidate_id']}
    assert len(checks.read(root/'all-master-changes.json')) == 3  # price row + selected-source lists for 19/39
    full_changes = checks.read(root/'all-field-changes.json')
    assert full_changes
    reconstructed = copy.deepcopy(old)
    for change in full_changes:
        parts = change['path'].strip('/').split('/')
        parent = reconstructed
        for part in parts[:-1]:
            parent = parent[int(part)] if isinstance(parent, list) else parent[part]
        key = int(parts[-1]) if isinstance(parent, list) else parts[-1]
        if not change.get('after_present', True):
            del parent[key]
        else:
            parent[key] = change['after']
    assert reconstructed == b, 'complete field diff must reconstruct the final saved bundle'
    return {'status': 'verified', 'source_records_compared': 1417, 'source_identity_and_quantities_unchanged': True,
            'masters_compared': 126, 'new_effective_selections': 2, 'reaffirmed_existing': 1, 'current_price_choice': 1,
            'remaining_business_issues': 1, 'ph_vn_pending_records_unchanged': 3, 'original22_unchanged': True,
            'inherited8_confirmations_2_deferrals_unchanged': True, 'all_outputs_consistent': True,
            'review_summary': b['review_summary']}


if __name__ == '__main__':
    print(json.dumps(verify(Path(sys.argv[1]).resolve()), ensure_ascii=False, indent=2))
