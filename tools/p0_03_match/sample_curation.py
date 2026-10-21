"""Explicit, frozen, one-sample curation. No persistence or future SKU bindings."""
from __future__ import annotations

import copy
import json
from pathlib import Path

import pandas as pd
from openpyxl import load_workbook

from .cli import _freeze, _json, _new_output, _sha256, preserve_sample_ids
from .loaders import load_master, load_bigseller, load_jushuitan_merged
from .match_engine import build_match_bundle
from .models import MasterRow
from .review_exports import export_effective_outputs, write_csv
from .review_result import MANUAL_FIELDS, read_decisions, resolve_reviews, source_identity


def curate_master(original, raw_rows, plan):
    by_row = {m.row_index: m.to_public() for m in original}
    aliases = {str(n): n for n in by_row}
    provenance = {}
    for group in plan['master_groups']:
        anchor, rows = group['anchor_row'], group['source_rows']
        if anchor not in rows or any(by_row[n]['ice_code'] != group['ice_code'] for n in rows):
            raise ValueError('Master grouping disagrees with frozen Excel rows')
        for n in rows:
            aliases[str(n)] = anchor
        provenance[anchor] = group
    curated, details = [], []
    for n, m in by_row.items():
        if aliases[str(n)] != n:
            continue
        group = provenance.get(n, {'source_rows': [n], 'primary_row': n})
        sources = group['source_rows']
        data = copy.deepcopy(raw_rows[n])
        price_pending = group.get('price_pending', False)
        if price_pending:
            data['成本价格'] = data['运营价格'] = None
        if group.get('primary_row') is None:
            data['日期'] = None
        corrections = [x for x in plan['master_corrections'] if x['row_index'] == n]
        for correction in corrections:
            field = correction['field']
            if m[field] != correction['before']:
                raise ValueError('Master correction before value differs')
            m[field] = correction['after']
            data[{'ice_code': '聚水潭内部货号', 'barcode': '69商品编码'}[field]] = correction['after']
        curated.append(MasterRow(**m))
        details.append({**m, 'source_rows': sources, 'primary_row': group.get('primary_row'),
                        'data': data, 'price_pending': price_pending,
                        'price_versions': [{'source_row': r, 'cost': raw_rows[r].get('成本价格'),
                                            'operating_price': raw_rows[r].get('运营价格')} for r in sources],
                        'source_records': [{'excel_row': r, 'data': raw_rows[r]} for r in sources],
                        'corrections': corrections, 'valuation_authorized': False})
    return curated, aliases, details


def apply_explicit_corrections(old, decisions, plan, masters):
    """Return a single current CSV snapshot; retain conflicting originals in audit."""
    by_id = {c['candidate_id']: c for c in old['candidates']}
    master = {m.row_index: m.to_public() for m in masters}
    effective = copy.deepcopy(decisions)
    audit = []
    seen = set()
    for correction in plan['source_corrections']:
        c = by_id[correction['candidate_id']]
        if tuple(correction['source_identity']) != source_identity(c) or c['candidate_id'] in seen:
            raise ValueError('Correction must identify one unique frozen source record')
        seen.add(c['candidate_id'])
        previous = c.get('decision_records') or []
        if any(r.get('review_decision') in ('reject', 'ignore') for r in previous):
            raise ValueError('Explicit rejected/ignored source cannot be reactivated')
        target = master.get(correction.get('target_row'))
        if correction['decision'] == 'confirm' and (not target or target['ice_code'] != correction['target_ice']):
            raise ValueError('Explicit correction target does not exist')
        ids = {c['candidate_id'], *c.get('candidate_id_lineage', []), *(r['candidate_id'] for r in previous)}
        original_records = [copy.deepcopy(effective[i]) for i in ids if i in effective]
        for i in ids:
            effective.pop(i, None)
        raw = {'candidate_id': c['candidate_id'], 'review_decision': correction['decision'],
               'review_notes': correction['reason'], **{k: '' for k in MANUAL_FIELDS}}
        if target:
            raw.update(manual_master_row=str(target['row_index']), manual_master_ice=target['ice_code'])
        effective[c['candidate_id']] = raw
        audit.append({'correction': correction, 'original_csv_records': original_records,
                      'previous_decision_records': previous, 'effective_csv_record': raw})
    return effective, audit


def cmd_curate_sample(args):
    base = Path(args.evidence).resolve()
    old = _json(base/'match-bundle.json')
    plan = _json(Path(args.corrections))
    if plan['base_bundle_sha256'] != _sha256(base/'match-bundle.json'):
        raise ValueError('Corrections are for a different sample baseline')
    out = _new_output(args.output)
    manifest = {'scope': 'current_sample_curation_only; future_binding_undecided',
                'base_evidence': str(base), 'base_evidence_hashes': {p.name: _sha256(p) for p in base.iterdir() if p.is_file()},
                'inputs': old['input_manifest']['inputs'], 'history_bundles': [],
                'decision_source': _freeze(Path(args.review_csv).resolve(), out, 'manual-decisions.original.frozen.csv'),
                'explicit_corrections': _freeze(Path(args.corrections).resolve(), out, 'business-corrections.frozen.json')}
    _freeze(base/'match-bundle.json', out, 'original-match-bundle.frozen.json')
    inputs = manifest['inputs']
    paths = [inputs['master'], inputs['bigseller'], *inputs['jushuitan']['paths']]
    for i, entry in enumerate(paths):
        path = Path(entry['path'])
        if _sha256(path) != entry['sha256']:
            raise ValueError('Original Excel hash changed')
        entry['frozen'] = _freeze(path, out, f'input-{i}.frozen.xlsx')['frozen']
    history = [old]
    for i, entry in enumerate(old['input_manifest']['history_bundles']):
        frozen = _freeze(base/entry['frozen'], out, f'history-bundle-{i}.frozen.json')
        manifest['history_bundles'].append(frozen)
        history.append(_json(out/frozen['frozen']))
    master_path = out/inputs['master']['frozen']
    original = load_master(master_path)
    df = pd.read_excel(master_path, dtype=str).fillna('')
    raw_rows = {n+2: r.to_dict() for n, r in df.iterrows()}
    # Preserve formulas and Excel error cells, including invalid factory references.
    book = load_workbook(master_path, read_only=True, data_only=False)
    cells = []
    for row in book.worksheets[0]:
        for cell in row:
            if cell.data_type in ('f', 'e'):
                cells.append({'coordinate': cell.coordinate, 'value': cell.value, 'type': cell.data_type})
    book.close()
    masters, aliases, details = curate_master(original, raw_rows, plan)
    sources = load_bigseller(out/inputs['bigseller']['frozen']) + load_jushuitan_merged(*[out/e['frozen'] for e in inputs['jushuitan']['paths']])
    bundle = preserve_sample_ids(build_match_bundle(masters, sources), old)
    bundle.update(original_master_rows=[m.to_public() for m in original], master_row_aliases=aliases,
                  batch_target_authorizations=[x for x in plan['source_corrections'] if x['decision'] == 'confirm'],
                  batch_business_pending=plan['pending_business'], master_provenance=details)
    bundle['summary'].update(master_excel_data_rows=len(df), master_blank_rows_skipped=len(df)-len(original),
                             original_master_nonempty_rows=len(original), original_nonempty_ice_rows=sum(bool(m.ice_code) for m in original),
                             original_distinct_nonempty_ice=len({m.ice_code for m in original if m.ice_code}),
                             curated_master_rows=len(masters), curated_nonempty_ice_rows=sum(bool(m.ice_code) for m in masters),
                             curated_distinct_nonempty_ice=len({m.ice_code for m in masters if m.ice_code}))
    # Keep undecided product choices exactly as delivered. No new confirmation.
    old_by_id = {c['candidate_id']: c for c in old['candidates']}
    pending_ids = {cid: p for p in plan['pending_business'] for cid in p.get('candidate_ids', [])}
    for c in bundle['candidates']:
        previous = old_by_id[c['candidate_id']]
        c['batch_business_pending'] = pending_ids.get(c['candidate_id'])
        if c['candidate_id'] in pending_ids and pending_ids[c['candidate_id']].get('preserve_matches'):
            c['master_matches'] = copy.deepcopy(previous['master_matches'])
            c['lifecycle'] = previous['lifecycle']
    decisions, audit = apply_explicit_corrections(old, read_decisions(out/'manual-decisions.original.frozen.csv'), plan, masters)
    write_csv(out/'manual-decisions.effective.csv', list(decisions.values()), ['candidate_id', 'review_decision', 'review_notes', *MANUAL_FIELDS])
    manifest['effective_decision_source'] = {'frozen': 'manual-decisions.effective.csv', 'sha256': _sha256(out/'manual-decisions.effective.csv'),
                                             'derived_from': ['decision_source', 'explicit_corrections']}
    outcome = resolve_reviews(bundle, decisions, masters, history=history)
    outcome['input_manifest'] = manifest
    export_effective_outputs(outcome, out)
    changes = []
    for c in outcome['candidates']:
        before = old_by_id[c['candidate_id']]
        keys = ('review_state', 'review_decision', 'selected_master', 'selected_jushuitan', 'master_matches', 'validation_errors')
        if any(before.get(k) != c.get(k) for k in keys):
            explicit = next((x for x in plan['source_corrections'] if x['candidate_id'] == c['candidate_id']), None)
            sku = c['source']['external_sku_raw']
            derived = {'WM0128': '原Excel第116行WM00128纠正为WM0128；仅恢复候选，原CSV空白不新增确认',
                       'WM10012': 'WM五位整品识别修复：恢复原第39行候选，原CSV空白不新增确认',
                       'WM10013': 'WM五位整品识别修复：恢复原第18行候选，继承原CSV confirm',
                       'WM0093': '用户确认第28行包装条码更正757577407076；保留原CSV决定及原H列值'}
            reason = derived.get(sku, '用户指定同货号重复资料合并为同一商品，保留原行追溯及原CSV决定；不新增人工确认')
            changes.append({'candidate_id': c['candidate_id'], 'source': c['source'],
                            'before': {k: before.get(k) for k in keys}, 'after': {k: c.get(k) for k in keys},
                            'basis': explicit or reason})
    chosen = [c for c in old['candidates'] if c.get('manual_master_row')]
    after_ids = {c['candidate_id']: c for c in outcome['candidates']}
    comparison = [{'candidate_id': c['candidate_id'], 'before': c, 'after': after_ids[c['candidate_id']]} for c in chosen]
    lineage = [{'original_row': int(n), 'canonical_row': a} for n, a in aliases.items()]
    for name, value in [('input-manifest.json', manifest), ('master-row-lineage.json', lineage),
                        ('source-formulas-and-errors.json', cells), ('explicit-correction-audit.json', audit),
                        ('all-correspondence-changes.json', changes), ('original-22-comparison.json', comparison),
                        ('pending-business.json', plan['pending_business'])]:
        (out/name).write_text(json.dumps(value, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print(json.dumps({'output': str(out), 'review': outcome['review_summary'], 'counts': outcome['summary'], 'changed_records': len(changes)}, ensure_ascii=False))
    return 0
