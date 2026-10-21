"""聚水潭 ↔ 商品库匹配汇总（与 BigSeller 并列展示）。"""
from __future__ import annotations

from typing import Any

from . import config as cfg


def _is_jushuitan(candidate: dict[str, Any]) -> bool:
    return (candidate.get('source') or {}).get('source_system') == cfg.SOURCE_JUSHUITAN


def build_jushuitan_summary(bundle: dict[str, Any]) -> dict[str, Any]:
    total = 0
    pending_review = 0
    unmatched = 0
    unmatched_ids: list[str] = []
    pending_ids: list[str] = []
    methods: dict[str, int] = {}

    for c in bundle.get('candidates') or []:
        if not _is_jushuitan(c):
            continue
        total += 1
        cid = c.get('candidate_id') or ''
        for m in c.get('match_methods') or []:
            methods[m] = methods.get(m, 0) + 1
        if c.get('lifecycle') == 'pending_review' and (c.get('master_matches') or []):
            pending_review += 1
            pending_ids.append(cid)
        elif c.get('lifecycle') == 'unmatched':
            unmatched += 1
            unmatched_ids.append(cid)

    return {
        'jushuitan_row_count': total,
        'pending_review': pending_review,
        'unmatched': unmatched,
        'match_method_counts': methods,
        'pending_candidate_ids': pending_ids,
        'unmatched_candidate_ids': unmatched_ids,
        'match_rule': '款式编码/商品编码 → 商品库 G 列货号或 H 列匹配条码',
    }
