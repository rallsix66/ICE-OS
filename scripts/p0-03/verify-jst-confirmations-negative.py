"""Failure injection on new copies only; never edits delivered or old evidence."""
from __future__ import annotations

import copy
import csv
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

spec = importlib.util.spec_from_file_location('saved_projection_checks', Path(__file__).with_name('verify-curation-evidence.py'))
checks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checks)


def snapshot(folder):
    return {str(p.relative_to(folder)): checks.sha(p) for p in sorted(folder.rglob('*')) if p.is_file()}


def main(delivery, evidence):
    evidence.mkdir(parents=True, exist_ok=False)
    bundle = checks.read(delivery/'match-bundle.json')
    before = {c['candidate_id']: c for c in bundle['candidates']}
    plan = checks.read(delivery/'jst-decisions.frozen.json')
    base = Path(checks.read(delivery/'input-manifest.json')['base_evidence'])
    env = os.environ | {'PYTHONPATH': str(Path('tools').resolve()), 'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONUTF8': '1'}
    original_hashes = snapshot(delivery)
    reports = []

    def run_case(name, args, expected_success):
        folder = evidence/name
        folder.mkdir(exist_ok=True)
        command = [sys.executable, '-B', '-X', 'utf8', '-m', 'p0_03_match', *args]
        run = subprocess.run(command, capture_output=True, text=True, encoding='utf-8', env=env)
        (folder/'stdout.log').write_text(run.stdout, encoding='utf-8')
        (folder/'stderr.log').write_text(run.stderr, encoding='utf-8')
        record = {'case': name, 'purpose': 'failure injection in a new regression copy; not a business decision',
                  'command': command, 'exit_code': run.returncode, 'expected_success': expected_success,
                  'stdout': 'stdout.log', 'stderr': 'stderr.log'}
        (folder/'command.json').write_text(json.dumps(record, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
        assert (run.returncode == 0) == expected_success, record
        reports.append(record)
        return folder

    mutations = [
        ('wrong-source', lambda p: p['source_decisions'][0]['source'].update(warehouse='fabricated-market')),
        ('wrong-source-row', lambda p: p['source_decisions'][0]['source_file'].update(excel_row=797)),
        ('wrong-target-code', lambda p: p['source_decisions'][0].update(target_ice='WM0070')),
        ('wrong-target-row', lambda p: p['source_decisions'][0].update(target_row=214)),
        ('conflicting-explicit-decisions', lambda p: p['source_decisions'].append(p['source_decisions'][0] | {'decision': 'ignore'})),
        ('wrong-input-hash', lambda p: p['base_hashes'].update({'match-bundle.json': '0'*64})),
    ]
    for name, mutate in mutations:
        folder = evidence/name; folder.mkdir()
        changed = copy.deepcopy(plan); mutate(changed)
        plan_path = folder/'injected-decisions.json'
        plan_path.write_text(json.dumps(changed, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
        run_case(name, ['confirm-jst-sample', '--evidence', str(base), '--decisions', str(plan_path), '--output', str(folder/'result')], False)
        assert not (folder/'result').exists() or not any((folder/'result').iterdir()), (name, 'rejection must not create partial evidence')
    run_case('nonempty-output-guard', ['confirm-jst-sample', '--evidence', str(base), '--decisions', str(delivery/'jst-decisions.frozen.json'), '--output', str(delivery)], False)
    assert snapshot(delivery) == original_hashes, 'nonempty guard overwrote final evidence'

    original_csv = checks.csv_rows(delivery/'manual-decisions.effective.csv')
    cases = [(prefix+'-'+decision, cid, decision) for prefix, cid in [('jst69', 'mc-f713998ca2c722a8'), ('jst72', 'mc-fd977bdb831a5b5b')]
             for decision in ('reject', 'ignore', 'clear', 'defer')]
    cases += [('ignored7-clear', 'mc-eec4d01202d4a7de', 'clear')]
    for name, cid, decision in cases:
        folder = evidence/name; folder.mkdir()
        rows = copy.deepcopy(original_csv)
        raw = next(r for r in rows if r['candidate_id'] == cid)
        raw['review_decision'] = decision
        raw['review_notes'] = 'regression injection only: current '+decision
        injected = folder/'injected.csv'
        with injected.open('w', encoding='utf-8-sig', newline='') as f:
            writer = csv.DictWriter(f, fieldnames=list(rows[0])); writer.writeheader(); writer.writerows(rows)
        run_case(name, ['apply-review', '--bundle', str(delivery/'match-bundle.json'), '--review-csv', str(injected),
                       '--output', str(folder/'result/review-outcome.json')], True)
        current = checks.verify_outputs(folder/'result')
        by_id = {c['candidate_id']: c for c in current['candidates']}
        c = by_id[cid]
        assert c['review_decision'] == decision and c['review_state'] == {'reject': 'rejected', 'ignore': 'ignored'}.get(decision, 'pending')
        assert c['selected_master'] is None and c['selected_jushuitan'] is None
        assert current['jst_confirmation_events'] == bundle['jst_confirmation_events'], 'new negative must preserve history'
        for key in ('correction_events', 'business_confirmation_events', 'batch_business_pending', 'batch_bs_not_created'):
            assert current[key] == bundle[key], (name, key)
        summary = checks.read(folder/'result/jst-confirmation-summary.json')
        assert summary == current['jst_confirmation_summary']
        expected_new = [e['explicit_decision']['candidate_id'] for e in bundle['jst_confirmation_events']
                        if e['explicit_decision']['decision'] == 'confirm'
                        and by_id[e['explicit_decision']['candidate_id']]['selected_master']
                        and by_id[e['explicit_decision']['candidate_id']]['review_state'] == 'manual_selected']
        expected_ignored = [e['explicit_decision']['candidate_id'] for e in bundle['jst_confirmation_events']
                            if e['explicit_decision']['decision'] == 'ignore'
                            and by_id[e['explicit_decision']['candidate_id']]['review_state'] == 'ignored'
                            and by_id[e['explicit_decision']['candidate_id']]['review_decision'] == 'ignore']
        assert summary['recorded_source_decisions'] == 12
        assert summary['new_effective_candidate_ids'] == expected_new and summary['new_effective_selections'] == len(expected_new)
        assert summary['ignored_candidate_ids'] == expected_ignored and summary['effective_ignores'] == len(expected_ignored)
        assert len(expected_new) == (11 if name == 'ignored7-clear' else 10)
        assert len(expected_ignored) == (0 if name == 'ignored7-clear' else 1)
        assert summary['bs_not_created_product_codes'] == ['WM0070', 'WM0072']
        for other, other_c in by_id.items():
            if other != cid:
                assert other_c['selected_master'] == before[other]['selected_master'], (name, other, 'unrelated target changed')
                assert other_c['review_decision'] == before[other]['review_decision'], (name, other, 'unrelated decision changed')
        price = next(m for m in current['master_provenance'] if m['row_index'] == 66)
        assert price['data']['成本价格'] == '5.18' and price['data']['运营价格'] == '5.68' and price['price_pending'] is False
        assert price['price_versions'] == next(m for m in bundle['master_provenance'] if m['row_index'] == 66)['price_versions']
        assert len([x for x in current['candidates'] if x['selected_master']]) == (545 if name == 'ignored7-clear' else 544)
        reports[-1].update(current_operation_effective=True, every_saved_projection_verified=True, history_preserved=True)
    assert snapshot(delivery) == original_hashes, 'regression mutated final delivery'
    report = {'status': 'verified', 'cases': len(reports), 'rejected_malformed_or_nonempty_cases': 7,
              'current_negative_operations': len(cases), 'delivered_files_unchanged': True, 'results': reports}
    (evidence/'negative-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__':
    main(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve())
