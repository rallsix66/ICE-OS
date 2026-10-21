"""从三份样表加载主资料与来源行（只读，不写库）。"""
from __future__ import annotations

from pathlib import Path

import pandas as pd

from . import config as cfg
from .models import MasterRow, SourceRow
from .normalize import as_string, is_combo_sku, normalize_key


def load_master(path: Path) -> list[MasterRow]:
    df = pd.read_excel(path, sheet_name=cfg.MASTER_SHEET, header=0, dtype=str)
    rows: list[MasterRow] = []
    for idx, row in df.iterrows():
        # Skip empty Excel records without renumbering the remaining source rows.
        if not any(as_string(value).strip() for value in row):
            continue
        rows.append(
            MasterRow(
                row_index=int(idx) + 2,
                ice_code=normalize_key(row.get(cfg.MASTER_COL_ICE)),
                barcode=normalize_key(row.get(cfg.MASTER_COL_BARCODE)),
                name_cn=as_string(row.get(cfg.MASTER_COL_NAME)),
                spec=as_string(row.get(cfg.MASTER_COL_SPEC)),
            )
        )
    return rows


def _bigseller_scope(warehouse: str, sheet_name: str, raw_sku: str, sku_type: str) -> str:
    if warehouse != cfg.TARGET_INVENTORY_WAREHOUSE:
        return cfg.SCOPE_MATCH_ONLY
    if is_combo_sku(raw_sku, sheet_name, sku_type):
        return cfg.SCOPE_MATCH_ONLY
    if sheet_name != cfg.BIGSELLER_SHEET_SINGLE:
        return cfg.SCOPE_MATCH_ONLY
    return cfg.SCOPE_INVENTORY_PUBLISH


def load_bigseller(path: Path) -> list[SourceRow]:
    """加载 BigSeller 库存行；组合 SKU 整表/整行跳过，不进入匹配与核对。"""
    out: list[SourceRow] = []
    with pd.ExcelFile(path) as xl:
        sheet_names = [s for s in xl.sheet_names if s != cfg.BIGSELLER_SHEET_COMBO]
    for sheet_name in sheet_names:
        df = pd.read_excel(path, sheet_name=sheet_name, header=0, dtype=str)
        sku_type_col = 'SKU类型' if 'SKU类型' in df.columns else None
        for idx, row in df.iterrows():
            warehouse = as_string(row.get(cfg.BIGSELLER_COL_WAREHOUSE))
            raw_sku = as_string(row.get(cfg.BIGSELLER_COL_SKU))
            if not raw_sku:
                continue
            sku_type = as_string(row.get(sku_type_col)) if sku_type_col else ''
            if is_combo_sku(raw_sku, sheet_name, sku_type):
                continue
            scope = _bigseller_scope(warehouse, sheet_name, raw_sku, sku_type)
            row_key = f'bigseller:{sheet_name}:{idx + 2}:{warehouse}:{raw_sku}'
            out.append(
                SourceRow(
                    source_system=cfg.SOURCE_BIGSELLER,
                    source_row_key=row_key,
                    scope=scope,
                    warehouse=warehouse or None,
                    external_sku_raw=raw_sku,
                    external_name=as_string(row.get(cfg.BIGSELLER_COL_NAME)),
                    sheet_name=sheet_name,
                    gtin_raw=as_string(row.get(cfg.BIGSELLER_COL_GTIN)) or None,
                    available_qty=as_string(row.get(cfg.BIGSELLER_COL_AVAILABLE)) or None,
                    extra={
                        'is_combo': is_combo_sku(raw_sku, sheet_name, sku_type),
                        'sku_type': sku_type or None,
                    },
                )
            )
    return out


def _jushuitan_business_key(row: SourceRow) -> tuple[str, str]:
    extra = row.extra or {}
    style = normalize_key(extra.get('style_code') or '')
    sku = normalize_key(extra.get('product_code') or row.external_sku_raw)
    return style, sku


def load_jushuitan_merged(*paths: Path) -> list[SourceRow]:
    """多份聚水潭导出合并；同一款式+商品编码以后出现的文件为准。"""
    by_key: dict[tuple[str, str], SourceRow] = {}
    for path in paths:
        for row in load_jushuitan(path):
            by_key[_jushuitan_business_key(row)] = row
    return list(by_key.values())


def load_jushuitan(path: Path) -> list[SourceRow]:
    df = pd.read_excel(path, header=0, dtype=str)
    out: list[SourceRow] = []
    for idx, row in df.iterrows():
        style = normalize_key(row.get(cfg.JST_COL_STYLE))
        sku = normalize_key(row.get(cfg.JST_COL_SKU))
        if not style and not sku:
            continue
        raw = sku or style
        row_key = f'jushuitan:{idx + 2}:{style}:{sku}'
        out.append(
            SourceRow(
                source_system=cfg.SOURCE_JUSHUITAN,
                source_row_key=row_key,
                scope=cfg.SCOPE_MATCH_ONLY,
                warehouse=None,
                external_sku_raw=raw,
                external_name=as_string(row.get(cfg.JST_COL_NAME)),
                sheet_name='Sheet1',
                available_qty=as_string(row.get(cfg.JST_COL_AVAILABLE)) or None,
                extra={
                    'style_code': style or None,
                    'product_code': sku or None,
                    'spec': as_string(row.get(cfg.JST_COL_SPEC)) or None,
                    'actual_qty': as_string(row.get(cfg.JST_COL_ACTUAL)) or None,
                    'cloud_available_qty': as_string(row.get(cfg.JST_COL_CLOUD_AVAILABLE)) or None,
                },
            )
        )
    return out
