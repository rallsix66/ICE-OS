"""品名二次核对：在货号匹配之外，对比主资料与来源品名。"""
from __future__ import annotations

import re
from collections import defaultdict

from .models import MasterRow
from .normalize import as_string

_NAME_STRIP_RE = re.compile(r'[\s\*·•|/\\\-—–()（）\[\]【】]+')


def normalize_product_name(name: str) -> str:
    s = as_string(name).casefold()
    s = _NAME_STRIP_RE.sub('', s)
    return s


def compare_product_names(master_name: str, source_name: str) -> tuple[str, str]:
    """返回 (status, detail)。"""
    ma = normalize_product_name(master_name)
    so = normalize_product_name(source_name)
    if not ma and not so:
        return 'NAME_BOTH_EMPTY', '两侧品名均为空'
    if not ma or not so:
        return 'NAME_MISSING', '一侧品名为空'
    if ma == so:
        return 'NAME_EXACT', '品名规范化后一致'
    shorter, longer = (ma, so) if len(ma) <= len(so) else (so, ma)
    if len(shorter) >= 4 and shorter in longer:
        return 'NAME_SIMILAR', '品名包含关系（疑似同款表述差异）'
    return 'NAME_MISMATCH', '品名不一致，请人工确认是否同一商品'


def build_name_index(master_rows: list[MasterRow]) -> dict[str, list[MasterRow]]:
    idx: dict[str, list[MasterRow]] = defaultdict(list)
    for row in master_rows:
        key = normalize_product_name(row.name_cn)
        if key:
            idx[key].append(row)
    return idx


def apply_name_review_to_candidate(
    candidate: dict,
    name_index: dict[str, list[MasterRow]],
) -> None:
    src = candidate.get('source') or {}
    source_name = as_string(src.get('external_name'))
    masters = candidate.get('master_matches') or []
    flags = set(candidate.get('flags') or [])

    review: dict = {
        'sourceName': source_name,
        'status': '',
        'detail': '',
        'nameOnlyMasters': [],
    }

    if len(masters) == 1:
        master_name = masters[0].get('name_cn') or ''
        status, detail = compare_product_names(master_name, source_name)
        review['status'] = status
        review['detail'] = detail
        review['masterName'] = master_name
        if status == 'NAME_MISMATCH':
            flags.add('NAME_MISMATCH')
        elif status == 'NAME_SIMILAR':
            flags.add('NAME_SIMILAR')
    elif len(masters) > 1:
        review['status'] = 'NAME_SKIPPED_ONE_TO_MANY'
        review['detail'] = '货号一对多，品名逐条比对略过'
    else:
        key = normalize_product_name(source_name)
        hits = name_index.get(key, [])
        if len(hits) == 1:
            review['status'] = 'NAME_ONLY_HINT'
            review['detail'] = '货号未匹配，但品名与主资料唯一一行相同（仅提示，不自动映射）'
            review['nameOnlyMasters'] = [h.to_public() for h in hits]
            flags.add('NAME_ONLY_HINT')
        elif len(hits) > 1:
            review['status'] = 'NAME_ONLY_AMBIGUOUS'
            review['detail'] = f'货号未匹配，品名命中主资料 {len(hits)} 行'
            review['nameOnlyMasters'] = [h.to_public() for h in hits]
            flags.add('NAME_ONLY_AMBIGUOUS')
        else:
            review['status'] = 'NAME_NO_HIT'
            review['detail'] = '货号与品名均未唯一命中主资料'

    candidate['name_review'] = review
    candidate['flags'] = sorted(flags)


def apply_name_review_bundle(bundle: dict, master_rows: list[MasterRow]) -> dict:
    idx = build_name_index(master_rows)
    counts: dict[str, int] = defaultdict(int)
    for c in bundle.get('candidates') or []:
        apply_name_review_to_candidate(c, idx)
        counts[c['name_review']['status']] += 1
    bundle.setdefault('summary', {})['name_review'] = dict(counts)
    return bundle
