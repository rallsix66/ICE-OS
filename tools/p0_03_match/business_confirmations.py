"""Four explicit decisions on the approved sample; no rematch or future bindings."""
from __future__ import annotations

import copy
import json
from datetime import datetime, timezone
from pathlib import Path

from .models import MasterRow
from .review_exports import export_effective_outputs, refresh_confirmation_summary, review_records, write_csv
from .review_result import MANUAL_FIELDS, read_decisions, resolve_reviews, source_identity


def field_changes(before, after, path=''):
    """Complete saved-bundle differences, including technical provenance rollovers."""
    if before == after:
        return []
    if isinstance(before, dict) and isinstance(after, dict):
        changes = []
        for key in sorted(set(before) | set(after)):
            location = path+'/'+str(key)
            if key not in before or key not in after:
                changes.append({'path': location, 'before_present': key in before, 'after_present': key in after,
                                'before': before.get(key), 'after': after.get(key)})
            else:
                changes.extend(field_changes(before[key], after[key], location))
        return changes
    if isinstance(before, list) and isinstance(after, list) and len(before) == len(after):
        return [change for n, (a, b) in enumerate(zip(before, after)) for change in field_changes(a, b, path+'/'+str(n))]
    return [{'path': path, 'before': before, 'after': after}]


def apply_business_confirmations(base, decisions, plan):
    bundle, effective = copy.deepcopy(base), copy.deepcopy(decisions)
    by_id = {c['candidate_id']: c for c in bundle['candidates']}
    if len(by_id) != len(bundle['candidates']):
        raise ValueError('Duplicate sample candidate ID')
    masters = {m['row_index']: m for m in bundle['master_rows']}
    pending = {p['number']: p for p in bundle['batch_business_pending']}
    confirmations = plan['source_confirmations']
    if len(confirmations) != 3 or len({x['candidate_id'] for x in confirmations}) != 3:
        raise ValueError('This batch requires three distinct source confirmations')
    audit, resolved = [], set()
    for explicit in confirmations:
        cid = explicit['candidate_id']
        c = by_id[cid]
        target = masters[explicit['target_row']]
        number = explicit['resolves_pending_number']
        if (tuple(explicit['source_identity']) != source_identity(c) or c['source'] != explicit['source']
                or target['ice_code'] != explicit['target_ice'] or cid not in pending[number]['candidate_ids']):
            raise ValueError('Explicit decision disagrees with frozen source/target/pending issue')
        if c.get('review_decision') in ('reject', 'ignore', 'clear', 'defer'):
            raise ValueError('This batch does not authorize overriding a negative decision')
        # Some approved JST rows retain historical IDs in the effective CSV.
        # Resolve only the frozen source lineage; never use CSV order as precedence.
        ids = {cid, *c.get('candidate_id_lineage', []), *(r['candidate_id'] for r in c.get('decision_records', []))}
        previous_rows = [copy.deepcopy(effective[i]) for i in sorted(ids) if i in effective]
        if not previous_rows:
            raise ValueError('No inherited CSV decision for this frozen source')
        signatures = {tuple(r.get(k, '') for k in ('review_decision', 'review_notes', *MANUAL_FIELDS)) for r in previous_rows}
        if len(signatures) != 1:
            raise ValueError('Unexpected conflicting rows in the approved effective CSV')
        for other in by_id.values():
            if other['candidate_id'] != cid and ids.intersection({other['candidate_id'], *other.get('candidate_id_lineage', []),
                *(r['candidate_id'] for r in other.get('decision_records', []))}):
                raise ValueError('Ambiguous frozen source ID lineage')
        raw = copy.deepcopy(previous_rows[0])
        if any(raw.get(k) for k in ('manual_jst_candidate_id', 'manual_jst_sku')):
            raise ValueError('Unexpected JST reference on this batch decision')
        for old_id in ids:
            effective.pop(old_id, None)
        raw.update(candidate_id=cid, review_decision='confirm', manual_master_row=str(target['row_index']),
                   manual_master_ice=target['ice_code'], review_notes=explicit['reason'])
        effective[cid] = raw
        audit.append({'decision_id': explicit['decision_id'], 'type': 'source_confirmation',
                      'explicit_decision': copy.deepcopy(explicit), 'before_csv_records': previous_rows,
                      'after_csv': copy.deepcopy(raw), 'before_selected_master': copy.deepcopy(c.get('selected_master')),
                      'before_decision_records': copy.deepcopy(c.get('decision_records', []))})
        resolved.add(number)

    price = plan['price_confirmation']
    detail = next(m for m in bundle['master_provenance'] if m['row_index'] == price['master_anchor_row'])
    if detail['ice_code'] != price['ice_code'] or not detail['price_pending']:
        raise ValueError('Price decision does not address the pending product')
    number = price['resolves_pending_number']
    if number not in pending or pending[number]['title'] != 'WM0072桂花泰版精油价格':
        raise ValueError('Price issue is not pending in the approved baseline')
    source = next(r for r in detail['source_records'] if r['excel_row'] == price['source_row'])
    data = source['data']
    if (data['成本价格'] != price['cost'] or data['运营价格'] != price['operating_price']
            or data['日期'].split(' ')[0] != price['source_date']):
        raise ValueError('Selected price/date does not match the preserved source version')
    before_price = {'cost': detail['data']['成本价格'], 'operating_price': detail['data']['运营价格'],
                    'price_pending': detail['price_pending']}
    selection = {'decision_id': price['decision_id'], 'source_row': price['source_row'],
                 'source_date': price['source_date'], 'cost': price['cost'],
                 'operating_price': price['operating_price'], 'basis': price['reason']}
    detail['data'].update({'成本价格': price['cost'], '运营价格': price['operating_price']})
    detail['price_pending'] = False
    detail['current_price_selection'] = selection
    detail.setdefault('price_decision_history', []).append({'before': before_price, 'selection': copy.deepcopy(selection)})
    audit.append({'decision_id': price['decision_id'], 'type': 'current_price_selection',
                  'explicit_decision': copy.deepcopy(price), 'before_price': before_price,
                  'selected_source_record': copy.deepcopy(source), 'selection': copy.deepcopy(selection)})
    resolved.add(number)
    if resolved != {2, 3, 4, 5} or set(pending) != {1, 2, 3, 4, 5}:
        raise ValueError('Only the four specified business issues may be resolved')
    bundle['batch_business_pending'] = [copy.deepcopy(pending[1])]
    still_pending = {cid: pending[1] for cid in pending[1]['candidate_ids']}
    for c in bundle['candidates']:
        c['batch_business_pending'] = copy.deepcopy(still_pending.get(c['candidate_id']))
    outcome = resolve_reviews(bundle, effective, [MasterRow(**m) for m in bundle['master_rows']])
    acted_ids = {x['candidate_id'] for x in confirmations}
    for c in outcome['candidates']:
        if c['candidate_id'] not in acted_ids:
            # Unchanged CSV rows are not new human operations. Preserve their
            # prior-review projection instead of manufacturing history rollover.
            c['previous_review'] = copy.deepcopy(by_id[c['candidate_id']].get('previous_review'))
    after_ids = {c['candidate_id']: c for c in outcome['candidates']}
    for explicit in confirmations:
        target = after_ids[explicit['candidate_id']]['selected_master']
        if not target or target['row_index'] != explicit['target_row'] or target['ice_code'] != explicit['target_ice']:
            raise ValueError('An explicit confirmation did not become an effective selection')
    outcome.setdefault('business_confirmation_events', []).extend(copy.deepcopy(audit))
    refresh_confirmation_summary(outcome)
    return outcome, effective, audit


def cmd_confirm_sample(args):
    from .cli import _freeze, _json, _new_output, _sha256
    base, plan_path = Path(args.evidence).resolve(), Path(args.decisions).resolve()
    plan = _json(plan_path)
    for name in ('match-bundle.json', 'manual-decisions.effective.csv'):
        if _sha256(base/name) != plan['base_hashes'][name]:
            raise ValueError(f'Approved baseline hash mismatch: {name}')
    out = _new_output(args.output)
    manifest = {'scope': 'current_sample_only; no_future_binding_or_valuation',
                'generated_at': datetime.now(timezone.utc).isoformat(), 'base_evidence': str(base),
                'base_evidence_hashes': {p.name: _sha256(p) for p in base.iterdir() if p.is_file()},
                'baseline_bundle': _freeze(base/'match-bundle.json', out, 'baseline-match-bundle.frozen.json'),
                'decision_source': _freeze(base/'manual-decisions.effective.csv', out, 'baseline-effective-decisions.frozen.csv'),
                'explicit_decisions': _freeze(plan_path, out, 'business-decisions.frozen.json'),
                'baseline_manifest': _freeze(base/'input-manifest.json', out, 'baseline-input-manifest.frozen.json')}
    old = _json(out/'baseline-match-bundle.frozen.json')
    outcome, effective, audit = apply_business_confirmations(old, read_decisions(out/'baseline-effective-decisions.frozen.csv'),
                                                           _json(out/'business-decisions.frozen.json'))
    # Freeze inherited source evidence and original inputs without reopening Desktop CSV decisions.
    inherited = old['input_manifest']
    manifest['inherited_files'] = []
    for name in ('master-row-lineage.json', 'source-formulas-and-errors.json', 'explicit-correction-audit.json',
                 'business-corrections.frozen.json', 'original-22-comparison.json', 'manual-decisions.original.frozen.csv',
                 'input-0.frozen.xlsx', 'input-1.frozen.xlsx', 'input-2.frozen.xlsx', 'input-3.frozen.xlsx',
                 'history-bundle-0.frozen.json', 'history-bundle-1.frozen.json'):
        manifest['inherited_files'].append(_freeze(base/name, out, name))
    manifest['original_input_hashes'] = inherited['inputs']
    write_csv(out/'manual-decisions.effective.csv', list(effective.values()), ['candidate_id', 'review_decision', 'review_notes', *MANUAL_FIELDS])
    manifest['effective_decision_source'] = {'frozen': 'manual-decisions.effective.csv',
        'sha256': _sha256(out/'manual-decisions.effective.csv'), 'derived_from': ['decision_source', 'explicit_decisions']}
    outcome['input_manifest'] = manifest
    export_effective_outputs(outcome, out)
    before_rows = {r['candidate_id']: r for r in review_records(old)}
    after_rows = review_records(outcome)
    changes = [{'candidate_id': r['candidate_id'], 'before': before_rows[r['candidate_id']], 'after': r,
                'changed_fields': [k for k in r if r[k] != before_rows[r['candidate_id']][k]]}
               for r in after_rows if r != before_rows[r['candidate_id']]]
    old_masters = {m['row_index']: m for m in old['master_provenance']}
    master_changes = [{'row_index': m['row_index'], 'before': old_masters[m['row_index']], 'after': m}
                      for m in outcome['master_provenance'] if m != old_masters[m['row_index']]]
    original22_ids = {x['candidate_id'] for x in _json(base/'original-22-comparison.json')}
    raw22 = [c for c in old['candidates'] if c['candidate_id'] in original22_ids]
    after_ids = {c['candidate_id']: c for c in outcome['candidates']}
    for name, value in [('input-manifest.json', manifest), ('current-decision-audit.json', audit),
                        ('all-correspondence-changes.json', changes), ('all-master-changes.json', master_changes),
                        ('all-field-changes.json', field_changes(old, outcome)),
                        ('current-original-22-comparison.json', [{'candidate_id': c['candidate_id'], 'before': c, 'after': after_ids[c['candidate_id']]} for c in raw22]),
                        ('business-confirmation-summary.json', outcome['business_confirmation_summary'])]:
        (out/name).write_text(json.dumps(value, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    # Preserve the full inherited correction/event history. The new four decisions append separately.
    print(json.dumps({'output': str(out), 'review': outcome['review_summary'],
                      'business_decisions': outcome['business_confirmation_summary'],
                      'changed_source_records': len(changes), 'changed_master_records': len(master_changes)}, ensure_ascii=False))
    return 0
