"""把人工对照（CSV 中的 manual_* 列）合并进三表总览。"""
from __future__ import annotations

from typing import Any

from . import config as cfg
from .models import MasterRow
from .unified_view import _link_from_candidate


def _master_public(master_rows: list[MasterRow], row_index: int) -> dict[str, Any] | None:
    for m in master_rows:
        if m.row_index == row_index:
            return m.to_public()
    return None


def augment_unified_with_manual(
    bundle: dict[str, Any],
    unified: dict[str, Any],
    embedded_reviews: dict[str, dict[str, Any]],
    master_rows: list[MasterRow] | None,
) -> dict[str, Any]:
    if bundle.get('review_schema'):
        from .unified_view import build_unified_rows
        return build_unified_rows(bundle)
    if not master_rows:
        return unified

    by_id = {c['candidate_id']: c for c in bundle.get('candidates') or []}
    rows = list(unified.get('rows') or [])
    seen_unified: set[str] = {u.get('unifiedId') or '' for u in rows}
    manual_full = manual_partial = 0

    for cid, rev in embedded_reviews.items():
        if rev.get('decision') != 'confirm':
            continue
        raw_row = (rev.get('manual_master_row') or '').strip()
        if not raw_row:
            continue
        try:
            master_idx = int(raw_row)
        except ValueError:
            continue
        cand = by_id.get(cid)
        if not cand:
            continue
        src = cand.get('source') or {}
        if src.get('source_system') != cfg.SOURCE_BIGSELLER:
            continue
        mp = _master_public(master_rows, master_idx)
        if not mp:
            continue
        if rev.get('manual_master_ice') != mp.get('ice_code'):
            continue
        from .review_result import target_error
        if target_error(cand, mp):
            continue

        unified_id = f'manual-{cid}'
        if unified_id in seen_unified:
            continue
        seen_unified.add(unified_id)

        bs_link = _link_from_candidate(cand)
        jst_links: list[dict[str, Any]] = []
        jst_cid = (rev.get('manual_jst_candidate_id') or '').strip()
        if jst_cid and jst_cid in by_id:
            jst_cand = by_id[jst_cid]
            if (jst_cand.get('source') or {}).get('source_system') == cfg.SOURCE_JUSHUITAN:
                jst_links.append(_link_from_candidate(jst_cand))

        tier = 'manual_full' if jst_links else 'manual_partial'
        if tier == 'manual_full':
            manual_full += 1
        else:
            manual_partial += 1

        rows.append(
            {
                'unifiedId': unified_id,
                'tier': tier,
                'manualWorkbench': True,
                'master': {
                    'rowIndex': mp.get('row_index'),
                    'iceCode': mp.get('ice_code') or '',
                    'barcode': mp.get('barcode') or '',
                    'nameCn': mp.get('name_cn') or '',
                    'spec': mp.get('spec') or '',
                },
                'bigseller': [bs_link],
                'jushuitan': jst_links,
                'hasInStockBigseller': bs_link.get('inStock', False),
                'hasInStockJushuitan': any(x.get('inStock') for x in jst_links),
                'candidateIds': [cid] + [x['candidateId'] for x in jst_links if x.get('candidateId')],
            }
        )

    summary = dict(unified.get('summary') or {})
    summary['three_way_linked'] = summary.get('three_way_linked', 0)
    summary['manual_full_linked'] = manual_full
    summary['manual_partial_linked'] = manual_partial
    summary['overview_rows'] = (
        summary.get('three_way_linked', 0) + manual_full + manual_partial
    )

    return {**unified, 'rows': rows, 'summary': summary}
