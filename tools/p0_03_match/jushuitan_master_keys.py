"""聚水潭仅整品行参与挂库：款式编码=商品编码，且非包材/半成品编码。"""
from __future__ import annotations

import re

from .normalize import normalize_key

# 整码人工指定（大写）→ ICE 货号
JUSHUITAN_CODE_TO_ICE: dict[str, str] = {}

_FINISHED_ICE = re.compile(r'^(?:ICE)?(WM\d{4,5}|KP\d{4}|LS\d{5,})$', re.IGNORECASE)
_NAME_NOT_FINISHED = (
    '标贴',
    '内料',
    '彩盒',
    '瓶子',
    '半成品',
    '半成',
    '原料',
    '包材',
    '外包',
)
_CODE_PREFIX_NOT_FINISHED = (
    'BCP.',
    'BT.',
    'CH.',
    'NL.',
    'PZ.',
    'SY1',
)


def is_jushuitan_finished_goods(
    style_code: str | None,
    product_code: str | None,
    name: str | None = None,
) -> bool:
    style = normalize_key(style_code)
    product = normalize_key(product_code)
    if not style or style != product:
        return False
    if '.' in style:
        return False
    upper = style.upper()
    for prefix in _CODE_PREFIX_NOT_FINISHED:
        if prefix.endswith('.') and upper.startswith(prefix):
            return False
        if not prefix.endswith('.') and upper.startswith(prefix):
            return False
    if not _FINISHED_ICE.match(style):
        return False
    nm = name or ''
    if any(tag in nm for tag in _NAME_NOT_FINISHED):
        return False
    return True


def jushuitan_master_lookup_keys(
    style_code: str | None,
    product_code: str | None,
    name: str | None = None,
) -> list[str]:
    if not is_jushuitan_finished_goods(style_code, product_code, name):
        return []
    style = normalize_key(style_code)
    keys = [style]
    mapped = JUSHUITAN_CODE_TO_ICE.get(style.upper())
    if mapped:
        keys.append(normalize_key(mapped))
    out: list[str] = []
    seen: set[str] = set()
    for k in keys:
        if k and k not in seen:
            seen.add(k)
            out.append(k)
    return out
