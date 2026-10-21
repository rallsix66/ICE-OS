"""Independently verify a read-only P0-03 product coverage delivery.

Uses only the standard library. It reads the pinned saved result and frozen
Excel provenance, never imports the exporter/matcher and never creates files.
--self-test checks in-memory corruptions, leaving all delivery files untouched.
"""
from __future__ import annotations

import argparse
import copy
import csv
import hashlib
import json
import posixpath
import re
from collections import Counter, defaultdict
from pathlib import Path
from xml.etree import ElementTree
from zipfile import ZipFile

PINS = {
    'match-bundle.json': 'c0fa4bc9814080a9e78d15ad7136276e03156254d67a3fe59e4d49c841e80936',
    'manual-decisions.effective.csv': 'a66c564942220f5df4e1043ab2b076f1cec26c3056fa8dffd5a2e2733844b58f',
}
FINAL_PREDECESSOR_PINS = {
    'match-bundle.json': '3c2babc9b13ca11fab14cb4bbce5e8617052319d06bc80c922256f6893346159',
    'manual-decisions.effective.csv': '48544cd03154131970fce220fb2ff7c704e18d7860e2ea7c72e6a0ef1ac8d921',
}
FINAL_AUTHORIZED = {
    'mc-e1b56fb81b0db46c': ('bigseller', 376, '6974674957349', 19, 'WM0012', 'confirm'),
    'mc-73ac4812d7d8de64': ('bigseller', 380, '6974674957349', 19, 'WM0012', 'confirm'),
    'mc-b7bd376e964738cd': ('bigseller', 526, '6974674957349', 19, 'WM0012', 'confirm'),
    'mc-e78031a3b38c39f1': ('jushuitan', 743, 'WM0006', 13, 'WM0006', 'ignore'),
    'mc-06e9251af096ae18': ('jushuitan', 745, 'WM0008', 14, 'WM0008', 'ignore'),
    'mc-75e0ce710d064c4c': ('jushuitan', 857, 'WM0130', 121, 'WM0130', 'confirm'),
    'mc-44b8f0236d346bc7': ('bigseller', 220, '757577407359', 67, 'WM0073', 'confirm'),
    'mc-c8e6e17fc25361f1': ('bigseller', 321, '757577407359', 67, 'WM0073', 'confirm'),
}
JST_AUTHORIZED = {
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
FROZEN = ('match-bundle.json', 'manual-decisions.effective.csv', 'master-overview.json',
          'input-manifest.json', 'source-formulas-and-errors.json',
          'current-original-22-comparison.json', 'pending-business.json', 'input-0.frozen.xlsx')
PH_VN = {'mc-e1b56fb81b0db46c', 'mc-73ac4812d7d8de64', 'mc-b7bd376e964738cd'}
XML = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
DRAWING = '{http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing}'
ART = '{http://schemas.openxmlformats.org/drawingml/2006/main}'
REL = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'
SPEC_CODES = {'WM0006', 'WM0008', 'WM0130', 'WM0031', 'WM0062', 'WM0098'}
IMAGE_MEANINGS = {
    'found': '发现嵌入图片对象及对应媒体文件；未展示图片，未核验内容是否正确',
    'no_found': '在所核查全部原始来源行未找到可关联的嵌入图片对象；不证明商品无图片',
    'unknown': '图片对象关系无法完整解析或来源行关联不明确；不能判为无图',
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def csv_decisions(path):
    with path.open(encoding='utf-8-sig', newline='') as stream:
        records = list(csv.DictReader(stream))
    require(len({r['candidate_id'] for r in records}) == len(records), 'duplicate effective CSV IDs')
    return {r['candidate_id']: r for r in records}


def verify_authorized_batch(base, config, plan):
    """New pins alone confer no authority: prove this exact twelve-record delta."""
    previous = config['previous_baseline']
    require(previous['pins'] == PINS and plan['base_hashes'] == PINS, 'new batch approved predecessor pins')
    old_base = Path(previous['directory'])
    require(all(digest(old_base / n) == h for n, h in PINS.items()), 'new batch predecessor bytes changed')
    old, new = read(old_base / 'match-bundle.json'), read(base / 'match-bundle.json')
    require(new['master_rows'] == old['master_rows'], 'new batch changed product identities')
    require(new['batch_business_pending'] == old['batch_business_pending'], 'new batch changed unresolved business issues')
    old_by_id = {c['candidate_id']: c for c in old['candidates']}
    new_by_id = {c['candidate_id']: c for c in new['candidates']}
    require(list(new_by_id) == list(old_by_id) and len(new_by_id) == len(new['candidates']), 'new batch source inventory')
    decisions = plan['source_decisions']
    require(len(decisions) == len(JST_AUTHORIZED) and {d['candidate_id'] for d in decisions} == set(JST_AUTHORIZED),
            'new batch explicit twelve identities')
    events = new['jst_confirmation_events']
    require(len(events) == len(decisions) and [e['explicit_decision'] for e in events] == decisions,
            'new batch exact once-only explicit event history')
    old_csv, new_csv = csv_decisions(old_base / 'manual-decisions.effective.csv'), csv_decisions(base / 'manual-decisions.effective.csv')
    inherited_ids, active_ids = set(), set()
    masters = {m['row_index']: m for m in old['master_rows']}
    manifest = read(old_base / 'input-manifest.json')
    source_input = manifest['original_input_hashes']['jushuitan']['paths'][0]
    require(Path(source_input['path']).name == '商品资料_20261015165159_200874071_1.xlsx', 'authorized JST original file')
    require(digest(old_base / source_input['frozen']) == source_input['sha256'], 'authorized JST frozen file hash')
    raw_rows = dict(workbook_sheets(old_base / source_input['frozen'])['Sheet1'])
    allowed_candidate_changes = {'review_decision', 'review_notes', 'previous_review', 'decision_records', 'selected_master',
        'selected_jushuitan', 'validation_errors', 'manual_jushuitan_conflict', 'manual_master_row', 'manual_master_ice',
        'manual_jst_candidate_id', 'manual_jst_sku', 'validated_manual_target', 'review_state', 'review_reason',
        'retained_quality_flags', 'selected_master_quality_issues'}
    for d, event in zip(decisions, events):
        cid = d['candidate_id']; code, source_row, target_row, decision = JST_AUTHORIZED[cid]
        before, after = old_by_id[cid], new_by_id[cid]
        source = before['source']
        require((d['target_ice'], d['source_file']['excel_row'], d['target_row'], d['decision']) ==
                (code, source_row, target_row, decision), 'new batch explicit source row target or action')
        require(d['source'] == source and d['source_identity'] == ['jushuitan', code, code], 'new batch frozen source identity')
        require(source['source_row_key'] == f'jushuitan:{source_row}:{code}:{code}' and
                source['source_system'] == 'jushuitan' and source['sheet_name'] == 'Sheet1' and
                source['external_sku_raw'] == code, 'new batch source scope or raw SKU')
        f = d['source_file']
        require((f['file_name'], f['frozen'], f['sha256'], f['sheet_name']) ==
                (Path(source_input['path']).name, source_input['frozen'], source_input['sha256'], 'Sheet1'),
                'new batch authorized physical provenance')
        raw = raw_rows[source_row]
        require(raw['款式编码'] == code and raw['商品编码'] == code and raw['商品名称'] == source['external_name'],
                'new batch physical source row contents')
        require({k: '' if v is None else str(v) for k, v in f['raw_record'].items()} ==
                {k: raw.get(k, '') for k in f['raw_record']} and set(raw).issubset(f['raw_record']),
                'new batch explicit raw source evidence differs from frozen Excel')
        require(masters[target_row] == d['target_master'] and masters[target_row]['ice_code'] == code,
                'new batch target master identity')
        require(before['selected_master'] is None and before['review_state'] == 'candidate' and
                not before['review_decision'], 'new batch may act only on specified old candidates')
        require(d['reason'].strip() and after['review_notes'] == d['reason'], 'new batch authorization reason retained')
        require({k: v for k, v in before.items() if k not in allowed_candidate_changes} ==
                {k: v for k, v in after.items() if k not in allowed_candidate_changes}, 'new batch source or original candidate altered')
        require(after['review_decision'] == decision and after['review_state'] ==
                ('manual_selected' if decision == 'confirm' else 'ignored'), 'new batch effective confirm or ignore')
        require(after['selected_master'] == (masters[target_row] if decision == 'confirm' else None), 'new batch effective target')
        ids = {cid, *before.get('candidate_id_lineage', []), *(r['candidate_id'] for r in before.get('decision_records', []))}
        old_records = [old_csv[k] for k in sorted(ids) if k in old_csv]
        require(bool(old_records) and event['before_csv_records'] == old_records, 'new batch prior CSV history')
        require(event['before_selected_master'] == before['selected_master'] and
                event['before_decision_records'] == before['decision_records'], 'new batch historical candidate facts')
        inherited_ids.update(k for k in ids if k in old_csv); active_ids.add(cid)
        require(cid in new_csv and event['after_csv'] == new_csv[cid], 'new batch event saved CSV')
        row = new_csv[cid]
        require(row['review_decision'] == decision and row['review_notes'] == d['reason'] and
                row['manual_master_row'] == (str(target_row) if decision == 'confirm' else '') and
                row['manual_master_ice'] == (code if decision == 'confirm' else '') and
                not row['manual_jst_candidate_id'] and not row['manual_jst_sku'], 'new batch CSV actual target or ignore')
    require({k: v for k, v in old_csv.items() if k not in inherited_ids} ==
            {k: v for k, v in new_csv.items() if k not in active_ids}, 'new batch changed unrelated CSV decisions')
    require(all(new_by_id[cid] == before for cid, before in old_by_id.items() if cid not in JST_AUTHORIZED),
            'new batch changed original selections rejects deferrals or other source records')
    statuses = plan['bs_not_created']
    require(len(statuses) == 2 and {s['ice_code']: s['master_row'] for s in statuses} == {'WM0070': 214, 'WM0072': 66},
            'new batch BS not-created scope')
    require(new['batch_bs_not_created'] == statuses, 'new batch BS explanation lost')
    for s in statuses:
        require(s['source_system'] == 'bigseller' and s['status'] == 'user_confirmed_not_created' and
                s['reason'].strip() and s['basis'].strip() and '0' in s['inventory_implication'], 'new batch BS explanation boundaries')
    for before, after in zip(old['master_provenance'], new['master_provenance']):
        allowed = {'selected_source_ids', 'bs_creation_status'}
        require({k: v for k, v in before.items() if k not in allowed} ==
                {k: v for k, v in after.items() if k not in allowed}, 'new batch master data prices or history changed')
        expected_status = next((s for s in statuses if s['master_row'] == before['row_index']), None)
        require(after.get('bs_creation_status') == expected_status, 'new batch master BS explanation')
        if expected_status:
            require(not any(c['source']['source_system'] == 'bigseller' and c['selected_master'] and
                            c['selected_master']['row_index'] == before['row_index'] for c in new['candidates']),
                    'new batch fabricated BS choice')
    return plan


def verify_final_authorized_batch(base, config, plan):
    """Independent proof of the eight exact operations, retained history and metadata-only closure."""
    previous = config['previous_baseline']; old_base = Path(previous['directory'])
    require(previous['pins'] == FINAL_PREDECESSOR_PINS and plan['base_hashes'] == FINAL_PREDECESSOR_PINS,
            'final batch predecessor pins')
    require(all(digest(old_base / n) == h for n, h in FINAL_PREDECESSOR_PINS.items()), 'final predecessor bytes')
    old, new = read(old_base / 'match-bundle.json'), read(base / 'match-bundle.json')
    old_by = {c['candidate_id']: c for c in old['candidates']}; new_by = {c['candidate_id']: c for c in new['candidates']}
    require(list(old_by) == list(new_by) and len(new_by) == len(new['candidates']) == 1417, 'final source identity inventory')
    require(new['master_rows'] == old['master_rows'], 'final master business identities')
    decisions = plan['source_decisions']; events = new['final_confirmation_events']
    require(len(decisions) == len(FINAL_AUTHORIZED) and {d['candidate_id'] for d in decisions} == set(FINAL_AUTHORIZED),
            'final finite eight source decisions')
    require(len(events) == len(decisions) and [e['explicit_decision'] for e in events] == decisions,
            'final once-only event authority')
    manifest = read(old_base / 'input-manifest.json'); original = manifest['original_input_hashes']
    raw_cache = {}; masters = {m['row_index']: m for m in old['master_rows']}
    old_csv, new_csv = csv_decisions(old_base / 'manual-decisions.effective.csv'), csv_decisions(base / 'manual-decisions.effective.csv')
    inherited, active = set(), set()
    allowed = {'review_decision', 'review_notes', 'previous_review', 'decision_records', 'selected_master',
               'selected_jushuitan', 'validation_errors', 'manual_jushuitan_conflict', 'manual_master_row',
               'manual_master_ice', 'manual_jst_candidate_id', 'manual_jst_sku', 'validated_manual_target',
               'review_state', 'review_reason', 'retained_quality_flags', 'selected_master_quality_issues',
               'batch_business_pending', 'batch_version_confirmation'}
    for d, event in zip(decisions, events):
        cid = d['candidate_id']; system, row, sku, anchor, code, action = FINAL_AUTHORIZED[cid]
        before, after = old_by[cid], new_by[cid]; f = d['source_file']
        require((d['target_row'], d['target_ice'], d['decision'], f['excel_row']) == (anchor, code, action, row),
                'final source row target or action')
        require(d['source'] == before['source'] and d['source']['source_system'] == system and
                d['source']['external_sku_raw'] == sku, 'final frozen source scope')
        expected_identity = ['bigseller', before['source']['source_row_key']] if system == 'bigseller' else ['jushuitan', sku, sku]
        require(d['source_identity'] == expected_identity, 'final explicit source identity')
        item = original['bigseller'] if system == 'bigseller' else original['jushuitan']['paths'][0]
        require((f['file_name'], f['frozen'], f['sha256'], f['sheet_name']) ==
                (Path(item['path']).name, item['frozen'], item['sha256'], before['source']['sheet_name']),
                'final actual source provenance')
        path = old_base / f['frozen']; require(digest(path) == f['sha256'], 'final source workbook hash')
        if path not in raw_cache:
            raw_cache[path] = {sheet: dict(rows) for sheet, rows in workbook_sheets(path).items()}
        raw = raw_cache[path][f['sheet_name']][row]
        name_key, sku_key = ('名称', 'SKU编号') if system == 'bigseller' else ('商品名称', '商品编码')
        require(raw[name_key] == before['source']['external_name'] and raw[sku_key] == sku, 'final physical source row')
        require({k: '' if v is None else str(v) for k, v in f['raw_record'].items()} ==
                {k: raw.get(k, '') for k in f['raw_record']} and set(raw).issubset(f['raw_record']), 'final raw evidence')
        if system == 'bigseller':
            require(raw['仓库'] == before['source']['warehouse'], 'final physical warehouse')
        require(d['target_master'] == masters[anchor] and masters[anchor]['ice_code'] == code, 'final master target row/code')
        require(d['reason'].strip() and after['review_notes'] == d['reason'], 'final reason retained')
        require(after['review_decision'] == action and after['review_state'] ==
                ('manual_selected' if action == 'confirm' else 'ignored'), 'final effective action')
        require(after['selected_master'] == (masters[anchor] if action == 'confirm' else None), 'final effective target')
        require({k: v for k, v in before.items() if k not in allowed} ==
                {k: v for k, v in after.items() if k not in allowed}, 'final altered raw source/candidates/history')
        if cid in PH_VN:
            require(before['selected_master'] == after['selected_master'] and before['batch_business_pending'] and
                    not after['batch_business_pending'], 'version confirmation must not add a choice')
        elif code == 'WM0073':
            require(before['review_decision'] == 'defer' and before['selected_master'] is None,
                    'final set only replaces the two explicit deferrals')
        elif action == 'ignore':
            require(before['review_state'] == 'candidate' and d['reason'] == '用户要求本批忽略', 'final ignore exact reason')
        ids = {cid, *before.get('candidate_id_lineage', []), *(r['candidate_id'] for r in before.get('decision_records', []))}
        old_records = [old_csv[k] for k in sorted(ids) if k in old_csv]
        require(event['before_csv_records'] == old_records and event['before_selected_master'] == before['selected_master'] and
                event['before_decision_records'] == before['decision_records'], 'final prior CSV/history preserved')
        inherited.update(k for k in ids if k in old_csv); active.add(cid)
        require(event['after_csv'] == new_csv[cid], 'final event actual CSV')
        r = new_csv[cid]
        require((r['review_decision'], r['review_notes'], r['manual_master_row'], r['manual_master_ice']) ==
                (action, d['reason'], str(anchor) if action == 'confirm' else '', code if action == 'confirm' else ''),
                'final CSV effective decision or target')
    require({k: v for k, v in old_csv.items() if k not in inherited} ==
            {k: v for k, v in new_csv.items() if k not in active}, 'final unrelated CSV decisions')
    require(all(after['selected_master'] == old_by[cid]['selected_master'] for cid, after in new_by.items()
                if old_by[cid]['selected_master']), 'final prior545 target preservation')
    require(all(after == old_by[cid] for cid, after in new_by.items() if cid not in FINAL_AUTHORIZED), 'final unrelated candidate changed')
    require(not new['batch_business_pending'] and new['resolved_business_pending_history'], 'final pending closed with history')
    require(new['resolved_business_pending_history'][0]['previous_pending'] == old['batch_business_pending'][0] and
            new['resolved_business_pending_history'][0]['resolution_decision_ids'] == [d['decision_id'] for d in decisions[:3]],
            'final exact original version issue and resolving decisions')
    require(new['batch_version_confirmations'] == [dict(v, effective_selection=True) for v in plan['version_confirmations']],
            'final version confirmation authority')
    require(new['batch_specification_resolutions'] == plan['specification_resolutions'] and
            new['batch_brush_preservation'] == plan['brush_preservation'], 'final annotation authority')
    require(new['batch_bs_not_created'] == old['batch_bs_not_created'] and
            new['jst_confirmation_events'] == old['jst_confirmation_events'], 'final retained old batch events and BS facts')
    for before, after in zip(old['master_provenance'], new['master_provenance']):
        allowed_master = {'selected_source_ids', 'specification_resolution', 'brush_preservation'}
        require({k: v for k, v in before.items() if k not in allowed_master} ==
                {k: v for k, v in after.items() if k not in allowed_master}, 'final master prices/fields/lineage changed')
    old_questions = read(old_base / 'coverage/audit-questions.json')
    require(read(base / 'inherited-baseline/coverage/audit-questions.json') == old_questions and
            plan['previous_audit_questions'] == {'file': 'coverage/audit-questions.json',
                'sha256': digest(old_base / 'coverage/audit-questions.json')},
            'final all seven original audit explanations retained')
    # Validate the inherited six difference explanations with the unchanged
    # historical mode as well; the old facts are not trusted merely because a
    # new plan copied them. This reads only and runs once, outside mutations.
    run(old_base / 'coverage', input_pins=old_base / 'coverage/inputs/audit-input-pins.frozen.json')
    return plan


def independent_image_facts(base, manifest):
    """Parse the actual frozen OOXML relationship graph, without the image helper.

    The facts stay separate from submitted evidence. Media bytes are hashed in
    place; no extraction, rendering or claim about their contents is made.
    """
    original = manifest['original_input_hashes']['master']
    path = base / original['frozen']
    require(digest(path) == original['sha256'], 'image workbook must be frozen approved bytes')

    def part(owner, target):
        return posixpath.normpath(target.lstrip('/') if target.startswith('/') else
                                 posixpath.join(posixpath.dirname(owner), target))

    def rel_part(owner):
        return posixpath.join(posixpath.dirname(owner), '_rels', posixpath.basename(owner) + '.rels')

    def marker(anchor, name):
        node = anchor.find(DRAWING + name)
        if node is None:
            return None
        row0, col0 = int(node.findtext(DRAWING + 'row')), int(node.findtext(DRAWING + 'col'))
        return {'row': row0 + 1, 'column': col0 + 1, 'row_raw0': row0, 'column_raw0': col0,
                'row_offset_emu': int(node.findtext(DRAWING + 'rowOff', '0')),
                'column_offset_emu': int(node.findtext(DRAWING + 'colOff', '0'))}

    with ZipFile(path) as archive:
        members = set(archive.namelist())

        def relationships(owner):
            location = rel_part(owner)
            if location not in members:
                return {}
            return {r.attrib['Id']: dict(r.attrib) for r in ElementTree.fromstring(archive.read(location))}

        book = ElementTree.fromstring(archive.read('xl/workbook.xml'))
        sheet = book.find(XML + 'sheets')[0]
        sheet_id = sheet.attrib[REL + 'id']
        sheet_part = part('xl/workbook.xml', relationships('xl/workbook.xml')[sheet_id]['Target'])
        sheet_root = ElementTree.fromstring(archive.read(sheet_part))
        sheet_rels = relationships(sheet_part)
        shared = []
        if 'xl/sharedStrings.xml' in members:
            shared = [''.join(n.itertext()) for n in
                      ElementTree.fromstring(archive.read('xl/sharedStrings.xml')).findall(XML + 'si')]
        image_columns = []
        first_row = sheet_root.find(XML + 'sheetData/' + XML + 'row')
        for cell in first_row:
            value = cell.find(XML + 'v')
            text = value.text if value is not None else ''
            if cell.attrib.get('t') == 's':
                text = shared[int(text)] if text else ''
            elif cell.attrib.get('t') == 'inlineStr':
                text = ''.join(cell.find(XML + 'is').itertext())
            if text == '产品图片':
                image_columns.append(re.sub('[0-9]+', '', cell.attrib['r']))
        require(len(image_columns) == 1, 'independent parser image column header')
        anchors = []
        unknown_global = []
        for drawing_reference in sheet_root.findall(XML + 'drawing'):
            drawing_id = drawing_reference.attrib[REL + 'id']
            relationship = sheet_rels.get(drawing_id)
            if not relationship or relationship.get('TargetMode') == 'External':
                unknown_global.append('unresolved sheet drawing relationship')
                continue
            drawing_part = part(sheet_part, relationship['Target'])
            if drawing_part not in members:
                unknown_global.append('missing drawing part')
                continue
            drawing_root = ElementTree.fromstring(archive.read(drawing_part))
            drawing_rels = relationships(drawing_part)
            for index, node in enumerate(drawing_root, 1):
                errors = []
                anchor_type = node.tag.rsplit('}', 1)[-1]
                try:
                    start, end = marker(node, 'from'), marker(node, 'to')
                except (ValueError, TypeError):
                    start, end = None, None
                    errors.append('unreadable anchor coordinates')
                if anchor_type not in {'twoCellAnchor', 'oneCellAnchor'} or start is None:
                    errors.append('unresolvable source row')
                if anchor_type == 'twoCellAnchor' and end is None:
                    errors.append('unreadable two-cell ending marker')
                refs = []
                for blip in node.findall('.//' + ART + 'blip'):
                    embed = blip.attrib.get(REL + 'embed')
                    relation = drawing_rels.get(embed)
                    target = relation.get('Target') if relation else None
                    media_part = part(drawing_part, target) if target and relation.get('TargetMode') != 'External' else None
                    exists = bool(media_part and media_part in members)
                    raw = archive.read(media_part) if exists else None
                    refs.append({'embed_relationship_id': embed, 'media_target': target,
                                 'media_zip_member': media_part, 'media_exists': exists,
                                 'media_sha256': hashlib.sha256(raw).hexdigest() if raw is not None else None,
                                 'media_bytes': len(raw) if raw is not None else None})
                    if not embed or not target or not exists:
                        errors.append('unresolved image relationship or media')
                if not refs:
                    errors.append('no embedded image relationship')
                anchors.append({'worksheet': sheet.attrib['name'], 'worksheet_part': sheet_part,
                                'sheet_drawing_relationship_id': drawing_id, 'drawing_part': drawing_part,
                                'anchor_index': index, 'anchor_type': anchor_type, 'from': start, 'to': end,
                                'media_refs': refs, 'has_errors': bool(errors), 'errors': errors})
        return {'worksheet': sheet.attrib['name'], 'worksheet_part': sheet_part,
                'worksheet_relationship_id': sheet_id, 'anchors': anchors,
                'unknown_global': unknown_global, 'raw_cells': workbook_sheets(path)[sheet.attrib['name']],
                'image_column': image_columns[0]}


def verify_image_evidence(data, bundle, base, manifest, facts):
    evidence = data['images']
    require(set(evidence) == {'workbook', 'anchors', 'masters', 'summary'}, 'image evidence top-level fields')
    source = manifest['original_input_hashes']['master']
    workbook = evidence['workbook']
    independent_anchors = facts['anchors']
    submitted = evidence['anchors']
    require(len(submitted) == len(independent_anchors), 'image anchor evidence omitted')
    require(len({a['anchor_id'] for a in submitted}) == len(submitted), 'duplicate image anchor ID')
    global_unknown = bool(facts['unknown_global'])
    for number, (actual, physical) in enumerate(zip(submitted, independent_anchors), 1):
        structural = {k: physical[k] for k in ('worksheet', 'worksheet_part',
                      'sheet_drawing_relationship_id', 'drawing_part', 'anchor_index', 'anchor_type', 'from', 'to')}
        require(all(actual.get(k) == value for k, value in structural.items()), 'image anchor row or relationship differs')
        require(actual['anchor_id'] == f'image-anchor-{number:04d}', 'image anchor identity or order')
        require(len(actual['media_refs']) == len(physical['media_refs']), 'embedded image relationship omitted')
        for media, raw in zip(actual['media_refs'], physical['media_refs']):
            require(all(media.get(k) == value for k, value in raw.items()), 'image media target bytes or hash differs')
            parsed = bool(raw['embed_relationship_id'] and raw['media_target'] and raw['media_exists'])
            require(media['parse_status'] == ('parsed' if parsed else 'unknown'), 'image media parse state')
            require(bool(media['unresolved_reasons']) == (not parsed), 'image media unresolved reason missing or invented')
            require(set(media) == set(raw) | {'parse_status', 'unresolved_reasons'}, 'image media evidence fields')
        flat = physical['media_refs'][0] if len(physical['media_refs']) == 1 else {
            k: None for k in ('embed_relationship_id', 'media_target', 'media_zip_member',
                              'media_exists', 'media_sha256', 'media_bytes')}
        require(all(actual.get(k) == value for k, value in flat.items()), 'flat image media projection')
        state = 'unknown' if physical['has_errors'] else 'parsed'
        require(actual['parse_status'] == state, 'image anchor parse state')
        require(bool(actual['unresolved_reasons']) == physical['has_errors'], 'image anchor unresolved reason missing or invented')
        require(set(actual) == set(structural) | set(flat) | {
            'anchor_id', 'media_refs', 'parse_status', 'unresolved_reasons'}, 'image anchor evidence fields')
    book_unknown = global_unknown or any(a['has_errors'] for a in independent_anchors)
    require(workbook == {
        'original_file': Path(source['path']).name, 'original_path': source['path'],
        'frozen_path': str((base / source['frozen']).resolve()), 'sha256': source['sha256'],
        'worksheet': facts['worksheet'], 'worksheet_part': facts['worksheet_part'],
        'worksheet_relationship_id': facts['worksheet_relationship_id'],
        'image_cell_header': '产品图片', 'image_cell_column': facts['image_column'],
        'parse_status': 'unknown' if book_unknown else 'parsed',
        'unresolved_reasons': workbook['unresolved_reasons'] if global_unknown else [],
        'scope': '冻结主库首个工作表的DrawingML锚点及嵌入图片关系；不提取展示或核验图片内容'},
        'image workbook provenance or boundary differs')
    require(bool(workbook['unresolved_reasons']) == global_unknown, 'image workbook unresolved reason')
    masters = evidence['masters']
    require(len(masters) == len(bundle['master_provenance']), 'image master evidence omitted')
    raw_rows = dict(facts['raw_cells'])
    for image, master in zip(masters, bundle['master_provenance']):
        all_rows = sorted(set(master['source_rows']))
        matched = [a for a in submitted if a['from'] and a['from']['row'] in all_rows]
        found = any(ref['media_exists'] is True and ref['parse_status'] == 'parsed'
                    for anchor in matched for ref in anchor['media_refs'])
        has_unknown = global_unknown or any(a['from'] is None for a in submitted) or any(
            a['parse_status'] == 'unknown' for a in matched)
        state = 'found' if found else 'unknown' if has_unknown else 'no_found'
        value = master['data'].get('产品图片')
        expected = {
            'master_anchor_row': master['row_index'], 'ice_code': master['ice_code'],
            'cell_value_empty': value is None or str(value).strip() == '', 'cell_value': value,
            'source_rows_considered': all_rows,
            'cell_values_by_source_row': {str(row): raw_rows.get(row, {}).get('产品图片', '') for row in all_rows},
            'anchor_ids': [a['anchor_id'] for a in matched], 'object_status': state,
            'content_verified': False, 'unresolved_reasons': image['unresolved_reasons'] if has_unknown else [],
            'meaning': IMAGE_MEANINGS[state],
        }
        require(image == expected, 'image source rows association or meaning differs: ' + str(master['row_index']))
        require(bool(image['unresolved_reasons']) == has_unknown, 'image unknown must carry reason')
    expected_summary = {
        'anchor_count': len(independent_anchors),
        'anchor_parse_status_counts': dict(Counter('unknown' if a['has_errors'] else 'parsed' for a in independent_anchors)),
        'master_count': len(masters),
        'master_object_status_counts': dict(Counter(m['object_status'] for m in masters)),
        'master_image_cell_empty_count': sum(m['cell_value_empty'] for m in masters),
        'content_verified_count': sum(m['content_verified'] for m in masters),
    }
    require(evidence['summary'] == expected_summary, 'image summary differs from independent OOXML facts')


def workbook_sheets(path):
    """Return actual worksheet row numbers and cached field values from OOXML."""
    with ZipFile(path) as archive:
        shared = []
        if 'xl/sharedStrings.xml' in archive.namelist():
            shared = [''.join(node.itertext()) for node in
                      ElementTree.fromstring(archive.read('xl/sharedStrings.xml')).findall(XML + 'si')]
        workbook = ElementTree.fromstring(archive.read('xl/workbook.xml'))
        relationships = ElementTree.fromstring(archive.read('xl/_rels/workbook.xml.rels'))
        targets = {r.attrib['Id']: r.attrib['Target'] for r in relationships}
        output = {}
        for sheet in workbook.find(XML + 'sheets'):
            rel = sheet.attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id']
            target = targets[rel]
            member = target.lstrip('/') if target.startswith('/') else 'xl/' + target
            result = []
            for row in ElementTree.fromstring(archive.read(member)).find(XML + 'sheetData'):
                fields = {}
                for cell in row:
                    if cell.tag != XML + 'c':
                        continue
                    column = re.sub('[0-9]+', '', cell.attrib['r'])
                    value = cell.find(XML + 'v')
                    value = '' if value is None or value.text is None else value.text
                    if cell.attrib.get('t') == 's':
                        value = shared[int(value)] if value else ''
                    elif cell.attrib.get('t') == 'inlineStr':
                        value = ''.join(cell.find(XML + 'is').itertext())
                    fields[column] = value
                result.append((int(row.attrib['r']), fields))
            headers = result[0][1]
            output[sheet.attrib['name']] = [(n, {headers.get(k, k): v for k, v in cells.items()})
                                           for n, cells in result[1:]]
        return output


def origin_index(base, manifest):
    inputs = manifest['original_input_hashes']
    index = defaultdict(list)
    for item in inputs['jushuitan']['paths']:
        path = base / item['frozen']
        require(digest(path) == item['sha256'], 'JST frozen workbook hash')
        sheets = workbook_sheets(path)
        sheet, rows = next(iter(sheets.items()))
        for row_number, fields in rows:
            style = fields.get('款式编码', '').strip()
            code = fields.get('商品编码', '').strip()
            if style or code:
                index[(style, code)].append({
                    'original_file': Path(item['path']).name, 'original_path': item['path'],
                    'frozen_path': str(path), 'sha256': item['sha256'], 'sheet': sheet,
                    'excel_row': row_number, 'style_code': style, 'product_code': code,
                    'external_name': fields.get('商品名称', ''),
                    'available_qty': fields.get('可用数', ''),
                })
    for category in ('master', 'bigseller'):
        item = inputs[category]
        require(digest(base / item['frozen']) == item['sha256'], category + ' frozen workbook hash')
    return index


def expected_origin(candidate, base, manifest, jst_index):
    source = candidate['source']
    if source['source_system'] == 'bigseller':
        item = manifest['original_input_hashes']['bigseller']
        key = source['source_row_key'].split(':', 3)
        require(key[0] == 'bigseller' and key[1] == source['sheet_name'], 'BS source row key')
        origin = {'original_file': Path(item['path']).name, 'original_path': item['path'],
                  'frozen_path': str(base / item['frozen']), 'sha256': item['sha256'],
                  'sheet': source['sheet_name'], 'excel_row': int(key[2])}
        occurrences = [origin]
    else:
        extra = source['extra']
        occurrences = jst_index[(extra.get('style_code') or '', extra.get('product_code') or '')]
        require(bool(occurrences), 'JST source has no physical provenance')
        # The saved result used last-file-wins merge. Verify that existing origin;
        # do not merge or regenerate any matcher input or decision.
        origin = occurrences[-1]
        require(origin['excel_row'] == int(source['source_row_key'].split(':')[1]), 'JST original row')
        require(origin['sheet'] == source['sheet_name'], 'JST original sheet')
        require(origin['external_name'] == source['external_name'], 'JST original name')
        require(origin['available_qty'] == (source['available_qty'] or ''), 'JST original quantity')
    return {'effective_origin': origin, 'all_input_occurrences': occurrences,
            'basis': '冻结来源身份与原行核对；JST文件顺序仅复核既有合并结果，不生成对应'}


def review_category(candidate):
    if candidate['review_state'] not in {'pending', 'candidate'}:
        return None
    if candidate['review_decision'] == 'defer':
        return 'explicit_defer'
    if candidate['master_matches']:
        return 'unconfirmed_candidate'
    if (candidate.get('name_review') or {}).get('nameOnlyMasters'):
        return 'name_hint_only'
    return 'no_saved_candidate'


def relation_explanation(candidate):
    if review_category(candidate) != 'no_saved_candidate':
        return candidate['review_reason']
    source = candidate['source']
    if source['source_system'] == 'bigseller':
        return 'BigSeller现有结果无候选；不能证明主库没有该商品'
    style = source['extra'].get('style_code') or ''
    product = source['extra'].get('product_code') or ''
    if '.' in style or '.' in product:
        return 'JST编码含分段符；含物料/组件式记录，不能硬套成品，也未建立组件关系'
    if style != product:
        return 'JST款式与商品编码不同；当前未建立其与主库的确认关系'
    if style.upper().startswith('SY1'):
        return 'JST为SY1系列编码；现有结果未给出成品主库候选，不新增组件或成品关系'
    return 'JST现有结果无候选；仅凭本批证据不能确认关系或断言来源不存在'


def verify_sources(data, bundle, base, manifest, jst_index):
    sources = data['sources']
    candidates = bundle['candidates']
    require(len(sources) == len(candidates) == 1417, 'source count')
    require(len({s['candidate_id'] for s in sources}) == 1417, 'duplicate candidate ID')
    identities = [(c['source']['source_system'], c['source']['source_row_key']) for c in candidates]
    require(len(set(identities)) == 1417, 'duplicate frozen source identity')
    master_targets = {m['row_index']: m for m in bundle['master_rows']}
    relations = defaultdict(list)
    chosen = defaultdict(list)
    for i, (result, candidate) in enumerate(zip(sources, candidates)):
        target = candidate.get('selected_master')
        require(bool(target) == (candidate['review_state'] == 'manual_selected'), 'invalid frozen target state')
        if target:
            require(target == master_targets[target['row_index']], 'invalid frozen selected target')
            require(not candidate['validation_errors'], 'frozen selected target has errors')
            chosen[target['row_index']].append(candidate)
        hints = (candidate.get('name_review') or {}).get('nameOnlyMasters', [])
        anchors = {x['row_index'] for x in candidate['master_matches'] + hints}
        if target:
            anchors.add(target['row_index'])
        expected = {
            'candidate_id': candidate['candidate_id'], 'source': candidate['source'],
            'account': None, 'market': None, 'effective_time': None,
            'scope_missing_note': '样表未提供账号/市场/关系有效期；不推造字段，不宣称正式关系已建',
            'provenance': expected_origin(candidate, base, manifest, jst_index),
            'review_state': candidate['review_state'], 'review_decision': candidate['review_decision'],
            'review_notes': candidate['review_notes'], 'selected_master': target,
            'selected_jushuitan': candidate.get('selected_jushuitan'),
            'candidate_targets': candidate['master_matches'], 'name_only_hints': hints,
            'related_master_anchors': sorted(anchors), 'general_review_category': review_category(candidate),
            'relationship_note': relation_explanation(candidate),
            'batch_business_pending': candidate['batch_business_pending'],
            'baseline_pointer': f'match-bundle.json#/candidates/{i}',
        }
        if 'final_confirmation_events' in bundle:
            expected['batch_version_confirmation'] = candidate.get('batch_version_confirmation')
        require(result == expected, 'source-record projection differs: ' + candidate['candidate_id'])
        for anchor in anchors:
            relations[anchor].append(candidate)
    require(Counter(s['source']['source_system'] for s in sources) == {'bigseller': 530, 'jushuitan': 887},
            'source system totals')
    return chosen, relations


def verify_master_rows(data, bundle, base, manifest, chosen, relations):
    masters = bundle['master_provenance']
    rows = data['coverage']
    require(len(rows) == len(masters) == 126, 'master count')
    codes = [r['ice_code'] for r in rows if r['ice_code']]
    require(len(codes) == len(set(codes)) == 125, 'ICE code count or uniqueness')
    require(len({r['master_anchor_row'] for r in rows}) == 126, 'duplicate master anchor')
    formulas = read(base / 'source-formulas-and-errors.json')
    master_input = manifest['original_input_hashes']['master']
    labels = {'both': '两边已有选择', 'bigseller_only': '仅BigSeller已有选择',
              'jushuitan_only': '仅聚水潭已有选择', 'neither': '两边均未找到已确认对应'}
    source_by_id = {s['candidate_id']: s for s in data['sources']}

    def source_detail(candidate):
        saved = source_by_id[candidate['candidate_id']]
        source = candidate['source']
        return {'candidate_id': candidate['candidate_id'], 'system': source['source_system'],
                'warehouse': source['warehouse'], 'sku': source['external_sku_raw'],
                'name': source['external_name'], 'origin': saved['provenance']['effective_origin'],
                'review_state': candidate['review_state'], 'review_decision': candidate['review_decision'],
                'version_pending': candidate['batch_business_pending']}

    for i, (row, master) in enumerate(zip(rows, masters)):
        anchor = master['row_index']
        selected = chosen[anchor]
        require({c['candidate_id'] for c in selected} == set(master['selected_source_ids']), 'saved master selections')
        bs = defaultdict(list)
        jst = []
        for c in selected:
            if c['source']['source_system'] == 'bigseller':
                bs[c['source']['warehouse']].append(c['candidate_id'])
            else:
                jst.append(c['candidate_id'])
        classification = { (True, True): 'both', (True, False): 'bigseller_only',
                           (False, True): 'jushuitan_only', (False, False): 'neither'}[(bool(bs), bool(jst))]
        pending = [c for c in relations[anchor] if review_category(c)]
        candidate_members = [c for c in pending if any(target['row_index'] == anchor for target in c['master_matches'])]
        versions = [c['candidate_id'] for c in selected if c['batch_business_pending']]
        deferred, context = [], []
        if master['ice_code'] in ('WM0081', 'brush'):
            deferred.append('刷子两款保持分开，不新增对应；按已批准延期登记，不重复催问')
            context = [c['candidate_id'] for c in bundle['candidates']
                       if c['source']['source_system'] == 'bigseller' and
                       '硅胶刷' in c['source']['external_name'] and c['review_state'] == 'pending']
        if master['ice_code'] == 'WM0073' and 'final_confirmation_events' not in bundle:
            deferred.append('菲越757577407359两条显式defer继续目标为空；仅登记已批准延期的相关证据')
            context = [c['candidate_id'] for c in bundle['candidates'] if c['review_decision'] == 'defer'
                       and c['source']['external_sku_raw'] == '757577407359']
        if anchor == 122:
            deferred.append('新品缺货号/条码；JST WM0131仅同名提示，用户已要求待补，不认领该码')
        if master['ice_code'] == 'WM0040':
            deferred.append('旧商品主资料保留，不认定确定停产')
        if not master['data'].get('生产工厂'):
            deferred.append('工厂资料缺失/失效引用按既有延期保留，不猜填')
        expected = {
            'master_anchor_row': anchor, 'ice_code': master['ice_code'], 'name_cn': master['name_cn'],
            'spec_column': master['spec'],
            'master_source': {'original_file': Path(master_input['path']).name, 'sha256': master_input['sha256'],
                              'frozen_path': str(base / master_input['frozen']),
                              'original_rows': master['source_rows'], 'primary_row': master['primary_row'],
                              'baseline_pointer': f'master-overview.json#/{i}'},
            'coverage_class': classification, 'coverage_label': labels[classification],
            'bigseller_selected_by_warehouse': dict(bs), 'jushuitan_selected': jst,
            'selected_source_details': [source_detail(c) for c in selected],
            'effective_selection_count': len(selected),
            'unconfirmed_candidates': [c['candidate_id'] for c in candidate_members],
            'unconfirmed_candidate_details': [source_detail(c) for c in candidate_members],
            'name_only_hints': [c['candidate_id'] for c in pending if anchor in
                                [m['row_index'] for m in (c.get('name_review') or {}).get('nameOnlyMasters', [])]],
            'deferred_related_sources': [c['candidate_id'] for c in pending if c['review_decision'] == 'defer'],
            'inactive_related_sources': [c['candidate_id'] for c in relations[anchor]
                                         if c['review_state'] in ('rejected', 'ignored', 'outside_rules')],
            'context_only_sources': context,
            'context_only_note': '已有延期/无法区分的来源记录，仅供追溯，不作为候选或有效对应',
            'data_gaps': [k for k, v in master['data'].items() if v is None or str(v).strip() == ''],
            'data_gap_note': '仅列当前资料空值，不规定全部必填；规格专列为空不等于名称中无规格；产品图片值空仅指单元格，不代表缺少嵌入图片，图片对象状态另列且内容未核验',
            'image_evidence': next(image for image in data['images']['masters'] if image['master_anchor_row'] == anchor),
            'spec_audit_question_ids': ['audit-spec-' + master['ice_code']] if master['ice_code'] in SPEC_CODES else [],
            'source_coverage_gap': {'bigseller': None if bs else '当前未找到已确认对应',
                                    'jushuitan': None if jst else '当前未找到已确认对应'},
            'version_review': {'pending_records': versions,
                               'status': '已登记版本待决' if versions else '无已登记版本待决；未作全面版本认证',
                               'all_versions_verified': None},
            'shared_barcode_facts': [q for q in bundle['master_quality_issues'] if anchor in q['row_indices']],
            'invalid_formula_references': [f for f in formulas if '#REF!' in f['value'] and
                                           int(re.search('[0-9]+', f['coordinate'])[0]) in master['source_rows']],
            'approved_deferrals': deferred,
            'price_facts': {'current_cost': master['data'].get('成本价格'),
                            'current_operating_price': master['data'].get('运营价格'),
                            'price_pending': master['price_pending'], 'source_versions': master['price_versions'],
                            'current_selection': master.get('current_price_selection'),
                            'valuation_authorized': master['valuation_authorized']},
        }
        if 'batch_bs_not_created' in bundle:
            status = master.get('bs_creation_status')
            require(status == next((s for s in bundle['batch_bs_not_created'] if s['master_row'] == anchor), None),
                    'BS not-created product explanation mismatch')
            if status:
                require(not bs and status['ice_code'] == master['ice_code'], 'not-created BS must not fabricate selected sources')
                expected['source_coverage_gap']['bigseller'] = status['reason']
            expected['bigseller_creation_status'] = status
        if 'final_confirmation_events' in bundle:
            expected['specification_resolution'] = master.get('specification_resolution')
            expected['brush_preservation'] = master.get('brush_preservation')
            confirmed = [c['candidate_id'] for c in selected if c.get('batch_version_confirmation')]
            expected['version_review']['confirmed_records'] = confirmed
            if confirmed:
                expected['version_review']['status'] = '指定菲越三条已由用户确认升级款；未作全面版本认证'
        require(row == expected, 'master coverage differs: ' + str(anchor))
    require(set(relations).issubset({m['row_index'] for m in masters}), 'unknown related master')


def verify_summary(data, bundle):
    rows, sources = data['coverage'], data['sources']
    general = [s for s in sources if s['general_review_category']]
    codes = [r['ice_code'] for r in rows if r['ice_code']]
    expected = {
        'masters': len(rows), 'nonempty_ice_codes': len(codes), 'distinct_nonempty_ice_codes': len(set(codes)),
        'missing_ice_codes': len(rows) - len(codes), 'sources': len(sources),
        'source_systems': dict(Counter(s['source']['source_system'] for s in sources)),
        'coverage': dict(Counter(r['coverage_class'] for r in rows)),
        'review_states': dict(Counter(s['review_state'] for s in sources)),
        'effective_selected_sources': sum(r['effective_selection_count'] for r in rows),
        'general_review_records': len(general),
        'general_review_categories': dict(Counter(s['general_review_category'] for s in general)),
        'no_saved_candidate_explanations': dict(Counter(s['relationship_note'] for s in general
                                                       if s['general_review_category'] == 'no_saved_candidate')),
        'registered_business_issues': len(bundle['batch_business_pending']),
        'registered_version_pending_records': sum(len(r['version_review']['pending_records']) for r in rows),
        'data_empty_field_counts': dict(Counter(field for r in rows for field in r['data_gaps'])),
        'shared_barcode_groups': len(bundle['master_quality_issues']),
        'invalid_formula_cells': sum(len(r['invalid_formula_references']) for r in rows),
        'masters_with_invalid_formula': sum(bool(r['invalid_formula_references']) for r in rows),
        'source_account_market_effective_time_provided': False,
        'image_objects': data['images']['summary'],
        'specification_audit_questions': sum(len(r['spec_audit_question_ids']) for r in rows),
    }
    if 'final_confirmation_events' in bundle:
        expected['open_specification_audit_questions'] = sum(not r.get('specification_resolution')
            for r in rows if r['spec_audit_question_ids'])
        expected['closed_specification_audit_questions'] = sum(bool(r.get('specification_resolution'))
            for r in rows if r['spec_audit_question_ids'])
        expected['registered_version_confirmed_records'] = sum(len(r['version_review']['confirmed_records']) for r in rows)
        expected['remaining_user_decisions'] = len(bundle['batch_business_pending']) + expected['open_specification_audit_questions']
    require(data['summary'] == expected, 'coverage summary differs from recalculation')
    require(sum(expected['coverage'].values()) == 126, 'coverage partition total')
    require(expected['effective_selected_sources'] == expected['review_states']['manual_selected'], 'selected partition')


def verify_csv(data):
    require(len(data['csv']) == len(data['coverage']), 'CSV row count')
    require(data['csv_fields'] == list(data['coverage'][0]), 'CSV field order or missing column')
    for n, (cells, row) in enumerate(zip(data['csv'], data['coverage'])):
        expected = {k: json.dumps(v, ensure_ascii=False) if isinstance(v, (dict, list)) else
                    '' if v is None else str(v) for k, v in row.items()}
        require(cells == expected, 'CSV field mismatch at row ' + str(n + 2))


def no_formal_binding(value):
    if isinstance(value, dict):
        for key, item in value.items():
            require(key not in {'formal_mapping_eligible', 'formal_binding_eligible',
                                'binding_eligible', 'database_unique_constraint_implemented'},
                    'unauthorized formal binding claim')
            no_formal_binding(item)
    elif isinstance(value, list):
        for item in value:
            no_formal_binding(item)


def verify_questions_report(data, bundle, base, manifest):
    """Check the extra explanatory artifacts against the independently checked rows."""
    if 'final_confirmation_events' in bundle:
        return verify_final_questions_report(data, bundle, base, manifest)
    questions = data['questions']
    require(len(questions) == 7 and len({q['id'] for q in questions}) == 7, 'audit question inventory')
    sources = {s['candidate_id']: s for s in data['sources']}
    coverage = {r['ice_code']: r for r in data['coverage']}
    master_by_code = {m['ice_code']: m for m in bundle['master_provenance']}
    existing = [q for q in questions if q['kind'] == 'existing_business_issue']
    require(len(existing) == 1 and existing[0]['id'] == 'existing-ph-vn-cleanser-version', 'existing business issue annotation')
    existing = existing[0]
    require(existing['current_correspondence'] == [
        {'candidate_id': cid, 'target': sources[cid]['selected_master'], 'source': sources[cid]['source']}
        for cid in bundle['batch_business_pending'][0]['candidate_ids']], 'existing issue source projection')
    require(existing['baseline_pending_unchanged'] is True, 'existing pending status changed')
    fresh = [q for q in questions if q['kind'] == 'new_specification_evidence_question']
    require({q['product']['ice_code'] for q in fresh} == {'WM0006', 'WM0008', 'WM0130'}, 'new specification question products')
    for q in questions:
        require(q['blocks_this_readonly_batch'] is False, 'audit question must not fabricate batch blocker')
        require(all(isinstance(q[k], str) and q[k].strip() for k in
                    ('uncertain', 'user_choice_needed')), 'question lacks uncertainty or user choice')
    for q in fresh:
        code = q['product']['ice_code']
        master, row = master_by_code[code], coverage[code]
        require(q['id'] == 'audit-spec-' + code, 'new audit question ID')
        require(q['product'] == {'ice_code': code, 'name': master['name_cn'],
                                  'master_anchor': master['row_index']}, 'question product')
        source_id = q['current_correspondence']['unconfirmed_candidate_id']
        source = sources[source_id]
        require(source_id in row['unconfirmed_candidates'] and source['selected_master'] is None and
                source['review_state'] == 'candidate', 'question candidate is already selected')
        require(q['current_correspondence'] == {
            'bigseller_selected': row['bigseller_selected_by_warehouse'],
            'jushuitan_selected': row['jushuitan_selected'],
            'unconfirmed_candidate_id': source_id}, 'question current correspondence')
        require(q['evidence'] == {
            'master_name': master['name_cn'], 'master_spec_column': master['spec'],
            'master_single_product_weight_kg': master['data'].get('单个产品重量(kg）'),
            'master_note': master['data'].get('备注'),
            'jst_source_name': source['source']['external_name'],
            'source_origin': source['provenance']['effective_origin']}, 'question evidence differs from source')
        require(isinstance(q['decision_unchanged'], str) and '不写confirm' in q['decision_unchanged'],
                'question must retain candidate and decisions')
    selected_questions = [q for q in questions if q['kind'] == 'selected_specification_evidence_question']
    require({q['product']['ice_code'] for q in selected_questions} == {'WM0031', 'WM0062', 'WM0098'},
            'selected specification question inventory')
    raw_cache = {}

    def raw_row(origin):
        path = Path(origin['frozen_path'])
        require(digest(path) == origin['sha256'], 'selected specification source workbook hash')
        if path not in raw_cache:
            raw_cache[path] = {sheet: dict(rows) for sheet, rows in workbook_sheets(path).items()}
        return raw_cache[path][origin['sheet']][origin['excel_row']]

    def source_evidence(source):
        origin = source['provenance']['effective_origin']
        raw = raw_row(origin)
        bs = source['source']['source_system'] == 'bigseller'
        name, sku = raw['名称' if bs else '商品名称'], raw['SKU编号' if bs else '商品编码']
        require(name == source['source']['external_name'] and sku == source['source']['external_sku_raw'],
                'selected question must reference actual frozen source text')
        if bs:
            require(raw['仓库'] == source['source']['warehouse'], 'selected question frozen source warehouse')
        return {'candidate_id': source['candidate_id'], 'system': source['source']['source_system'],
                'warehouse': source['source']['warehouse'], 'origin': origin, 'raw_name': name, 'raw_sku': sku,
                'selected_master': source['selected_master'], 'review_state': source['review_state'],
                'review_decision': source['review_decision']}

    master_item = manifest['original_input_hashes']['master']
    master_sheets = workbook_sheets(base / master_item['frozen'])
    master_sheet, master_rows = next(iter(master_sheets.items()))
    master_rows = dict(master_rows)
    for q in selected_questions:
        code = q['product']['ice_code']
        master, row = master_by_code[code], coverage[code]
        require(q['id'] == 'audit-spec-' + code, 'selected question ID')
        require(q['product'] == {'ice_code': code, 'name': master['name_cn'],
                                  'master_anchor': master['row_index']}, 'selected question product')
        require(q['current_correspondence'] == {
            'bigseller_selected': row['bigseller_selected_by_warehouse'],
            'jushuitan_selected': row['jushuitan_selected'],
            'selected_source_ids': master['selected_source_ids']}, 'selected question current correspondence')
        # WM0031's JST name exposes the g/ml difference; its three BS names do
        # not carry a quantity. The other two questions retain every selected
        # source exposing the original specification wording.
        refs = [s for s in data['sources'] if s['selected_master'] and s['selected_master']['ice_code'] == code
                and (code != 'WM0031' or s['source']['source_system'] == 'jushuitan')]
        rejected = [s for s in data['sources'] if code == 'WM0062' and
                    s['source']['source_system'] == 'jushuitan' and s['source']['external_sku_raw'] == code and
                    s['review_decision'] == 'reject']
        require(len(rejected) == (1 if code == 'WM0062' else 0), 'preserved JST rejection evidence')
        require(all(s['selected_master'] is None for s in rejected), 'rejected evidence was reactivated')
        raw = master_rows[master['row_index']]
        require(q['evidence'] == {
            'master': {'original_file': Path(master_item['path']).name, 'original_path': master_item['path'],
                       'frozen_path': str(base / master_item['frozen']), 'sha256': master_item['sha256'],
                       'sheet': master_sheet, 'excel_row': master['row_index'],
                       'raw_name': raw['中文产品名称'], 'raw_spec': raw['规格']},
            'sources': [source_evidence(s) for s in refs],
            'preserved_rejected_sources': [source_evidence(s) for s in rejected]},
            'selected specification evidence omitted or changed: ' + code)
        require('不撤销' in q['decision_unchanged'] and '不降级' in q['decision_unchanged'] and
                '不新增确认' in q['decision_unchanged'], 'selected questions must preserve existing decisions')
    require(all('本轮不要求' in q['user_choice_needed'] and '后续' in q['user_choice_needed']
                for q in fresh + selected_questions), 'specification questions must remain nonblocking future work')
    report = data['report']
    summary = data['summary']
    expected_phrases = [
        f"两边已有选择{summary['coverage']['both']}份",
        f"仅BigSeller{summary['coverage']['bigseller_only']}份",
        f"仅聚水潭{summary['coverage']['jushuitan_only']}份",
        f"两边均未找到已确认对应{summary['coverage']['neither']}份",
        f"来源共{summary['sources']}条", f"有效人工选择{summary['effective_selected_sources']}条",
        f"覆盖{sum(bool(r['effective_selection_count']) for r in data['coverage'])}份主资料",
        f"{summary['general_review_records']}条一般未核对记录",
        '菲越三条WM0012明确保留版本待决', 'price_pending=false',
        '长期正式关系保存、自动复用、数量归集及同步仍待业务流程另定',
        'P0_03_IMPLEMENTED_AWAITING_REVIEW', '不代表整个P0-03 PASS',
    ]
    image_summary = data['images']['summary']
    image_statuses = image_summary['master_object_status_counts']
    expected_phrases.extend([
        f"产品图片单元格值空{image_summary['master_image_cell_empty_count']}份",
        '仅指单元格值，不代表缺少嵌入图片',
        f"实际读取冻结Excel得到{image_summary['anchor_count']}个图片锚点",
        f"找到关联图片对象{image_statuses.get('found', 0)}份",
        f"未找到关联图片对象{image_statuses.get('no_found', 0)}份",
        f"未能判断{image_statuses.get('unknown', 0)}份",
        '按全部原始来源行关联、按主资料去重',
        '找到对象不代表图片内容正确', '未找到对象不证明商品确实无图', '图片内容尚未核验',
        'image-object-evidence.json', '不提取展示或补图',
    ])
    require(all(phrase in report for phrase in expected_phrases), 'Chinese report summary or boundaries inconsistent')
    candidate_count = sum(s['general_review_category'] == 'unconfirmed_candidate' for s in data['sources'])
    require(f'{candidate_count}条JST候选逐条如下' in report, 'Chinese report candidate count')
    if 'jst_confirmation_events' in bundle:
        require('其JST本轮已依据用户明确决定确认为有效选择' in report and '其JST仍为候选' not in report,
                'Chinese report stale WM0072 JST status')
        for status in bundle['batch_bs_not_created']:
            require(status['ice_code'] in report and status['reason'] in report and status['basis'] in report,
                    'Chinese report BS not-created explanation missing')
        require('不表示库存为0' in report and '不是reject或全系统停用' in report,
                'Chinese report ignore and BS scope')
    for q in fresh:
        require(q['product']['ice_code'] in report and q['evidence']['jst_source_name'] in report,
                'Chinese report lacks question evidence')
    for q in selected_questions:
        require(q['product']['ice_code'] in report and q['evidence']['master']['raw_spec'] in report,
                'Chinese report omits selected specification question')
        for source in q['evidence']['sources'] + q['evidence']['preserved_rejected_sources']:
            require(source['candidate_id'] in report and str(source['origin']['excel_row']) in report,
                    'Chinese report omits selected specification source evidence')
    for candidate in (s for s in data['sources'] if s['general_review_category'] == 'unconfirmed_candidate'):
        require(candidate['source']['external_name'] in report, 'Chinese report omits a saved candidate')
    for category in ('bigseller_only', 'jushuitan_only', 'neither'):
        members = [r for r in data['coverage'] if r['coverage_class'] == category]
        for r in members:
            require((r['ice_code'] or '缺货号新品') + f"（原{r['master_anchor_row']}行）" in report,
                    'Chinese report coverage list differs')


def verify_final_questions_report(data, bundle, base, manifest):
    """Closed annotations retain the fully validated previous explanations, not stale current status."""
    questions = data['questions']; historical = read(base / 'inherited-baseline/coverage/audit-questions.json')
    require(len(questions) == len(historical) == 7 and {q['id'] for q in questions} == {q['id'] for q in historical},
            'final seven historical annotations retained')
    sources = {r['candidate_id']: r for r in data['sources']}; products = {r['ice_code']: r for r in data['coverage']}
    masters = {m['ice_code']: m for m in bundle['master_provenance']}
    resolutions = bundle['batch_specification_resolutions']
    require(len(resolutions) == 6 and {r['ice_code'] for r in resolutions} == SPEC_CODES, 'final six specification resolutions')
    require(len(bundle['batch_version_confirmations']) == 3 and
            {r['candidate_id'] for r in bundle['batch_version_confirmations']} == PH_VN, 'final three version authority')
    original_by = {q['id']: q for q in historical}
    resolution_by = {r['ice_code']: r for r in resolutions}
    for q in questions:
        original = original_by[q['id']]
        require(q['previous_audit_question'] == original and q['evidence'] == original['evidence'], 'final original evidence/history altered')
        require(q['kind'] == original['kind'] and q['product'] == original['product'] and
                q['blocks_this_readonly_batch'] is False, 'final annotation identity or blocker')
        require(q['user_choice_needed'] == '无新增选择要求；本项当前已关闭。', 'final stale user-choice request')
        if q['kind'] == 'existing_business_issue':
            require(q['status'] == 'closed_user_confirmed_upgraded' and q['baseline_pending_unchanged'] is False,
                    'final cleanser closed annotation')
            require(q['resolution'] == bundle['batch_version_confirmations'], 'final cleanser resolution projection')
            expected = [{'candidate_id': cid, 'target': sources[cid]['selected_master'], 'source': sources[cid]['source']}
                        for cid in [r['candidate_id'] for r in bundle['batch_version_confirmations']]]
            require(q['current_correspondence'] == expected, 'final cleanser current correspondence')
            for resolution in q['resolution']:
                source = sources[resolution['candidate_id']]
                require(source['batch_version_confirmation'] == resolution and resolution['confirmed_version'] == '升级普通版' and
                        resolution['effective_selection'] is True and source['selected_master']['row_index'] == 19 and
                        source['selected_master']['ice_code'] == 'WM0012' and not source['batch_business_pending'],
                        'final upgraded version current selected record')
            require('用户确认三条均为升级普通版WM0012' in q['uncertain'], 'final cleanser current explanation')
            continue
        code = q['product']['ice_code']; resolution = resolution_by[code]; product = products[code]
        require(q['status'] == 'closed' and q['resolution'] == resolution and
                resolution['previous_audit_question'] == original, 'final closed specification history')
        require(product['specification_resolution'] == resolution and resolution['master_row'] == product['master_anchor_row'] and
                resolution['quantity_conversion_authorized'] is False, 'final specification master evidence')
        expected = {'bigseller_selected': product['bigseller_selected_by_warehouse'],
                    'jushuitan_selected': product['jushuitan_selected']}
        if q['kind'] == 'new_specification_evidence_question':
            cid = original['current_correspondence']['unconfirmed_candidate_id']; source = sources[cid]
            expected.update(source_id=cid, review_state=source['review_state'], review_decision=source['review_decision'],
                            selected_master=source['selected_master'])
            if code in ('WM0006', 'WM0008'):
                require(source['review_decision'] == 'ignore' and source['review_state'] == 'ignored' and
                        source['selected_master'] is None and source['review_notes'] == '用户要求本批忽略', 'final ignored spec source')
            else:
                require(source['review_decision'] == 'confirm' and source['selected_master'] ==
                        next(m for m in bundle['master_rows'] if m['row_index'] == 121), 'final WM0130 actual confirmation')
        else:
            expected['selected_source_ids'] = [s['candidate_id'] for s in data['sources'] if s['selected_master'] and
                                               s['selected_master']['row_index'] == product['master_anchor_row']]
        require(q['current_correspondence'] == expected, 'final specification current correspondence')
        if code in ('WM0006', 'WM0008'):
            require(resolution['status'] == 'closed_ignored_for_batch' and resolution['source_column'] is None and
                    resolution['selected_spec'] is None, 'final ignore must not fabricate a specification')
        else:
            spec = {'WM0031': '20ml/支', 'WM0062': '20ml/支', 'WM0098': '120g/瓶', 'WM0130': '20ml/支'}[code]
            require((resolution['status'], resolution['source_column'], resolution['selected_spec']) ==
                    ('closed_master_column_c', 'C', spec) and product['spec_column'] == spec and masters[code]['spec'] == spec,
                    'final master C-column specification exact value')
        require('已依据本轮用户明确决定关闭' in q['uncertain'] and '不换算g/ml' in q['decision_unchanged'],
                'final specification boundaries')
    master_file = manifest['original_input_hashes']['master']
    master_raw = dict(next(iter(workbook_sheets(base / master_file['frozen']).values())))
    for resolution in resolutions:
        if resolution['source_column'] == 'C':
            require(master_raw[resolution['master_row']]['规格'] == resolution['selected_spec'], 'final actual frozen C column')
    require(len(bundle['batch_brush_preservation']) == 2 and
            {(r['ice_code'], r['master_row']) for r in bundle['batch_brush_preservation']} == {('WM0081', 62), ('brush', 107)},
            'final two brush rows distinct')
    for preserved in bundle['batch_brush_preservation']:
        product = products[preserved['ice_code']]
        require(product['brush_preservation'] == preserved and product['name_cn'] == preserved['name'] and
                preserved['status'] == 'pending_confirmation' and preserved['do_not_merge'] is True and preserved['future_requirement'],
                'final brush visibility and pending preservation')
    rejected = next(s for s in data['sources'] if s['source']['source_system'] == 'jushuitan' and
                    s['source']['external_sku_raw'] == 'WM0062')
    require(rejected['review_decision'] == 'reject' and rejected['selected_master'] is None, 'final WM0062 reject must remain')
    summary, report = data['summary'], data['report']
    require(summary['open_specification_audit_questions'] == 0 and summary['closed_specification_audit_questions'] == 6 and
            summary['registered_version_pending_records'] == 0 and summary['registered_version_confirmed_records'] == 3 and
            summary['remaining_user_decisions'] == 0, 'final current open/resolved counts')
    image = data['images']['summary']; status = image['master_object_status_counts']
    phrases = [f"两边已有选择{summary['coverage']['both']}份", f"仅BigSeller{summary['coverage']['bigseller_only']}份",
        f"仅聚水潭{summary['coverage']['jushuitan_only']}份", f"两边均未找到已确认对应{summary['coverage']['neither']}份",
        f"来源共{summary['sources']}条", f"有效人工选择{summary['effective_selected_sources']}条",
        f"覆盖{sum(bool(r['effective_selection_count']) for r in data['coverage'])}份主资料",
        f"{summary['general_review_records']}条一般未核对记录", '菲越三条WM0012已由用户确认升级款',
        '本轮规格待复核0项、已关闭6项', 'previous_audit_question', 'remaining_user_decisions=0',
        '不是reject或全系统停用', '原789行reject不自动撤销', '旧暂缓作为历史保留',
        'WM0081原62行与brush原107行两份主资料分别可见', 'price_pending=false',
        '其JST本轮已依据用户明确决定确认为有效选择', '长期正式关系保存、自动复用、数量归集及同步仍待业务流程另定',
        f"产品图片单元格值空{image['master_image_cell_empty_count']}份", '仅指单元格值，不代表缺少嵌入图片',
        f"实际读取冻结Excel得到{image['anchor_count']}个图片锚点", '按全部原始来源行关联、按主资料去重',
        f"找到关联图片对象{status.get('found', 0)}份", f"未找到关联图片对象{status.get('no_found', 0)}份",
        f"未能判断{status.get('unknown', 0)}份", '找到对象不代表图片内容正确', '未找到对象不证明商品确实无图',
        '图片内容尚未核验', 'image-object-evidence.json', '不提取展示或补图',
        'P0_03_IMPLEMENTED_AWAITING_REVIEW', '不代表整个P0-03 PASS']
    require(all(phrase in report for phrase in phrases), 'final Chinese report current decision/count/image/boundary text')
    for stale in ('菲越三条WM0012明确保留版本待决', '原已登记业务待决仍1项', '资料是否及如何补正留待后续'):
        require(stale not in report, 'final Chinese report stale unresolved status')
    for q in questions[1:]:
        require(q['product']['ice_code'] in report, 'final report missing closed specification product')
        if q['kind'] == 'new_specification_evidence_question':
            require(q['evidence']['jst_source_name'] in report, 'final report missing original candidate name')
        else:
            for s in q['evidence']['sources'] + q['evidence']['preserved_rejected_sources']:
                require(s['candidate_id'] in report and s['raw_name'] in report, 'final report missing raw source difference')
    for preserved in bundle['batch_bs_not_created']:
        require(preserved['ice_code'] in report and preserved['reason'] in report and preserved['basis'] in report and
                '不表示库存为0' in report, 'final report retained BS not-created scope')
    candidates = [s for s in data['sources'] if s['general_review_category'] == 'unconfirmed_candidate']
    require(f'{len(candidates)}条JST候选逐条如下' in report, 'final report actual candidate count')
    require(all(s['source']['external_name'] in report for s in candidates), 'final report candidate names')
    for category in ('bigseller_only', 'jushuitan_only', 'neither'):
        require(all((r['ice_code'] or '缺货号新品') + f"（原{r['master_anchor_row']}行）" in report
                    for r in data['coverage'] if r['coverage_class'] == category), 'final report coverage identities')


def verify(data, bundle, base, manifest, jst_index, image_facts):
    no_formal_binding(data)
    verify_image_evidence(data, bundle, base, manifest, image_facts)
    chosen, relations = verify_sources(data, bundle, base, manifest, jst_index)
    verify_master_rows(data, bundle, base, manifest, chosen, relations)
    verify_summary(data, bundle)
    verify_csv(data)
    verify_questions_report(data, bundle, base, manifest)
    by_id = {s['candidate_id']: s for s in data['sources']}
    wm12 = next(r for r in data['coverage'] if r['ice_code'] == 'WM0012')
    if 'final_confirmation_events' in bundle:
        require(not bundle['batch_business_pending'] and not wm12['version_review']['pending_records'], 'final PH/VN version must be closed')
        require(set(wm12['version_review']['confirmed_records']) == PH_VN, 'final PH/VN exact version confirmations')
        for source_id in PH_VN:
            row = by_id[source_id]
            require(row['selected_master']['ice_code'] == 'WM0012' and not row['batch_business_pending'] and
                    row['batch_version_confirmation']['confirmed_version'] == '升级普通版', 'final PH/VN upgraded version')
    else:
        require(len(bundle['batch_business_pending']) == 1, 'remaining business issue')
        require(set(bundle['batch_business_pending'][0]['candidate_ids']) == PH_VN, 'PH/VN business issue members')
        require(set(wm12['version_review']['pending_records']) == PH_VN, 'PH/VN version remains pending')
        for source_id in PH_VN:
            row = by_id[source_id]
            require(row['selected_master']['ice_code'] == 'WM0012' and row['batch_business_pending'], 'PH/VN selection/version')
    wm72 = next(r for r in data['coverage'] if r['ice_code'] == 'WM0072')
    price = wm72['price_facts']
    require((price['current_cost'], price['current_operating_price'], price['price_pending']) ==
            ('5.18', '5.68', False), 'WM0072 current price')
    require(price['source_versions'] == [{'source_row': 66, 'cost': '5', 'operating_price': '5.5'},
                                         {'source_row': 216, 'cost': '5.18', 'operating_price': '5.68'}], 'WM0072 price history')
    jst72 = [s for s in data['sources'] if s['source']['source_system'] == 'jushuitan' and
             s['source']['external_sku_raw'] == 'WM0072']
    if 'jst_confirmation_events' in bundle:
        require(len(jst72) == 1 and jst72[0]['review_state'] == 'manual_selected' and
                jst72[0]['selected_master']['row_index'] == 66 and jst72[0]['selected_master']['ice_code'] == 'WM0072' and
                jst72[0]['review_decision'] == 'confirm', 'WM0072 JST explicit new confirmation must persist')
    else:
        require(len(jst72) == 1 and jst72[0]['review_state'] == 'candidate' and
                jst72[0]['selected_master'] is None and jst72[0]['review_decision'] is None,
                'WM0072 JST must remain unconfirmed')


def self_test(data, bundle, base, manifest, jst_index, image_facts):
    """Mutation tests exercise the verifier itself, without touching artifacts."""
    cases = []

    def rejects(name, mutation):
        corrupted = copy.deepcopy(data)
        mutation(corrupted)
        try:
            verify(corrupted, bundle, base, manifest, jst_index, image_facts)
        except (ValueError, KeyError, IndexError, TypeError):
            cases.append({'case': name, 'result': 'rejected'})
        else:
            raise ValueError('negative audit unexpectedly accepted: ' + name)

    candidate_index = next(i for i, r in enumerate(data['sources']) if r['review_state'] == 'candidate')
    selected_index = next(i for i, r in enumerate(data['sources']) if r['selected_master'])
    alternate = next(m for m in bundle['master_rows'] if m != data['sources'][selected_index]['selected_master'])
    rejects('candidate_disguised_as_selected', lambda d: d['sources'][candidate_index].update(
        review_state='manual_selected', selected_master=copy.deepcopy(alternate)))
    rejects('wrong_selected_target', lambda d: d['sources'][selected_index].update(selected_master=alternate))
    rejects('missing_master', lambda d: d['coverage'].pop())
    rejects('missing_source', lambda d: d['sources'].pop())
    rejects('duplicate_ice_code', lambda d: d['coverage'][1].update(ice_code=d['coverage'][0]['ice_code']))
    rejects('selected_falsely_means_version_verified', lambda d: next(
        r for r in d['coverage'] if r['ice_code'] == 'WM0012')['version_review'].update(all_versions_verified=True))
    rejects('csv_tamper', lambda d: d['csv'][0].update(name_cn='tampered'))
    rejects('summary_tamper', lambda d: d['summary']['coverage'].update(both=999))
    rejects('source_quantity_tamper', lambda d: d['sources'][0]['source'].update(available_qty='999999'))
    rejects('provenance_row_tamper', lambda d: d['sources'][0]['provenance']['effective_origin'].update(excel_row=999999))
    if 'jst_confirmation_events' not in bundle:
        rejects('unconfirmed_price_record_auto_confirmed', lambda d: next(
            r for r in d['sources'] if r['source']['source_system'] == 'jushuitan' and
            r['source']['external_sku_raw'] == 'WM0072').update(review_decision='confirm'))
    else:
        # The exact same confirm is now expressly authorized. In this mode,
        # removing it is a corruption; the old mutation remains intact above.
        rejects('authorized_jst_confirmation_removed', lambda d: next(
            r for r in d['sources'] if r['candidate_id'] == 'mc-fd977bdb831a5b5b').update(review_decision=None))
    rejects('formal_binding_claim', lambda d: d['coverage'][0].update(formal_mapping_eligible=True))
    rejects('audit_question_source_evidence_tamper', lambda d: d['questions'][1]['evidence'].update(jst_source_name='tampered'))
    original_phrase = f"两边已有选择{data['summary']['coverage']['both']}份"
    rejects('chinese_report_summary_tamper', lambda d: d.update(report=d['report'].replace(original_phrase, '两边已有选择999份')))
    first_found = next(i for i, m in enumerate(data['images']['masters']) if m['object_status'] == 'found')
    first_not_found = next(i for i, m in enumerate(data['images']['masters']) if m['object_status'] == 'no_found')
    duplicated_source = next(i for i, m in enumerate(data['images']['masters']) if len(m['source_rows_considered']) > 1)
    wrong_anchor = next(a['anchor_id'] for a in data['images']['anchors']
                        if a['anchor_id'] not in data['images']['masters'][first_found]['anchor_ids'])
    rejects('image_wrong_master_association', lambda d: d['images']['masters'][first_found].update(anchor_ids=[wrong_anchor]))
    rejects('image_anchor_evidence_omitted', lambda d: d['images']['anchors'].pop())
    rejects('image_master_evidence_omitted', lambda d: d['images']['masters'].pop())
    rejects('image_summary_tamper', lambda d: d['images']['summary'].update(anchor_count=999))
    rejects('image_only_primary_loses_duplicate_source', lambda d: d['images']['masters'][duplicated_source].update(
        source_rows_considered=d['images']['masters'][duplicated_source]['source_rows_considered'][-1:]))
    rejects('image_content_falsely_verified', lambda d: d['images']['masters'][first_found].update(content_verified=True))
    rejects('image_empty_cell_falsely_means_no_picture', lambda d: d['images']['masters'][first_found].update(
        object_status='no_found', meaning=IMAGE_MEANINGS['no_found']))
    rejects('image_not_found_falsely_means_real_absence', lambda d: d['images']['masters'][first_not_found].update(
        meaning='商品确实无图片'))
    rejects('image_unknown_without_reason', lambda d: d['images']['masters'][first_not_found].update(
        object_status='unknown', meaning=IMAGE_MEANINGS['unknown'], unresolved_reasons=[]))
    rejects('image_media_hash_tamper', lambda d: d['images']['anchors'][0]['media_refs'][0].update(media_sha256='0' * 64))
    rejects('selected_spec_question_omitted', lambda d: d['questions'].remove(next(
        q for q in d['questions'] if q['kind'] == 'selected_specification_evidence_question')))
    rejects('selected_spec_source_evidence_omitted', lambda d: next(
        q for q in d['questions'] if q['id'] == 'audit-spec-WM0098')['evidence']['sources'].pop())
    rejects('selected_spec_source_target_tamper', lambda d: next(
        q for q in d['questions'] if q['id'] == 'audit-spec-WM0031')['evidence']['sources'][0].update(selected_master=alternate))
    rejects('selected_spec_preserved_rejection_omitted', lambda d: next(
        q for q in d['questions'] if q['id'] == 'audit-spec-WM0062')['evidence']['preserved_rejected_sources'].clear())
    if 'jst_confirmation_events' in bundle:
        rejects('bs_not_created_explanation_omitted', lambda d: next(
            r for r in d['coverage'] if r['ice_code'] == 'WM0070').update(bigseller_creation_status=None))
        rejects('bs_not_created_fabricated_choice', lambda d: next(
            r for r in d['coverage'] if r['ice_code'] == 'WM0072')['bigseller_selected_by_warehouse'].update(fake=['fake']))
        rejects('ignored_wm0007_disguised_as_rejected', lambda d: next(
            r for r in d['sources'] if r['candidate_id'] == 'mc-eec4d01202d4a7de').update(review_decision='reject'))
        rejects('bs_not_created_report_means_zero_inventory', lambda d: d.update(report=d['report'].replace('不表示库存为0', '表示库存为0')))
    if 'final_confirmation_events' in bundle:
        rejects('final_cleanser_resolution_reopened', lambda d: d['questions'][0].update(status='open'))
        rejects('final_cleanser_confirmation_omitted', lambda d: next(
            s for s in d['sources'] if s['candidate_id'] == 'mc-e1b56fb81b0db46c').update(batch_version_confirmation=None))
        rejects('final_cleanser_version_pending_reintroduced', lambda d: next(
            r for r in d['coverage'] if r['ice_code'] == 'WM0012')['version_review'].update(pending_records=list(PH_VN)))
        rejects('final_spec_resolution_missing', lambda d: next(
            r for r in d['coverage'] if r['ice_code'] == 'WM0130').update(specification_resolution=None))
        rejects('final_spec_wrong_c_column', lambda d: next(
            q for q in d['questions'] if q['id'] == 'audit-spec-WM0098')['resolution'].update(selected_spec='120ml/瓶'))
        rejects('final_spec_original_history_altered', lambda d: next(
            q for q in d['questions'] if q['id'] == 'audit-spec-WM0006')['previous_audit_question']['evidence'].update(master_spec_column='0'))
        rejects('final_ignored_wm0006_target_restored', lambda d: next(
            s for s in d['sources'] if s['candidate_id'] == 'mc-e78031a3b38c39f1').update(selected_master=alternate))
        rejects('final_wm0130_confirmation_removed', lambda d: next(
            s for s in d['sources'] if s['candidate_id'] == 'mc-75e0ce710d064c4c').update(review_decision=None))
        rejects('final_oil_confirmation_reverted_to_defer', lambda d: next(
            s for s in d['sources'] if s['candidate_id'] == 'mc-44b8f0236d346bc7').update(review_decision='defer'))
        rejects('final_brush_preservation_omitted', lambda d: next(
            r for r in d['coverage'] if r['ice_code'] == 'brush').update(brush_preservation=None))
        rejects('final_remaining_user_decisions_fabricated', lambda d: d['summary'].update(remaining_user_decisions=1))
        rejects('final_report_reopens_closed_specifications', lambda d: d.update(report=d['report'].replace(
            '本轮规格待复核0项、已关闭6项', '本轮规格待复核6项、已关闭0项')))
    return cases


def run(delivery, negative=False, input_pins=None):
    hashes = read(delivery / 'input-hashes.json')
    base = Path(hashes['base_directory'])
    pins = PINS
    if input_pins:
        config = read(input_pins)
        require(set(config['pins']) == set(PINS), 'new batch must pin bundle and CSV')
        pins = config['pins']
        require(hashes.get('explicit_authorization') == {'pins_file_sha256': digest(input_pins), 'config': config},
                'frozen authorization config provenance')
        require((delivery / 'inputs/audit-input-pins.frozen.json').read_bytes() == input_pins.read_bytes(),
                'frozen explicit input pins')
        decision_path = Path(config['decision_file']['path'])
        require(digest(decision_path) == config['decision_file']['sha256'], 'explicit decision file hash')
        require((delivery / 'inputs/audit-explicit-decisions.frozen.json').read_bytes() == decision_path.read_bytes(),
                'frozen explicit decision source')
        if config.get('authorization_kind') == 'final_product_decisions_v1':
            verify_final_authorized_batch(base, config, read(decision_path))
        else:
            verify_authorized_batch(base, config, read(decision_path))
    else:
        require('explicit_authorization' not in hashes, 'new batch requires an explicit --input-pins argument')
    require(hashes['pinned'] == pins, 'input pin values')
    for filename, expected in pins.items():
        require(digest(base / filename) == expected, 'approved baseline hash: ' + filename)
    require(set(hashes['all_baseline_files']) == {p.name for p in base.iterdir() if p.is_file()}, 'baseline file inventory')
    for filename, expected in hashes['all_baseline_files'].items():
        require(digest(base / filename) == expected, 'baseline file changed: ' + filename)
    for filename in FROZEN:
        require((delivery / 'inputs' / filename).read_bytes() == (base / filename).read_bytes(),
                'frozen input differs from approved baseline: ' + filename)
    bundle = read(delivery / 'inputs/match-bundle.json')
    manifest = read(delivery / 'inputs/input-manifest.json')
    require(read(delivery / 'inputs/master-overview.json') == bundle['master_provenance'], 'master baseline projection')
    require(read(delivery / 'inputs/pending-business.json') == bundle['batch_business_pending'], 'business deferrals baseline')
    original22 = read(delivery / 'inputs/current-original-22-comparison.json')
    require(len(original22) == 22, 'original 22 comparison count')
    candidates = {c['candidate_id']: c for c in bundle['candidates']}
    for entry in original22:
        require(entry['after'] == candidates[entry['candidate_id']], 'original22 entire record or JST reference changed')
        require(entry['before'] == entry['after'], 'original22 comparison is not unchanged')
    with (delivery / 'product-coverage.csv').open(encoding='utf-8-sig', newline='') as stream:
        reader = csv.DictReader(stream)
        csv_rows = list(reader)
        fields = reader.fieldnames
    data = {'coverage': read(delivery / 'product-coverage.json'),
            'sources': read(delivery / 'source-records.json'),
            'summary': read(delivery / 'coverage-summary.json'), 'csv': csv_rows, 'csv_fields': fields,
            'questions': read(delivery / 'audit-questions.json'),
            'images': read(delivery / 'image-object-evidence.json'),
            'report': (delivery / 'coverage-report.zh.md').read_text(encoding='utf-8')}
    jst_index = origin_index(base, manifest)
    image_facts = independent_image_facts(base, manifest)
    verify(data, bundle, base, manifest, jst_index, image_facts)
    output_hashes = read(delivery / 'output-hashes.json')
    require(set(output_hashes) == {p.name for p in delivery.iterdir() if p.is_file() and p.name != 'output-hashes.json'},
            'output hash manifest inventory')
    for filename, expected in output_hashes.items():
        require(digest(delivery / filename) == expected, 'output file hash: ' + filename)
    tests = self_test(data, bundle, base, manifest, jst_index, image_facts) if negative else []
    # Re-check all baseline bytes after verification, including histories,
    # corrections, prices, manual decisions and old original-22 evidence.
    require(all(digest(base / n) == h for n, h in hashes['all_baseline_files'].items()), 'baseline changed during audit')
    return {'result': 'PASS', 'baseline_pins': pins,
            'masters': len(data['coverage']), 'nonempty_unique_ice_codes': 125,
            'sources': len(data['sources']), 'coverage': data['summary']['coverage'],
            'image_objects': data['images']['summary'],
            'specification_audit_questions': data['summary']['specification_audit_questions'],
            'selected_specification_evidence_sources': sum(len(q['evidence']['sources']) for q in data['questions']
                if q['kind'] == 'selected_specification_evidence_question'),
            'preserved_rejected_specification_sources': sum(len(q['evidence']['preserved_rejected_sources'])
                for q in data['questions'] if q['kind'] == 'selected_specification_evidence_question'),
            'checks': ['all baseline file hashes and frozen input bytes',
                       'all 1417 source identities quantities targets decisions and provenance',
                       'all 126 master rows candidates gaps deferrals and price facts',
                       'all CSV fields equal JSON projections', 'summary independently recalculated',
                       'audit questions evidence and Chinese report factual summary',
                       'independent frozen OOXML image anchors relationships media bytes and all-source-row links',
                       'image evidence does not certify content or prove real absence',
                       'original22 full records/JST references unchanged',
                       'PHVN3 user-confirmed upgraded version; prior pending history retained' if
                       'final_confirmation_events' in bundle else 'PHVN3 selections version pending',
                       'WM0072 current price both histories; JST explicitly confirmed' if input_pins else
                       'WM0072 current price both histories JST unconfirmed',
                       'explicit eight-source final authorization; six specifications closed with original history; two brushes retained' if
                       'final_confirmation_events' in bundle else
                       'explicit twelve-record authorization chain and unchanged predecessor choices' if input_pins else
                       'original approved baseline pins'],
            'negative_cases': tests, 'negative_case_count': len(tests),
            'matcher_imported_or_run': False, 'files_written': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--delivery', required=True, type=Path)
    parser.add_argument('--self-test', action='store_true')
    parser.add_argument('--input-pins', type=Path, help='Explicit new-batch pins and authorization chain; default retains original approved baseline')
    args = parser.parse_args()
    print(json.dumps(run(args.delivery.resolve(), args.self_test, args.input_pins.resolve() if args.input_pins else None), ensure_ascii=False, indent=2))
