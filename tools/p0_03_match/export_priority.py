"""导出优先核对 CSV（列名标明所属表）。"""
from __future__ import annotations

import csv
from pathlib import Path
from typing import Any

from .table_catalog import candidate_to_csv_row


def export_priority_csv(priority: dict[str, Any], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    rows = []
    for c in priority.get('candidates') or []:
        row = candidate_to_csv_row(c)
        src = c.get('source') or {}
        wh = src.get('warehouse') or ''
        row['优先分组'] = '菲律宾单SKU' if '菲律宾' in wh else (
            '聚水潭' if src.get('source_system') == 'jushuitan' else '其他'
        )
        rows.append(row)
    fieldnames: list[str] = []
    for row in rows:
        for key in row:
            if key not in fieldnames:
                fieldnames.append(key)
    if '优先分组' in fieldnames:
        fieldnames.remove('优先分组')
        fieldnames.insert(0, '优先分组')
    with path.open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        w.writerows(rows)


def export_priority_only(bundle: dict[str, Any], path: Path) -> None:
    """从全量 bundle 筛优先项导出（与 build_priority_bundle 一致）。"""
    from .priority_review import build_priority_bundle

    export_priority_csv(build_priority_bundle(bundle), path)
