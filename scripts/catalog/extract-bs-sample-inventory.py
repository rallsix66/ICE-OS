#!/usr/bin/env python3
"""Extract BigSeller single-SKU sample rows from frozen input-1 for local display import."""
from __future__ import annotations

import hashlib
import json
import sys
from decimal import Decimal, InvalidOperation
from pathlib import Path

import pandas as pd

PIN_SHA256 = '53d88779fb10f5269cde58204d262d724d8b2a821c24df6e3c72b0d11fc77020'
SHEET = '单个SKU'
COLS = {
    'sku': 'SKU编号',
    'warehouse': '仓库',
    'on_hand': '现有库存',
    'order_locked': '订单已锁',
    'warehouse_available': '整仓可用',
    'activity_reserved': '活动预留',
    'in_transit': '在途中',
    'sku_type': 'SKU类型',
}


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def cell_text(value) -> str | None:
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return None
    text = str(value).strip()
    if text == '' or text.lower() == 'nan' or text == '--':
        return None
    return text


def parse_decimal(text: str | None) -> Decimal | None:
    if text is None:
        return None
    try:
        return Decimal(text)
    except InvalidOperation:
        return None


def main() -> int:
    if len(sys.argv) != 3:
        print('usage: extract-bs-sample-inventory.py <input-1.frozen.xlsx> <output.json>', file=sys.stderr)
        return 2
    src = Path(sys.argv[1]).resolve()
    out = Path(sys.argv[2]).resolve()
    digest = sha256_file(src)
    if digest != PIN_SHA256:
        print(json.dumps({'error': 'BS_SAMPLE_XLSX_PIN_MISMATCH', 'sha256': digest}), file=sys.stderr)
        return 1
    df = pd.read_excel(src, sheet_name=SHEET, header=0, dtype=str)
    rows = []
    for idx, row in df.iterrows():
        excel_row = int(idx) + 2
        sku = cell_text(row.get(COLS['sku']))
        warehouse = cell_text(row.get(COLS['warehouse']))
        if not sku or not warehouse:
            continue
        sku_type = cell_text(row.get(COLS['sku_type']))
        if sku_type and 'combo' in sku_type.lower():
            continue
        source_row_key = f'bigseller:{SHEET}:{excel_row}:{warehouse}:{sku}'
        fields = {key: cell_text(row.get(col)) for key, col in COLS.items() if key not in ('sku', 'warehouse', 'sku_type')}
        on_hand = parse_decimal(fields['on_hand'])
        locked = parse_decimal(fields['order_locked'])
        reserved = parse_decimal(fields['activity_reserved'])
        available = parse_decimal(fields['warehouse_available'])
        formula_ok = None
        if on_hand is not None and locked is not None and reserved is not None and available is not None:
            formula_ok = (on_hand - locked - reserved) == available
        rows.append({
            'excelRow': excel_row,
            'sourceRowKey': source_row_key,
            'warehouse': warehouse,
            'sku': sku,
            'onHand': fields['on_hand'],
            'orderLocked': fields['order_locked'],
            'warehouseAvailable': fields['warehouse_available'],
            'activityReserved': fields['activity_reserved'],
            'inTransit': fields['in_transit'],
            'formulaOk': formula_ok,
        })
    if len(rows) != 530:
        print(json.dumps({'error': 'BS_SAMPLE_ROW_COUNT_INVALID', 'count': len(rows)}), file=sys.stderr)
        return 1
    payload = {
        'exportLabel': '2026-10-15导出样表',
        'sourceXlsxSha256': digest,
        'sheetName': SHEET,
        'rowCount': len(rows),
        'rows': rows,
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'ok': True, 'rowCount': len(rows), 'output': str(out)}))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
