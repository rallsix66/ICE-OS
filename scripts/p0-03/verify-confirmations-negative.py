"""Current negative decisions must override inherited and new confirmations."""
import csv
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

spec = importlib.util.spec_from_file_location('checks', Path(__file__).with_name('verify-curation-evidence.py'))
checks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checks)


def main(delivery, evidence):
    evidence.mkdir(parents=True, exist_ok=False)
    original = checks.csv_rows(delivery/'manual-decisions.effective.csv')
    bundle = checks.read(delivery/'match-bundle.json')
    by_id = {c['candidate_id']: c for c in bundle['candidates']}
    cases = [('ph-'+d, 'mc-994fa1007b50d5be', d) for d in ('reject', 'ignore', 'clear', 'defer')]
    cases += [('ph-wrong-target', 'mc-994fa1007b50d5be', 'confirm'), ('jst-conflict', 'mc-4dab89199dfcee96', 'confirm')]
    cases += [(prefix+'-'+d, cid, d) for prefix, cid in [('milk', 'mc-59f065c77b77953a'),
        ('eye', 'mc-0b2c37c654a967b1'), ('sun', 'mc-5131dbfa1ad6207d')] for d in ('clear', 'defer')]
    report = []
    for name, cid, decision in cases:
        folder = evidence/name
        folder.mkdir()
        rows = [dict(r) for r in original]
        raw = next(r for r in rows if r['candidate_id'] == cid)
        raw['review_decision'] = decision
        if name == 'ph-wrong-target':
            raw.update(manual_master_row='28', manual_master_ice='WM0093')
        elif name == 'jst-conflict':
            jst = next(c for c in bundle['candidates'] if c['source']['source_system'] == 'jushuitan' and c['source']['external_sku_raw'] == 'WM0048')
            raw.update(manual_jst_candidate_id=jst['candidate_id'], manual_jst_sku='WM0048')
        csv_path = folder/'injected.csv'
        with csv_path.open('w', encoding='utf-8-sig', newline='') as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0])); w.writeheader(); w.writerows(rows)
        command = [sys.executable, '-m', 'p0_03_match', 'apply-review', '--bundle', str(delivery/'match-bundle.json'),
                   '--review-csv', str(csv_path), '--output', str(folder/'result/review-outcome.json')]
        run = subprocess.run(command, capture_output=True, text=True, encoding='utf-8',
            env=os.environ|{'PYTHONPATH': str(Path('tools').resolve()), 'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONUTF8': '1'})
        (folder/'command.log').write_text(run.stdout+run.stderr, encoding='utf-8')
        item = {'case': name, 'purpose': 'injected regression copy only; not business decisions', 'command': command,
                'exit_code': run.returncode, 'input_sha256': checks.sha(csv_path), 'result': str(folder/'result')}
        (folder/'command.json').write_text(json.dumps(item, indent=2), encoding='utf-8')
        assert run.returncode == 0, item
        result = checks.verify_outputs(folder/'result')
        current = {c['candidate_id']: c for c in result['candidates']}
        c = current[cid]
        assert c['selected_master'] is None and c['selected_jushuitan'] is None
        assert c['review_state'] == {'reject': 'rejected', 'ignore': 'ignored'}.get(decision, 'pending')
        assert c['review_decision'] == decision
        assert result['correction_events'] == bundle['correction_events']
        assert result['business_confirmation_events'] == bundle['business_confirmation_events']
        assert checks.read(folder/'result/pending-business.json') == bundle['batch_business_pending']
        summary = checks.read(folder/'result/business-confirmation-summary.json')
        assert summary == result['business_confirmation_summary']
        assert summary['recorded_business_decisions'] == 4
        assert summary['new_effective_selections'] == (1 if name.startswith(('milk-', 'eye-')) else 2)
        assert summary['reaffirmed_existing_selections'] == (0 if name.startswith('sun-') else 1)
        assert summary['current_price_selections'] == 1
        assert summary['implemented_business_decisions'] == (3 if name.startswith(('milk-', 'eye-', 'sun-')) else 4)
        price = next(m for m in result['master_provenance'] if m['row_index'] == 66)
        assert not price['price_pending'] and price['data']['成本价格'] == '5.18' and price['data']['运营价格'] == '5.68'
        for other_id in current:
            if other_id != cid:
                assert current[other_id]['selected_master'] == by_id[other_id]['selected_master']
        item.update(status='verified', records_compared=1417, all_outputs_consistent=True)
        report.append(item)
    (evidence/'negative-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'status': 'verified', 'cases': len(report), 'records_per_case': 1417}))


if __name__ == '__main__':
    main(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve())
