"""Effective sample review. CSV is the sole decision snapshot; no formal binding."""
from __future__ import annotations

import copy
import csv
from collections import Counter, defaultdict
from pathlib import Path

from .market_disambiguation import batch_market_block_reason
from .models import MasterRow, SourceRow

MANUAL_FIELDS = ('manual_master_row', 'manual_master_ice', 'manual_jst_candidate_id', 'manual_jst_sku')
ALLOWED_DECISIONS = {'confirm', 'reject', 'ignore', 'defer', 'clear', ''}
CORRECTION_REASON = '用户已确认：菲律宾-新创启辰自建仓 ICEWM0039 → WM0093 泰国特供版绑错；撤销，正确目标待核对'


def source_identity(c):
    s = c.get('source') or {}
    e = s.get('extra') or {}
    if s.get('source_system') == 'jushuitan':
        return ('jushuitan', e.get('style_code', ''), e.get('product_code') or s.get('external_sku_raw'))
    return (s.get('source_system'), s.get('source_row_key'))


def effective_master(c):
    if 'review_state' in c:
        return c.get('selected_master')
    matches = c.get('master_matches') or []
    return matches[0] if len(matches) == 1 else None


def target_error(c, target):
    if c.get('lifecycle') == 'outside_rules' or 'COMBO_SKU' in c.get('flags', []):
        return 'outside_batch_rules'
    s = c.get('source') or {}
    source = SourceRow(s.get('source_system', ''), s.get('source_row_key', ''),
                       s.get('scope', ''), s.get('warehouse'), s.get('external_sku_raw', ''), s.get('external_name', ''))
    return batch_market_block_reason(source, MasterRow(**target))


def batch_target_authorized(bundle, candidate, target):
    """Exact frozen sample source + target only; never a warehouse-wide exception."""
    return bool(target) and any(
        tuple(a['source_identity']) == source_identity(candidate)
        and a['target_row'] == target['row_index'] and a['target_ice'] == target['ice_code']
        for a in bundle.get('batch_target_authorizations', []))


def read_decisions(path: Path):
    decisions = {}
    with path.open(encoding='utf-8-sig', newline='') as f:
        reader = csv.DictReader(f)
        if not {'candidate_id', 'review_decision'}.issubset(reader.fieldnames or []):
            raise ValueError('CSV requires candidate_id and review_decision')
        for row in reader:
            raw = {k: (v or '').strip() for k, v in row.items() if k is not None}
            cid = raw.get('candidate_id')
            if not cid:
                continue
            raw['review_decision'] = raw.get('review_decision', '').lower()
            if raw['review_decision'] not in ALLOWED_DECISIONS or cid in decisions:
                raise ValueError(f'invalid/duplicate CSV decision: {raw}')
            decisions[cid] = raw
    return decisions


def resolve_reviews(bundle, decisions, master_rows, *, history=()):
    result = copy.deepcopy(bundle)
    result['review_schema'] = 'p0-03-sample-review-v2'
    result['master_rows'] = [m.to_public() for m in master_rows]
    masters = {m.row_index: m.to_public() for m in master_rows}
    by_id = {c['candidate_id']: c for c in result['candidates']}
    current, historic, assigned = defaultdict(list), defaultdict(set), defaultdict(list)
    for c in by_id.values():
        current[source_identity(c)].append(c['candidate_id'])
    for b in (bundle, *history):
        for c in b['candidates']:
            historic[c['candidate_id']].add(source_identity(c))
            for previous_id in c.get('candidate_id_lineage', []):
                historic[previous_id].add(source_identity(c))
            for record in c.get('decision_records', []):
                historic[record['candidate_id']].add(source_identity(c))
            # Same frozen review may be reapplied with clear/defer edits. This is
            # source-record lineage within the sample, not a reusable SKU binding.
            saved = c.get('validated_manual_jushuitan') or c.get('selected_jushuitan') or {}
            if saved.get('original_candidate_id') and saved.get('source'):
                historic[saved['original_candidate_id']].add(source_identity(saved))

    def resolve_id(cid):
        if cid in by_id:
            return cid
        keys = historic.get(cid, set())
        targets = current.get(next(iter(keys)), []) if len(keys) == 1 else []
        return targets[0] if len(targets) == 1 else None

    unapplied = []
    for cid, raw in decisions.items():
        dest = resolve_id(cid)
        if dest:
            assigned[dest].append(raw)
        elif raw.get('review_decision') or any(raw.get(k) for k in MANUAL_FIELDS):
            records = [c for b in history for c in b['candidates'] if c['candidate_id'] == cid]
            unapplied.append({'csv_record': raw, 'historical_records': records, 'reason': 'not_in_current_sample_or_not_unique'})
    # Revocation is a historical event, independent of the current CSV snapshot.
    events = copy.deepcopy(bundle.get('correction_events') or [])
    for previous in history:
        for event in previous.get('correction_events') or []:
            if event not in events:
                events.append(copy.deepcopy(event))
    for cid, c in by_id.items():
        previous_decisions = copy.deepcopy(c.get('decision_records') or [])
        if not previous_decisions and c.get('review_decision'):
            previous_decisions = [{'candidate_id': cid, 'review_decision': c['review_decision'],
                                   'review_notes': c.get('review_notes') or ''}]
        c['previous_review'] = {k: c.get(k) for k in ('review_decision', 'review_notes', *MANUAL_FIELDS)}
        for k in list(c):
            if k.startswith('formal_mapping_'):
                del c[k]
        options = assigned.get(cid, [])
        signatures = {tuple(r.get(k, '') for k in ('review_decision', 'review_notes', *MANUAL_FIELDS)) for r in options}
        raw = options[0] if len(signatures) == 1 else {}
        decision = raw.get('review_decision', '')
        c.update(review_decision=decision or None, review_notes=raw.get('review_notes', ''),
                 review_source='explicit_csv' if options else 'none', decision_records=options,
                 selected_master=None, selected_jushuitan=None, validation_errors=[])
        c.pop('validated_manual_jushuitan', None)
        c['manual_jushuitan_conflict'] = None
        c['historical_correction_reason'] = ''
        for k in MANUAL_FIELDS:
            c[k] = raw.get(k, '')
        errors = c['validation_errors']
        if len(signatures) > 1:
            errors.append('conflicting_csv_records_for_same_source')
        target = None
        has_manual = any(raw.get(k) for k in MANUAL_FIELDS)
        if has_manual:
            try:
                original_row = int(raw.get('manual_master_row', ''))
                alias = result.get('master_row_aliases', {}).get(str(original_row), original_row)
                target = masters.get(alias)
            except ValueError:
                pass
            if not target:
                errors.append('manual_master_row_missing_or_invalid')
            elif raw.get('manual_master_ice') != target['ice_code'] and not any(
                m['row_index'] == original_row and m['ice_code'] == raw.get('manual_master_ice')
                for m in result.get('original_master_rows', [])):
                errors.append('manual_ice_does_not_match_excel_row')
                target = None
            elif not target['ice_code']:
                errors.append('manual_target_has_no_ice_code')
                target = None
        elif decision == 'confirm':
            matches = c.get('master_matches') or []
            if len(matches) == 1:
                m = matches[0]
                target = masters.get(m.get('row_index'))
                if not target or target['ice_code'] != m.get('ice_code'):
                    target = None
                    errors.append('candidate_target_not_in_master')
            else:
                errors.append('confirm_requires_one_valid_target')
        if target:
            reason = target_error(c, target)
            if reason and not (reason != 'outside_batch_rules' and batch_target_authorized(result, c, target)):
                errors.append(reason)
                target = None
        c['validated_manual_target'] = target if has_manual else None
        jst_id, jst_sku = raw.get('manual_jst_candidate_id', ''), raw.get('manual_jst_sku', '')
        if jst_id or jst_sku:
            resolved = resolve_id(jst_id)
            src = (by_id.get(resolved) or {}).get('source') or {}
            if src.get('source_system') != 'jushuitan' or src.get('external_sku_raw') != jst_sku:
                errors.append('manual_jushuitan_missing_ambiguous_or_sku_mismatch')
            else:
                c['validated_manual_jushuitan'] = {'candidate_id': resolved, 'original_candidate_id': jst_id, 'source': copy.deepcopy(src)}
        if decision in ('reject', 'ignore', 'defer', 'clear'):
            c['review_state'] = {'reject': 'rejected', 'ignore': 'ignored', 'defer': 'pending', 'clear': 'pending'}[decision]
            c['review_reason'] = {'reject': 'reviewer_rejected', 'ignore': 'reviewer_ignored', 'defer': 'deferred', 'clear': 'cleared'}[decision]
        elif target and not errors and decision == 'confirm':
            c.update(selected_master=target, selected_jushuitan=c.get('validated_manual_jushuitan'), review_state='manual_selected', review_reason='本批人工资料选择；资料冲突仍保留，不代表正式绑定方案')
        else:
            c['review_state'] = 'candidate' if c.get('master_matches') and not errors and not decision else 'pending'
            if c.get('lifecycle') == 'outside_rules':
                c['review_state'] = 'outside_rules'
            c['review_reason'] = ';'.join(errors) or 'awaiting_review'
        s = c.get('source') or {}
        if s.get('source_system') == 'bigseller' and s.get('warehouse') == '菲律宾-新创启辰自建仓' and s.get('external_sku_raw') == 'ICEWM0039':
            if not any(e.get('candidate_id') == cid and e.get('action') == 'revoke' for e in events):
                original = previous_decisions or (options if decision == 'confirm' else [])
                events.append({'candidate_id': cid, 'source': copy.deepcopy(s), 'previous_candidates': copy.deepcopy(c.get('previous_master_matches', c.get('master_matches'))), 'original_decision': copy.deepcopy(original), 'action': 'revoke', 'reason': CORRECTION_REASON, 'replacement': None})
            c['historical_correction_reason'] = CORRECTION_REASON
            # No replacement has been authorized in this sample. Negative current
            # decisions still take effect; a historical revoke must not become defer.
            authorized_replacement = target and target['ice_code'] == 'WM0039' and batch_target_authorized(result, c, target)
            if not authorized_replacement:
                c.update(selected_master=None, selected_jushuitan=None)
            if not authorized_replacement and decision not in ('reject', 'ignore', 'clear', 'defer'):
                c.update(review_state='pending', review_reason=CORRECTION_REASON)
        c['retained_quality_flags'] = list(c.get('flags') or [])
        c['selected_master_quality_issues'] = [i for i in result.get('master_quality_issues', []) if target and target['row_index'] in i.get('row_indices', [])]

    # Resolve both sides before comparing. Only their actual selected Excel rows
    # establish a contradiction; different supplier SKU strings do not.
    selected_rows = {cid: copy.deepcopy(c.get('selected_master')) for cid, c in by_id.items()}
    for cid, c in by_id.items():
        reference = c.get('selected_jushuitan') or {}
        target = selected_rows[cid]
        jst_target = selected_rows.get(reference.get('candidate_id'))
        if target and jst_target and target['row_index'] != jst_target['row_index']:
            conflict = {'selected_master_row': target['row_index'], 'selected_master_ice': target['ice_code'],
                        'jst_candidate_id': reference['candidate_id'],
                        'jst_selected_master_row': jst_target['row_index'], 'jst_selected_master_ice': jst_target['ice_code']}
            c['validation_errors'].append('manual_jushuitan_master_row_conflict')
            c.update(manual_jushuitan_conflict=conflict, selected_master=None, selected_jushuitan=None,
                     review_state='pending', review_reason=f"人工所选主库行 {target['row_index']} 与引用 JST 已选主库行 {jst_target['row_index']} 矛盾，待核对；保留原填写内容，不替换目标")
    result.update(correction_events=events, unapplied_decisions=unapplied,
                  review_summary=dict(Counter(c['review_state'] for c in by_id.values())))
    result.setdefault('summary', {})['review'] = result['review_summary']
    result['summary'].pop('auto_clean_review', None)
    return result
