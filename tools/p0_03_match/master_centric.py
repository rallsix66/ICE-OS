"""以商品库为主轴，关联 BigSeller 有库存行，汇总仍需人工核对的范围。"""
from __future__ import annotations

import re
from typing import Any

from . import config as cfg
from .match_policy import is_in_policy_candidate
from .models import MasterRow

_BLOCK_FLAGS = frozenset(
    {
        'COMBO_SKU',
        'ONE_TO_MANY',
        'MANY_TO_ONE',
        'MASTER_DUPLICATE_ICE',
        'MASTER_DUPLICATE_BARCODE',
        'MASTER_SPEC_CONFLICT',
        'NAME_MISMATCH',
        'NAME_ONLY_AMBIGUOUS',
    }
)

# 多仓同一 SKU 时 MANY_TO_ONE 属预期，不单独视为冲突
_BLOCK_FLAGS_MULTI_WH_SAME_SKU = _BLOCK_FLAGS - frozenset({'MANY_TO_ONE'})

_QTY_RE = re.compile(r'^-?\d+(\.\d+)?$')


def parse_available_qty(raw: str | None) -> float:
    s = (raw or '').strip().replace(',', '')
    if not s or s in ('-', '—', 'NA', 'N/A'):
        return 0.0
    if _QTY_RE.match(s):
        return float(s)
    try:
        return float(s)
    except ValueError:
        return 0.0


def is_in_stock_bigseller_candidate(candidate: dict[str, Any]) -> bool:
    src = candidate.get('source') or {}
    if src.get('source_system') != cfg.SOURCE_BIGSELLER:
        return False
    if src.get('extra', {}).get('is_combo'):
        return False
    if src.get('sheet_name') == cfg.BIGSELLER_SHEET_COMBO:
        return False
    return parse_available_qty(src.get('available_qty')) > 0


def _master_issue_keys(bundle: dict[str, Any]) -> tuple[set[str], set[str], set[str]]:
    dup_ice: set[str] = set()
    dup_barcode: set[str] = set()
    spec_ice: set[str] = set()
    for issue in bundle.get('master_quality_issues') or []:
        t = issue.get('issue_type')
        key = issue.get('key') or ''
        if t == 'DUPLICATE_ICE_CODE':
            dup_ice.add(key)
        elif t == 'DUPLICATE_BARCODE':
            dup_barcode.add(key)
        elif t == 'SPEC_CONFLICT':
            spec_ice.add(key)
    return dup_ice, dup_barcode, spec_ice


def _effective_link_flags(link: dict[str, Any], *, same_sku_multi_wh: bool) -> set[str]:
    flags = set(link.get('flags') or [])
    if same_sku_multi_wh:
        flags -= {'MANY_TO_ONE'}
    elif len(link.get('master_matches') or []) == 1:
        # 其它无库存/别仓来源导致的 MANY_TO_ONE，不阻塞「有库存单条」主资料核对
        flags -= {'MANY_TO_ONE'}
    return flags


def _classify_master_row(
    master: MasterRow,
    links: list[dict[str, Any]],
    dup_ice: set[str],
    dup_barcode: set[str],
    spec_ice: set[str],
) -> dict[str, Any]:
    reasons: list[str] = []
    if master.ice_code in dup_ice:
        reasons.append('主资料货号重复')
    if master.barcode in dup_barcode:
        reasons.append('主资料条码重复')
    if master.ice_code in spec_ice:
        reasons.append('主资料同货号规格冲突')

    skus_pre = {(link.get('source') or {}).get('external_sku_raw') or '' for link in links}
    skus_pre.discard('')
    same_sku_multi_wh = len(links) > 1 and len(skus_pre) <= 1

    flags_union: set[str] = set()
    for link in links:
        flags_union.update(_effective_link_flags(link, same_sku_multi_wh=same_sku_multi_wh))

    if not links:
        tier = 'needs_manual' if reasons else 'no_in_stock_bigseller'
        if not reasons:
            reasons.append('BigSeller 无整仓可用>0 的匹配行')
        return _row_payload(master, links, tier, reasons, flags_union)

    if len(links) > 1:
        if same_sku_multi_wh and not (flags_union & _BLOCK_FLAGS_MULTI_WH_SAME_SKU):
            reasons.append(f'多仓有库存、同一 SKU（{len(links)} 行）')
            nr_ok = all(
                (link.get('name_review') or {}).get('status')
                in ('NAME_EXACT', 'NAME_SIMILAR', 'NAME_MISSING', 'NAME_BOTH_EMPTY', '')
                for link in links
            )
            if nr_ok and not reasons[: len(reasons) - 1]:
                return _row_payload(master, links, 'review_light', reasons, flags_union)
        reasons.append(f'多条有库存 BigSeller 行指向同一主资料（{len(links)}）')
        return _row_payload(master, links, 'needs_manual', reasons, flags_union)

    c = links[0]
    cflags = _effective_link_flags(c, same_sku_multi_wh=False)
    if cflags & _BLOCK_FLAGS:
        for f in sorted(cflags & _BLOCK_FLAGS):
            reasons.append(f'来源标记:{f}')
        return _row_payload(master, links, 'needs_manual', reasons, flags_union)

    if len(c.get('master_matches') or []) != 1:
        reasons.append('来源行一对多主资料')
        return _row_payload(master, links, 'needs_manual', reasons, flags_union)

    nr = c.get('name_review') or {}
    st = nr.get('status') or ''
    if st == 'NAME_SIMILAR':
        reasons.append('品名疑似同款（包含关系）')
        return _row_payload(master, links, 'review_light', reasons, flags_union)
    if st in ('NAME_MISSING', 'NAME_BOTH_EMPTY'):
        reasons.append('品名一侧为空，建议补全后确认')
        return _row_payload(master, links, 'review_light', reasons, flags_union)

    if reasons:
        return _row_payload(master, links, 'needs_manual', reasons, flags_union)

    return _row_payload(master, links, 'likely_ok', ['单条有库存匹配且无冲突标记'], flags_union)


def _row_payload(
    master: MasterRow,
    links: list[dict[str, Any]],
    tier: str,
    reasons: list[str],
    flags_union: set[str],
) -> dict[str, Any]:
    bs_summaries = []
    for c in links:
        src = c.get('source') or {}
        bs_summaries.append(
            {
                'candidate_id': c.get('candidate_id'),
                'warehouse': src.get('warehouse'),
                'sku': src.get('external_sku_raw'),
                'name': src.get('external_name'),
                'available_qty': src.get('available_qty'),
                'scope': src.get('scope'),
                'match_methods': c.get('match_methods') or [],
                'flags': c.get('flags') or [],
                'name_status': (c.get('name_review') or {}).get('status'),
            }
        )
    return {
        'master_row_index': master.row_index,
        'ice_code': master.ice_code,
        'barcode': master.barcode,
        'name_cn': master.name_cn,
        'spec': master.spec,
        'in_stock_bigseller_count': len(links),
        'review_tier': tier,
        'review_reasons': reasons,
        'flags_union': sorted(flags_union),
        'bigseller_links': bs_summaries,
    }


def build_master_centric_bundle(master_rows: list[MasterRow], bundle: dict[str, Any]) -> dict[str, Any]:
    dup_ice, dup_barcode, spec_ice = _master_issue_keys(bundle)
    by_master: dict[int, list[dict[str, Any]]] = {}
    for m in master_rows:
        by_master[m.row_index] = []

    for c in bundle.get('candidates') or []:
        if not is_in_policy_candidate(c):
            continue
        if not is_in_stock_bigseller_candidate(c):
            continue
        for m in c.get('master_matches') or []:
            idx = m.get('row_index')
            if idx is not None:
                by_master.setdefault(int(idx), []).append(c)

    rows: list[dict[str, Any]] = []
    tier_counts: dict[str, int] = {}
    for master in master_rows:
        links = by_master.get(master.row_index) or []
        row = _classify_master_row(master, links, dup_ice, dup_barcode, spec_ice)
        rows.append(row)
        tier = row['review_tier']
        tier_counts[tier] = tier_counts.get(tier, 0) + 1

    orphan_in_stock: list[dict[str, Any]] = []
    for c in bundle.get('candidates') or []:
        if not is_in_policy_candidate(c):
            continue
        if not is_in_stock_bigseller_candidate(c):
            continue
        if c.get('lifecycle') == 'unmatched' or not (c.get('master_matches') or []):
            src = c.get('source') or {}
            orphan_in_stock.append(
                {
                    'candidate_id': c.get('candidate_id'),
                    'warehouse': src.get('warehouse'),
                    'sku': src.get('external_sku_raw'),
                    'name': src.get('external_name'),
                    'available_qty': src.get('available_qty'),
                    'flags': c.get('flags') or [],
                    'name_status': (c.get('name_review') or {}).get('status'),
                }
            )

    manual_master = tier_counts.get('needs_manual', 0)
    light = tier_counts.get('review_light', 0)
    likely_ok = tier_counts.get('likely_ok', 0)
    no_stock = tier_counts.get('no_in_stock_bigseller', 0)

    return {
        'policy': {
            'perspective': 'master_catalog_primary',
            'bigseller_link_rule': '仅整仓可用>0、非组合SKU 的 BigSeller 行参与主资料关联',
            'auto_confirm_forbidden': True,
        },
        'summary': {
            'master_row_count': len(master_rows),
            'masters_with_in_stock_bigseller': sum(1 for r in rows if r['in_stock_bigseller_count'] > 0),
            'tier_counts': tier_counts,
            'human_review_master_rows': manual_master + light,
            'human_review_master_strict': manual_master,
            'human_review_master_light': light,
            'likely_ok_unique_in_stock': likely_ok,
            'masters_no_in_stock_bigseller_link': no_stock,
            'orphan_in_stock_bigseller_rows': len(orphan_in_stock),
        },
        'rows': rows,
        'orphan_in_stock_bigseller': orphan_in_stock,
    }
