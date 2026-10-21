"""Independently check frozen inputs and every saved projection of this batch."""
import csv
import hashlib
import json
import re
import sys
from collections import Counter
from pathlib import Path


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def csv_rows(path):
    with path.open(encoding='utf-8-sig', newline='') as f:
        return list(csv.DictReader(f))


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify_outputs(root):
    b = read(root/'review-outcome.json')
    rows = read(root/'effective-review-records.json')
    assert read(root/'match-bundle.json') == b
    by_id = {c['candidate_id']: c for c in b['candidates']}
    assert len(rows) == len(by_id) == 1417
    assert Counter(r['source_system'] for r in rows) == {'bigseller': 530, 'jushuitan': 887}
    assert Counter(r['review_state'] for r in rows) == b['review_summary']
    masters = {m['row_index']: m for m in b['master_rows']}
    assert len(masters) == 126
    for r in rows:
        c = by_id[r['candidate_id']]
        assert r['review_decision'] == (c['review_decision'] or '')
        assert r['review_state'] == c['review_state']
        assert r['review_notes'] == c['review_notes']
        assert r['external_sku_raw'] == c['source']['external_sku_raw']
        m = c['selected_master']
        assert (r['master_row_index'], r['master_ice_code']) == ((m['row_index'], m['ice_code']) if m else ('', ''))
        if m:
            assert m == masters[m['row_index']]
            assert c['review_state'] == 'manual_selected'
            j = by_id.get((c['selected_jushuitan'] or {}).get('candidate_id'))
            if j and j['selected_master']:
                assert j['selected_master']['row_index'] == m['row_index']
        else:
            assert not c['selected_jushuitan']
        assert not any(k.startswith('formal_mapping_') for k in c)
    csv_expected = [{k: str(v) for k, v in r.items()} for r in rows]
    for name, expected in [('manual-review.csv', csv_expected), ('review-decisions-export.csv', csv_expected),
                           ('matched-total-detail.csv', [r for r in csv_expected if r['review_state'] == 'manual_selected']),
                           ('pending-user-review.csv', [r for r in csv_expected if r['review_state'] in ('pending', 'candidate')]),
                           ('manual-selections-restored.csv', [r for r in csv_expected if r['manual_master_row']]),
                           ('outside-rules.csv', [r for r in csv_expected if r['review_state'] == 'outside_rules'])]:
        assert csv_rows(root/name) == expected, name
    for name in ('match-review.html', 'bs-warehouse-overview.html'):
        page = (root/name).read_text(encoding='utf-8')
        payload = json.loads(re.search(r'<script id="review-data" type="application/json">(.*?)</script>', page, re.S)[1])
        expected = rows if name == 'match-review.html' else [r for r in rows if r['source_system'] == 'bigseller']
        assert payload['rows'] == expected
        assert payload['summary'] == Counter(r['review_state'] for r in expected)
        assert re.findall(r'<tr data-id="([^"]+)"', page) == [r['candidate_id'] for r in expected]
    unified = read(root/'unified-view.json')
    assert unified['review_records'] == rows
    selected = {c['candidate_id'] for c in by_id.values() if c['selected_master']}
    ids = [cid for r in unified['rows'] for cid in r['candidateIds']]
    assert len(ids) == len(selected) and set(ids) == selected
    groups = csv_rows(root/'matched-total-by-master.csv')
    assert {cid for g in groups for cid in g['candidate_ids'].split(';')} == selected
    for g in groups:
        members = [r for r in rows if str(r['master_row_index']) == g['master_row_index']]
        assert int(g['selected_source_rows']) == len(members)
        assert g['master_ice_code'] == masters[int(g['master_row_index'])]['ice_code']
    for w in csv_rows(root/'bs-warehouse-overview.csv'):
        members = [r for r in rows if r['source_system'] == 'bigseller' and r['warehouse'] == w['warehouse']]
        assert int(w['source_rows']) == len(members)
        for state, n in Counter(r['review_state'] for r in members).items():
            assert int(w[state]) == n
    overview = read(root/'master-overview.json')
    assert b['master_provenance'] == overview
    assert len(overview) == 126
    payload = json.loads(re.search(r'<script id="master-data" type="application/json">(.*?)</script>', (root/'master-overview.html').read_text(encoding='utf-8'), re.S)[1])
    assert payload == overview
    overview_csv = {int(r['row_index']): r for r in csv_rows(root/'master-overview.csv')}
    for m in overview:
        r = overview_csv[m['row_index']]
        assert {k: m[k] for k in masters[m['row_index']]} == masters[m['row_index']]
        assert m['selected_source_ids'] == [c['candidate_id'] for c in by_id.values() if c['selected_master'] and c['selected_master']['row_index'] == m['row_index']]
        for k, v in m['data'].items():
            assert r[k] == ('' if v is None else str(v)), (m['row_index'], k)
        for k in ('source_rows', 'price_versions', 'selected_source_ids'):
            assert json.loads(r[k]) == m[k]
    return b


def verify(root):
    b = verify_outputs(root)
    manifest = read(root/'input-manifest.json')
    old = read(root/'original-match-bundle.frozen.json')
    old_ids = {c['candidate_id']: c for c in old['candidates']}
    by_id = {c['candidate_id']: c for c in b['candidates']}
    assert set(old_ids) == set(by_id)
    for key in ('decision_source', 'explicit_corrections'):
        item = manifest[key]
        assert sha(root/item['frozen']) == item['sha256'] == sha(Path(item['path']))
    e = manifest['effective_decision_source']
    assert sha(root/e['frozen']) == e['sha256']
    for item in [manifest['inputs']['master'], manifest['inputs']['bigseller'], *manifest['inputs']['jushuitan']['paths']]:
        assert sha(root/item['frozen']) == item['sha256'] == sha(Path(item['path']))
    for item in manifest['history_bundles']:
        assert sha(root/item['frozen']) == item['sha256'] == sha(Path(item['path']))
    for name, digest in manifest['base_evidence_hashes'].items():
        assert sha(Path(manifest['base_evidence'])/name) == digest
    assert b['correction_events'] == old['correction_events']
    assert b['summary']['master_excel_data_rows'] == 217
    assert b['summary']['master_blank_rows_skipped'] == 85
    assert b['summary']['original_master_nonempty_rows'] == 132
    assert b['summary']['original_nonempty_ice_rows'] == 131
    assert b['summary']['original_distinct_nonempty_ice'] == 125
    assert len(b['master_rows']) == 126
    assert sum(bool(m['ice_code']) for m in b['master_rows']) == 125
    assert len({m['ice_code'] for m in b['master_rows'] if m['ice_code']}) == 125
    plan = read(root/'business-corrections.frozen.json')
    audit = read(root/'explicit-correction-audit.json')
    assert len(audit) == len(plan['source_corrections']) == 27
    for a in audit:
        correction = a['correction']; c = by_id[correction['candidate_id']]
        assert c['source'] == correction['source']
        assert c['review_decision'] == correction['decision']
        if correction['decision'] == 'confirm':
            assert c['selected_master']['row_index'] == correction['target_row']
            assert c['selected_master']['ice_code'] == correction['target_ice']
        else:
            assert c['review_state'] == 'pending' and c['selected_master'] is None
    conflicts = [a for a in audit if a['correction']['group'] == 'ten-id-conflicts']
    assert len(conflicts) == 10
    assert sum(a['correction']['decision'] == 'confirm' for a in conflicts) == 8
    for a in conflicts:
        assert {r['review_decision'] for r in a['original_csv_records']} == {'', 'confirm'}
    raw22 = [r for r in csv_rows(root/'manual-decisions.original.frozen.csv') if r.get('manual_master_row')]
    assert len(raw22) == 22
    for r in raw22:
        before, c = old_ids[r['candidate_id']], by_id[r['candidate_id']]
        for k in ('manual_master_row', 'manual_master_ice', 'manual_jst_candidate_id', 'manual_jst_sku', 'review_notes', 'selected_master', 'selected_jushuitan', 'review_decision', 'review_state'):
            assert before[k] == c[k], (r['candidate_id'], k)
    for c in b['candidates']:
        previous = old_ids[c['candidate_id']]
        if previous['review_decision'] in ('reject', 'ignore', 'defer'):
            assert c['review_decision'] == previous['review_decision']
            assert c['selected_master'] is None
        if previous['review_state'] == 'outside_rules':
            assert c['review_state'] == 'outside_rules' and c['selected_master'] is None
    assert len(plan['pending_business']) == 5
    for pending in plan['pending_business']:
        for cid in pending['candidate_ids']:
            assert by_id[cid]['selected_master'] == old_ids[cid]['selected_master']
            assert by_id[cid]['review_decision'] == old_ids[cid]['review_decision']
            assert by_id[cid]['batch_business_pending'] == pending
    eye = next(c for c in b['candidates'] if c['source']['source_system'] == 'jushuitan' and c['source']['external_sku_raw'] == 'WM10012')
    assert eye['review_state'] == 'candidate' and eye['review_decision'] is None
    assert [m['row_index'] for m in eye['master_matches']] == [39]
    stick = next(c for c in b['candidates'] if c['source']['source_system'] == 'jushuitan' and c['source']['external_sku_raw'] == 'WM10013')
    assert stick['selected_master']['row_index'] == 18 and stick['review_decision'] == 'confirm'
    details = {m['row_index']: m for m in read(root/'master-overview.json')}
    assert details[66]['price_pending']
    assert details[66]['data']['成本价格'] is None and details[66]['data']['运营价格'] is None
    assert [(p['cost'], p['operating_price']) for p in details[66]['price_versions']] == [('5', '5.5'), ('5.18', '5.68')]
    assert details[28]['barcode'] == '757577407076' and details[28]['source_records'][0]['data']['69商品编码'] == 'ICEWM0039'
    assert details[116]['ice_code'] == 'WM0128' and details[116]['source_records'][0]['data']['聚水潭内部货号'] == 'WM00128'
    assert details[122]['ice_code'] == details[122]['barcode'] == ''
    assert details[29]['ice_code'] == 'WM0040'
    assert details[62]['ice_code'] == 'WM0081' and details[107]['ice_code'] == 'brush'
    assert len([n for m in details.values() for n in m['source_rows']]) == 132
    assert len(set(n for m in details.values() for n in m['source_rows'])) == 132
    actual_changes = {cid for cid, c in by_id.items() if any(c.get(k) != old_ids[cid].get(k) for k in ('review_state', 'review_decision', 'selected_master', 'selected_jushuitan', 'master_matches', 'validation_errors'))}
    saved_changes = read(root/'all-correspondence-changes.json')
    assert {c['candidate_id'] for c in saved_changes} == actual_changes
    return {'status': 'verified', 'source_rows': 1417, 'master_rows': 126, 'original_22_unchanged': True,
            'id_conflicts_confirmed': 8, 'id_conflicts_deferred': 2, 'changed_records': len(actual_changes),
            'all_outputs_consistent': True, 'review_summary': b['review_summary']}


if __name__ == '__main__':
    print(json.dumps(verify(Path(sys.argv[1]).resolve()), ensure_ascii=False, indent=2))
