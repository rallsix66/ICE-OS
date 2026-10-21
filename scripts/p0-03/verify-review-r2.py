"""Inject review-only negatives into copies; never edit the original CSV."""
import csv
import hashlib
import io
import json
import os
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path


def load(path):
    return json.loads(path.read_text(encoding='utf-8'))


def csv_rows(path):
    return list(csv.DictReader(io.StringIO(path.read_text(encoding='utf-8-sig'))))


def verify_outputs(folder):
    outcome = load(folder/'review-outcome.json')
    rows = load(folder/'effective-review-records.json')
    by_id = {c['candidate_id']: c for c in outcome['candidates']}
    assert len(rows) == len(by_id) == 1417
    assert outcome['review_summary'] == dict(Counter(r['review_state'] for r in rows))
    for r in rows:
        c = by_id[r['candidate_id']]
        assert r['review_decision'] == (c['review_decision'] or '')
        assert r['review_state'] == c['review_state']
        assert r['review_reason'] == c['review_reason']
        assert r['master_row_index'] == (c.get('selected_master') or {}).get('row_index', '')
        assert r['historical_correction_reason'] == c['historical_correction_reason']
        assert json.loads(r['manual_jushuitan_conflict']) == c.get('manual_jushuitan_conflict')
        for k in ('manual_master_row', 'manual_master_ice', 'manual_jst_candidate_id', 'manual_jst_sku', 'review_notes'):
            assert r[k] == c[k]
    expected = [{k: str(v) for k, v in r.items()} for r in rows]
    for name, subset in [('manual-review.csv', expected), ('review-decisions-export.csv', expected),
                         ('matched-total-detail.csv', [r for r in expected if r['review_state'] == 'manual_selected']),
                         ('pending-user-review.csv', [r for r in expected if r['review_state'] in ('pending', 'candidate')]),
                         ('manual-selections-restored.csv', [r for r in expected if r['manual_master_row']]),
                         ('outside-rules.csv', [r for r in expected if r['review_state'] == 'outside_rules'])]:
        assert csv_rows(folder/name) == subset, name
    assert load(folder/'match-bundle.json') == outcome
    assert load(folder/'correction-events.json') == outcome['correction_events']
    for name in ('match-review.html', 'bs-warehouse-overview.html'):
        page = (folder/name).read_text(encoding='utf-8')
        payload = json.loads(re.search(r'<script id="review-data" type="application/json">(.*?)</script>', page, re.S)[1])
        subset = rows if name == 'match-review.html' else [r for r in rows if r['source_system'] == 'bigseller']
        assert payload['rows'] == subset
        assert re.findall(r'<tr data-id="([^"]+)"', page) == [r['candidate_id'] for r in subset]
    selected = {c['candidate_id'] for c in by_id.values() if c['selected_master']}
    unified = load(folder/'unified-view.json')
    assert unified['review_records'] == rows
    assert {cid for u in unified['rows'] for cid in u['candidateIds']} == selected
    assert {cid for r in csv_rows(folder/'matched-total-by-master.csv') for cid in r['candidate_ids'].split(';')} == selected
    for wh in csv_rows(folder/'bs-warehouse-overview.csv'):
        members = [r for r in rows if r['source_system'] == 'bigseller' and r['warehouse'] == wh['warehouse']]
        assert int(wh['source_rows']) == len(members)
        for state in ('candidate', 'manual_selected', 'pending', 'rejected', 'ignored', 'outside_rules'):
            assert int(wh[state]) == sum(r['review_state'] == state for r in members)
    return by_id


def main():
    repo = Path(__file__).resolve().parents[2]
    delivery, output = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
    output.mkdir(parents=True, exist_ok=False)
    (output/'README.txt').write_text('Negative test fixtures only. These CSV copies/results are not business decisions. Authoritative delivery is separate.\n', encoding='utf-8')
    original = delivery/'manual-decisions.frozen.csv'
    digest = hashlib.sha256(original.read_bytes()).hexdigest()
    baseline = load(delivery/'review-outcome.json')
    reports = []
    for case in ('reject', 'ignore', 'clear', 'defer', 'jst-master-conflict'):
        root = output/case
        root.mkdir()
        rows = csv_rows(original)
        if case == 'jst-master-conflict':
            row = next(r for r in rows if r['candidate_id'] == 'mc-4dab89199dfcee96')
            row.update(manual_jst_candidate_id='mc-da6bb0fcaa0d5c49', manual_jst_sku='WM0048')
        else:
            row = next(r for r in rows if r['candidate_id'] == 'mc-994fa1007b50d5be')
            row.update(review_decision=case, review_notes='Injected negative test: '+case)
        fixture = root/'injected-decisions.csv'
        with fixture.open('w', encoding='utf-8-sig', newline='') as f:
            writer = csv.DictWriter(f, fieldnames=list(rows[0]))
            writer.writeheader()
            writer.writerows(rows)
        command = [sys.executable, '-m', 'p0_03_match', 'apply-review', '--bundle', str(delivery/'review-outcome.json'), '--review-csv', str(fixture), '--output', str(root/'output/review-outcome.json')]
        result = subprocess.run(command, cwd=repo/'tools', capture_output=True, text=True, encoding='utf-8', env={**os.environ, 'PYTHONUTF8': '1', 'PYTHONDONTWRITEBYTECODE': '1'})
        (root/'cli.log').write_text(result.stdout+result.stderr, encoding='utf-8')
        assert result.returncode == 0, result.stderr
        by_id = verify_outputs(root/'output')
        assert load(root/'output/correction-events.json') == baseline['correction_events']
        if case == 'jst-master-conflict':
            c = by_id['mc-4dab89199dfcee96']
            assert c['review_state'] == 'pending' and c['selected_master'] is None
            assert c['manual_master_row'] == '45' and c['manual_master_ice'] == 'WM0047'
            assert c['manual_jst_candidate_id'] == row['manual_jst_candidate_id'] and c['manual_jst_sku'] == 'WM0048'
            assert c['manual_jushuitan_conflict']['selected_master_row'] == 45
            assert c['manual_jushuitan_conflict']['jst_selected_master_row'] == 46
            assert by_id['mc-da6bb0fcaa0d5c49']['selected_master']['row_index'] == 46
        else:
            c = by_id['mc-994fa1007b50d5be']
            assert c['review_decision'] == case and c['selected_master'] is None
            assert c['review_state'] == {'reject': 'rejected', 'ignore': 'ignored', 'clear': 'pending', 'defer': 'pending'}[case]
            assert c['review_reason'] == {'reject': 'reviewer_rejected', 'ignore': 'reviewer_ignored', 'clear': 'cleared', 'defer': 'deferred'}[case]
        reports.append({'case': case, 'fixture_only': True, 'rows_compared': len(by_id), 'argv': command, 'exit_code': result.returncode, 'frozen_fixture_sha256': hashlib.sha256(fixture.read_bytes()).hexdigest()})
    assert hashlib.sha256(original.read_bytes()).hexdigest() == digest
    report = {'status': 'verified', 'original_csv_unchanged': True, 'cases': reports, 'exit_code': 0}
    (output/'negative-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'status': 'verified', 'cases': len(reports), 'rows_per_case': 1417, 'original_csv_unchanged': True, 'exit_code': 0}))


if __name__ == '__main__':
    main()
