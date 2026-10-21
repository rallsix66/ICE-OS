"""来源行 ↔ 主资料匹配候选（仅建议，不确认正式映射）。"""
from __future__ import annotations

import hashlib
from collections import defaultdict

from . import config as cfg
from .bigseller_sku_aliases import bigseller_alias_ice_code
from .jushuitan_master_keys import jushuitan_master_lookup_keys
from .master_quality import analyze_master_quality
from .models import MasterQualityIssue, MasterRow, MatchCandidate, SourceRow
from .market_disambiguation import batch_market_block_reason, build_barcode_market_pairs, try_market_disambiguation
from .normalize import is_combo_sku, normalize_key


def _build_master_indexes(master_rows: list[MasterRow]) -> tuple[
    dict[str, list[MasterRow]],
    dict[str, list[MasterRow]],
]:
    by_ice: dict[str, list[MasterRow]] = defaultdict(list)
    by_barcode: dict[str, list[MasterRow]] = defaultdict(list)
    for row in master_rows:
        if row.ice_code:
            by_ice[row.ice_code].append(row)
        if row.barcode:
            by_barcode[row.barcode].append(row)
    return by_ice, by_barcode


def _candidate_id(source: SourceRow, methods: list[str]) -> str:
    digest = hashlib.sha256(
        f'{source.source_row_key}|{"|".join(sorted(methods))}'.encode('utf-8')
    ).hexdigest()[:16]
    return f'mc-{digest}'


def _is_ph_single_sku(source: SourceRow) -> bool:
    wh = source.warehouse or ''
    if cfg.PH_WAREHOUSE_KEYWORD not in wh:
        return False
    if source.sheet_name != cfg.BIGSELLER_SHEET_SINGLE:
        return False
    if source.extra.get('is_combo'):
        return False
    return True


def _append_barcode_hits(
    key: str,
    method: str,
    *,
    by_barcode: dict[str, list[MasterRow]],
    methods: list[str],
    matched: list[MasterRow],
) -> None:
    if not key or key not in by_barcode:
        return
    methods.append(method)
    matched.extend(by_barcode[key])


def _ph_ice_keys(raw_sku: str) -> list[str]:
    """菲律宾单 SKU：整段货号 + 可选 `-` 前主货号（如 WM0110-P07 → WM0110）。"""
    raw = normalize_key(raw_sku)
    if not raw:
        return []
    keys = [raw]
    if '-' in raw:
        head = raw.split('-', 1)[0].strip()
        if head and head not in keys:
            keys.append(head)
    return keys


def _unique_masters(rows: list[MasterRow]) -> list[MasterRow]:
    seen: set[int] = set()
    out: list[MasterRow] = []
    for row in rows:
        if row.row_index in seen:
            continue
        seen.add(row.row_index)
        out.append(row)
    return sorted(out, key=lambda r: r.row_index)


def _match_source_row(
    source: SourceRow,
    by_ice: dict[str, list[MasterRow]],
    by_barcode: dict[str, list[MasterRow]],
    master_issues: list[MasterQualityIssue],
    barcode_market_pairs: dict[str, dict[str, str]],
) -> MatchCandidate:
    methods: list[str] = []
    matched: list[MasterRow] = []
    flags: list[str] = []

    dup_ice = {i.key for i in master_issues if i.issue_type == 'DUPLICATE_ICE_CODE'}
    dup_barcode = {i.key for i in master_issues if i.issue_type == 'DUPLICATE_BARCODE'}
    spec_conflict_ice = {i.key for i in master_issues if i.issue_type == 'SPEC_CONFLICT'}

    if source.source_system == cfg.SOURCE_BIGSELLER:
        raw = source.external_sku_raw
        sheet = source.sheet_name or ''
        sku_type = source.extra.get('sku_type') or ''
        if is_combo_sku(raw, sheet, sku_type):
            flags.append('COMBO_SKU')

        alias_ice = bigseller_alias_ice_code(raw, source.warehouse)
        if alias_ice and alias_ice in by_ice:
            methods.append('BS_SKU_ALIAS')
            matched.extend(by_ice[alias_ice])

        if _is_ph_single_sku(source):
            for key in _ph_ice_keys(raw):
                if key in by_ice:
                    methods.append('PH_ICE_CODE' if key == normalize_key(raw) else 'PH_ICE_CODE_PREFIX')
                    matched.extend(by_ice[key])
            # 少数菲律宾行 SKU 本身为匹配条码（数字条码）
            _append_barcode_hits(
                normalize_key(raw),
                'PH_BARCODE_SKU',
                by_barcode=by_barcode,
                methods=methods,
                matched=matched,
            )
            _append_barcode_hits(
                normalize_key(source.gtin_raw),
                'PH_GTIN_BARCODE',
                by_barcode=by_barcode,
                methods=methods,
                matched=matched,
            )
        else:
            sku_barcode = normalize_key(raw)
            _append_barcode_hits(
                sku_barcode,
                'BARCODE_SKU',
                by_barcode=by_barcode,
                methods=methods,
                matched=matched,
            )
            gtin = normalize_key(source.gtin_raw)
            if gtin and gtin != sku_barcode:
                _append_barcode_hits(
                    gtin,
                    'GTIN_BARCODE',
                    by_barcode=by_barcode,
                    methods=methods,
                    matched=matched,
                )

    elif source.source_system == cfg.SOURCE_JUSHUITAN:
        style = normalize_key(source.extra.get('style_code'))
        product = normalize_key(source.extra.get('product_code'))
        lookup_keys = jushuitan_master_lookup_keys(
            style, product, source.external_name
        )
        for i, code in enumerate(lookup_keys):
            origin = 'JST_STYLE_CODE' if code == style else (
                'JST_PRODUCT_CODE' if code == product else 'JST_ICE_DERIVED'
            )
            if code in by_ice:
                methods.append(origin if i == 0 else f'{origin}_ICE')
                matched.extend(by_ice[code])
            if code in by_barcode:
                methods.append(f'{origin}_BARCODE')
                matched.extend(by_barcode[code])

    master_matches = _unique_masters(matched)
    methods = sorted(set(methods))

    disambiguated, dis_flags, dis_methods = try_market_disambiguation(
        source, master_matches, barcode_market_pairs
    )
    if dis_flags:
        master_matches = disambiguated
        flags.extend(dis_flags)
        methods = sorted(set(methods + dis_methods))

    allowed = [m for m in master_matches if not batch_market_block_reason(source, m)]
    if len(allowed) != len(master_matches):
        flags.append('BATCH_MARKET_REJECTED')
    master_matches = allowed

    for m in master_matches:
        if m.ice_code in dup_ice:
            flags.append('MASTER_DUPLICATE_ICE')
        if m.barcode in dup_barcode:
            flags.append('MASTER_DUPLICATE_BARCODE')
        if m.ice_code in spec_conflict_ice:
            flags.append('MASTER_SPEC_CONFLICT')

    if len(master_matches) > 1:
        flags.append('ONE_TO_MANY')
    if len(master_matches) == 0:
        flags.append('UNMATCHED')

    if source.extra.get('is_combo'):
        flags.append('COMBO_SKU')

    lifecycle = 'unmatched' if not master_matches else 'pending_review'
    auto_confirm_forbidden = True

    notes = ''
    if source.scope == cfg.SCOPE_INVENTORY_PUBLISH:
        notes = '首批库存闭环候选（DEE 单 SKU）；须人工核对后才会进入发布链。'
    elif source.source_system == cfg.SOURCE_JUSHUITAN:
        notes = '聚水潭样表：仅匹配分析，不扩大库存发布范围。'

    return MatchCandidate(
        candidate_id=_candidate_id(source, methods or ['none']),
        source=source,
        lifecycle=lifecycle,
        match_methods=methods,
        master_matches=master_matches,
        flags=sorted(set(flags)),
        auto_confirm_forbidden=auto_confirm_forbidden,
        notes=notes,
    )


def build_match_bundle(
    master_rows: list[MasterRow],
    source_rows: list[SourceRow],
) -> dict:
    master_issues = analyze_master_quality(master_rows)
    by_ice, by_barcode = _build_master_indexes(master_rows)
    barcode_market_pairs = build_barcode_market_pairs(master_rows)

    from .match_policy import LIFECYCLE_OUTSIDE, apply_policy_to_candidate

    candidates = [
        _match_source_row(source, by_ice, by_barcode, master_issues, barcode_market_pairs)
        for source in source_rows
    ]

    for c in candidates:
        apply_policy_to_candidate(c)

    source_dup_flags: dict[str, list[str]] = defaultdict(list)
    master_key_to_sources: dict[str, list[str]] = defaultdict(list)
    for c in candidates:
        if c.lifecycle == LIFECYCLE_OUTSIDE:
            continue
        if len(c.master_matches) == 1:
            m = c.master_matches[0]
            master_key_to_sources[m.ice_code or m.barcode].append(c.candidate_id)

    for key, ids in master_key_to_sources.items():
        if len(ids) > 1:
            for cid in ids:
                source_dup_flags[cid].append('MANY_TO_ONE')

    for c in candidates:
        if c.lifecycle == LIFECYCLE_OUTSIDE:
            continue
        extra = source_dup_flags.get(c.candidate_id, [])
        if extra:
            c.flags = sorted(set(c.flags + extra))

    summary = {
        'master_row_count': len(master_rows),
        'source_row_count': len(source_rows),
        'candidate_count': len(candidates),
        'master_quality_issue_count': len(master_issues),
        'lifecycle': {
            'pending_review': sum(1 for c in candidates if c.lifecycle == 'pending_review'),
            'unmatched': sum(1 for c in candidates if c.lifecycle == 'unmatched'),
            LIFECYCLE_OUTSIDE: sum(1 for c in candidates if c.lifecycle == LIFECYCLE_OUTSIDE),
        },
        'scope': {
            cfg.SCOPE_INVENTORY_PUBLISH: sum(
                1 for c in candidates if c.source.scope == cfg.SCOPE_INVENTORY_PUBLISH
            ),
            cfg.SCOPE_MATCH_ONLY: sum(
                1 for c in candidates if c.source.scope == cfg.SCOPE_MATCH_ONLY
            ),
        },
        'flags': {},
    }
    for c in candidates:
        for flag in c.flags:
            summary['flags'][flag] = summary['flags'].get(flag, 0) + 1

    from .name_review import apply_name_review_bundle

    bundle = {
        'master_rows': [m.to_public() for m in master_rows],
        'master_quality_issues': [i.to_public() for i in master_issues],
        'candidates': [c.to_public() for c in candidates],
        'summary': summary,
        'barcode_market_pairs': barcode_market_pairs,
    }
    return apply_name_review_bundle(bundle, master_rows)
