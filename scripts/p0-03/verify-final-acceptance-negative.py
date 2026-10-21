"""Final-acceptance failure injection, always in new regression evidence copies."""
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
    plan = checks.read(delivery/'final-decisions.frozen.json')
    base = Path(checks.read(delivery/'input-manifest.json')['base_evidence'])
    env = os.environ | {'PYTHONPATH': str(Path('tools').resolve()), 'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONUTF8': '1'}
    original_hashes = snapshot(delivery)
    report = []

    def run(name, args, expected_success):
        folder = evidence/name
        folder.mkdir(exist_ok=True)
        command = [sys.executable, '-B', '-X', 'utf8', '-m', 'p0_03_match', *args]
        result = subprocess.run(command, capture_output=True, text=True, encoding='utf-8', env=env)
        (folder/'stdout.log').write_text(result.stdout, encoding='utf-8')
        (folder/'stderr.log').write_text(result.stderr, encoding='utf-8')
        record = {'case': name, 'purpose': 'regression injection only; never a business decision', 'command': command,
                  'exit_code': result.returncode, 'expected_success': expected_success, 'stdout': 'stdout.log', 'stderr': 'stderr.log'}
        (folder/'command.json').write_text(json.dumps(record, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
        assert (result.returncode == 0) == expected_success, record
        report.append(record)
        return folder

    mutations = [
        ('wrong-source', lambda p: p['source_decisions'][0]['source'].update(warehouse='fabricated-warehouse')),
        ('wrong-source-row', lambda p: p['source_decisions'][0]['source_file'].update(excel_row=377)),
        ('wrong-target-code', lambda p: p['source_decisions'][0].update(target_ice='LS101275')),
        ('wrong-target-row', lambda p: p['source_decisions'][0].update(target_row=116)),
        ('conflicting-decisions', lambda p: p['source_decisions'].append(p['source_decisions'][0] | {'decision': 'ignore'})),
        ('wrong-input-hash', lambda p: p['base_hashes'].update({'match-bundle.json': '0'*64})),
    ]
    for name, mutate in mutations:
        folder = evidence/name; folder.mkdir()
        changed = copy.deepcopy(plan); mutate(changed)
        injected = folder/'injected-decisions.json'
        injected.write_text(json.dumps(changed, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
        run(name, ['finalize-sample', '--evidence', str(base), '--decisions', str(injected), '--output', str(folder/'result')], False)
        assert not (folder/'result').exists() or not any((folder/'result').iterdir()), (name, 'partial output after rejection')
    run('nonempty-output-guard', ['finalize-sample', '--evidence', str(base), '--decisions', str(delivery/'final-decisions.frozen.json'), '--output', str(delivery)], False)
    assert snapshot(delivery) == original_hashes
    repeated = run('already-applied-output-as-input-rejected', ['finalize-sample', '--evidence', str(delivery),
                   '--decisions', str(delivery/'final-decisions.frozen.json'), '--output', str(evidence/'already-applied-output-as-input-rejected/result')], False)
    assert not (repeated/'result').exists() or not any((repeated/'result').iterdir())
    cases = [(prefix+'-'+d, cid, d) for prefix, cid in [('jst130', 'mc-75e0ce710d064c4c'),
             ('bs73', 'mc-44b8f0236d346bc7'), ('ph-version', 'mc-e1b56fb81b0db46c')]
             for d in ('reject', 'ignore', 'clear', 'defer')]
    cases += [('jst6-ignore-cleared', 'mc-e78031a3b38c39f1', 'clear')]
    original_csv = checks.csv_rows(delivery/'manual-decisions.effective.csv')
    for name, cid, decision in cases:
        folder = evidence/name; folder.mkdir()
        rows = copy.deepcopy(original_csv)
        raw = next(r for r in rows if r['candidate_id'] == cid)
        raw['review_decision'] = decision
        raw['review_notes'] = 'regression injection only: '+decision
        injected = folder/'injected.csv'
        with injected.open('w', encoding='utf-8-sig', newline='') as f:
            writer = csv.DictWriter(f, fieldnames=list(rows[0])); writer.writeheader(); writer.writerows(rows)
        run(name, ['apply-review', '--bundle', str(delivery/'match-bundle.json'), '--review-csv', str(injected),
                   '--output', str(folder/'result/review-outcome.json')], True)
        current = checks.verify_outputs(folder/'result')
        by_id = {c['candidate_id']: c for c in current['candidates']}
        c = by_id[cid]
        assert c['review_decision'] == decision and c['review_state'] == {'reject': 'rejected', 'ignore': 'ignored'}.get(decision, 'pending')
        assert c['selected_master'] is None and c['selected_jushuitan'] is None
        for key in ('final_confirmation_events', 'jst_confirmation_events', 'business_confirmation_events', 'correction_events',
                    'batch_business_pending', 'batch_bs_not_created', 'batch_specification_resolutions',
                    'batch_target_authorizations', 'resolved_business_pending_history'):
            assert current[key] == bundle[key], (name, 'history changed', key)
        assert current['batch_business_pending'] == []
        versions = {x['candidate_id']: x for x in current['batch_version_confirmations']}
        if cid in versions:
            assert versions[cid]['effective_selection'] is False
            assert c['batch_version_confirmation']['effective_selection'] is False
        for other_id, other in by_id.items():
            if other_id != cid:
                assert other['selected_master'] == before[other_id]['selected_master'], (name, other_id)
                assert other['review_decision'] == before[other_id]['review_decision'], (name, other_id)
        price = next(m for m in current['master_provenance'] if m['row_index'] == 66)
        original_price = next(m for m in bundle['master_provenance'] if m['row_index'] == 66)
        for key in ('data', 'price_pending', 'current_price_selection', 'price_versions', 'price_decision_history', 'source_records'):
            assert price[key] == original_price[key], (name, 'WM72 price/history', key)
        assert len([x for x in current['candidates'] if x['selected_master']]) == (548 if name == 'jst6-ignore-cleared' else 547)
        summary = checks.read(folder/'result/final-confirmation-summary.json')
        assert summary == current['final_confirmation_summary']
        active_new, active_reaffirmed, active_ignored = [], [], []
        for event in bundle['final_confirmation_events']:
            p = event['explicit_decision']; now = by_id[p['candidate_id']]
            target = now['selected_master'] or {}
            active = (now['review_state'] == 'manual_selected' and now['review_decision'] == 'confirm'
                      and target.get('row_index') == p['target_row'] and target.get('ice_code') == p['target_ice'])
            if p['decision'] == 'confirm' and active:
                (active_reaffirmed if event['before_selected_master'] else active_new).append(p['candidate_id'])
            if p['decision'] == 'ignore' and now['review_state'] == 'ignored' and now['review_decision'] == 'ignore':
                active_ignored.append(p['candidate_id'])
        assert summary['recorded_source_decisions'] == 8
        assert summary['new_effective_candidate_ids'] == active_new and summary['new_effective_selections'] == len(active_new)
        assert summary['reaffirmed_candidate_ids'] == active_reaffirmed and summary['reaffirmed_existing_selections'] == len(active_reaffirmed)
        assert summary['ignored_candidate_ids'] == active_ignored and summary['effective_ignores'] == len(active_ignored)
        assert summary['current_confirmed_versions'] == sum(x['effective_selection'] for x in versions.values())
        assert summary['closed_specification_issues'] == 6 and summary['remaining_business_issues'] == 0
        report[-1].update(current_operation_effective=True, all_projections_verified=True, history_and_price_preserved=True)
    assert snapshot(delivery) == original_hashes, 'failure injection mutated delivered evidence'
    result = {'status': 'verified', 'cases': len(report), 'rejected_plan_or_output_cases': 8,
              'current_negative_operations': len(cases), 'delivered_files_unchanged': True, 'results': report}
    (evidence/'negative-report.json').write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve())
