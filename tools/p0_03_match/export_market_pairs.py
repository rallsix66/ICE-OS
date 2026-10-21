"""导出菲越/泰马 69 码成对规则及 BigSeller 消歧命中统计。"""
from __future__ import annotations

import csv
import json
from pathlib import Path

from .loaders import load_master
from .market_disambiguation import list_market_pair_catalog


def export_market_pairs_report(
    master_path: Path,
    bundle_path: Path,
    out_csv: Path,
) -> dict:
    master_rows = load_master(master_path)
    catalog = list_market_pair_catalog(master_rows)
    bundle = json.loads(bundle_path.read_text(encoding='utf-8')) if bundle_path.is_file() else {}

    bs_hits: dict[str, int] = {}
    for c in bundle.get('candidates') or []:
        src = c.get('source') or {}
        if src.get('source_system') != 'bigseller':
            continue
        if 'MARKET_DISAMBIGUATED' not in (c.get('flags') or []):
            continue
        mm = c.get('master_matches') or []
        if len(mm) != 1:
            continue
        ice = mm[0].get('ice_code') or ''
        bs_hits[ice] = bs_hits.get(ice, 0) + 1

    out_csv.parent.mkdir(parents=True, exist_ok=True)
    fields = [
        'barcode_69',
        'ph_vn_ice',
        'ph_vn_name',
        'th_my_ice',
        'th_my_name',
        'warehouse_ph_vn',
        'warehouse_th_my',
        'bigseller_rows_disambiguated_ph_side',
        'bigseller_rows_disambiguated_th_side',
    ]
    with out_csv.open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for row in catalog:
            ph = row['ph_vn_ice']
            th = row['th_my_ice']
            w.writerow(
                {
                    **row,
                    'bigseller_rows_disambiguated_ph_side': bs_hits.get(ph, 0),
                    'bigseller_rows_disambiguated_th_side': bs_hits.get(th, 0),
                }
            )

    return {'pair_count': len(catalog), 'catalog': catalog, 'bs_hits_by_ice': bs_hits}
