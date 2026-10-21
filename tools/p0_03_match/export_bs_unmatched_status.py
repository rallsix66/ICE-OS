"""BigSeller 有库存仍未挂商品库 — 含人工对照与核对状态。"""
from __future__ import annotations

import csv
from pathlib import Path
from typing import Any

from .bigseller_centric import build_workbench_queue_summary
from .master_centric import parse_available_qty


def export_bs_in_stock_unmatched_status(
    bundle: dict[str, Any],
    embedded_reviews: dict[str, dict[str, Any]] | None,
    path: Path,
) -> dict[str, int]:
    embedded_reviews = embedded_reviews or {}
    summary = build_workbench_queue_summary(bundle, embedded_reviews)
    want = set(summary.get('workbench_in_stock_queue_ids') or [])
    rows_out: list[dict[str, str]] = []
    with_manual = 0

    for c in bundle.get('candidates') or []:
        cid = c.get('candidate_id') or ''
        if cid not in want:
            continue
        src = c.get('source') or {}
        rev = embedded_reviews.get(cid) or {}
        manual_row = (rev.get('manual_master_row') or '').strip()
        manual_ice = (rev.get('manual_master_ice') or '').strip()
        if manual_row or manual_ice:
            with_manual += 1
        rows_out.append(
            {
                'candidate_id': cid,
                'sku': src.get('external_sku_raw') or '',
                'name': src.get('external_name') or '',
                'warehouse': src.get('warehouse') or '',
                'available_qty': src.get('available_qty') or '',
                'engine_lifecycle': c.get('lifecycle') or '',
                'review_decision': rev.get('decision') or '',
                'manual_master_row': manual_row,
                'manual_master_ice': manual_ice,
                'manual_jst_candidate_id': (rev.get('manual_jst_candidate_id') or '').strip(),
                'manual_jst_sku': (rev.get('manual_jst_sku') or '').strip(),
                'still_engine_unmatched': 'yes',
            }
        )

    rows_out.sort(key=lambda r: (-parse_available_qty(r.get('available_qty')), r.get('sku') or ''))
    fields = [
        'candidate_id',
        'sku',
        'name',
        'warehouse',
        'available_qty',
        'engine_lifecycle',
        'review_decision',
        'manual_master_row',
        'manual_master_ice',
        'manual_jst_candidate_id',
        'manual_jst_sku',
        'still_engine_unmatched',
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(rows_out)

    return {
        'in_stock_unmatched': len(rows_out),
        'with_manual_master_in_csv': with_manual,
        'without_manual_master': len(rows_out) - with_manual,
    }
