"""Independent assertions for this P0-03 sample rework's saved artifacts."""
import csv
import hashlib
import io
import json
import re
import sys
from collections import Counter
from pathlib import Path


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8'))


def read_csv(path):
    return list(csv.DictReader(io.StringIO(path.read_text(encoding='utf-8-sig'))))


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify(root):
    outcome = read_json(root/'review-outcome.json')
    manifest = read_json(root/'input-manifest.json')
    assert sha(root/manifest['decision_source']['frozen']) == manifest['decision_source']['sha256']
    assert sha(Path(manifest['decision_source']['path'])) == manifest['decision_source']['sha256']
    for item in manifest['history_bundles']:
        assert sha(root/item['frozen']) == item['sha256'] == sha(Path(item['path']))
    for name, digest in manifest['base_evidence_hashes'].items():
        assert sha(Path(manifest['base_evidence'])/name) == digest, name
    inputs = manifest['inputs']
    for item in [inputs['master'], inputs['bigseller'], *inputs['jushuitan']['paths']]:
        assert sha(Path(item['path'])) == item['sha256']
    candidates = outcome['candidates']
    assert len(candidates) == 1417
    assert Counter(c['source']['source_system'] for c in candidates) == {'bigseller': 530, 'jushuitan': 887}
    assert len(outcome['master_rows']) == 132
    assert outcome['summary']['master_excel_data_rows'] == 217
    assert outcome['summary']['master_blank_rows_skipped'] == 85
    master = {m['row_index']: m for m in outcome['master_rows']}
    assert len(master) == 132
    assert sum(bool(m['ice_code']) for m in master.values()) == 131
    assert len({m['ice_code'] for m in master.values() if m['ice_code']}) == 125
    rows = read_json(root/'effective-review-records.json')
    by_id = {c['candidate_id']: c for c in candidates}
    assert len(rows) == len(by_id) == 1417
    assert Counter(r['review_state'] for r in rows) == outcome['review_summary']
    for r in rows:
        c = by_id[r['candidate_id']]
        assert r['review_state'] == c['review_state']
        assert r['review_decision'] == (c['review_decision'] or '')
        assert r['external_sku_raw'] == c['source']['external_sku_raw']
        assert r['warehouse'] == (c['source']['warehouse'] or '')
        m = c.get('selected_master')
        if m:
            assert c['review_state'] == 'manual_selected'
            assert master[m['row_index']] == m
            assert r['master_row_index'] == m['row_index']
            assert r['master_ice_code'] == m['ice_code']
        else:
            assert r['master_row_index'] == r['master_ice_code'] == ''
        assert not any(k.startswith('formal_mapping_') for k in c)
        reference = c.get('selected_jushuitan') or {}
        other = by_id.get(reference.get('candidate_id')) or {}
        if m and other.get('selected_master'):
            assert m['row_index'] == other['selected_master']['row_index']
    expected_csv = [{k: str(v) for k, v in r.items()} for r in rows]
    for name in ['manual-review.csv', 'review-decisions-export.csv']:
        assert read_csv(root/name) == expected_csv, name
    for name in ['match-review.html', 'bs-warehouse-overview.html']:
        page = (root/name).read_text(encoding='utf-8')
        payload = json.loads(re.search(r'<script id="review-data" type="application/json">(.*?)</script>', page, re.S)[1])
        expected = rows if name == 'match-review.html' else [r for r in rows if r['source_system'] == 'bigseller']
        assert payload['rows'] == expected
        assert re.findall(r'<tr data-id="([^"]+)"', page) == [r['candidate_id'] for r in expected]
        assert 'localStorage' not in page
    unified = read_json(root/'unified-view.json')
    assert unified['review_records'] == rows
    selected_ids = {c['candidate_id'] for c in candidates if c['selected_master']}
    unified_ids = [cid for r in unified['rows'] for cid in r['candidateIds']]
    assert len(unified_ids) == len(selected_ids)
    assert set(unified_ids) == selected_ids
    assert {r['candidate_id'] for r in read_csv(root/'matched-total-detail.csv')} == selected_ids
    for r in read_csv(root/'bs-warehouse-overview.csv'):
        members = [c for c in candidates if c['source']['source_system'] == 'bigseller' and c['source']['warehouse'] == r['warehouse']]
        assert int(r['source_rows']) == len(members)
        for state, n in Counter(c['review_state'] for c in members).items():
            assert int(r[state]) == n
    raw = {r['candidate_id']: r for r in read_csv(root/'manual-decisions.frozen.csv')}
    chosen = [r for r in raw.values() if r.get('manual_master_row')]
    assert len(chosen) == 22
    for r in chosen:
        c = by_id[r['candidate_id']]
        for key in ['manual_master_row', 'manual_master_ice', 'manual_jst_candidate_id', 'manual_jst_sku', 'review_notes']:
            assert c[key] == r[key]
        assert c['selected_master']['row_index'] == int(r['manual_master_row'])
        assert c['selected_master']['ice_code'] == r['manual_master_ice']
        assert c['selected_jushuitan']['source']['external_sku_raw'] == r['manual_jst_sku']
    wrong = by_id['mc-994fa1007b50d5be']
    assert wrong['selected_master'] is None and wrong['review_state'] == 'pending'
    assert wrong['review_decision'] == raw[wrong['candidate_id']]['review_decision']
    assert wrong['historical_correction_reason']
    event = outcome['correction_events'][0]
    assert event['previous_candidates'][0]['ice_code'] == 'WM0093'
    assert event['original_decision'][0]['review_decision'] == 'confirm'
    assert event['replacement'] is None
    original = read_json(root/'original-match-bundle.frozen.json')
    if original.get('correction_events'):
        assert outcome['correction_events'] == original['correction_events']
    return {'status': 'verified', 'rows_compared': len(rows), 'manual_selections_restored': len(chosen),
            'wrong_link_revoked': True, 'review_summary': outcome['review_summary'],
            'original_files_hashes_unchanged': True}


if __name__ == '__main__':
    print(json.dumps(verify(Path(sys.argv[1]).resolve()), ensure_ascii=False, indent=2))
