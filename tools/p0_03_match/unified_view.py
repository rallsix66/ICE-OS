"""三表串联视图：以商品库为枢纽，汇总 BigSeller + 聚水潭 命中同一主资料行。"""
from __future__ import annotations

from collections import defaultdict
from typing import Any

from . import config as cfg
from .master_centric import is_in_stock_bigseller_candidate, parse_available_qty
from .match_policy import is_in_policy_candidate


def _link_from_candidate(c: dict[str, Any]) -> dict[str, Any]:
    src = c.get('source') or {}
    nr = c.get('name_review') or {}
    return {
        'candidateId': c.get('candidate_id'),
        'lifecycle': c.get('lifecycle'),
        'flags': c.get('flags') or [],
        'matchMethods': c.get('match_methods') or [],
        'sku': src.get('external_sku_raw') or '',
        'name': src.get('external_name') or '',
        'warehouse': src.get('warehouse') or '',
        'availableQty': src.get('available_qty') or '',
        'inStock': parse_available_qty(src.get('available_qty')) > 0,
        'nameStatus': nr.get('status') or '',
        'scope': src.get('scope') or '',
        'styleCode': (src.get('extra') or {}).get('style_code') or '',
        'productCode': (src.get('extra') or {}).get('product_code') or '',
        'actualQty': (src.get('extra') or {}).get('actual_qty') or '',
        'cloudAvailQty': (src.get('extra') or {}).get('cloud_available_qty') or '',
    }


def build_unified_rows(bundle: dict[str, Any]) -> dict[str, Any]:
    """按主资料 row_index 聚合；仅单条主资料命中的来源纳入串联。"""
    if bundle.get('review_schema'):
        from .review_result import effective_master
        from .review_exports import review_records
        projection = {
            'candidates': [
                {**c, 'master_matches': [effective_master(c)]}
                for c in bundle['candidates'] if effective_master(c)
            ]
        }
        view = build_unified_rows(projection)
        view['review_records'] = review_records(bundle)
        view['review_summary'] = bundle['review_summary']
        view['policy'] = '本批有效人工资料选择；候选与暂缓不计入已选关系，后续绑定未定'
        return view
    masters: dict[int, dict[str, Any]] = {}
    by_master: dict[int, dict[str, list[dict[str, Any]]]] = defaultdict(
        lambda: {'bigseller': [], 'jushuitan': []}
    )
    orphans: list[dict[str, Any]] = []
    ambiguous: list[dict[str, Any]] = []

    for c in bundle.get('candidates') or []:
        if not is_in_policy_candidate(c):
            continue
        src = c.get('source') or {}
        system = src.get('source_system')
        if system not in (cfg.SOURCE_BIGSELLER, cfg.SOURCE_JUSHUITAN):
            continue
        matches = c.get('master_matches') or []
        if len(matches) > 1:
            ambiguous.append(
                {
                    'candidateId': c.get('candidate_id'),
                    'source': system,
                    'link': _link_from_candidate(c),
                    'masterCount': len(matches),
                }
            )
            continue
        if len(matches) == 0:
            orphans.append(
                {
                    'unifiedId': f"orphan-{c.get('candidate_id')}",
                    'tier': 'orphan',
                    'master': None,
                    'bigseller': [_link_from_candidate(c)] if system == cfg.SOURCE_BIGSELLER else [],
                    'jushuitan': [_link_from_candidate(c)] if system == cfg.SOURCE_JUSHUITAN else [],
                }
            )
            continue
        m = matches[0]
        idx = int(m['row_index'])
        masters[idx] = m
        link = _link_from_candidate(c)
        if system == cfg.SOURCE_BIGSELLER:
            by_master[idx]['bigseller'].append(link)
        else:
            by_master[idx]['jushuitan'].append(link)

    unified: list[dict[str, Any]] = []
    for idx in sorted(masters.keys()):
        m = masters[idx]
        bs = by_master[idx]['bigseller']
        jst = by_master[idx]['jushuitan']
        has_stock = any(x.get('inStock') for x in bs)
        has_jst_stock = any(x.get('inStock') for x in jst)
        if bs and jst:
            tier = 'full'
        elif bs:
            tier = 'bs_only'
        elif jst:
            tier = 'jst_only'
        else:
            tier = 'master_only'
        unified.append(
            {
                'unifiedId': f'master-{idx}',
                'tier': tier,
                'master': {
                    'rowIndex': m.get('row_index'),
                    'iceCode': m.get('ice_code') or '',
                    'barcode': m.get('barcode') or '',
                    'nameCn': m.get('name_cn') or '',
                    'spec': m.get('spec') or '',
                },
                'bigseller': bs,
                'jushuitan': jst,
                'hasInStockBigseller': has_stock,
                'hasInStockJushuitan': has_jst_stock,
                'candidateIds': [x['candidateId'] for x in bs + jst if x.get('candidateId')],
            }
        )

    tier_counts: dict[str, int] = defaultdict(int)
    for u in unified:
        tier_counts[u['tier']] += 1
    tier_counts['orphan'] = len(orphans)

    in_stock_unified = sum(
        1
        for u in unified
        if u.get('hasInStockBigseller') and not (u.get('bigseller') and u.get('jushuitan'))
    )

    return {
        'policy': '商品库为枢纽：BS 可多 SKU 对同一 G 货号；JST 仅整品行对 G 货号，合并为串联记录',
        'summary': {
            'linked_master_rows': len(unified),
            'three_way_linked': tier_counts.get('full', 0),
            'bigseller_only': tier_counts.get('bs_only', 0),
            'jushuitan_only': tier_counts.get('jst_only', 0),
            'orphan_source_rows': tier_counts.get('orphan', 0),
            'ambiguous_source_rows': len(ambiguous),
            'in_stock_bs_not_full_chain': in_stock_unified,
        },
        'rows': unified,
        'orphans': orphans,
        'ambiguous': ambiguous,
    }
