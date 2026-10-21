"""Read-only coverage of the approved saved result; never import the matcher.

Only output artifacts are created. Frozen XLSX reads supply missing file/row
provenance for JST records, not new matches or decisions.
"""
from __future__ import annotations

import argparse
import copy
import csv
import hashlib
import json
import os
import re
import shutil
from collections import Counter, defaultdict
from pathlib import Path
from xml.etree import ElementTree as ET
from zipfile import ZipFile

from coverage_image_evidence import inspect_images

PINNED = {
    'match-bundle.json': 'c0fa4bc9814080a9e78d15ad7136276e03156254d67a3fe59e4d49c841e80936',
    'manual-decisions.effective.csv': 'a66c564942220f5df4e1043ab2b076f1cec26c3056fa8dffd5a2e2733844b58f',
}
JST_APPROVED_PINS = {
    'match-bundle.json': '3c2babc9b13ca11fab14cb4bbce5e8617052319d06bc80c922256f6893346159',
    'manual-decisions.effective.csv': '48544cd03154131970fce220fb2ff7c704e18d7860e2ea7c72e6a0ef1ac8d921',
}
FINAL_SOURCES = {
    'mc-e1b56fb81b0db46c': ('bigseller', 376, '6974674957349', 19, 'WM0012', 'confirm'),
    'mc-73ac4812d7d8de64': ('bigseller', 380, '6974674957349', 19, 'WM0012', 'confirm'),
    'mc-b7bd376e964738cd': ('bigseller', 526, '6974674957349', 19, 'WM0012', 'confirm'),
    'mc-75e0ce710d064c4c': ('jushuitan', 857, 'WM0130', 121, 'WM0130', 'confirm'),
    'mc-44b8f0236d346bc7': ('bigseller', 220, '757577407359', 67, 'WM0073', 'confirm'),
    'mc-c8e6e17fc25361f1': ('bigseller', 321, '757577407359', 67, 'WM0073', 'confirm'),
}
NS = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
LABELS = {'both': '两边已有选择', 'bigseller_only': '仅BigSeller已有选择',
          'jushuitan_only': '仅聚水潭已有选择', 'neither': '两边均未找到已确认对应'}
SPECIFICATION_REVIEW_CODES = ('WM0006', 'WM0008', 'WM0130', 'WM0031', 'WM0062', 'WM0098')
JST_DECISIONS = {
    'mc-f713998ca2c722a8': ('WM0069', 796, 213, 'confirm'),
    'mc-151a8acf447c6aff': ('WM0070', 797, 214, 'confirm'),
    'mc-4ce480743171808b': ('WM0071', 798, 215, 'confirm'),
    'mc-fd977bdb831a5b5b': ('WM0072', 799, 66, 'confirm'),
    'mc-6148a4d4e40a80ba': ('WM0073', 800, 67, 'confirm'),
    'mc-26aa4e763d422095': ('WM0082', 809, 84, 'confirm'),
    'mc-30c30b04c4ff9e0d': ('WM0092', 819, 212, 'confirm'),
    'mc-6f83255696c02117': ('WM0095', 822, 115, 'confirm'),
    'mc-a4a549dc9518a3d4': ('WM0117', 844, 108, 'confirm'),
    'mc-c3d22fb31a28db96': ('WM0128', 855, 116, 'confirm'),
    'mc-215172d1fdd95149': ('WM0129', 856, 123, 'confirm'),
    'mc-eec4d01202d4a7de': ('WM0007', 744, 15, 'ignore'),
}


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def approved_input_pins(base, input_pins=None):
    """Alternate hashes require the exact new batch's explicit authorization chain."""
    if input_pins is None:
        return PINNED, None
    config = read(input_pins)
    assert set(config['pins']) == set(PINNED), 'expected bundle and CSV pins'
    if config.get('authorization_kind') == 'final_product_decisions_v1':
        return approved_final_pins(base, config), config
    previous = config['previous_baseline']
    assert previous['pins'] == PINNED, 'unapproved previous baseline'
    old_base = Path(previous['directory'])
    assert all(sha(old_base / n) == h for n, h in PINNED.items()), 'previous baseline changed'
    decision = config['decision_file']
    assert sha(decision['path']) == decision['sha256'], 'explicit decision hash mismatch'
    plan = read(decision['path'])
    assert plan['base_hashes'] == PINNED, 'explicit decision base mismatch'
    assert len(plan['source_decisions']) == len(JST_DECISIONS)
    assert {d['candidate_id'] for d in plan['source_decisions']} == set(JST_DECISIONS)
    old = read(old_base / 'match-bundle.json')
    candidates = {c['candidate_id']: c for c in old['candidates']}
    for d in plan['source_decisions']:
        code, source_row, target_row, action = JST_DECISIONS[d['candidate_id']]
        source = candidates[d['candidate_id']]['source']
        assert (d['target_ice'], d['source_file']['excel_row'], d['target_row'], d['decision']) == (code, source_row, target_row, action)
        assert d['source'] == source and d['source_identity'] == ['jushuitan', code, code]
        assert source['source_row_key'] == f'jushuitan:{source_row}:{code}:{code}'
        assert d['source_file']['file_name'] == '商品资料_20261015165159_200874071_1.xlsx'
        assert d['source_file']['sheet_name'] == 'Sheet1' and d['reason'].strip()
    bundle = read(base / 'match-bundle.json')
    assert bundle['batch_bs_not_created'] == plan['bs_not_created']
    assert {r['ice_code'] for r in plan['bs_not_created']} == {'WM0070', 'WM0072'}
    assert len(bundle['jst_confirmation_events']) == len(JST_DECISIONS)
    assert [e['explicit_decision'] for e in bundle['jst_confirmation_events']] == plan['source_decisions']
    return config['pins'], config


def approved_final_pins(base, config):
    """Only the final finite authorization may extend the latest approved batch."""
    previous = config['previous_baseline']
    assert previous['pins'] == JST_APPROVED_PINS, 'final predecessor pins'
    old_base = Path(previous['directory'])
    assert all(sha(old_base / n) == h for n, h in JST_APPROVED_PINS.items()), 'final predecessor bytes'
    decision = config['decision_file']
    assert sha(decision['path']) == decision['sha256'], 'final explicit decision hash'
    plan = read(decision['path'])
    assert plan['base_hashes'] == JST_APPROVED_PINS, 'final explicit base'
    old, new = read(old_base / 'match-bundle.json'), read(base / 'match-bundle.json')
    decisions = plan['source_decisions']
    assert len(decisions) == 8 and len({d['candidate_id'] for d in decisions}) == 8
    old_by = {c['candidate_id']: c for c in old['candidates']}
    expected = dict(FINAL_SOURCES)
    for code, row in [('WM0006', 743), ('WM0008', 745)]:
        c = next(c for c in old['candidates'] if c['source']['source_system'] == 'jushuitan' and
                 c['source']['source_row_key'] == f'jushuitan:{row}:{code}:{code}')
        expected[c['candidate_id']] = ('jushuitan', row, code, c['master_matches'][0]['row_index'], code, 'ignore')
    assert {d['candidate_id'] for d in decisions} == set(expected), 'final finite source scope'
    for d in decisions:
        system, row, sku, target, code, action = expected[d['candidate_id']]
        assert d['source'] == old_by[d['candidate_id']]['source'], 'final source identity'
        identity = ['bigseller', d['source']['source_row_key']] if system == 'bigseller' else ['jushuitan', sku, sku]
        assert d['source_identity'] == identity, 'final explicit scoped identity'
        assert (d['source']['source_system'], d['source_file']['excel_row'], d['source']['external_sku_raw'],
                d['target_row'], d['target_ice'], d['decision']) == (system, row, sku, target, code, action)
        assert d['reason'].strip() and new['master_rows'] == old['master_rows'], 'final reason or master mutation'
    assert [e['explicit_decision'] for e in new['final_confirmation_events']] == decisions, 'final once-only events'
    assert new['batch_specification_resolutions'] == plan['specification_resolutions'], 'final specification authority'
    assert {r['ice_code'] for r in plan['specification_resolutions']} == set(SPECIFICATION_REVIEW_CODES)
    assert new['batch_brush_preservation'] == plan['brush_preservation'], 'final brush preservation'
    assert new['batch_version_confirmations'] == [dict(v, effective_selection=True) for v in plan['version_confirmations']], 'final version authority'
    assert not new['batch_business_pending'] and new['resolved_business_pending_history'], 'final version closure history'
    assert new['resolved_business_pending_history'][0]['previous_pending'] == old['batch_business_pending'][0], 'final original pending history'
    assert new['batch_bs_not_created'] == old['batch_bs_not_created'], 'final BS explanation retained'
    return config['pins']


def xlsx_rows(path, sheet_name=None, row_numbers=None):
    """Read cached strings/numbers in the first sheet using the OOXML public format."""
    with ZipFile(path) as z:
        strings = []
        if 'xl/sharedStrings.xml' in z.namelist():
            for si in ET.fromstring(z.read('xl/sharedStrings.xml')).findall('s:si', NS):
                strings.append(''.join(si.itertext()))
        workbook = ET.fromstring(z.read('xl/workbook.xml'))
        sheets = workbook.findall('s:sheets/s:sheet', NS)
        sheet = next(s for s in sheets if s.attrib['name'] == sheet_name) if sheet_name else sheets[0]
        rid = sheet.attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id']
        rels = ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))
        target = next(r.attrib['Target'] for r in rels if r.attrib['Id'] == rid)
        target = target.lstrip('/') if target.startswith('/') else 'xl/' + target
        rows = []
        for row in ET.fromstring(z.read(target)).findall('s:sheetData/s:row', NS):
            if row_numbers is not None and int(row.attrib['r']) != 1 and int(row.attrib['r']) not in row_numbers:
                continue
            cells = {}
            for c in row.findall('s:c', NS):
                value = c.find('s:v', NS)
                text = value.text if value is not None and value.text is not None else ''
                if c.attrib.get('t') == 's':
                    text = strings[int(text)] if text else ''
                elif c.attrib.get('t') == 'inlineStr':
                    text = ''.join(c.find('s:is', NS).itertext())
                cells[re.sub(r'\d+', '', c.attrib['r'])] = text
            rows.append((int(row.attrib['r']), cells))
        headers = rows[0][1]
        return sheet.attrib['name'], [(n, {headers.get(k, k): v for k, v in r.items()}) for n, r in rows[1:]]


def source_provenance(base, manifest, candidates):
    """Attach original files to already frozen identities, preserving all occurrences."""
    inputs = manifest['original_input_hashes']
    occurrences = defaultdict(list)
    for item in inputs['jushuitan']['paths']:
        path = base / item['frozen']
        assert sha(path) == item['sha256']
        sheet, rows = xlsx_rows(path)
        for number, row in rows:
            style, sku = row.get('款式编码', '').strip(), row.get('商品编码', '').strip()
            if style or sku:
                occurrences[(style, sku)].append({
                    'original_file': Path(item['path']).name, 'original_path': item['path'],
                    'frozen_path': str(path), 'sha256': item['sha256'], 'sheet': sheet,
                    'excel_row': number, 'style_code': style, 'product_code': sku,
                    'external_name': row.get('商品名称', ''), 'available_qty': row.get('可用数', ''),
                })
    result = {}
    for c in candidates:
        s = c['source']
        if s['source_system'] == 'bigseller':
            item = inputs['bigseller']
            number = int(s['source_row_key'].split(':', 3)[2])
            origin = {'original_file': Path(item['path']).name, 'original_path': item['path'],
                      'frozen_path': str(base / item['frozen']), 'sha256': item['sha256'],
                      'sheet': s['sheet_name'], 'excel_row': number}
            origins = [origin]
        else:
            e = s['extra']
            origins = occurrences[(e.get('style_code') or '', e.get('product_code') or '')]
            assert origins, c['candidate_id']
            # Verify the existing merge's saved row, without changing/merging the bundle.
            origin = origins[-1]
            assert origin['excel_row'] == int(s['source_row_key'].split(':')[1])
            assert origin['sheet'] == s['sheet_name']
            assert origin['external_name'] == s['external_name']
            assert origin['available_qty'] == (s['available_qty'] or '')
        result[c['candidate_id']] = {'effective_origin': origin, 'all_input_occurrences': origins,
                                    'basis': '冻结来源身份与原行核对；JST文件顺序仅复核既有合并结果，不生成对应'}
    return result


def related_rows(c):
    return sorted({m['row_index'] for m in c['master_matches']}
                  | {m['row_index'] for m in (c.get('name_review') or {}).get('nameOnlyMasters', [])}
                  | ({c['selected_master']['row_index']} if c.get('selected_master') else set()))


def pending_category(c):
    if c['review_state'] not in ('pending', 'candidate'):
        return None
    if c['review_decision'] == 'defer':
        return 'explicit_defer'
    if c['master_matches']:
        return 'unconfirmed_candidate'
    if (c.get('name_review') or {}).get('nameOnlyMasters'):
        return 'name_hint_only'
    return 'no_saved_candidate'


def no_candidate_explanation(c):
    s = c['source']; e = s.get('extra') or {}
    if s['source_system'] == 'bigseller':
        return 'BigSeller现有结果无候选；不能证明主库没有该商品'
    if '.' in (e.get('style_code') or '') or '.' in (e.get('product_code') or ''):
        return 'JST编码含分段符；含物料/组件式记录，不能硬套成品，也未建立组件关系'
    if e.get('style_code') != e.get('product_code'):
        return 'JST款式与商品编码不同；当前未建立其与主库的确认关系'
    if (e.get('style_code') or '').upper().startswith('SY1'):
        return 'JST为SY1系列编码；现有结果未给出成品主库候选，不新增组件或成品关系'
    return 'JST现有结果无候选；仅凭本批证据不能确认关系或断言来源不存在'


def build(base, pins=None):
    for name, expected in (pins or PINNED).items():
        assert sha(base / name) == expected, ('baseline_hash_mismatch', name)
    b = read(base / 'match-bundle.json')
    final = 'final_confirmation_events' in b
    details = read(base / 'master-overview.json')
    assert details == b['master_provenance']
    masters = {m['row_index']: m for m in details}
    candidates = b['candidates']
    assert len(masters) == len(details) == 126
    codes = [m['ice_code'] for m in details if m['ice_code']]
    assert len(codes) == len(set(codes)) == 125
    assert len({c['candidate_id'] for c in candidates}) == len(candidates) == 1417
    assert Counter(c['source']['source_system'] for c in candidates) == {'bigseller': 530, 'jushuitan': 887}
    manifest = read(base / 'input-manifest.json')
    images = inspect_images(base, manifest, details)
    images_by_row = {m['master_anchor_row']: m for m in images['masters']}
    provenance = source_provenance(base, manifest, candidates)
    source_rows = []
    for c in candidates:
        chosen = c.get('selected_master')
        assert bool(chosen) == (c['review_state'] == 'manual_selected')
        if chosen:
            m = next(m for m in b['master_rows'] if m['row_index'] == chosen['row_index'])
            assert chosen == m and not c['validation_errors']
        relations = related_rows(c)
        assert all(n in masters for n in relations)
        source_rows.append({
            'candidate_id': c['candidate_id'], 'source': c['source'],
            'account': None, 'market': None, 'effective_time': None,
            'scope_missing_note': '样表未提供账号/市场/关系有效期；不推造字段，不宣称正式关系已建',
            'provenance': provenance[c['candidate_id']], 'review_state': c['review_state'],
            'review_decision': c['review_decision'], 'review_notes': c['review_notes'],
            'selected_master': chosen, 'selected_jushuitan': c.get('selected_jushuitan'),
            'candidate_targets': c['master_matches'],
            'name_only_hints': (c.get('name_review') or {}).get('nameOnlyMasters', []),
            'related_master_anchors': relations, 'general_review_category': pending_category(c),
            'relationship_note': no_candidate_explanation(c) if pending_category(c) == 'no_saved_candidate' else c['review_reason'],
            'batch_business_pending': c['batch_business_pending'],
            'baseline_pointer': f"match-bundle.json#/candidates/{len(source_rows)}",
        })
        if final:
            source_rows[-1]['batch_version_confirmation'] = c.get('batch_version_confirmation')
    by_id = {r['candidate_id']: r for r in source_rows}
    formulas = read(base / 'source-formulas-and-errors.json')
    master_input = manifest['original_input_hashes']['master']
    covered = []
    def readable_source(r):
        return {'candidate_id': r['candidate_id'], 'system': r['source']['source_system'],
                'warehouse': r['source']['warehouse'], 'sku': r['source']['external_sku_raw'],
                'name': r['source']['external_name'], 'origin': r['provenance']['effective_origin'],
                'review_state': r['review_state'], 'review_decision': r['review_decision'],
                'version_pending': r['batch_business_pending']}
    for m in details:
        row = m['row_index']
        members = [r for r in source_rows if r['selected_master'] and r['selected_master']['row_index'] == row]
        assert {r['candidate_id'] for r in members} == set(m['selected_source_ids'])
        bs = defaultdict(list)
        for r in members:
            if r['source']['source_system'] == 'bigseller':
                bs[r['source']['warehouse']].append(r['candidate_id'])
        jst = [r['candidate_id'] for r in members if r['source']['source_system'] == 'jushuitan']
        cls = ('both' if jst else 'bigseller_only') if bs else ('jushuitan_only' if jst else 'neither')
        pending = [r for r in source_rows if row in r['related_master_anchors'] and r['general_review_category']]
        inactive = [r['candidate_id'] for r in source_rows if row in r['related_master_anchors']
                    and r['review_state'] in ('rejected', 'ignored', 'outside_rules')]
        open_versions = [r['candidate_id'] for r in members if r['batch_business_pending']]
        gaps = [k for k, v in m['data'].items() if v is None or str(v).strip() == '']
        bad_refs = [f for f in formulas if '#REF!' in f['value'] and int(re.search(r'\d+', f['coordinate'])[0]) in m['source_rows']]
        shared = [q for q in b['master_quality_issues'] if row in q['row_indices']]
        deferred = []
        context_only = []
        if m['ice_code'] in ('WM0081', 'brush'):
            deferred.append('刷子两款保持分开，不新增对应；按已批准延期登记，不重复催问')
            context_only = [r['candidate_id'] for r in source_rows if r['source']['source_system'] == 'bigseller'
                            and '硅胶刷' in r['source']['external_name'] and r['review_state'] == 'pending']
        if m['ice_code'] == 'WM0073' and not final:
            deferred.append('菲越757577407359两条显式defer继续目标为空；仅登记已批准延期的相关证据')
            context_only = [r['candidate_id'] for r in source_rows if r['review_decision'] == 'defer'
                            and r['source']['external_sku_raw'] == '757577407359']
        if row == 122:
            deferred.append('新品缺货号/条码；JST WM0131仅同名提示，用户已要求待补，不认领该码')
        if m['ice_code'] == 'WM0040':
            deferred.append('旧商品主资料保留，不认定确定停产')
        if not m['data'].get('生产工厂'):
            deferred.append('工厂资料缺失/失效引用按既有延期保留，不猜填')
        covered.append({
            'master_anchor_row': row, 'ice_code': m['ice_code'], 'name_cn': m['name_cn'], 'spec_column': m['spec'],
            'master_source': {'original_file': Path(master_input['path']).name, 'sha256': master_input['sha256'],
                              'frozen_path': str(base / master_input['frozen']), 'original_rows': m['source_rows'],
                              'primary_row': m['primary_row'], 'baseline_pointer': f'master-overview.json#/{len(covered)}'},
            'coverage_class': cls, 'coverage_label': LABELS[cls],
            'bigseller_selected_by_warehouse': dict(bs), 'jushuitan_selected': jst,
            'selected_source_details': [readable_source(r) for r in members],
            'effective_selection_count': len(members),
            'unconfirmed_candidates': [r['candidate_id'] for r in pending if row in [t['row_index'] for t in r['candidate_targets']]],
            'unconfirmed_candidate_details': [readable_source(r) for r in pending if row in [t['row_index'] for t in r['candidate_targets']]],
            'name_only_hints': [r['candidate_id'] for r in pending if row in [n['row_index'] for n in r['name_only_hints']]],
            'deferred_related_sources': [r['candidate_id'] for r in pending if r['review_decision'] == 'defer'],
            'inactive_related_sources': inactive,
            'context_only_sources': context_only,
            'context_only_note': '已有延期/无法区分的来源记录，仅供追溯，不作为候选或有效对应',
            'data_gaps': gaps, 'data_gap_note': '仅列当前资料空值，不规定全部必填；规格专列为空不等于名称中无规格；产品图片值空仅指单元格，不代表缺少嵌入图片，图片对象状态另列且内容未核验',
            'image_evidence': images_by_row[row],
            'spec_audit_question_ids': ['audit-spec-' + m['ice_code']] if m['ice_code'] in SPECIFICATION_REVIEW_CODES else [],
            'source_coverage_gap': {'bigseller': None if bs else '当前未找到已确认对应',
                                    'jushuitan': None if jst else '当前未找到已确认对应'},
            'version_review': {'pending_records': open_versions,
                               'status': '已登记版本待决' if open_versions else '无已登记版本待决；未作全面版本认证',
                               'all_versions_verified': None},
            'shared_barcode_facts': shared, 'invalid_formula_references': bad_refs, 'approved_deferrals': deferred,
            'price_facts': {'current_cost': m['data'].get('成本价格'), 'current_operating_price': m['data'].get('运营价格'),
                            'price_pending': m['price_pending'], 'source_versions': m['price_versions'],
                            'current_selection': m.get('current_price_selection'), 'valuation_authorized': m['valuation_authorized']},
        })
        if 'batch_bs_not_created' in b:
            status = m.get('bs_creation_status')
            expected_status = next((r for r in b['batch_bs_not_created'] if r['master_row'] == row), None)
            assert status == expected_status
            if status:
                assert status['ice_code'] == m['ice_code'] and not bs
                covered[-1]['source_coverage_gap']['bigseller'] = status['reason']
            covered[-1]['bigseller_creation_status'] = status
        if final:
            covered[-1]['specification_resolution'] = m.get('specification_resolution')
            covered[-1]['brush_preservation'] = m.get('brush_preservation')
            confirmed = [r['candidate_id'] for r in members if r.get('batch_version_confirmation')]
            covered[-1]['version_review']['confirmed_records'] = confirmed
            if confirmed:
                covered[-1]['version_review']['status'] = '指定菲越三条已由用户确认升级款；未作全面版本认证'
    general = [r for r in source_rows if r['general_review_category']]
    summary = {
        'masters': len(covered), 'nonempty_ice_codes': len(codes), 'distinct_nonempty_ice_codes': len(set(codes)),
        'missing_ice_codes': len(details) - len(codes), 'sources': len(source_rows),
        'source_systems': dict(Counter(r['source']['source_system'] for r in source_rows)),
        'coverage': dict(Counter(r['coverage_class'] for r in covered)),
        'review_states': dict(Counter(r['review_state'] for r in source_rows)),
        'effective_selected_sources': sum(r['effective_selection_count'] for r in covered),
        'general_review_records': len(general), 'general_review_categories': dict(Counter(r['general_review_category'] for r in general)),
        'no_saved_candidate_explanations': dict(Counter(r['relationship_note'] for r in general if r['general_review_category'] == 'no_saved_candidate')),
        'registered_business_issues': len(b['batch_business_pending']),
        'registered_version_pending_records': sum(len(r['version_review']['pending_records']) for r in covered),
        'data_empty_field_counts': dict(Counter(k for r in covered for k in r['data_gaps'])),
        'shared_barcode_groups': len(b['master_quality_issues']),
        'invalid_formula_cells': sum(len(r['invalid_formula_references']) for r in covered),
        'masters_with_invalid_formula': sum(bool(r['invalid_formula_references']) for r in covered),
        'source_account_market_effective_time_provided': False,
        'image_objects': images['summary'],
        'specification_audit_questions': sum(len(r['spec_audit_question_ids']) for r in covered),
    }
    if final:
        summary['open_specification_audit_questions'] = sum(not r.get('specification_resolution')
            for r in covered if r['spec_audit_question_ids'])
        summary['closed_specification_audit_questions'] = sum(bool(r.get('specification_resolution'))
            for r in covered if r['spec_audit_question_ids'])
        summary['registered_version_confirmed_records'] = sum(len(r['version_review']['confirmed_records']) for r in covered)
        summary['remaining_user_decisions'] = len(b['batch_business_pending']) + summary['open_specification_audit_questions']
    assert sum(summary['coverage'].values()) == len(covered)
    assert summary['effective_selected_sources'] == summary['review_states']['manual_selected']
    assert set(by_id) == {c['candidate_id'] for c in candidates}
    return covered, source_rows, summary, images


def audit_questions(base, covered, sources):
    """Evidence questions are audit annotations, never edits to saved decisions."""
    b = read(base / 'match-bundle.json')
    if 'final_confirmation_events' in b:
        return final_audit_questions(base, b, covered, sources)
    by_master = {m['ice_code']: m for m in covered}
    source_by_id = {r['candidate_id']: r for r in sources}
    existing = b['batch_business_pending'][0]
    questions = [{
        'id': 'existing-ph-vn-cleanser-version', 'kind': 'existing_business_issue',
        'product': '菲越普通洗面奶：LS101275原款 / WM0012升级普通版',
        'current_correspondence': [{'candidate_id': cid, 'target': source_by_id[cid]['selected_master'],
                                    'source': source_by_id[cid]['source']} for cid in existing['candidate_ids']],
        'evidence': '沿用用户已核查结论：各仓只有一条6974674957349，名称/GTIN/重量/尺寸/图片链接相同、备注为空，组合页亦无区分版本记录。本轮未重复扫描。',
        'uncertain': '无法逐条证明原款或升级款，已有WM0012选择不代表版本已确认。',
        'user_choice_needed': '后续提供可区分原款/升级款的实际记录，按三条分别核实；现有值及历史保留。',
        'blocks_this_readonly_batch': False, 'baseline_pending_unchanged': True,
    }]
    for code in ('WM0006', 'WM0008', 'WM0130'):
        product = by_master[code]
        m = next(m for m in b['master_provenance'] if m['ice_code'] == code)
        refs = [r for r in sources if r['candidate_id'] in product['unconfirmed_candidates']]
        assert len(refs) == 1 and refs[0]['selected_master'] is None
        r = refs[0]
        questions.append({
            'id': 'audit-spec-' + code, 'kind': 'new_specification_evidence_question',
            'product': {'ice_code': code, 'name': product['name_cn'], 'master_anchor': product['master_anchor_row']},
            'current_correspondence': {'bigseller_selected': product['bigseller_selected_by_warehouse'],
                                       'jushuitan_selected': product['jushuitan_selected'],
                                       'unconfirmed_candidate_id': r['candidate_id']},
            'evidence': {'master_name': m['name_cn'], 'master_spec_column': m['spec'],
                         'master_single_product_weight_kg': m['data'].get('单个产品重量(kg）'),
                         'master_note': m['data'].get('备注'), 'jst_source_name': r['source']['external_name'],
                         'source_origin': r['provenance']['effective_origin']},
            'uncertain': '名称/规格分别使用克重和容量，现有资料无法证明是净容量与整件重量差异、填写口径差异或不同版本；不能自行换算或当作确定错品。',
            'user_choice_needed': '本轮不要求提供包装或作答；资料是否及如何补正留待后续，当前保持原状。',
            'blocks_this_readonly_batch': False,
            'decision_unchanged': '仅新增审计疑点说明；JST仍是未人工确认候选，不写confirm，不改变主资料或原业务待决文件。',
        })
    manifest = read(base / 'input-manifest.json')
    inputs = manifest['original_input_hashes']
    master_item = inputs['master']
    assert sha(base / master_item['frozen']) == master_item['sha256']
    master_sheet, raw_master_rows = xlsx_rows(base / master_item['frozen'], row_numbers={25, 83, 92})
    raw_masters = dict(raw_master_rows)
    spec_scope = {
        'WM0031': {'bigseller': set(), 'jushuitan': {758}},
        'WM0062': {'bigseller': {230, 313, 383, 384, 385}, 'jushuitan': set()},
        'WM0098': {'bigseller': {2, 188, 189, 221, 223}, 'jushuitan': {825}},
    }

    def source_evidence(r):
        origin = r['provenance']['effective_origin']
        assert sha(Path(origin['frozen_path'])) == origin['sha256']
        _, raw_rows = xlsx_rows(Path(origin['frozen_path']), origin['sheet'], {origin['excel_row']})
        raw = dict(raw_rows)[origin['excel_row']]
        is_bs = r['source']['source_system'] == 'bigseller'
        name, sku = raw['名称' if is_bs else '商品名称'], raw['SKU编号' if is_bs else '商品编码']
        assert name == r['source']['external_name'] and sku == r['source']['external_sku_raw']
        if is_bs:
            assert raw['仓库'] == r['source']['warehouse']
        return {'candidate_id': r['candidate_id'], 'system': r['source']['source_system'],
                'warehouse': r['source']['warehouse'], 'origin': origin, 'raw_name': name, 'raw_sku': sku,
                'selected_master': r['selected_master'], 'review_state': r['review_state'],
                'review_decision': r['review_decision']}

    for code, scope in spec_scope.items():
        product = by_master[code]
        m = next(m for m in b['master_provenance'] if m['ice_code'] == code)
        raw = raw_masters[m['row_index']]
        assert raw['规格'] == m['spec'] and raw['中文产品名称'] == m['name_cn']
        refs = [r for r in sources if r['source']['source_system'] in scope
                and r['provenance']['effective_origin']['excel_row'] in scope[r['source']['source_system']]]
        assert len(refs) == sum(len(rows) for rows in scope.values())
        assert all(r['selected_master'] and r['selected_master']['ice_code'] == code for r in refs)
        rejected = [r for r in sources if code == 'WM0062' and r['source']['source_system'] == 'jushuitan'
                    and r['provenance']['effective_origin']['excel_row'] == 789]
        assert all(r['review_decision'] == 'reject' and r['selected_master'] is None for r in rejected)
        questions.append({
            'id': 'audit-spec-' + code, 'kind': 'selected_specification_evidence_question',
            'product': {'ice_code': code, 'name': m['name_cn'], 'master_anchor': m['row_index']},
            'current_correspondence': {'bigseller_selected': product['bigseller_selected_by_warehouse'],
                                       'jushuitan_selected': product['jushuitan_selected'],
                                       'selected_source_ids': m['selected_source_ids']},
            'evidence': {'master': {'original_file': Path(master_item['path']).name, 'original_path': master_item['path'],
                                    'frozen_path': str(base / master_item['frozen']), 'sha256': master_item['sha256'],
                                    'sheet': master_sheet, 'excel_row': m['row_index'],
                                    'raw_name': raw['中文产品名称'], 'raw_spec': raw['规格']},
                         'sources': [source_evidence(r) for r in refs],
                         'preserved_rejected_sources': [source_evidence(r) for r in rejected]},
            'uncertain': '已确认商品对应不等于规格字段已核实；g与ml的口径差异既不能证明错品，也不能证明等价，不换算、不猜测哪边正确。',
            'user_choice_needed': '本轮不要求提供包装或作答；规格是否及如何补正留待后续，当前保持原状。',
            'blocks_this_readonly_batch': False,
            'decision_unchanged': '所有既有选择不撤销、不降级、不新增确认；原拒绝继续保留，不写入业务待决或人工决定文件。',
        })
    return questions


def final_audit_questions(base, bundle, covered, sources):
    """Retain each original explanation while making the new current decision explicit."""
    historical = read(base / 'inherited-baseline/coverage/audit-questions.json')
    by_product = {r['ice_code']: r for r in covered}
    by_source = {r['candidate_id']: r for r in sources}
    original = next(q for q in historical if q['kind'] == 'existing_business_issue')
    version_ids = [r['candidate_id'] for r in bundle['batch_version_confirmations']]
    issue = copy.deepcopy(original)
    issue.update(status='closed_user_confirmed_upgraded', previous_audit_question=original,
        current_correspondence=[{'candidate_id': cid, 'target': by_source[cid]['selected_master'],
                                'source': by_source[cid]['source']} for cid in version_ids],
        resolution=copy.deepcopy(bundle['batch_version_confirmations']),
        uncertain='本轮用户确认三条均为升级普通版WM0012；此前无法区分版本的调查结论作为历史保留。',
        user_choice_needed='无新增选择要求；本项当前已关闭。', baseline_pending_unchanged=False)
    questions = [issue]
    resolutions = {r['ice_code']: r for r in bundle['batch_specification_resolutions']}
    for original in (q for q in historical if q['kind'] != 'existing_business_issue'):
        q = copy.deepcopy(original); code = q['product']['ice_code']; product = by_product[code]
        resolution = resolutions[code]
        assert resolution['previous_audit_question'] == original, 'original specification audit history'
        current = {'bigseller_selected': product['bigseller_selected_by_warehouse'],
                   'jushuitan_selected': product['jushuitan_selected']}
        if q['kind'] == 'new_specification_evidence_question':
            cid = original['current_correspondence']['unconfirmed_candidate_id']; r = by_source[cid]
            current.update(source_id=cid, review_state=r['review_state'], review_decision=r['review_decision'],
                           selected_master=r['selected_master'])
        else:
            current['selected_source_ids'] = [r['candidate_id'] for r in sources if r['selected_master'] and
                                              r['selected_master']['row_index'] == product['master_anchor_row']]
        q.update(status='closed', previous_audit_question=original, current_correspondence=current,
                 resolution=copy.deepcopy(resolution), uncertain='已依据本轮用户明确决定关闭，原差异及来源原值保留。',
                 user_choice_needed='无新增选择要求；本项当前已关闭。',
                 decision_unchanged='当前处理仅按本轮明确授权；原差异、历史选择和拒绝保持可追溯，不换算g/ml。')
        questions.append(q)
    return questions


def chinese_report(covered, sources, summary, questions, output):
    if questions[0].get('status') == 'closed_user_confirmed_upgraded':
        return final_chinese_report(covered, sources, summary, questions, output)
    by_id = {s['candidate_id']: s for s in sources}
    standard = Path(__file__).resolve().parents[2] / 'docs/product-identity-standard-v1.md'
    standard_link = Path(os.path.relpath(standard, output)).as_posix()
    selected_counts = Counter(s['source']['source_system'] for s in sources if s['selected_master'])
    covered_count = sum(bool(r['effective_selection_count']) for r in covered)
    image_states = Counter(r['image_evidence']['object_status'] for r in covered)
    image_empty_cells = sum(r['image_evidence']['cell_value_empty'] for r in covered)
    wm72 = next(r for r in covered if r['ice_code'] == 'WM0072')
    wm72_jst = '本轮已依据用户明确决定确认为有效选择' if wm72['jushuitan_selected'] else '仍为候选'
    candidate_count = sum(r['general_review_category'] == 'unconfirmed_candidate' for r in sources)
    bs_creation = [r for r in covered if r.get('bigseller_creation_status')]
    bs_creation_note = '\n'.join('- ' + r['ice_code'] + '：' + r['bigseller_creation_status']['reason'] + '。依据：' + r['bigseller_creation_status']['basis'] + '；只登记业务状态，不新增BS记录或选择，不表示库存为0。' for r in bs_creation)
    authorized_batch_note = ('本轮只对冻结明确决定中的11条JST记录写入confirm，WM0007原744行按用户不再经营的说明写ignore，保留来源、原候选和主资料，不是reject或全系统停用。'
                             if bs_creation else '')
    no_image_objects = [r for r in covered if r['image_evidence']['object_status'] == 'no_found']
    no_image_labels = '、'.join((r['ice_code'] or '缺码新品') + f"（原{r['master_anchor_row']}行）" for r in no_image_objects)
    groups = []
    for category in ('bigseller_only', 'jushuitan_only', 'neither'):
        members = [r for r in covered if r['coverage_class'] == category]
        groups.append(f"- {LABELS[category]}：" + '、'.join((r['ice_code'] or '缺货号新品') + f"（原{r['master_anchor_row']}行）" for r in members) + '。')
    candidate_lines = []
    for r in covered:
        for cid in r['unconfirmed_candidates']:
            c = by_id[cid]
            candidate_lines.append(f"- {r['ice_code']}：JST原{c['provenance']['effective_origin']['excel_row']}行，{c['source']['external_name']}；仅候选，未计入有效选择。")
    question_lines = []
    for q in questions:
        if q['kind'] == 'existing_business_issue':
            question_lines.append('### 菲越洗面奶版本（沿用1项待决）\n\n保留菲律宾新创启辰376行、PH彩妆仓380行、越南526行三条既有WM0012选择和历史。' + q['evidence'] + '\n\n' + q['uncertain'] + q['user_choice_needed'] + '不阻断本次只读核对收口，不重复催问。')
        elif q['kind'] == 'new_specification_evidence_question':
            e = q['evidence']; p = q['product']
            question_lines.append(f"### {p['ice_code']}：规格口径记录\n\n商品：{p['name']}（主库原{p['master_anchor']}行）。当前对应：BS有效选择{sum(len(x) for x in q['current_correspondence']['bigseller_selected'].values())}条，JST有效选择0条；JST原{e['source_origin']['excel_row']}行仍为候选。\n\n证据：主名称“{e['master_name']}”，规格专列“{e['master_spec_column'] or '空'}”，单个产品重量{e['master_single_product_weight_kg'] or '未填'}kg；JST名称“{e['jst_source_name']}”。\n\n{q['uncertain']}\n\n{q['user_choice_needed']}本次不改对应，不阻断本批收口。")
        else:
            e = q['evidence']; p = q['product']; current = q['current_correspondence']
            evidence_lines = [f"- {s['origin']['original_file']} / {s['origin']['sheet']} 原{s['origin']['excel_row']}行：{s['raw_name']}；来源ID {s['candidate_id']}，当前{s['review_state']}→{(s['selected_master'] or {}).get('ice_code', '空')}。" for s in e['sources']]
            rejected_lines = [f"- 保留拒绝：JST原{s['origin']['excel_row']}行 {s['candidate_id']}，{s['review_decision']}，目标为空。" for s in e['preserved_rejected_sources']]
            question_lines.append(f"### {p['ice_code']}：已有选择的规格口径差异\n\n商品：{p['name']}。主库{e['master']['original_file']} / {e['master']['sheet']} 原{e['master']['excel_row']}行，原规格“{e['master']['raw_spec']}”。当前BS有效选择{sum(len(x) for x in current['bigseller_selected'].values())}条、JST有效选择{len(current['jushuitan_selected'])}条，全部保持。\n\n" + '\n'.join(evidence_lines + rejected_lines) + f"\n\n{q['uncertain']}\n\n{q['user_choice_needed']}不影响本批收口。")
    return f"""# 126份产品的覆盖与缺口核对

本批继承已独立通过的四项确认结果，覆盖工具只读核对当前显式保存数据，未运行旧匹配流程。{authorized_batch_note}商品身份解释见[唯一标准正文]({standard_link})。{summary['masters']}份主资料中{summary['nonempty_ice_codes']}份具有非空且唯一的ICE货号，另{summary['missing_ice_codes']}份新品缺货号。没有来源记录不代表主资料不合格。

## 整体情况

从现有结果重算：两边已有选择{summary['coverage'].get('both', 0)}份，仅BigSeller{summary['coverage'].get('bigseller_only', 0)}份，仅聚水潭{summary['coverage'].get('jushuitan_only', 0)}份，两边均未找到已确认对应{summary['coverage'].get('neither', 0)}份，互斥合计{summary['masters']}份。有选择的商品不等于其全部版本都已核实；菲越三条WM0012明确保留版本待决。

来源共{summary['sources']}条（BS{summary['source_systems']['bigseller']}、JST{summary['source_systems']['jushuitan']}），有效人工选择{summary['effective_selected_sources']}条（BS{selected_counts['bigseller']}、JST{selected_counts['jushuitan']}），覆盖{covered_count}份主资料。候选和名称提示均未计作有效选择。这里的来源数量是记录条数，未合计库存数量、库存实物或货值。

{chr(10).join(groups)}

{bs_creation_note}

其中仅BS的WM0062在JST原789行存在已拒绝记录；不能写成JST不存在，也不重新确认。仅JST的WM10012保持上轮已确认选择，缺成本另列，不因资料空值撤销选择。

## 资料缺失与已批准延期

- 条码空6份：WM0081、WM0072、WM0073、brush、WM0117、新品。成本空2份：WM10012、新品。运营价空7份：brush、WM0117、WM0126、WM0127、WM0124、WM0125、新品。保留空值，不填0、不规定本批全部必填，也不估值。
- 规格专列空114份；很多名称已写规格，因此不能称114款完全没有规格。所有原有字段空值在覆盖表data_gaps列逐份列出，与source_coverage_gap的“当前未找到已确认对应”分开。
- 产品图片单元格值空{image_empty_cells}份，仅指单元格值，不代表缺少嵌入图片。实际读取冻结Excel得到{summary['image_objects']['anchor_count']}个图片锚点；按全部原始来源行关联、按主资料去重后，找到关联图片对象{image_states['found']}份，未找到关联图片对象{image_states['no_found']}份，未能判断{image_states['unknown']}份。未找到的是{no_image_labels}。找到对象不代表图片内容正确；未找到对象不证明商品确实无图，图片内容尚未核验。drawing/关系ID、原行列和媒体目标存在性见image-object-evidence.json，不提取展示或补图。
- 工厂列126份为空，其中93份保留原E列含#REF!的失效查找公式，其余33份空白；不猜填工厂。共享包装条码8组，保持不同编码、版本和包装单位，未自动合并。
- WM0081与brush继续分开，5条BS刷子未建立选择，不在两款之间猜分；WM0081的JST记录仍为候选。原122行新品缺码/条码，JST WM0131只有名称提示，不能认领货号。两项均已批准待补，仅登记现状。
- WM0072现价仍5.18/5.68，price_pending=false，原66/216行两版完整保存；其JST{wm72_jst}。WM0040资料保留，不认定确定停产。
- 菲越757577407359两条显式defer、原拒绝3条、规则外88条均保留，不重新确认。一般未填资料和既有延期保留。

## 一般未核对记录怎样理解

{summary['general_review_records']}条一般未核对记录由{summary['general_review_categories']['unconfirmed_candidate']}条有候选和{summary['review_states']['pending']}条零候选组成。零候选包括{summary['general_review_categories']['explicit_defer']}条明确defer、{summary['general_review_categories']['name_hint_only']}条新品名称提示和{summary['general_review_categories']['no_saved_candidate']}条无已保存候选，不整批交用户选择。

773条无已保存候选中：BS10条（ouyan精华3、刷子5、原名“作废”2）均保持原状态；JST763条中634条编码含分段符，101条为SY1系列，1条款式与商品编码不同，其余27条现有结果未给出主库候选。这些是来源编码与当前结果的解释，不是新通用业务规则，也不证明相应商品不存在。组件/物料关系不在本批强行建立。

{candidate_count}条JST候选逐条如下，均可从source-records.json追到原文件、行号及既有状态：

{chr(10).join(candidate_lines)}

名称提示或文本表示差异本身不能新增错绑结论或人工确认；本批人工决定只来自冻结的明确授权，不由覆盖工具推断。

## 规格差异记录与原业务待决（本轮无需作答）

原已登记业务待决仍1项（菲越洗面奶、三条记录）。规格审计复核事项共{summary['specification_audit_questions']}项：原WM0006、WM0008、WM0130三项保留，另列WM0031、WM0062、WM0098三款已有选择商品。六项审计注释仅登记已知资料口径差异，不证明错品或g与ml等价、不换算或修改规格，不改业务待决、既有选择或派生任何确认。本轮不要求用户为这些规格事项提供包装或作答；资料补正留待后续，均不阻断本次只读覆盖交付。已延期刷子、新品不再次催问。

{chr(10).join(question_lines)}

## 怎样追溯

product-coverage.csv与product-coverage.json包含全部126份，一行一份主资料，以master_anchor_row保留原Excel锚点，master_source列列出原资料文件、原行、主行与JSON定位。选择按BS仓库分列在bigseller_selected_by_warehouse，JST选择单列，未确认候选、名称提示和拒绝/规则外记录另列。所有candidate_id均在source-records.json中有完整来源身份、原行、文件哈希、原始数量和现有状态。context_only_sources仅保存已延期相关证据，不能作候选或选择。

image_evidence分列图片单元格原值与嵌入图片对象检查，spec_audit_question_ids指向六项规格复核；只保存审计说明，不能成为人工决定源。账号、市场及关系有效期在本来源未提供，保持空值；覆盖工具只读核对当前显式保存结果、冻结JST出处、主库图片对象和已查明的指定规格原行，没有重新匹配或派生选择，也未重新调查菲越版本。长期正式关系保存、自动复用、数量归集及同步仍待业务流程另定。

本批标准与覆盖核对停止于P0_03_IMPLEMENTED_AWAITING_REVIEW，交回独立审查，不代表整个P0-03 PASS。
"""


def final_chinese_report(covered, sources, summary, questions, output):
    standard = Path(__file__).resolve().parents[2] / 'docs/product-identity-standard-v1.md'
    standard_link = Path(os.path.relpath(standard, output)).as_posix()
    selected = Counter(r['source']['source_system'] for r in sources if r['selected_master'])
    classes = '\n'.join('- ' + LABELS[k] + '：' + '、'.join((r['ice_code'] or '缺货号新品') +
        f"（原{r['master_anchor_row']}行）" for r in covered if r['coverage_class'] == k) + '。'
        for k in ('bigseller_only', 'jushuitan_only', 'neither'))
    bs_notes = '\n'.join('- ' + r['ice_code'] + '：' + r['bigseller_creation_status']['reason'] + '；依据：' +
        r['bigseller_creation_status']['basis'] + '。只登记未建档状态，不表示库存为0。'
        for r in covered if r.get('bigseller_creation_status'))
    image = summary['image_objects']; statuses = image['master_object_status_counts']
    image_missing = '、'.join((r['ice_code'] or '缺码新品') + f"（原{r['master_anchor_row']}行）"
        for r in covered if r['image_evidence']['object_status'] == 'no_found')
    candidate_lines = []
    for r in covered:
        for source in r['unconfirmed_candidate_details']:
            candidate_lines.append(f"- {r['ice_code']}：JST原{source['origin']['excel_row']}行，{source['name']}；仅候选，未计入有效选择。")
    sections = []
    for q in questions[1:]:
        p, e, resolution = q['product'], q['evidence'], q['resolution']
        if q['kind'] == 'new_specification_evidence_question':
            old_text = f"原主库名称“{e['master_name']}”，C列“{e['master_spec_column'] or '空'}”，单个产品重量{e['master_single_product_weight_kg'] or '未填'}kg；JST原{e['source_origin']['excel_row']}行名称“{e['jst_source_name']}”。"
            cur = q['current_correspondence']
            current = f"当前{cur['source_id']}：{cur['review_decision']}，目标{(cur['selected_master'] or {}).get('ice_code', '空')}。"
        else:
            old_text = f"主库原{e['master']['excel_row']}行C列“{e['master']['raw_spec']}”。\n" + '\n'.join(
                f"- {s['origin']['original_file']} / {s['origin']['sheet']} 原{s['origin']['excel_row']}行：{s['raw_name']}；来源ID {s['candidate_id']}。"
                for s in e['sources'])
            old_text += '\n' + '\n'.join(f"- 保留拒绝：JST原{s['origin']['excel_row']}行 {s['candidate_id']}，原名称“{s['raw_name']}”，reject，目标为空。"
                for s in e['preserved_rejected_sources'])
            current = '已有选择保持，WM0062的JST原789行reject不撤销。' if p['ice_code'] == 'WM0062' else '已有选择保持。'
        choice = ('用户要求本批忽略，目标为空；不推导停产、不经营、全系统停用或删除。'
                  if resolution['status'] == 'closed_ignored_for_batch' else
                  '用户已明确采用商品库C列规格“' + resolution['selected_spec'] + '”；不换算g/ml，不用单品重量覆盖规格。')
        sections.append(f"### {p['ice_code']}：已关闭\n\n{old_text}\n\n{choice}{current}原差异、原系统名称和原始数值、此前复核说明完整保留，不再要求重复确认。")
    return f"""# 126份产品覆盖与本期验收核对

本批继承最新已独立通过的11条JST确认结果及有效CSV，仅落实冻结明确授权，没有重跑全库匹配。商品身份规则见[唯一标准正文]({standard_link})。主资料{summary['masters']}份，其中{summary['nonempty_ice_codes']}个非空ICE货号唯一，另{summary['missing_ice_codes']}份新品缺码；不称126份均已完成编码，不代表数据库唯一约束已实现。

## 整体情况

两边已有选择{summary['coverage']['both']}份，仅BigSeller{summary['coverage']['bigseller_only']}份，仅聚水潭{summary['coverage']['jushuitan_only']}份，两边均未找到已确认对应{summary['coverage']['neither']}份，分类互斥、合计{summary['masters']}份。来源共{summary['sources']}条（BS{summary['source_systems']['bigseller']}、JST{summary['source_systems']['jushuitan']}），有效人工选择{summary['effective_selected_sources']}条（BS{selected['bigseller']}、JST{selected['jushuitan']}），覆盖{sum(bool(r['effective_selection_count']) for r in covered)}份主资料。候选不冒充有效选择；没有来源记录不代表主资料不合格，不要求每款同时具备两系统对应。

{classes}

{bs_notes}

## 本轮已落实决定与历史

菲越三条WM0012已由用户确认升级款：菲律宾新创启辰376行、PH彩妆仓380行、越南526行6974674957349均维持主库19行WM0012。本项已解除版本待决，仅确认已有目标的版本，不增加有效选择；此前待决及只读调查原结论保留在previous_audit_question和业务历史。

WM0006原743行、WM0008原745行为ignore，理由仅“用户要求本批忽略”，目标为空，资料、来源、原候选和历史保留；不推导停产、不经营或全系统停用。WM0130原857行明确确认主库121行WM0130。菲越精油套盒原220/321行757577407359明确确认主库67行WM0073，当前confirm覆盖旧defer，旧暂缓作为历史保留，DEE/MY/印尼已有选择不变。上述新增3条选择，不建立同码自动确认规则。

此前11条JST确认、WM0007本批ignore均保持：WM0007不是reject或全系统停用，不删除主资料。WM0072主库锚点66，现价5.18/5.68，price_pending=false，66/216两版价格及历史完整，其JST本轮已依据用户明确决定确认为有效选择（沿用上一轮结果）。原22条人工选择及JST引用、原545条有效目标、历史纠错和未涉及的拒绝/规则外均保留。WM0031/WM0098选择与WM0062的BS选择不变，JST原789行reject不自动撤销。

## 六项规格差异已关闭，原证据保留

本轮规格待复核0项、已关闭{summary['closed_specification_audit_questions']}项。WM0006/WM0008按本批忽略关闭；WM0031=20ml/支、WM0062=20ml/支、WM0098=120g/瓶、WM0130=20ml/支采用商品库C列。保留原系统名称、原始数值和历史差异，不换算g/ml，不以单品重量替代规格，空规格不猜填。当前无需要用户重复选择的业务问题（remaining_user_decisions={summary['remaining_user_decisions']}）；不把已批准延期重新列为本批阻塞。

{chr(10).join(sections)}

## 已批准延期与资料缺口

WM0081原62行与brush原107行两份主资料分别可见，货号、名称、待确认说明保留。WM0081的JST候选和5条未确认BS刷子不猜绑、不合并；用户要求后续正式系统也保留两份资料及待确认状态，本轮不新建正式页面。原122行新品货号/条码缺失，不认领JST WM0131；工厂失效引用及其他空值保留，不猜填、不填0。WM0040旧资料保留，不认定确定停产。

资料空值在data_gaps逐份列出，与source_coverage_gap的“当前未找到已确认对应”分列。条码空6份、成本空2份、运营价空7份、规格专列空114份及工厂列126份空值保留；名称可能含规格，空C列不等于完全无规格，不自行规定全部必填，也不估值。

产品图片单元格值空{image['master_image_cell_empty_count']}份，仅指单元格值，不代表缺少嵌入图片。实际读取冻结Excel得到{image['anchor_count']}个图片锚点，按全部原始来源行关联、按主资料去重，找到关联图片对象{statuses.get('found', 0)}份，未找到关联图片对象{statuses.get('no_found', 0)}份，未能判断{statuses.get('unknown', 0)}份。未找到的是{image_missing}。找到对象不代表图片内容正确，未找到对象不证明商品确实无图，图片内容尚未核验；image-object-evidence.json保留关系、锚点和媒体哈希，不提取展示或补图。

## 一般未核对记录

{summary['general_review_records']}条一般未核对记录保留，包含{summary['review_states'].get('candidate', 0)}条候选、{summary['review_states'].get('pending', 0)}条待核对；不将全部记录交用户逐条作答。组件/物料、名称提示及未保存候选仅解释现有关系，不证明来源商品不存在。原3条reject、88条规则外保持，忽略记录保留来源，不作为有效选择。

{len(candidate_lines)}条JST候选逐条如下，均可从source-records.json追到原文件、行号及既有状态：

{chr(10).join(candidate_lines)}

## 追溯与边界

product-coverage.csv/JSON逐份覆盖126份主资料，保留原行锚点与资料出处；source-records.json逐条保存1417条来源、原系统字段、文件/行/哈希和当前选择。spec_audit_question_ids追溯六项原差异，status及resolution表达已关闭，previous_audit_question保存此前审计状态；不能将历史待决文字当作当前未完成。版本当前确认、原待决和保存事件分列。图片说明未核验内容，资料缺失与来源缺少已确认对应分列。

长期正式关系保存、自动复用、数量归集及同步仍待业务流程另定；不入库、不接真实服务、不发布或同步库存、不估值。本批停于P0_03_IMPLEMENTED_AWAITING_REVIEW，整体自验完成后等待P0-03独立总验收，不代表整个P0-03 PASS。
"""


def export(base, output, input_pins=None):
    pins, authorization = approved_input_pins(base, input_pins)
    covered, sources, summary, images = build(base, pins)
    questions = audit_questions(base, covered, sources)
    if output.exists() and any(output.iterdir()):
        raise ValueError('output must be a new empty directory; historical evidence is never overwritten')
    output.mkdir(parents=True, exist_ok=True)
    input_names = sorted(p.name for p in base.iterdir() if p.is_file())
    input_hashes = {n: sha(base / n) for n in input_names}
    freeze = output / 'inputs'; freeze.mkdir()
    for name in ('match-bundle.json', 'manual-decisions.effective.csv', 'master-overview.json', 'input-manifest.json',
                 'source-formulas-and-errors.json', 'current-original-22-comparison.json', 'pending-business.json',
                 'input-0.frozen.xlsx'):
        shutil.copyfile(base / name, freeze / name)
    input_record = {'base_directory': str(base), 'pinned': pins, 'all_baseline_files': input_hashes}
    if authorization:
        shutil.copyfile(input_pins, freeze / 'audit-input-pins.frozen.json')
        shutil.copyfile(authorization['decision_file']['path'], freeze / 'audit-explicit-decisions.frozen.json')
        input_record['explicit_authorization'] = {'pins_file_sha256': sha(input_pins), 'config': authorization}
    write(output / 'input-hashes.json', input_record)
    write(output / 'product-coverage.json', covered)
    write(output / 'source-records.json', sources)
    write(output / 'coverage-summary.json', summary)
    write(output / 'image-object-evidence.json', images)
    write(output / 'audit-questions.json', questions)
    (output / 'coverage-report.zh.md').write_text(chinese_report(covered, sources, summary, questions, output), encoding='utf-8')
    with (output / 'product-coverage.csv').open('w', encoding='utf-8-sig', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=list(covered[0]))
        writer.writeheader()
        for row in covered:
            writer.writerow({k: json.dumps(v, ensure_ascii=False) if isinstance(v, (dict, list)) else v for k, v in row.items()})
    write(output / 'output-hashes.json', {p.name: sha(p) for p in output.iterdir() if p.is_file()})
    assert all(sha(base / n) == h for n, h in input_hashes.items()), 'baseline mutated'
    return summary


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--input-pins', type=Path, help='Explicit new-batch pins plus approved previous baseline and decision hash')
    args = parser.parse_args()
    print(json.dumps(export(args.baseline.resolve(), args.output.resolve(), args.input_pins.resolve() if args.input_pins else None), ensure_ascii=False, indent=2))
