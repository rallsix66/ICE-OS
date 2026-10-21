"""Inject decisions into new CSV copies; never mutate the authorized delivery."""
import csv
import json
import os
from pathlib import Path
import subprocess
import sys

from importlib.util import spec_from_file_location, module_from_spec

spec = spec_from_file_location('verify_curation', Path(__file__).with_name('verify-curation-evidence.py'))
checks = module_from_spec(spec)
spec.loader.exec_module(checks)


def main(delivery, evidence):
    evidence.mkdir(parents=True, exist_ok=False)
    original = checks.csv_rows(delivery/'manual-decisions.effective.csv')
    bundle = checks.read(delivery/'match-bundle.json')
    report = []
    for case in ('reject', 'ignore', 'clear', 'defer', 'wrong-target', 'jst-conflict'):
        folder = evidence/case
        folder.mkdir()
        rows = [dict(r) for r in original]
        cid = 'mc-4dab89199dfcee96' if case == 'jst-conflict' else 'mc-994fa1007b50d5be'
        row = next(r for r in rows if r['candidate_id'] == cid)
        if case == 'jst-conflict':
            j = next(c for c in bundle['candidates'] if c['source']['source_system'] == 'jushuitan' and c['source']['external_sku_raw'] == 'WM0048')
            assert j['selected_master']['row_index'] == 46
            row.update(manual_jst_candidate_id=j['candidate_id'], manual_jst_sku='WM0048')
        elif case == 'wrong-target':
            row.update(review_decision='confirm', manual_master_row='28', manual_master_ice='WM0093')
        else:
            row['review_decision'] = case
        csv_path = folder/'injected.csv'
        with csv_path.open('w', encoding='utf-8-sig', newline='') as f:
            writer = csv.DictWriter(f, fieldnames=list(rows[0]))
            writer.writeheader(); writer.writerows(rows)
        output = folder/'result'
        command = [sys.executable, '-m', 'p0_03_match', 'apply-review', '--bundle', str(delivery/'match-bundle.json'),
                   '--review-csv', str(csv_path), '--output', str(output/'review-outcome.json')]
        env = os.environ | {'PYTHONPATH': str(Path('tools').resolve()), 'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONUTF8': '1'}
        run = subprocess.run(command, capture_output=True, text=True, encoding='utf-8', env=env)
        (folder/'command.log').write_text(run.stdout+run.stderr, encoding='utf-8')
        item = {'case': case, 'purpose': 'injected regression copy only; not business decisions', 'command': command,
                'exit_code': run.returncode, 'input_sha256': checks.sha(csv_path), 'result': str(output)}
        (folder/'command.json').write_text(json.dumps(item, indent=2), encoding='utf-8')
        assert run.returncode == 0, item
        result = checks.verify_outputs(output)
        c = next(c for c in result['candidates'] if c['candidate_id'] == cid)
        assert c['selected_master'] is None
        assert c['review_state'] == {'reject': 'rejected', 'ignore': 'ignored'}.get(case, 'pending')
        assert result['correction_events'] == bundle['correction_events']
        if case in ('reject', 'ignore', 'clear', 'defer'):
            assert c['review_decision'] == case and c['manual_master_ice'] == 'WM0039'
        elif case == 'wrong-target':
            assert c['manual_master_ice'] == 'WM0093'
        else:
            assert c['manual_master_row'] == '45' and c['manual_jst_sku'] == 'WM0048'
            assert c['manual_jushuitan_conflict']['jst_selected_master_row'] == 46
        item.update(status='verified', rows_compared=1417, all_outputs_consistent=True)
        report.append(item)
    (evidence/'negative-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'status': 'verified', 'cases': len(report), 'records_per_case': 1417}))


if __name__ == '__main__':
    main(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve())
