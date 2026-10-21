"""BigSeller 为主轴的匹配汇总（优先有库存、规则内未匹配）。"""
from __future__ import annotations

from typing import Any

from . import config as cfg
from .master_centric import is_in_stock_bigseller_candidate, parse_available_qty
from .match_policy import LIFECYCLE_OUTSIDE, is_in_policy_candidate


def _is_bigseller(candidate: dict[str, Any]) -> bool:
    return (candidate.get('source') or {}).get('source_system') == cfg.SOURCE_BIGSELLER


def match_rule_label(candidate: dict[str, Any]) -> str:
    if not _is_bigseller(candidate):
        return '聚水潭·款号/编码'
    if candidate.get('lifecycle') == LIFECYCLE_OUTSIDE:
        return '规则外'
    src = candidate.get('source') or {}
    wh = src.get('warehouse') or ''
    if cfg.PH_WAREHOUSE_KEYWORD in wh:
        return '菲律宾·货号(少数匹配条码)'
    return '其他市场·匹配条码'


def build_bigseller_summary(bundle: dict[str, Any]) -> dict[str, Any]:
    bs_total = 0
    in_stock = 0
    in_stock_in_policy = 0
    in_stock_matched = 0
    in_stock_unmatched = 0
    in_stock_outside = 0
    in_stock_pending_review = 0
    unmatched_ids: list[str] = []

    for c in bundle.get('candidates') or []:
        if not _is_bigseller(c):
            continue
        bs_total += 1
        if not is_in_stock_bigseller_candidate(c):
            continue
        in_stock += 1
        cid = c.get('candidate_id') or ''
        if not is_in_policy_candidate(c):
            in_stock_outside += 1
            continue
        in_stock_in_policy += 1
        lc = c.get('lifecycle')
        if lc == 'pending_review' and (c.get('master_matches') or []):
            in_stock_matched += 1
            in_stock_pending_review += 1
        elif lc == 'unmatched':
            in_stock_unmatched += 1
            unmatched_ids.append(cid)

    return {
        'bigseller_row_count': bs_total,
        'in_stock_row_count': in_stock,
        'in_stock_in_policy': in_stock_in_policy,
        'in_stock_pending_review': in_stock_pending_review,
        'in_stock_matched': in_stock_matched,
        'in_stock_unmatched': in_stock_unmatched,
        'in_stock_outside_rules': in_stock_outside,
        'in_stock_unmatched_candidate_ids': unmatched_ids,
    }


def _manual_master_linked_ids(embedded_reviews: dict[str, dict[str, Any]]) -> set[str]:
    out: set[str] = set()
    for cid, rev in embedded_reviews.items():
        if (rev.get('manual_master_row') or '').strip():
            out.add(cid)
    return out


def build_workbench_queue_summary(
    bundle: dict[str, Any],
    embedded_reviews: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """第二页队列：引擎仍 unmatched、且未在 CSV/人工对照中挂到商品库。"""
    embedded_reviews = embedded_reviews or {}
    summary = dict(build_bigseller_summary(bundle))
    resolved = _manual_master_linked_ids(embedded_reviews)

    queue_all: list[str] = []
    queue_in_stock: list[str] = []
    for c in bundle.get('candidates') or []:
        if not _is_bigseller(c):
            continue
        if not is_in_policy_candidate(c):
            continue
        if c.get('lifecycle') != 'unmatched':
            continue
        cid = c.get('candidate_id') or ''
        if not cid or cid in resolved:
            continue
        queue_all.append(cid)
        if is_in_stock_bigseller_candidate(c):
            queue_in_stock.append(cid)

    engine_unmatched = set(summary.get('in_stock_unmatched_candidate_ids') or [])
    summary['workbench_resolved_manual_ids'] = sorted(resolved & engine_unmatched)
    summary['workbench_queue_candidate_ids'] = queue_all
    summary['workbench_queue_count'] = len(queue_all)
    summary['workbench_in_stock_queue_ids'] = queue_in_stock
    summary['workbench_in_stock_queue_count'] = len(queue_in_stock)
    return summary
