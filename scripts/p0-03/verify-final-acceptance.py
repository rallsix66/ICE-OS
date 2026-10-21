"""Independently check the final explicitly authorized local sample decisions.

This imports only an existing saved-projection verifier, never the matcher or
decision implementation. Expected source identities are the user's finite list.
"""
from __future__ import annotations

import argparse
import copy
import importlib.util
import json
from decimal import Decimal
from collections import Counter
from pathlib import Path
import re
from xml.etree import ElementTree as ET
from zipfile import ZipFile

spec = importlib.util.spec_from_file_location('saved_projection_checks', Path(__file__).with_name('verify-curation-evidence.py'))
checks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checks)

PINS = {'match-bundle.json': '3c2babc9b13ca11fab14cb4bbce5e8617052319d06bc80c922256f6893346159',
        'manual-decisions.effective.csv': '48544cd03154131970fce220fb2ff7c704e18d7860e2ea7c72e6a0ef1ac8d921'}
# source system, original Excel row, frozen candidate ID, SKU, master anchor, ICE, operation
EXPECTED = [
    ('bigseller', 376, 'mc-e1b56fb81b0db46c', '6974674957349', 19, 'WM0012', 'version_reaffirmation'),
    ('bigseller', 380, 'mc-73ac4812d7d8de64', '6974674957349', 19, 'WM0012', 'version_reaffirmation'),
    ('bigseller', 526, 'mc-b7bd376e964738cd', '6974674957349', 19, 'WM0012', 'version_reaffirmation'),
    ('jushuitan', 743, 'mc-e78031a3b38c39f1', 'WM0006', 13, 'WM0006', 'ignore'),
    ('jushuitan', 745, 'mc-06e9251af096ae18', 'WM0008', 14, 'WM0008', 'ignore'),
    ('jushuitan', 857, 'mc-75e0ce710d064c4c', 'WM0130', 121, 'WM0130', 'confirm'),
    ('bigseller', 220, 'mc-44b8f0236d346bc7', '757577407359', 67, 'WM0073', 'confirm'),
    ('bigseller', 321, 'mc-c8e6e17fc25361f1', '757577407359', 67, 'WM0073', 'confirm'),
]
PH_VN = {x[2] for x in EXPECTED if x[-1] == 'version_reaffirmation'}
SPECS = {'WM0031': (25, '20ml/支'), 'WM0062': (83, '20ml/支'),
         'WM0098': (92, '120g/瓶'), 'WM0130': (121, '20ml/支')}


def xlsx_original_rows(path, sheet_name, wanted):
    """A separate OOXML read, without implementation/openpyxl row projection."""
    ns = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
    with ZipFile(path) as z:
        strings = [''.join(x.itertext()) for x in ET.fromstring(z.read('xl/sharedStrings.xml'))] if 'xl/sharedStrings.xml' in z.namelist() else []
        sheet = next(x for x in ET.fromstring(z.read('xl/workbook.xml')).findall('s:sheets/s:sheet', ns) if x.attrib['name'] == sheet_name)
        rid = sheet.attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id']
        target = next(x.attrib['Target'] for x in ET.fromstring(z.read('xl/_rels/workbook.xml.rels')) if x.attrib['Id'] == rid)
        member = target.lstrip('/') if target.startswith('/') else 'xl/'+target
        rows = {}
        for row in ET.fromstring(z.read(member)).findall('s:sheetData/s:row', ns):
            index = int(row.attrib['r'])
            if index not in wanted and index != 1:
                continue
            data = {}
            for cell in row.findall('s:c', ns):
                value = cell.find('s:v', ns)
                text = value.text if value is not None else ''
                if cell.attrib.get('t') == 's':
                    text = strings[int(text)]
                elif cell.attrib.get('t') == 'inlineStr':
                    text = ''.join(cell.find('s:is', ns).itertext())
                data[re.sub(r'\d+$', '', cell.attrib['r'])] = text or ''
            rows[index] = data
        return {index: {header: rows[index].get(column, '') for column, header in rows[1].items()}
                for index in wanted}


def verify(delivery, coverage=None):
    bundle = checks.verify_outputs(delivery)
    manifest = checks.read(delivery/'input-manifest.json')
    base = Path(manifest['base_evidence'])
    assert all(checks.sha(base/name) == digest for name, digest in PINS.items()), 'approved baseline hashes'
    old = checks.read(base/'match-bundle.json')
    plan = checks.read(delivery/'final-decisions.frozen.json')
    assert plan['base_hashes'] == PINS
    before = {c['candidate_id']: c for c in old['candidates']}
    after = {c['candidate_id']: c for c in bundle['candidates']}
    explicit = {x['candidate_id']: x for x in plan['source_decisions']}
    acted = {x[2] for x in EXPECTED}
    assert len(plan['source_decisions']) == len(acted) == 8 and set(explicit) == acted
    assert set(before) == set(after) and len(after) == 1417
    for key in ('baseline_bundle', 'decision_source', 'explicit_decisions', 'baseline_manifest'):
        item = manifest[key]
        assert checks.sha(delivery/item['frozen']) == item['sha256'] == checks.sha(Path(item['path'])), key
    for item in manifest['inherited_files']:
        assert checks.sha(delivery/item['frozen']) == item['sha256'] == checks.sha(Path(item['path']))
    assert checks.sha(delivery/'manual-decisions.effective.csv') == manifest['effective_decision_source']['sha256']
    for key in ('master_rows', 'master_row_aliases', 'original_master_rows', 'master_quality_issues', 'correction_events',
                'jst_confirmation_events', 'jst_confirmation_summary', 'batch_bs_not_created',
                'business_confirmation_events', 'unapplied_decisions'):
        assert bundle[key] == old[key], ('unapproved change', key)
    assert len(bundle['master_rows']) == 126
    assert sum(bool(m['ice_code']) for m in bundle['master_rows']) == 125
    assert len({m['ice_code'] for m in bundle['master_rows'] if m['ice_code']}) == 125
    assert Counter(c['source']['source_system'] for c in after.values()) == {'bigseller': 530, 'jushuitan': 887}
    inherited_auth = old['batch_target_authorizations']
    assert bundle['batch_target_authorizations'][:len(inherited_auth)] == inherited_auth
    new_auth = bundle['batch_target_authorizations'][len(inherited_auth):]
    assert len(new_auth) == 2 and {x['candidate_id'] for x in new_auth} == {'mc-44b8f0236d346bc7', 'mc-c8e6e17fc25361f1'}
    for item in new_auth:
        assert item['source'] == before[item['candidate_id']]['source'] and item['decision'] == 'confirm'
        assert item['target_row'] == 67 and item['target_ice'] == 'WM0073' and item['group'] == 'final_sample_record_only'
    for cid, c in after.items():
        assert c['source'] == before[cid]['source'], (cid, 'source / raw quantity changed')
        assert c['master_matches'] == before[cid]['master_matches'], (cid, 'rematched candidate evidence')
        if cid not in acted:
            assert c == before[cid], (cid, 'non-authorized candidate changed')
    original_selected = [c for c in before.values() if c['selected_master']]
    assert len(original_selected) == 545
    for c in original_selected:
        assert after[c['candidate_id']]['selected_master'] == c['selected_master'], (c['candidate_id'], 'original545 target')
        assert after[c['candidate_id']]['selected_jushuitan'] == c['selected_jushuitan'], (c['candidate_id'], 'original545 JST reference')
    masters = {m['row_index']: m for m in bundle['master_rows']}
    raw_sources = {}
    for e in explicit.values():
        source = e['source_file']
        key = (source['frozen'], source['sheet_name'])
        raw_sources.setdefault(key, set()).add(source['excel_row'])
    raw_sources = {key: xlsx_original_rows(base/key[0], key[1], rows) for key, rows in raw_sources.items()}
    comparisons = []
    for system, row, cid, sku, target, code, operation in EXPECTED:
        a, z, e = before[cid], after[cid], explicit[cid]
        assert a['source']['source_system'] == system and a['source']['external_sku_raw'] == sku
        assert e['source'] == a['source']
        assert e['source_file']['excel_row'] == row and e['source_file']['sheet_name'] == a['source']['sheet_name']
        assert checks.sha(base/e['source_file']['frozen']) == e['source_file']['sha256']
        raw = raw_sources[e['source_file']['frozen'], e['source_file']['sheet_name']][row]
        assert set(raw) == set(e['source_file']['raw_record'])
        for key, value in e['source_file']['raw_record'].items():
            if isinstance(value, (int, float)):
                assert Decimal(str(value)) == Decimal(raw[key]), (cid, 'frozen original numeric cell', key)
            else:
                assert (value or '') == raw[key], (cid, 'frozen original cell', key)
        assert e['target_row'] == target and e['target_ice'] == code and e['target_master'] == masters[target]
        assert e['reason'] and z['review_notes'] == e['reason']
        decision = 'ignore' if operation == 'ignore' else 'confirm'
        assert z['review_decision'] == e['decision'] == decision
        if system == 'jushuitan':
            assert a['source']['source_row_key'] == f'jushuitan:{row}:{sku}:{sku}'
            assert e['source_file']['file_name'] == '商品资料_20261015165159_200874071_1.xlsx'
            assert e['source_identity'] == ['jushuitan', sku, sku]
        else:
            assert a['source']['source_row_key'] == f'bigseller:单个SKU:{row}:{a["source"]["warehouse"]}:{sku}'
            assert e['source_identity'] == ['bigseller', a['source']['source_row_key']]
        if operation == 'version_reaffirmation':
            assert e['operation'] == operation
            assert z['selected_master'] == a['selected_master'] == masters[19] and z['review_state'] == 'manual_selected'
            assert z['batch_business_pending'] is None and a['batch_business_pending'] == old['batch_business_pending'][0]
            assert z['batch_version_confirmation'] and '升级' in json.dumps(z['batch_version_confirmation'], ensure_ascii=False)
            # Explicitly saving the user's reaffirmation fills previously blank
            # manual target metadata. It must name the unchanged effective target;
            # original blanks remain in the before_csv_records checked below.
            assert z['manual_master_row'] == str(a['selected_master']['row_index'])
            assert z['manual_master_ice'] == a['selected_master']['ice_code']
            assert z['validated_manual_target'] == a['selected_master']
            aa, zz = copy.deepcopy(a), copy.deepcopy(z)
            for key in ('review_notes', 'decision_records', 'previous_review', 'batch_business_pending', 'batch_version_confirmation',
                        'manual_master_row', 'manual_master_ice', 'validated_manual_target'):
                aa.pop(key, None); zz.pop(key, None)
            assert aa == zz, (cid, 'reaffirmation changed more than current version notes/history')
        elif operation == 'ignore':
            assert a['review_state'] == 'candidate' and z['review_state'] == 'ignored'
            assert z['selected_master'] is None and z['selected_jushuitan'] is None
            assert e['reason'] == '用户要求本批忽略'
        else:
            assert z['review_state'] == 'manual_selected' and z['selected_master'] == masters[target]
            if system == 'bigseller':
                assert a['review_decision'] == 'defer' and a['selected_master'] is None
                assert '泰国特供' in a['source']['external_name']
        comparisons.append({'candidate_id': cid, 'before': a, 'after': z, 'authorization': e})
    old_csv = checks.csv_rows(base/'manual-decisions.effective.csv')
    new_csv = checks.csv_rows(delivery/'manual-decisions.effective.csv')
    assert len(old_csv) == len(new_csv) == 3160
    lineage = {cid for acted_id in acted for cid in {acted_id, *before[acted_id].get('candidate_id_lineage', []),
               *(x['candidate_id'] for x in before[acted_id].get('decision_records', []))}}
    assert [r for r in old_csv if r['candidate_id'] not in lineage] == [r for r in new_csv if r['candidate_id'] not in lineage], 'unrelated CSV rows/order changed'
    by_csv = {r['candidate_id']: r for r in new_csv}
    assert len(by_csv) == len(new_csv)
    for cid in acted:
        assert by_csv[cid]['review_decision'] == explicit[cid]['decision'] and by_csv[cid]['review_notes'] == explicit[cid]['reason']
    events = bundle['final_confirmation_events']
    assert len(events) == len({e['decision_id'] for e in events}) == 8
    assert {e['explicit_decision']['candidate_id'] for e in events} == acted
    for event in events:
        cid = event['explicit_decision']['candidate_id']
        assert event['explicit_decision'] == explicit[cid]
        assert event['before_selected_master'] == before[cid]['selected_master']
        assert event['before_decision_records'] == before[cid]['decision_records']
        assert event['before_batch_business_pending'] == before[cid]['batch_business_pending']
        assert event['after_csv'] == by_csv[cid]
        assert all(r in old_csv for r in event['before_csv_records']) and event['before_csv_records']
    summary = checks.read(delivery/'final-confirmation-summary.json')
    assert summary == bundle['final_confirmation_summary']
    assert summary['recorded_source_decisions'] == 8 and summary['new_effective_selections'] == 3
    assert summary['reaffirmed_existing_selections'] == summary['current_confirmed_versions'] == 3
    assert summary['effective_ignores'] == 2 and summary['closed_specification_issues'] == 6 and summary['remaining_business_issues'] == 0
    assert set(summary['reaffirmed_candidate_ids']) == PH_VN
    assert set(summary['new_effective_candidate_ids']) == {x[2] for x in EXPECTED if x[-1] == 'confirm'}
    assert set(summary['ignored_candidate_ids']) == {x[2] for x in EXPECTED if x[-1] == 'ignore'}
    inherited = delivery/'inherited-baseline'
    assert {str(p.relative_to(base)): checks.sha(p) for p in base.rglob('*') if p.is_file()} == {str(p.relative_to(inherited)): checks.sha(p) for p in inherited.rglob('*') if p.is_file()}, 'entire approved baseline retained'
    assert bundle['batch_business_pending'] == [] and checks.read(delivery/'pending-business.json') == []
    pending_history = bundle['resolved_business_pending_history']
    assert old['batch_business_pending'][0] in [x['previous_pending'] for x in pending_history], 'original pending object retained in resolution history'
    resolutions = {x['ice_code']: x for x in bundle['batch_specification_resolutions']}
    assert set(resolutions) == {'WM0006', 'WM0008', *SPECS} and len(bundle['batch_specification_resolutions']) == 6
    assert bundle['batch_specification_resolutions'] == plan['specification_resolutions']
    for code in ('WM0006', 'WM0008'):
        assert resolutions[code]['status'] == 'closed_ignored_for_batch'
    for code, (row, selected_spec) in SPECS.items():
        r = resolutions[code]
        assert r['status'] == 'closed_master_column_c' and r['source_column'] == 'C' and r['selected_spec'] == selected_spec
        assert masters[row]['spec'] == selected_spec
    old_questions = checks.read(base/'coverage/audit-questions.json')
    for code, resolution in resolutions.items():
        assert resolution['previous_audit_question'] in old_questions
        assert code in json.dumps(resolution['previous_audit_question'], ensure_ascii=False)
        assert resolution['quantity_conversion_authorized'] is False
    old_details = {m['row_index']: m for m in old['master_provenance']}
    details = {m['row_index']: m for m in bundle['master_provenance']}
    brush = {x['ice_code']: x for x in bundle['batch_brush_preservation']}
    assert set(brush) == {'WM0081', 'brush'}
    for row, item in details.items():
        a, z = copy.deepcopy(old_details[row]), copy.deepcopy(item)
        a.pop('selected_source_ids'); z.pop('selected_source_ids')
        if item['ice_code'] in resolutions:
            assert z.pop('specification_resolution') == resolutions[item['ice_code']]
        if item['ice_code'] in brush:
            note = z.pop('brush_preservation')
            assert note == brush[item['ice_code']] and note['status'] == 'pending_confirmation'
            assert note['future_requirement']
        assert a == z, (row, 'master raw fields / spec / price / history must not change')
    assert details[62]['ice_code'] == 'WM0081' and details[107]['ice_code'] == 'brush'
    assert details[62]['selected_source_ids'] == details[107]['selected_source_ids'] == []
    for c in after.values():
        if c['source']['external_sku_raw'] == 'WM0081' and c['source']['source_system'] == 'jushuitan':
            assert c['review_state'] == 'candidate' and c['selected_master'] is None
    assert after['mc-eec4d01202d4a7de'] == before['mc-eec4d01202d4a7de'] and after['mc-eec4d01202d4a7de']['review_decision'] == 'ignore'
    for note in bundle['batch_bs_not_created']:
        assert note == next(x for x in old['batch_bs_not_created'] if x['ice_code'] == note['ice_code'])
    for original22 in checks.read(base/'current-original-22-comparison.json'):
        cid = original22['candidate_id']
        assert after[cid]['selected_master'] == before[cid]['selected_master']
        assert after[cid]['selected_jushuitan'] == before[cid]['selected_jushuitan']
        for key in ('manual_master_row', 'manual_master_ice', 'manual_jst_candidate_id', 'manual_jst_sku'):
            assert after[cid][key] == before[cid][key], (cid, key)
    selected = [c for c in after.values() if c['selected_master']]
    system_counts = Counter(c['source']['source_system'] for c in selected)
    assert len(selected) == 548 and system_counts == {'bigseller': 430, 'jushuitan': 118}
    states = Counter(c['review_state'] for c in after.values())
    assert states == {'manual_selected': 548, 'pending': 774, 'candidate': 1, 'ignored': 3, 'rejected': 3, 'outside_rules': 88}
    coverage_counts = Counter()
    for row in masters:
        systems = {c['source']['source_system'] for c in selected if c['selected_master']['row_index'] == row}
        coverage_counts['both' if len(systems) == 2 else next(iter(systems))+'_only' if systems else 'neither'] += 1
    assert coverage_counts == {'both': 114, 'bigseller_only': 2, 'jushuitan_only': 4, 'neither': 6}
    saved_comparison = checks.read(delivery/'final-source-comparison.json')
    assert len(saved_comparison) == 8 and {x['candidate_id'] for x in saved_comparison} == acted
    for item in saved_comparison:
        assert item['before'] == before[item['candidate_id']] and item['after'] == after[item['candidate_id']]
    reconstructed = copy.deepcopy(old)
    for change in checks.read(delivery/'all-field-changes.json'):
        parts = [part.replace('~1', '/').replace('~0', '~') for part in change['path'].strip('/').split('/')]
        parent = reconstructed
        for part in parts[:-1]:
            parent = parent[int(part)] if isinstance(parent, list) else parent[part]
        key = int(parts[-1]) if isinstance(parent, list) else parts[-1]
        if not change.get('after_present', True):
            del parent[key]
        else:
            parent[key] = change['after']
    assert reconstructed == bundle, 'complete saved field diff must reproduce final bundle'
    if coverage:
        rows = checks.read(coverage/'product-coverage.json')
        assert len(rows) == 126 and Counter(x['coverage_class'] for x in rows) == coverage_counts
        questions = checks.read(coverage/'audit-questions.json')
        assert len(questions) == 7 and all(q['status'].startswith('closed') for q in questions)
        assert sorted(q['previous_audit_question']['id'] for q in questions) == sorted(q['id'] for q in old_questions)
        assert [q['previous_audit_question'] for q in questions] == old_questions
        assert checks.read(coverage/'image-object-evidence.json')['summary']['content_verified_count'] == 0
        for name in PINS:
            assert checks.sha(coverage/'inputs'/name) == checks.sha(delivery/name)
    return {'status': 'verified', 'source_records_compared': 1417, 'masters_compared': 126,
            'original545_targets_and_jst_references_unchanged': True, 'original22_manual_references_unchanged': True,
            'authorized_sources_checked': 8, 'reaffirmed_existing_selections': 3, 'new_effective_selections': 3,
            'new_batch_ignores': 2, 'spec_audits_closed': 6, 'brush_records_distinct_unconfirmed': True,
            'selected_by_system': dict(system_counts), 'review_states': dict(states),
            'coverage_recomputed': dict(coverage_counts), 'all_saved_projections_consistent': True}, comparisons


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('delivery', type=Path)
    parser.add_argument('--coverage', type=Path)
    parser.add_argument('--comparison-output', type=Path)
    args = parser.parse_args()
    report, comparisons = verify(args.delivery.resolve(), args.coverage.resolve() if args.coverage else None)
    if args.comparison_output:
        with args.comparison_output.open('x', encoding='utf-8') as f:
            json.dump(comparisons, f, ensure_ascii=False, indent=2); f.write('\n')
    print(json.dumps(report, ensure_ascii=False, indent=2))
