"""本批样表的仓别核对约束；不定义以后两系统的绑定方案。"""
from __future__ import annotations

from collections import defaultdict

from . import config as cfg
from .models import MasterRow, SourceRow

# 仓库名关键词 → 市场（泰/马用精确仓名集合，避免「印尼-DEE」误判为泰）
_PH_VN_KEYWORDS = ('菲律宾', 'PH-', '越南')


def is_thai_market_master(row: MasterRow) -> bool:
    name = row.name_cn or ''
    return '泰文' in name or '泰国' in name


def batch_market_block_reason(source: SourceRow, master: MasterRow) -> str | None:
    """Unique hits, aliases and manual selections must use the same batch guard."""
    if source.source_system != cfg.SOURCE_BIGSELLER:
        return None
    if is_thai_market_master(master) and source.warehouse not in cfg.TH_MY_BIGSELLER_WAREHOUSES:
        return '本批泰文/泰国特供资料仅核对泰 DEE、马 MY 仓；当前仓别不符'
    return None


def build_barcode_market_pairs(master_rows: list[MasterRow]) -> dict[str, dict[str, str]]:
    """从主资料重复 69 推断：菲越货号 / 泰马货号（泰文或泰国特供版）。"""
    by_barcode: dict[str, list[MasterRow]] = defaultdict(list)
    for row in master_rows:
        if row.barcode:
            by_barcode[row.barcode].append(row)

    out: dict[str, dict[str, str]] = {}
    for barcode, rows in by_barcode.items():
        if len(rows) < 2:
            continue
        th_rows = [r for r in rows if is_thai_market_master(r)]
        non_th = [r for r in rows if not is_thai_market_master(r)]
        if len(th_rows) != 1:
            continue
        th_ice = th_rows[0].ice_code
        wm_std = [r for r in non_th if (r.ice_code or '').startswith('WM')]
        ph_pool = wm_std if wm_std else non_th
        if len(ph_pool) != 1:
            continue
        ph_ice = ph_pool[0].ice_code
        out[barcode] = {
            'ph_vn_ice': ph_ice,
            'th_my_ice': th_ice,
            'ph_vn_name': ph_pool[0].name_cn or '',
            'th_my_name': th_rows[0].name_cn or '',
            'row_indices_ph': ph_pool[0].row_index,
            'row_indices_th': th_rows[0].row_index,
        }
    return out


def warehouse_market(warehouse: str | None) -> str | None:
    wh = (warehouse or '').strip()
    if wh in cfg.TH_MY_BIGSELLER_WAREHOUSES:
        return 'th_my'
    if any(k in wh for k in _PH_VN_KEYWORDS):
        return 'ph_vn'
    return None


def try_market_disambiguation(
    source: SourceRow,
    masters: list[MasterRow],
    barcode_market_pairs: dict[str, dict[str, str]],
) -> tuple[list[MasterRow], list[str], list[str]]:
    if source.source_system != cfg.SOURCE_BIGSELLER or len(masters) <= 1:
        return masters, [], []

    market = warehouse_market(source.warehouse)
    if not market:
        return masters, [], []

    barcodes = {m.barcode for m in masters if m.barcode}
    if len(barcodes) != 1:
        return masters, [], []
    barcode = next(iter(barcodes))
    pair = barcode_market_pairs.get(barcode)
    if not pair:
        return masters, [], []

    pick_ice = pair['ph_vn_ice'] if market == 'ph_vn' else pair['th_my_ice']
    subset = [m for m in masters if m.ice_code == pick_ice]
    if len(subset) != 1:
        return masters, [], []

    return (
        subset,
        ['MARKET_DISAMBIGUATED'],
        [f'MARKET_PICK_{pick_ice}'],
    )


def list_market_pair_catalog(master_rows: list[MasterRow]) -> list[dict[str, str]]:
    """供报告：全部可自动按仓库拆市场的 69 码对。"""
    pairs = build_barcode_market_pairs(master_rows)
    catalog: list[dict[str, str]] = []
    for barcode in sorted(pairs.keys()):
        p = pairs[barcode]
        catalog.append(
            {
                'barcode_69': barcode,
                'ph_vn_ice': p['ph_vn_ice'],
                'ph_vn_name': p['ph_vn_name'],
                'th_my_ice': p['th_my_ice'],
                'th_my_name': p['th_my_name'],
                'warehouse_ph_vn': '菲律宾 / PH / 越南',
                'warehouse_th_my': f'泰 {cfg.TARGET_INVENTORY_WAREHOUSE} / 马 {cfg.MALAYSIA_MY_WAREHOUSE}',
            }
        )
    return catalog
