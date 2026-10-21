"""聚水潭匹配结果 CSV。"""
from __future__ import annotations

import csv
from pathlib import Path
from typing import Any

from . import config as cfg
from .table_catalog import candidate_to_csv_row


def export_jushuitan_match_csv(bundle: dict[str, Any], path: Path) -> None:
    rows = [
        candidate_to_csv_row(c)
        for c in bundle.get('candidates') or []
        if (c.get('source') or {}).get('source_system') == cfg.SOURCE_JUSHUITAN
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    if not rows:
        path.write_text('candidate_id\n', encoding='utf-8-sig')
        return
    fieldnames: list[str] = []
    for row in rows:
        for k in row:
            if k not in fieldnames:
                fieldnames.append(k)
    with path.open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        w.writerows(rows)
