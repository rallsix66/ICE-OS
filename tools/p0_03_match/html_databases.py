"""核对页内嵌三表「数据库」快照（只读，供浏览器内搜索与人工对照）。"""
from __future__ import annotations

from typing import Any

from . import config as cfg
from .master_centric import parse_available_qty
from .models import MasterRow


def build_master_database(master_rows: list[MasterRow]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for row in master_rows:
        if not (row.ice_code or row.barcode or row.name_cn):
            continue
        out.append(
            {
                'id': f'm-{row.row_index}',
                'rowIndex': row.row_index,
                'iceCode': row.ice_code or '',
                'barcode': row.barcode or '',
                'nameCn': row.name_cn or '',
                'spec': row.spec or '',
            }
        )
    return out


def _primary_master(matches: list[dict[str, Any]]) -> dict[str, Any] | None:
    if len(matches) == 1:
        return matches[0]
    return None


def build_bigseller_database(bundle: dict[str, Any]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for c in bundle.get('candidates') or []:
        src = c.get('source') or {}
        if src.get('source_system') != cfg.SOURCE_BIGSELLER:
            continue
        primary = _primary_master(c.get('master_matches') or [])
        out.append(
            {
                'candidateId': c.get('candidate_id') or '',
                'lifecycle': c.get('lifecycle') or '',
                'sku': src.get('external_sku_raw') or '',
                'name': src.get('external_name') or '',
                'warehouse': src.get('warehouse') or '',
                'qty': src.get('available_qty') or '',
                'inStock': parse_available_qty(src.get('available_qty')) > 0,
                'sheet': src.get('sheet_name') or '',
                'scope': src.get('scope') or '',
                'matchedIce': (primary or {}).get('ice_code') or '',
                'matchedBarcode': (primary or {}).get('barcode') or '',
                'matchedMasterRow': (primary or {}).get('row_index'),
                'flags': c.get('flags') or [],
            }
        )
    return out


def build_jushuitan_database(bundle: dict[str, Any]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for c in bundle.get('candidates') or []:
        src = c.get('source') or {}
        if src.get('source_system') != cfg.SOURCE_JUSHUITAN:
            continue
        extra = src.get('extra') or {}
        primary = _primary_master(c.get('master_matches') or [])
        out.append(
            {
                'candidateId': c.get('candidate_id') or '',
                'lifecycle': c.get('lifecycle') or '',
                'styleCode': extra.get('style_code') or '',
                'productCode': extra.get('product_code') or '',
                'sku': src.get('external_sku_raw') or '',
                'name': src.get('external_name') or '',
                'spec': extra.get('spec') or '',
                'qty': src.get('available_qty') or '',
                'actualQty': extra.get('actual_qty') or '',
                'cloudQty': extra.get('cloud_available_qty') or '',
                'inStock': parse_available_qty(src.get('available_qty')) > 0,
                'matchedIce': (primary or {}).get('ice_code') or '',
                'matchedBarcode': (primary or {}).get('barcode') or '',
                'matchedMasterRow': (primary or {}).get('row_index'),
                'flags': c.get('flags') or [],
            }
        )
    return out


def build_three_databases(
    bundle: dict[str, Any],
    master_rows: list[MasterRow] | None,
) -> dict[str, Any]:
    master = build_master_database(master_rows or [])
    bs = build_bigseller_database(bundle)
    jst = build_jushuitan_database(bundle)
    return {
        'master': master,
        'bigseller': bs,
        'jushuitan': jst,
        'counts': {
            'master': len(master),
            'bigseller': len(bs),
            'jushuitan': len(jst),
        },
    }
