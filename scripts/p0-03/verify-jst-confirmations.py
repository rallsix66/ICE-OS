"""Independent saved-output proof for the explicit 11 JST confirmations + ignore.

Does not import the matcher or the decision implementation. Expected identities
come from the user-authorized table and are checked against pinned baseline and
frozen OOXML, then every saved projection is checked by the existing verifier.
"""
from __future__ import annotations

import argparse
import copy
import importlib.util
import json
import re
from collections import Counter
from pathlib import Path
from xml.etree import ElementTree as ET
from zipfile import ZipFile

spec = importlib.util.spec_from_file_location('saved_projection_checks', Path(__file__).with_name('verify-curation-evidence.py'))
checks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checks)

PINS = {'match-bundle.json': 'c0fa4bc9814080a9e78d15ad7136276e03156254d67a3fe59e4d49c841e80936',
        'manual-decisions.effective.csv': 'a66c564942220f5df4e1043ab2b076f1cec26c3056fa8dffd5a2e2733844b58f'}
EXPECTED = [
    ('WM0069', 796, 213, 'mc-f713998ca2c722a8'), ('WM0070', 797, 214, 'mc-151a8acf447c6aff'),
    ('WM0071', 798, 215, 'mc-4ce480743171808b'), ('WM0072', 799, 66, 'mc-fd977bdb831a5b5b'),
    ('WM0073', 800, 67, 'mc-6148a4d4e40a80ba'), ('WM0082', 809, 84, 'mc-26aa4e763d422095'),
    ('WM0092', 819, 212, 'mc-30c30b04c4ff9e0d'), ('WM0095', 822, 115, 'mc-6f83255696c02117'),
    ('WM0117', 844, 108, 'mc-a4a549dc9518a3d4'), ('WM0128', 855, 116, 'mc-c3d22fb31a28db96'),
    ('WM0129', 856, 123, 'mc-215172d1fdd95149'), ('WM0007', 744, 15, 'mc-eec4d01202d4a7de'),
]
NS = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
PH_VN = {'mc-e1b56fb81b0db46c', 'mc-73ac4812d7d8de64', 'mc-b7bd376e964738cd'}


def frozen_sheet(path, wanted):
    with ZipFile(path) as z:
        strings = [''.join(x.itertext()) for x in ET.fromstring(z.read('xl/sharedStrings.xml'))] if 'xl/sharedStrings.xml' in z.namelist() else []
        sheet = next(x for x in ET.fromstring(z.read('xl/workbook.xml')).findall('s:sheets/s:sheet', NS) if x.attrib['name'] == 'Sheet1')
        rid = sheet.attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id']
        rel = next(x for x in ET.fromstring(z.read('xl/_rels/workbook.xml.rels')) if x.attrib['Id'] == rid)
        member = rel.attrib['Target'].lstrip('/') if rel.attrib['Target'].startswith('/') else 'xl/'+rel.attrib['Target']
        result = {}
        for row in ET.fromstring(z.read(member)).findall('s:sheetData/s:row', NS):
            n = int(row.attrib['r'])
            if n not in wanted:
                continue
            data = {}
            for cell in row.findall('s:c', NS):
                v = cell.find('s:v', NS)
                value = v.text if v is not None else ''
                if cell.attrib.get('t') == 's':
                    value = strings[int(value)]
                elif cell.attrib.get('t') == 'inlineStr':
                    value = ''.join(cell.find('s:is', NS).itertext())
                data[re.sub(r'\d+$', '', cell.attrib['r'])] = value or ''
            result[n] = data
        return result


def verify(delivery, coverage=None):
    b = checks.verify_outputs(delivery)
    manifest = checks.read(delivery/'input-manifest.json')
    base = Path(manifest['base_evidence'])
    for name, digest in PINS.items():
        assert checks.sha(base/name) == digest, ('pinned approved input', name)
    old = checks.read(base/'match-bundle.json')
    before = {c['candidate_id']: c for c in old['candidates']}
    after = {c['candidate_id']: c for c in b['candidates']}
    acted = {x[3] for x in EXPECTED}
    assert set(before) == set(after) and len(after) == 1417
    assert Counter(c['source']['source_system'] for c in after.values()) == {'bigseller': 530, 'jushuitan': 887}
    assert b['master_rows'] == old['master_rows'] and len(b['master_rows']) == 126
    assert len([m for m in b['master_rows'] if m['ice_code']]) == len({m['ice_code'] for m in b['master_rows'] if m['ice_code']}) == 125
    for key in ('original_master_rows', 'master_row_aliases', 'master_quality_issues', 'batch_target_authorizations', 'correction_events',
                'batch_business_pending', 'business_confirmation_events', 'business_confirmation_summary', 'unapplied_decisions'):
        assert b[key] == old[key], ('preserved bundle field', key)
    for cid, c in after.items():
        assert c['source'] == before[cid]['source'], (cid, 'source identity / quantities')
        assert c['master_matches'] == before[cid]['master_matches'], (cid, 'candidate evidence')
        if cid not in acted:
            assert c == before[cid], (cid, 'unapproved candidate change')
    original_selected = [c for c in before.values() if c['selected_master']]
    assert len(original_selected) == 534
    for c in original_selected:
        assert after[c['candidate_id']] == c, ('entire original534 record', c['candidate_id'])
    plan = checks.read(delivery/'jst-decisions.frozen.json')
    assert plan['base_hashes'] == PINS
    for key in ('baseline_bundle', 'decision_source', 'explicit_decisions', 'baseline_manifest'):
        item = manifest[key]
        assert checks.sha(delivery/item['frozen']) == item['sha256'] == checks.sha(Path(item['path'])), ('frozen input', key)
    for item in manifest['inherited_files']:
        assert checks.sha(delivery/item['frozen']) == item['sha256'] == checks.sha(Path(item['path']))
    assert checks.sha(delivery/'manual-decisions.effective.csv') == manifest['effective_decision_source']['sha256']
    explicit = {x['candidate_id']: x for x in plan['source_decisions']}
    assert set(explicit) == acted and len(plan['source_decisions']) == 12
    events = b['jst_confirmation_events']
    assert len(events) == 12 and {e['explicit_decision']['candidate_id'] for e in events} == acted
    event_by_id = {e['explicit_decision']['candidate_id']: e for e in events}
    summary = checks.read(delivery/'jst-confirmation-summary.json')
    assert summary == b['jst_confirmation_summary']
    assert summary['recorded_source_decisions'] == 12 and summary['new_effective_selections'] == 11 and summary['effective_ignores'] == 1
    assert set(summary['new_effective_candidate_ids']) == {x[3] for x in EXPECTED if x[0] != 'WM0007'}
    assert summary['ignored_candidate_ids'] == ['mc-eec4d01202d4a7de']
    assert summary['bs_not_created_product_codes'] == ['WM0070', 'WM0072']
    raw = frozen_sheet(base/'input-2.frozen.xlsx', {x[1] for x in EXPECTED})
    masters = {m['row_index']: m for m in b['master_rows']}
    comparison = []
    for code, row, target, cid in EXPECTED:
        a, z, e = before[cid], after[cid], explicit[cid]
        assert a['review_state'] == 'candidate' and a['selected_master'] is None
        assert a['source']['source_row_key'] == f'jushuitan:{row}:{code}:{code}'
        assert a['source']['source_system'] == 'jushuitan' and a['source']['sheet_name'] == 'Sheet1' and a['source']['warehouse'] is None
        assert a['source']['external_sku_raw'] == code and a['source']['extra']['style_code'] == a['source']['extra']['product_code'] == code
        assert raw[row]['B'] == raw[row]['C'] == code and raw[row]['D'] == a['source']['external_name']
        assert masters[target]['ice_code'] == code and e['target_row'] == target and e['target_ice'] == code
        assert e['source_identity'] == ['jushuitan', code, code]
        assert e['target_master'] == masters[target]
        assert e['source'] == a['source']
        assert e['source_file']['file_name'] == '商品资料_20261015165159_200874071_1.xlsx'
        assert e['source_file']['sheet_name'] == 'Sheet1' and e['source_file']['excel_row'] == row
        assert checks.sha(base/e['source_file']['frozen']) == e['source_file']['sha256']
        decision = 'ignore' if code == 'WM0007' else 'confirm'
        assert e['decision'] == z['review_decision'] == decision
        assert z['review_notes'] == e['reason'] and e['reason']
        assert event_by_id[cid]['explicit_decision'] == e
        if decision == 'confirm':
            assert z['review_state'] == 'manual_selected' and z['selected_master'] == masters[target]
            assert z['manual_master_row'] == str(target) and z['manual_master_ice'] == code
        else:
            assert z['review_state'] == 'ignored' and z['selected_master'] is None and z['selected_jushuitan'] is None
            assert '不再经营' in e['reason'] or '不经营' in e['reason']
        comparison.append({'ice_code': code, 'source_excel_row': row, 'target_master_row': target, 'candidate_id': cid,
                           'before': a, 'after': z, 'authorized_decision': e})
    saved_comparison = checks.read(delivery/'twelve-source-comparison.json')
    assert len(saved_comparison) == 12 and {x['candidate_id'] for x in saved_comparison} == acted
    for item in saved_comparison:
        cid = item['candidate_id']
        assert item['before'] == before[cid] and item['after'] == after[cid] and item['reason'] == explicit[cid]['reason']
    assert checks.read(delivery/'current-jst-decision-audit.json') == events
    full_changes = checks.read(delivery/'all-field-changes.json')
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
    assert reconstructed == b, 'saved full diff must reconstruct final bundle'
    old_csv = {r['candidate_id']: r for r in checks.csv_rows(base/'manual-decisions.effective.csv')}
    new_csv = {r['candidate_id']: r for r in checks.csv_rows(delivery/'manual-decisions.effective.csv')}
    removed = set(old_csv)-set(new_csv)
    authorized_lineage = {cid for x in acted for cid in {x, *before[x].get('candidate_id_lineage', [])}}
    assert removed <= authorized_lineage
    for cid in set(old_csv) & set(new_csv) - authorized_lineage:
        assert old_csv[cid] == new_csv[cid], ('unapproved CSV change', cid)
    for _, _, _, cid in EXPECTED:
        assert new_csv[cid]['review_decision'] == explicit[cid]['decision'] and new_csv[cid]['review_notes'] == explicit[cid]['reason']
    for name in ('original-22-comparison.json', 'manual-decisions.original.frozen.csv', 'explicit-correction-audit.json',
                 'business-corrections.frozen.json', 'master-row-lineage.json', 'source-formulas-and-errors.json',
                 'input-0.frozen.xlsx', 'input-1.frozen.xlsx', 'input-2.frozen.xlsx', 'input-3.frozen.xlsx'):
        assert checks.sha(delivery/name) == checks.sha(base/name), ('inherited artifact', name)
    original22 = checks.read(base/'current-original-22-comparison.json')
    assert len(original22) == 22
    for item in original22:
        assert after[item['candidate_id']] == before[item['candidate_id']]
    old_details = {m['row_index']: m for m in old['master_provenance']}
    details = {m['row_index']: m for m in b['master_provenance']}
    notes = {x['ice_code']: x for x in b['batch_bs_not_created']}
    assert set(notes) == {'WM0070', 'WM0072'} and b['batch_bs_not_created'] == plan['bs_not_created']
    for row, m in details.items():
        a, z = copy.deepcopy(old_details[row]), copy.deepcopy(m)
        a.pop('selected_source_ids'); z.pop('selected_source_ids')
        if m['ice_code'] in notes:
            note = z.pop('bs_creation_status')
            assert note == notes[m['ice_code']] and note['master_row'] == row and note['source_system'] == 'bigseller'
            assert note['status'] == 'user_confirmed_not_created' and note['reason'] and note['basis']
            assert all(c['source']['source_system'] != 'bigseller' for c in after.values() if c.get('selected_master', {}) and c['selected_master']['row_index'] == row)
        assert a == z, (row, 'product/price/source history changed')
    price = details[66]
    assert price['data']['成本价格'] == '5.18' and price['data']['运营价格'] == '5.68' and price['price_pending'] is False
    assert price['current_price_selection']['source_row'] == 216
    assert [(x['cost'], x['operating_price']) for x in price['price_versions']] == [('5', '5.5'), ('5.18', '5.68')]
    assert set(b['batch_business_pending'][0]['candidate_ids']) == PH_VN and len(b['batch_business_pending']) == 1
    for cid in PH_VN:
        assert after[cid] == before[cid] and after[cid]['selected_master']['ice_code'] == 'WM0012'
    selected = [c for c in after.values() if c['selected_master']]
    selected_systems = Counter(c['source']['source_system'] for c in selected)
    assert selected_systems == {'bigseller': 428, 'jushuitan': 117} and len(selected) == 545
    state_counts = Counter(c['review_state'] for c in after.values())
    assert state_counts == {'manual_selected': 545, 'outside_rules': 88, 'pending': 776, 'rejected': 3, 'candidate': 4, 'ignored': 1}
    coverage_counts = Counter()
    for row in masters:
        systems = {c['source']['source_system'] for c in selected if c['selected_master']['row_index'] == row}
        key = 'both' if len(systems) == 2 else next(iter(systems))+'_only' if systems else 'neither'
        coverage_counts[key] += 1
    assert coverage_counts == {'both': 113, 'bigseller_only': 3, 'jushuitan_only': 4, 'neither': 6}
    if coverage:
        coverage_rows = checks.read(coverage/'product-coverage.json')
        assert len(coverage_rows) == 126
        assert Counter(x['coverage_class'] for x in coverage_rows) == coverage_counts
        assert len(checks.read(coverage/'audit-questions.json')) == 7
        assert checks.read(coverage/'image-object-evidence.json')['summary']['content_verified_count'] == 0
        # Complete independent audit verifier is run separately, including all
        # image/spec mutation tests. This proof ties its exact inputs to delivery.
        for name in PINS:
            assert checks.sha(coverage/'inputs'/name) == checks.sha(delivery/name)
    return {'status': 'verified', 'source_records_compared': len(after), 'masters_compared': len(masters),
            'original534_full_records_unchanged': True, 'original22_full_records_unchanged': True,
            'twelve_authorized_sources_checked_against_frozen_xlsx': True, 'bs_not_created_only_explanations': True,
            'selected_by_source': dict(selected_systems), 'review_states': dict(state_counts),
            'coverage_classes_recomputed': dict(coverage_counts), 'all_saved_projections_consistent': True}, comparison


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('delivery', type=Path)
    parser.add_argument('--coverage', type=Path)
    parser.add_argument('--comparison-output', type=Path)
    args = parser.parse_args()
    report, comparison = verify(args.delivery.resolve(), args.coverage.resolve() if args.coverage else None)
    if args.comparison_output:
        with args.comparison_output.open('x', encoding='utf-8') as f:
            json.dump(comparison, f, ensure_ascii=False, indent=2); f.write('\n')
    print(json.dumps(report, ensure_ascii=False, indent=2))
