"""导出匹配明细与人工核对表。"""
from __future__ import annotations

import csv
import json
from pathlib import Path
from typing import Any

import pandas as pd

from .match_policy import LIFECYCLE_OUTSIDE
from .table_catalog import candidate_to_csv_row


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def export_outside_rules_csv(bundle: dict[str, Any], path: Path) -> None:
    rows = [
        candidate_to_csv_row(c)
        for c in bundle['candidates']
        if c.get('lifecycle') == LIFECYCLE_OUTSIDE
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    fieldnames: list[str] = []
    for row in rows:
        for key in row:
            if key not in fieldnames:
                fieldnames.append(key)
    with path.open('w', encoding='utf-8-sig', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def export_review_csv(bundle: dict[str, Any], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    rows = [candidate_to_csv_row(c) for c in bundle['candidates']]
    fieldnames: list[str] = []
    for row in rows:
        for key in row:
            if key not in fieldnames:
                fieldnames.append(key)
    with path.open('w', encoding='utf-8-sig', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def export_review_xlsx(bundle: dict[str, Any], path: Path) -> None:
    csv_path = path.with_suffix('.csv')
    export_review_csv(bundle, csv_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    in_policy = [
        candidate_to_csv_row(c)
        for c in bundle['candidates']
        if c.get('lifecycle') != LIFECYCLE_OUTSIDE
    ]
    outside_rows = [
        candidate_to_csv_row(c)
        for c in bundle['candidates']
        if c.get('lifecycle') == LIFECYCLE_OUTSIDE
    ]
    with pd.ExcelWriter(path, engine='openpyxl') as writer:
        pd.DataFrame(in_policy).to_excel(writer, sheet_name='规则内待核对', index=False)
        if outside_rows:
            pd.DataFrame(outside_rows).to_excel(writer, sheet_name='规则外单独处理', index=False)
        issues = pd.DataFrame(bundle.get('master_quality_issues') or [])
        if not issues.empty:
            issues.to_excel(writer, sheet_name='主资料质量问题', index=False)
        summary = pd.json_normalize(bundle.get('summary') or {})
        if not summary.empty:
            summary.to_excel(writer, sheet_name='汇总', index=False)


def export_inventory_publish_preview(bundle: dict[str, Any], path: Path) -> None:
    """DEE 单 SKU 发布范围预览 — 不含已确认映射，仅数量与候选引用。"""
    rows = []
    for c in bundle['candidates']:
        src = c['source']
        if src['scope'] != 'inventory_publish':
            continue
        rows.append(
            {
                'candidate_id': c['candidate_id'],
                'warehouse': src.get('warehouse'),
                'external_sku_raw': src['external_sku_raw'],
                'external_name': src['external_name'],
                'available_qty': src.get('available_qty'),
                'lifecycle': c['lifecycle'],
                'flags': ';'.join(c['flags']),
                'master_match_count': len(c['master_matches']),
            }
        )
    write_json(path, {'rows': rows, 'row_count': len(rows)})
