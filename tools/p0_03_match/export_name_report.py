"""品名核对专项 CSV（优先清单 + 品名冲突）。"""
from __future__ import annotations

import csv
from pathlib import Path
from typing import Any

from .match_policy import is_in_policy_candidate
from .table_catalog import candidate_to_csv_row


def export_name_focus_csv(bundle: dict[str, Any], path: Path) -> None:
    """导出：货号已匹配但品名不一致 + 货号未匹配但品名唯一命中。"""
    focus_status = {
        'NAME_MISMATCH',
        'NAME_SIMILAR',
        'NAME_ONLY_HINT',
        'NAME_ONLY_AMBIGUOUS',
        'NAME_MISSING',
    }
    rows = []
    for c in bundle.get('candidates') or []:
        if not is_in_policy_candidate(c):
            continue
        nr = c.get('name_review') or {}
        if nr.get('status') not in focus_status:
            continue
        if 'COMBO_SKU' in (c.get('flags') or []):
            continue
        row = candidate_to_csv_row(c)
        rows.append(row)
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
