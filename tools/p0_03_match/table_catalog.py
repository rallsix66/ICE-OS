"""三份样表的展示名称与字段标签（核对页 / CSV 统一口径）。"""
from __future__ import annotations

from typing import Any

from . import config as cfg

MASTER_CATALOG = {
    'role': 'master',
    'title': '商品主资料',
    'file': 'Icelerskin 商品库1.xlsx',
    'sheet': '商品库',
    'description': 'G 列聚水潭内部货号 = ICE 人工货号；H 列匹配条码（Excel 列名 69商品编码）按字符串保留',
}

BIGSELLER_CATALOG = {
    'role': 'bigseller',
    'title': '海外库存（BigSeller 导出）',
    'file': '库存清单20261015083723474.xlsx',
    'sheets': [cfg.BIGSELLER_SHEET_SINGLE],
    'description': '仅「单个SKU」表参与匹配；组合 SKU 已清洗剔除。菲律宾仓按货号；其他仓按匹配条码对 H 列',
    'field_sku': cfg.BIGSELLER_COL_SKU,
    'field_name': cfg.BIGSELLER_COL_NAME,
    'field_qty': cfg.BIGSELLER_COL_AVAILABLE,
    'field_warehouse': cfg.BIGSELLER_COL_WAREHOUSE,
}

JUSHUITAN_CATALOG = {
    'role': 'jushuitan',
    'title': '国内商品资料（聚水潭导出）',
    'file': '商品资料_20261015165159_200874071_1.xlsx',
    'sheet': 'Sheet1',
    'description': '款式编码、商品编码 → 商品库 G 列货号 / H 列匹配条码；仅分析，不扩大海外库存发布',
    'field_style': cfg.JST_COL_STYLE,
    'field_sku': cfg.JST_COL_SKU,
    'field_name': cfg.JST_COL_NAME,
    'field_qty': cfg.JST_COL_AVAILABLE,
}


def catalog_payload(manifest: dict[str, Any] | None = None) -> dict[str, Any]:
    master = {**MASTER_CATALOG}
    bs = {**BIGSELLER_CATALOG}
    jst = {**JUSHUITAN_CATALOG}
    if manifest and manifest.get('inputs'):
        inputs = manifest['inputs']
        if 'master' in inputs:
            master['file'] = _basename(inputs['master'].get('path', master['file']))
        if 'bigseller' in inputs:
            bs['file'] = _basename(inputs['bigseller'].get('path', bs['file']))
        if 'jushuitan' in inputs:
            jst['file'] = _basename(inputs['jushuitan'].get('path', jst['file']))
    return {'master': master, 'bigseller': bs, 'jushuitan': jst}


def _basename(path: str) -> str:
    path = path.replace('\\', '/')
    return path.rsplit('/', 1)[-1] if path else ''


def enrich_row(candidate: dict[str, Any]) -> dict[str, Any]:
    src = candidate.get('source') or {}
    masters = candidate.get('master_matches') or []
    primary = masters[0] if len(masters) == 1 else None
    system = src.get('source_system')

    master_side = {
        'tableTitle': MASTER_CATALOG['title'],
        'file': MASTER_CATALOG['file'],
        'sheet': MASTER_CATALOG['sheet'],
        'fields': [
            {'label': f"G · {cfg.MASTER_COL_ICE}", 'value': (primary or {}).get('ice_code', '')},
            {'label': f"H · {cfg.MASTER_COL_BARCODE}", 'value': (primary or {}).get('barcode', '')},
            {'label': cfg.MASTER_COL_NAME, 'value': (primary or {}).get('name_cn', '')},
            {'label': cfg.MASTER_COL_SPEC, 'value': (primary or {}).get('spec', '')},
            {'label': 'Excel 行号', 'value': str((primary or {}).get('row_index') or '')},
        ],
        'allMasters': masters,
    }

    if system == cfg.SOURCE_BIGSELLER:
        source_side = {
            'tableTitle': BIGSELLER_CATALOG['title'],
            'file': BIGSELLER_CATALOG['file'],
            'sheet': src.get('sheet_name') or '',
            'warehouse': src.get('warehouse') or '',
            'fields': [
                {'label': cfg.BIGSELLER_COL_SKU, 'value': src.get('external_sku_raw') or ''},
                {'label': cfg.BIGSELLER_COL_NAME, 'value': src.get('external_name') or ''},
                {'label': cfg.BIGSELLER_COL_WAREHOUSE, 'value': src.get('warehouse') or ''},
                {'label': cfg.BIGSELLER_COL_AVAILABLE, 'value': src.get('available_qty') or ''},
            ],
        }
    elif system == cfg.SOURCE_JUSHUITAN:
        extra = src.get('extra') or {}
        source_side = {
            'tableTitle': JUSHUITAN_CATALOG['title'],
            'file': JUSHUITAN_CATALOG['file'],
            'sheet': JUSHUITAN_CATALOG['sheet'],
            'warehouse': '',
            'fields': [
                {'label': cfg.JST_COL_STYLE, 'value': extra.get('style_code') or ''},
                {'label': cfg.JST_COL_SKU, 'value': extra.get('product_code') or ''},
                {'label': cfg.JST_COL_NAME, 'value': src.get('external_name') or ''},
                {'label': cfg.JST_COL_SPEC, 'value': extra.get('spec') or ''},
                {'label': cfg.JST_COL_AVAILABLE, 'value': src.get('available_qty') or ''},
                {'label': cfg.JST_COL_ACTUAL, 'value': extra.get('actual_qty') or ''},
                {'label': cfg.JST_COL_CLOUD_AVAILABLE, 'value': extra.get('cloud_available_qty') or ''},
            ],
        }
    else:
        source_side = {
            'tableTitle': '未知来源',
            'file': '',
            'sheet': '',
            'warehouse': '',
            'fields': [],
        }

    row = _row_from_sides(
        candidate.get('candidate_id'),
        candidate.get('lifecycle'),
        candidate.get('flags') or [],
        candidate.get('match_methods') or [],
        len(masters),
        masters,
        src,
        master_side,
        source_side,
        primary,
    )
    row['nameReview'] = candidate.get('name_review') or {}
    row['policyNotes'] = candidate.get('notes') or ''
    from .master_centric import parse_available_qty

    row['inStock'] = parse_available_qty(src.get('available_qty')) > 0
    return row


def candidate_to_csv_row(candidate: dict[str, Any]) -> dict[str, str]:
    row = enrich_row(candidate)
    m = row['masterSide']
    s = row['sourceSide']
    out: dict[str, str] = {
        'candidate_id': row['id'] or '',
        '对照说明': '表①主资料 ↔ 表②或表③其中一行',
    }
    for f in m['fields']:
        out[f"【表①·{m['file']}】{f['label']}"] = f.get('value') or ''
    out['【表①】工作表'] = m['sheet']
    for f in s['fields']:
        out[f"【来源·{s['file']}】{f['label']}"] = f.get('value') or ''
    out['【来源】工作表'] = s['sheet']
    out['【来源】表类型'] = s['tableTitle']
    if s.get('warehouse'):
        out['【来源】仓库'] = s['warehouse']
    out['lifecycle'] = row.get('lifecycle') or ''
    out['规则说明'] = row.get('policyNotes') or ''
    out['flags'] = ';'.join(row.get('flags') or [])
    out['match_methods'] = ';'.join(row.get('methods') or [])
    nr = row.get('nameReview') or {}
    out['品名核对状态'] = nr.get('status') or ''
    out['品名核对说明'] = nr.get('detail') or ''
    out['review_decision'] = ''
    out['review_notes'] = ''
    return out


def _row_from_sides(
    cid,
    lifecycle,
    flags,
    methods,
    match_count,
    masters,
    src,
    master_side,
    source_side,
    primary,
) -> dict[str, Any]:
    return {
        'id': cid,
        'source': src.get('source_system'),
        'scope': src.get('scope'),
        'warehouse': src.get('warehouse') or '',
        'sheet': src.get('sheet_name') or '',
        'lifecycle': lifecycle,
        'flags': flags,
        'methods': methods,
        'matchCount': match_count,
        'masterSide': master_side,
        'sourceSide': source_side,
        'sku': src.get('external_sku_raw') or '',
        'name': src.get('external_name') or '',
        'qty': src.get('available_qty') or '',
        'ice': primary.get('ice_code') if primary else '',
        'barcode': primary.get('barcode') if primary else '',
        'masterName': primary.get('name_cn') if primary else '',
        'masterRow': primary.get('row_index') if primary else '',
        'masters': masters,
    }
