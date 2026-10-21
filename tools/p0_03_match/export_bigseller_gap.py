"""BigSeller 有库存、规则内仍未匹配 — 缺口清单。"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from .bigseller_centric import build_bigseller_summary
from .table_catalog import candidate_to_csv_row


def export_bigseller_stock_unmatched_csv(bundle: dict[str, Any], path: Path) -> None:
    summary = build_bigseller_summary(bundle)
    want = set(summary.get('in_stock_unmatched_candidate_ids') or [])
    rows = [
        candidate_to_csv_row(c)
        for c in bundle.get('candidates') or []
        if c.get('candidate_id') in want
    ]
    if not rows:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('candidate_id\n', encoding='utf-8-sig')
        return
    import csv

    fieldnames: list[str] = []
    for row in rows:
        for k in row:
            if k not in fieldnames:
                fieldnames.append(k)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        w.writerows(rows)
