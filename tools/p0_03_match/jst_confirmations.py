"""The twelve explicitly authorized JST sample operations; never rematches data."""
from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path

from .business_confirmations import field_changes
from .models import MasterRow
from .review_exports import export_effective_outputs, refresh_confirmation_summary, review_records, write_csv
from .review_result import MANUAL_FIELDS, read_decisions, resolve_reviews, source_identity

BASE_HASHES = {
    'match-bundle.json': 'c0fa4bc9814080a9e78d15ad7136276e03156254d67a3fe59e4d49c841e80936',
    'manual-decisions.effective.csv': 'a66c564942220f5df4e1043ab2b076f1cec26c3056fa8dffd5a2e2733844b58f',
}
# The authorization is deliberately a finite list, not a same-SKU matching rule.
AUTHORIZED_ROWS = (
    ('WM0069', 796, 213, 'mc-f713998ca2c722a8', 'confirm'),
    ('WM0070', 797, 214, 'mc-151a8acf447c6aff', 'confirm'),
    ('WM0071', 798, 215, 'mc-4ce480743171808b', 'confirm'),
    ('WM0072', 799, 66, 'mc-fd977bdb831a5b5b', 'confirm'),
    ('WM0073', 800, 67, 'mc-6148a4d4e40a80ba', 'confirm'),
    ('WM0082', 809, 84, 'mc-26aa4e763d422095', 'confirm'),
    ('WM0092', 819, 212, 'mc-30c30b04c4ff9e0d', 'confirm'),
    ('WM0095', 822, 115, 'mc-6f83255696c02117', 'confirm'),
    ('WM0117', 844, 108, 'mc-a4a549dc9518a3d4', 'confirm'),
    ('WM0128', 855, 116, 'mc-c3d22fb31a28db96', 'confirm'),
    ('WM0129', 856, 123, 'mc-215172d1fdd95149', 'confirm'),
    ('WM0007', 744, 15, 'mc-eec4d01202d4a7de', 'ignore'),
)


def _validate_plan(base, plan):
    operations = plan.get('source_decisions', [])
    actual = [(p.get('target_ice'), (p.get('source_file') or {}).get('excel_row'),
               p.get('target_row'), p.get('candidate_id'), p.get('decision')) for p in operations]
    if actual != list(AUTHORIZED_ROWS):
        raise ValueError('Explicit decisions must be exactly the authorized eleven confirmations and one ignore')
    if len({p.get('decision_id') for p in operations}) != len(operations) or any(
            not p.get('decision_id') or not p.get('reason') for p in operations):
        raise ValueError('Explicit decisions require unique IDs and reasons')
    notices = plan.get('bs_not_created', [])
    if [(n.get('ice_code'), n.get('master_row')) for n in notices] != [('WM0070', 214), ('WM0072', 66)]:
        raise ValueError('Only the two authorized BigSeller creation notices are allowed')
    for notice in notices:
        if (notice.get('source_system') != 'bigseller' or notice.get('status') != 'user_confirmed_not_created'
                or not notice.get('reason') or not notice.get('basis')):
            raise ValueError('Missing explicit BigSeller not-created business explanation')
    if base.get('jst_confirmation_events') or base.get('batch_bs_not_created'):
        raise ValueError('This batch must start from the approved baseline, not an already-applied output')


def apply_jst_confirmations(base, decisions, plan):
    """Validate exact frozen identities and append this batch's operations once."""
    _validate_plan(base, plan)
    bundle, effective = copy.deepcopy(base), copy.deepcopy(decisions)
    candidates = {c['candidate_id']: c for c in bundle['candidates']}
    if len(candidates) != len(bundle['candidates']):
        raise ValueError('Duplicate frozen candidate ID')
    masters = {m['row_index']: m for m in bundle['master_rows']}
    events = []
    for explicit in plan['source_decisions']:
        cid = explicit['candidate_id']
        c = candidates.get(cid)
        target = masters.get(explicit['target_row'])
        file = explicit['source_file']
        ice = explicit['target_ice']
        if (not c or tuple(explicit['source_identity']) != source_identity(c)
                or c['source'] != explicit['source'] or not target
                or target['ice_code'] != ice or target != explicit['target_master']
                or c['source']['source_system'] != 'jushuitan'
                or c['source']['sheet_name'] != 'Sheet1'
                or c['source']['source_row_key'] != f'jushuitan:{file["excel_row"]}:{ice}:{ice}'
                or c['source']['external_sku_raw'] != ice
                or c['source']['extra']['style_code'] != ice
                or c['source']['extra']['product_code'] != ice):
            raise ValueError('Explicit decision disagrees with frozen source, original row or master target')
        if c.get('review_state') != 'candidate' or c.get('selected_master') or c.get('review_decision'):
            raise ValueError('This authorization does not override existing selected or negative decisions')
        # Historical IDs identify the same frozen row only. CSV order never decides precedence.
        ids = {cid, *c.get('candidate_id_lineage', []),
               *(r['candidate_id'] for r in c.get('decision_records', []))}
        for other in candidates.values():
            other_ids = {other['candidate_id'], *other.get('candidate_id_lineage', []),
                         *(r['candidate_id'] for r in other.get('decision_records', []))}
            if other['candidate_id'] != cid and ids & other_ids:
                raise ValueError('Ambiguous frozen source ID lineage')
        previous = [copy.deepcopy(effective[i]) for i in sorted(ids) if i in effective]
        signatures = {tuple(r.get(k, '') for k in ('review_decision', 'review_notes', *MANUAL_FIELDS))
                      for r in previous}
        if not previous or len(signatures) != 1:
            raise ValueError('Missing or conflicting inherited CSV rows for frozen source')
        raw = copy.deepcopy(previous[0])
        if raw.get('review_decision') or any(raw.get(k) for k in MANUAL_FIELDS):
            raise ValueError('Unexpected existing target or decision in the approved effective CSV')
        for old_id in ids:
            effective.pop(old_id, None)
        raw.update(candidate_id=cid, review_decision=explicit['decision'], review_notes=explicit['reason'],
                   manual_master_row=str(target['row_index']) if explicit['decision'] == 'confirm' else '',
                   manual_master_ice=ice if explicit['decision'] == 'confirm' else '')
        effective[cid] = raw
        events.append({'decision_id': explicit['decision_id'], 'type': 'jst_source_'+explicit['decision'],
                       'explicit_decision': copy.deepcopy(explicit), 'before_csv_records': previous,
                       'after_csv': copy.deepcopy(raw), 'before_selected_master': copy.deepcopy(c.get('selected_master')),
                       'before_decision_records': copy.deepcopy(c.get('decision_records', []))})
    outcome = resolve_reviews(bundle, effective, [MasterRow(**m) for m in bundle['master_rows']])
    acted = {p['candidate_id'] for p in plan['source_decisions']}
    for c in outcome['candidates']:
        if c['candidate_id'] not in acted:
            c['previous_review'] = copy.deepcopy(candidates[c['candidate_id']].get('previous_review'))
            if c != candidates[c['candidate_id']]:
                raise ValueError('Applying the explicit decisions would change an unauthorized source record')
    after = {c['candidate_id']: c for c in outcome['candidates']}
    for p in plan['source_decisions']:
        c = after[p['candidate_id']]
        if p['decision'] == 'confirm':
            if (c['review_state'] != 'manual_selected' or not c['selected_master']
                    or c['selected_master'] != p['target_master']):
                raise ValueError('An authorized confirmation did not become an effective selection')
        elif c['review_state'] != 'ignored' or c['selected_master']:
            raise ValueError('The authorized ignore must retain no effective selection')
    outcome['jst_confirmation_events'] = events
    outcome['batch_bs_not_created'] = copy.deepcopy(plan['bs_not_created'])
    for notice in outcome['batch_bs_not_created']:
        detail = next(m for m in outcome['master_provenance'] if m['row_index'] == notice['master_row'])
        if detail['ice_code'] != notice['ice_code'] or any(
                c['source']['source_system'] == 'bigseller' and c.get('selected_master')
                and c['selected_master']['row_index'] == notice['master_row'] for c in outcome['candidates']):
            raise ValueError('BigSeller not-created explanation contradicts saved effective selections')
        detail['bs_creation_status'] = copy.deepcopy(notice)
    refresh_confirmation_summary(outcome)
    return outcome, effective, events


def validate_frozen_sources(base, bundle, plan):
    """Read only the frozen workbook, including incorrectly declared sheet dimensions."""
    import openpyxl
    inputs = bundle['input_manifest']['original_input_hashes']
    if inputs != plan.get('original_inputs'):
        raise ValueError('The original input provenance does not match the approved baseline')
    for item in [inputs['master'], inputs['bigseller'], *inputs['jushuitan']['paths']]:
        if hashlib.sha256((base/item['frozen']).read_bytes()).hexdigest() != item['sha256']:
            raise ValueError('Frozen original input hash mismatch: '+item['frozen'])
    info = inputs['jushuitan']['paths'][0]
    path = base/info['frozen']
    if hashlib.sha256(path.read_bytes()).hexdigest() != info['sha256']:
        raise ValueError('Frozen JST source hash mismatch')
    by_row = {}
    for p in plan['source_decisions']:
        file = p['source_file']
        if (file['frozen'] != info['frozen'] or file['sha256'] != info['sha256']
                or file['file_name'] != Path(info['path']).name or file['sheet_name'] != 'Sheet1'):
            raise ValueError('Explicit source file, hash or sheet does not match frozen source')
        by_row[file['excel_row']] = p
    book = openpyxl.load_workbook(path, read_only=True, data_only=False)
    found = set()
    try:
        sheet = book['Sheet1']
        sheet.reset_dimensions()
        rows = sheet.iter_rows(values_only=True)
        headers = next(rows)
        for n, row in enumerate(rows, 2):
            if n in by_row:
                p = by_row[n]
                raw = {str(k): v for k, v in zip(headers, row)}
                if (raw != p['source_file']['raw_record'] or raw['款式编码'] != p['target_ice']
                        or raw['商品编码'] != p['target_ice'] or raw['商品名称'] != p['source']['external_name']):
                    raise ValueError('Explicit source evidence does not match the original frozen Excel row')
                found.add(n)
            if n >= max(by_row):
                break
        if found != set(by_row):
            raise ValueError('An authorized original source row was not found')
    finally:
        book.close()


def cmd_confirm_jst_sample(args):
    from .cli import _freeze, _json, _new_output, _sha256
    base, plan_path = Path(args.evidence).resolve(), Path(args.decisions).resolve()
    plan = _json(plan_path)
    if plan.get('base_hashes') != BASE_HASHES:
        raise ValueError('Explicit decision pins do not identify the approved baseline')
    for name, digest in BASE_HASHES.items():
        if _sha256(base/name) != digest:
            raise ValueError(f'Approved baseline hash mismatch: {name}')
    old = _json(base/'match-bundle.json')
    decisions = read_decisions(base/'manual-decisions.effective.csv')
    validate_frozen_sources(base, old, plan)
    outcome, effective, events = apply_jst_confirmations(old, decisions, plan)
    # All business and source checks complete before creating any output.
    out = _new_output(args.output)
    manifest = {'scope': 'current_sample_only; no_binding_reuse_inventory_or_real_service',
                'generated_at': plan['recorded_at'], 'base_evidence': str(base),
                'base_evidence_hashes': {p.name: _sha256(p) for p in sorted(base.iterdir()) if p.is_file()},
                'baseline_bundle': _freeze(base/'match-bundle.json', out, 'baseline-match-bundle.frozen.json'),
                'decision_source': _freeze(base/'manual-decisions.effective.csv', out, 'baseline-effective-decisions.frozen.csv'),
                'explicit_decisions': _freeze(plan_path, out, 'jst-decisions.frozen.json'),
                'baseline_manifest': _freeze(base/'input-manifest.json', out, 'baseline-input-manifest.frozen.json'),
                'original_input_hashes': copy.deepcopy(old['input_manifest']['original_input_hashes'])}
    inherited = ('master-row-lineage.json', 'source-formulas-and-errors.json', 'explicit-correction-audit.json',
                 'business-corrections.frozen.json', 'business-decisions.frozen.json', 'original-22-comparison.json',
                 'manual-decisions.original.frozen.csv', 'input-0.frozen.xlsx', 'input-1.frozen.xlsx',
                 'input-2.frozen.xlsx', 'input-3.frozen.xlsx', 'history-bundle-0.frozen.json', 'history-bundle-1.frozen.json')
    manifest['inherited_files'] = [_freeze(base/name, out, name) for name in inherited]
    write_csv(out/'manual-decisions.effective.csv', list(effective.values()),
              ['candidate_id', 'review_decision', 'review_notes', *MANUAL_FIELDS])
    manifest['effective_decision_source'] = {'frozen': 'manual-decisions.effective.csv',
        'sha256': _sha256(out/'manual-decisions.effective.csv'), 'derived_from': ['decision_source', 'explicit_decisions']}
    outcome['input_manifest'] = manifest
    export_effective_outputs(outcome, out)
    before, after = ({c['candidate_id']: c for c in b['candidates']} for b in (old, outcome))
    comparisons = [{'candidate_id': p['candidate_id'], 'decision_id': p['decision_id'],
                    'before': before[p['candidate_id']], 'after': after[p['candidate_id']], 'reason': p['reason']}
                   for p in plan['source_decisions']]
    old_rows = {r['candidate_id']: r for r in review_records(old)}
    changes = [{'candidate_id': r['candidate_id'], 'before': old_rows[r['candidate_id']], 'after': r,
                'changed_fields': [k for k in r if r[k] != old_rows[r['candidate_id']][k]]}
               for r in review_records(outcome) if r != old_rows[r['candidate_id']]]
    original22 = _json(base/'current-original-22-comparison.json')
    old_masters = {m['row_index']: m for m in old['master_provenance']}
    master_changes = [{'row_index': m['row_index'], 'before': old_masters[m['row_index']], 'after': m}
                      for m in outcome['master_provenance'] if m != old_masters[m['row_index']]]
    comparison_rows = []
    for item in comparisons:
        a, b = item['before'], item['after']
        comparison_rows.append({'candidate_id': item['candidate_id'], 'source_system': b['source']['source_system'],
            'source_row_key': b['source']['source_row_key'], 'source_sku': b['source']['external_sku_raw'],
            'before_review_state': a['review_state'], 'after_review_state': b['review_state'],
            'before_target_row': (a.get('selected_master') or {}).get('row_index', ''),
            'after_target_row': (b.get('selected_master') or {}).get('row_index', ''),
            'after_target_ice': (b.get('selected_master') or {}).get('ice_code', ''),
            'after_decision': b.get('review_decision') or '', 'reason': item['reason']})
    write_csv(out/'twelve-source-comparison.csv', comparison_rows)
    values = [('input-manifest.json', manifest), ('current-jst-decision-audit.json', events),
              ('twelve-source-comparison.json', comparisons), ('all-correspondence-changes.json', changes),
              ('all-master-changes.json', master_changes),
              ('all-field-changes.json', field_changes(old, outcome)),
              ('current-original-22-comparison.json', [{'candidate_id': r['candidate_id'],
                 'before': before[r['candidate_id']], 'after': after[r['candidate_id']]} for r in original22])]
    for name, value in values:
        (out/name).write_text(json.dumps(value, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print(json.dumps({'review': outcome['review_summary'], 'batch': outcome['jst_confirmation_summary'],
                      'changed_source_records': len(changes)}, ensure_ascii=False))
    return 0
