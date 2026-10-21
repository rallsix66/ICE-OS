"""字符串规范化 — 条码/货号按字符串保留，不做跨来源合并。"""
import re

_COMBO_PATTERN = re.compile(r'[+*]')


def as_string(value) -> str:
    if value is None:
        return ''
    text = str(value).strip()
    if text.lower() in ('nan', 'none', '#ref!'):
        return ''
    if text.endswith('.0'):
        head = text[:-2]
        if head.isdigit() or (head.startswith('-') and head[1:].isdigit()):
            text = head
    return text


def normalize_key(value) -> str:
    return as_string(value)


def split_bigseller_sku_tokens(raw_sku: str) -> list[str]:
    raw = as_string(raw_sku)
    if not raw:
        return []
    parts = re.split(r'[+*]', raw)
    return [p for p in (normalize_key(part) for part in parts) if p]


def is_combo_sku(raw_sku: str, sheet_name: str, sku_type_col: str | None = None) -> bool:
    raw = as_string(raw_sku)
    if sheet_name == '组合SKU':
        return True
    if _COMBO_PATTERN.search(raw):
        return True
    if sku_type_col and '组合' in sku_type_col:
        return True
    return False
