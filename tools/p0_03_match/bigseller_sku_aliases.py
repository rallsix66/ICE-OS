"""本批样表的候选别名，不定义以后两系统的持续绑定或自动复用。

泰国特供 / 泰文版：条码或 SKU 别名仅绑定 cfg.TH_MY_BIGSELLER_WAREHOUSES（泰 DEE + 马 MY）。
同一匹配条码另有菲越等标准货号时，由 market_disambiguation 按仓库拆分。
"""
from __future__ import annotations

from dataclasses import dataclass

from . import config as cfg
from .normalize import normalize_key

VIETNAM_WAREHOUSE = '越南青林湾仓库'


@dataclass(frozen=True)
class BigsellerSkuAlias:
    bs_sku: str
    ice_code: str
    warehouses: frozenset[str] | None = None


# BS 导出 SKU → 商品库 / 聚水潭 内部货号（ICE）
# warehouses=None 表示任意仓；否则仅列出的 BigSeller 仓库名（精确匹配）
BIGSELLER_SKU_ALIASES: tuple[BigsellerSkuAlias, ...] = (
    BigsellerSkuAlias('KP0001', 'WM0117'),
    # 业务口径：泰国 = DEE-龙仔厝（ICE专属）
    BigsellerSkuAlias(
        'WM0005',
        'WM0005',
        frozenset({cfg.TARGET_INVENTORY_WAREHOUSE, VIETNAM_WAREHOUSE}),
    ),
    BigsellerSkuAlias(
        'ICEWM0027',
        'WM0027',
        frozenset({cfg.MALAYSIA_MY_WAREHOUSE}),
    ),
    # 主资料 H 列未填；泰文版套盒条码 — 仅泰/马 → WM0073
    BigsellerSkuAlias(
        '757577407359',
        'WM0073',
        frozenset(cfg.TH_MY_BIGSELLER_WAREHOUSES),
    ),
)


def bigseller_alias_ice_code(
    raw_sku: str | None,
    warehouse: str | None = None,
) -> str | None:
    key = normalize_key(raw_sku).upper()
    if not key:
        return None
    wh = (warehouse or '').strip()
    for alias in BIGSELLER_SKU_ALIASES:
        if alias.bs_sku != key:
            continue
        if alias.warehouses is not None and wh not in alias.warehouses:
            continue
        return alias.ice_code
    return None


def bigseller_has_sku_alias(raw_sku: str | None, warehouse: str | None = None) -> bool:
    return bigseller_alias_ice_code(raw_sku, warehouse) is not None
