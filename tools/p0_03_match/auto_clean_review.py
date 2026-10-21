"""三表齐且品名一致只作提示，不生成或覆盖人工决定。"""
from __future__ import annotations

from typing import Any

from .match_policy import is_in_policy_candidate

# 自动提示的冲突过滤；不是未来正式绑定的准入规则。
BLOCK_CONFIRM_FLAGS = frozenset(
    {
        'ONE_TO_MANY',
        'COMBO_SKU',
        'MASTER_DUPLICATE_ICE',
        'MASTER_DUPLICATE_BARCODE',
        'MASTER_SPEC_CONFLICT',
    }
)
from .unified_view import build_unified_rows

AUTO_CLEAN_NOTE = '核对提示：三表齐·品名一致·无冲突；仍需人工决定'


def full_chain_master_row_indices(bundle: dict[str, Any]) -> set[int]:
    uv = build_unified_rows(bundle)
    out: set[int] = set()
    for u in uv.get('rows') or []:
        if u.get('tier') != 'full':
            continue
        m = u.get('master') or {}
        ri = m.get('rowIndex')
        if ri is not None:
            out.add(int(ri))
    return out


def is_auto_clean_eligible(candidate: dict[str, Any], full_chain_rows: set[int]) -> bool:
    if candidate.get('lifecycle') != 'pending_review':
        return False
    if not is_in_policy_candidate(candidate):
        return False
    flags = set(candidate.get('flags') or [])
    if flags.intersection(BLOCK_CONFIRM_FLAGS):
        return False
    if (candidate.get('name_review') or {}).get('status') != 'NAME_EXACT':
        return False
    matches = candidate.get('master_matches') or []
    if len(matches) != 1:
        return False
    return int(matches[0]['row_index']) in full_chain_rows


def auto_clean_candidate_ids(bundle: dict[str, Any]) -> set[str]:
    full = full_chain_master_row_indices(bundle)
    ids: set[str] = set()
    for c in bundle.get('candidates') or []:
        cid = c.get('candidate_id')
        if cid and is_auto_clean_eligible(c, full):
            ids.add(cid)
    return ids


def stamp_auto_clean_review(bundle: dict[str, Any], *, respect_existing: bool = True) -> dict[str, Any]:
    """仅写入候选提示；不生成或覆盖人工决定。"""
    full = full_chain_master_row_indices(bundle)
    stamped: list[str] = []
    for c in bundle.get('candidates') or []:
        cid = c.get('candidate_id')
        if not cid:
            continue
        existing = (c.get('review_decision') or '').strip().lower()
        if respect_existing and existing in ('confirm', 'reject', 'ignore', 'defer', 'clear'):
            continue
        if not is_auto_clean_eligible(c, full):
            continue
        c['review_suggestion'] = 'clean_candidate_only'
        stamped.append(cid)

    summary = bundle.setdefault('summary', {})
    summary['auto_clean_review'] = {
        'stamped_count': len(stamped),
        'full_chain_master_rows': len(full),
        'candidate_ids': stamped,
    }
    return bundle


def enrich_unified_review_flags(bundle: dict[str, Any], unified: dict[str, Any]) -> dict[str, Any]:
    """为串联行标注是否整行已自动通过、是否仍需人工。"""
    full = full_chain_master_row_indices(bundle)
    auto_ids = auto_clean_candidate_ids(bundle)

    for u in unified.get('rows') or []:
        ids = u.get('candidateIds') or []
        tier = u.get('tier')
        if tier != 'full' or not ids:
            u['needsManualReview'] = True
            u['autoCleanRow'] = False
            continue
        u['autoCleanRow'] = all(cid in auto_ids for cid in ids)
        u['needsManualReview'] = not u['autoCleanRow']

    uni_sum = unified.setdefault('summary', {})
    rows = unified.get('rows') or []
    uni_sum['auto_clean_unified_rows'] = sum(1 for u in rows if u.get('autoCleanRow'))
    uni_sum['needs_manual_unified_rows'] = sum(1 for u in rows if u.get('needsManualReview'))
    return unified
