"""BigSeller 市场匹配规则内外划分：规则外行不进「待核对/未匹配」队列。"""
from __future__ import annotations

from . import config as cfg
from .models import MatchCandidate, SourceRow
from .bigseller_sku_aliases import bigseller_has_sku_alias
from .normalize import is_combo_sku, normalize_key

LIFECYCLE_OUTSIDE = 'outside_rules'
FLAG_OUTSIDE = 'OUTSIDE_MATCH_POLICY'


def looks_like_match_barcode(value: str | None) -> bool:
    """SKU/GTIN 是否按数字条码对商品库 H 列（69、7575、780 等 8–14 位纯数字）。"""
    s = normalize_key(value)
    if not s or not s.isdigit():
        return False
    return 8 <= len(s) <= 14


def looks_like_69_barcode(value: str | None) -> bool:
    """兼容旧名；语义同 looks_like_match_barcode。"""
    return looks_like_match_barcode(value)


def bigseller_outside_reason(source: SourceRow) -> str | None:
    if source.source_system != cfg.SOURCE_BIGSELLER:
        return None
    sheet = source.sheet_name or ''
    sku_type = source.extra.get('sku_type') or ''
    raw = source.external_sku_raw
    wh = source.warehouse or ''
    if is_combo_sku(raw, sheet, sku_type) or source.extra.get('is_combo'):
        return '组合 SKU，不适用菲律宾货号/其他市场匹配条码规则'
    if bigseller_has_sku_alias(raw, wh):
        return None
    if sheet != cfg.BIGSELLER_SHEET_SINGLE:
        return '非「单个SKU」工作表，不适用本批匹配规则'
    if cfg.PH_WAREHOUSE_KEYWORD in wh:
        return None
    sku = normalize_key(raw)
    gtin = normalize_key(source.gtin_raw)
    if looks_like_match_barcode(sku) or looks_like_match_barcode(gtin):
        return None
    return '非菲律宾仓且 SKU/GTIN 均非匹配条码，请单独处理'


def apply_policy_to_candidate(candidate: MatchCandidate) -> None:
    reason = bigseller_outside_reason(candidate.source)
    if not reason:
        return
    candidate.lifecycle = LIFECYCLE_OUTSIDE
    candidate.master_matches = []
    candidate.match_methods = []
    flags = set(candidate.flags)
    flags.add(FLAG_OUTSIDE)
    flags.discard('UNMATCHED')
    flags.discard('ONE_TO_MANY')
    candidate.flags = sorted(flags)
    candidate.notes = reason


def is_in_policy_candidate(candidate: dict) -> bool:
    return candidate.get('lifecycle') != LIFECYCLE_OUTSIDE
