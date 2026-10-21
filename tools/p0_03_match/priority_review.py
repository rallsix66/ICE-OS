"""优先核对清单：菲律宾单 SKU（货号）+ 聚水潭唯一候选；不含组合 SKU。"""
from __future__ import annotations

from typing import Any

from . import config as cfg
from .match_policy import is_in_policy_candidate

_BLOCK_FLAGS = frozenset(
    {
        'COMBO_SKU',
        'ONE_TO_MANY',
        'MASTER_DUPLICATE_ICE',
        'MASTER_DUPLICATE_BARCODE',
        'MASTER_SPEC_CONFLICT',
    }
)


def _is_ph_single_row(src: dict[str, Any]) -> bool:
    if src.get('source_system') != cfg.SOURCE_BIGSELLER:
        return False
    if cfg.PH_WAREHOUSE_KEYWORD not in (src.get('warehouse') or ''):
        return False
    if src.get('sheet_name') != cfg.BIGSELLER_SHEET_SINGLE:
        return False
    if src.get('extra', {}).get('is_combo'):
        return False
    return True


def is_priority_candidate(candidate: dict[str, Any]) -> bool:
    if not is_in_policy_candidate(candidate):
        return False
    flags = set(candidate.get('flags') or [])
    if flags & cfg.PRIORITY_EXCLUDE_FLAGS:
        return False
    if flags & _BLOCK_FLAGS:
        return False
    if candidate.get('lifecycle') != 'pending_review':
        return False
    masters = candidate.get('master_matches') or []
    if len(masters) != 1:
        return False

    src = candidate.get('source') or {}
    if _is_ph_single_row(src):
        methods = set(candidate.get('match_methods') or [])
        return bool(methods & {'PH_ICE_CODE', 'PH_ICE_CODE_PREFIX'})

    if src.get('source_system') == cfg.SOURCE_JUSHUITAN:
        methods = set(candidate.get('match_methods') or [])
        return bool(methods & {'JST_STYLE_CODE', 'JST_PRODUCT_CODE'})

    return False


def build_priority_bundle(bundle: dict[str, Any]) -> dict[str, Any]:
    picked = [c for c in bundle.get('candidates') or [] if is_priority_candidate(c)]
    ph = sum(1 for c in picked if _is_ph_single_row(c.get('source') or {}))
    jst = sum(1 for c in picked if (c.get('source') or {}).get('source_system') == cfg.SOURCE_JUSHUITAN)
    return {
        'summary': {
            'priority_count': len(picked),
            'philippines_single_sku': ph,
            'jushuitan_unique': jst,
            'excludes': 'COMBO_SKU 及一对多/主资料重复等冲突标记',
        },
        'candidates': picked,
    }
