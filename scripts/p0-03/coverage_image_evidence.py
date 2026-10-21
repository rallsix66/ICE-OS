"""Read-only OOXML image-object evidence for the frozen product master.

This module neither extracts media nor renders/verifies picture content.  A found
object proves only a row anchor, image relationship and existing ZIP member.
"""
from __future__ import annotations

import hashlib
import posixpath
import re
from collections import Counter
from pathlib import Path, PurePosixPath, PureWindowsPath
from urllib.parse import unquote, urlsplit
from xml.etree import ElementTree as ET
from zipfile import BadZipFile, ZipFile


IMAGE_HEADER = '产品图片'
MEANINGS = {
    'found': '发现嵌入图片对象及对应媒体文件；未展示图片，未核验内容是否正确',
    'no_found': '在所核查全部原始来源行未找到可关联的嵌入图片对象；不证明商品无图片',
    'unknown': '图片对象关系无法完整解析或来源行关联不明确；不能判为无图',
}
REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'


def _local(tag):
    return tag.rsplit('}', 1)[-1]


def _rel_id(element, name='id'):
    return element.attrib.get(f'{{{REL_NS}}}{name}')


def _unique(values):
    return list(dict.fromkeys(values))


def _member(part, target):
    """Resolve an internal relationship URI without allowing package escape."""
    if not target or '\\' in target:
        raise ValueError('empty_or_invalid_relationship_target')
    uri = urlsplit(target)
    if uri.scheme or uri.netloc or uri.query or uri.fragment:
        raise ValueError('non_package_relationship_target')
    path = unquote(uri.path)
    member = posixpath.normpath(path.lstrip('/') if path.startswith('/')
                               else posixpath.join(posixpath.dirname(part), path))
    if member in ('', '.', '..') or member.startswith('../'):
        raise ValueError('relationship_target_escapes_package')
    return member


def _rels_part(part):
    p = PurePosixPath(part)
    return str(p.parent / '_rels' / (p.name + '.rels'))


def _xml(archive, member, reasons):
    try:
        return ET.fromstring(archive.read(member))
    except (KeyError, ET.ParseError, OSError, RuntimeError, BadZipFile) as error:
        reasons.append(f'xml_unreadable:{member}:{type(error).__name__}')
        return None


def _relationships(archive, part, reasons):
    root = _xml(archive, _rels_part(part), reasons)
    result = {}
    if root is not None:
        for item in root:
            if _local(item.tag) != 'Relationship':
                continue
            rid = item.attrib.get('Id')
            if not rid or rid in result:
                reasons.append(f'invalid_or_duplicate_relationship_id:{part}:{rid}')
                continue
            result[rid] = dict(item.attrib)
    return result


def _position(anchor, name, reasons):
    node = next((c for c in anchor if _local(c.tag) == name), None)
    if node is None:
        reasons.append(f'anchor_{name}_missing')
        return None
    values = {_local(c.tag): c.text for c in node}
    try:
        row, column = int(values['row']), int(values['col'])
        if row < 0 or column < 0:
            raise ValueError('negative_cell_coordinate')
        return {
            'row': row + 1, 'column': column + 1,
            'row_raw0': row, 'column_raw0': column,
            'row_offset_emu': int(values.get('rowOff', '0')),
            'column_offset_emu': int(values.get('colOff', '0')),
        }
    except (KeyError, TypeError, ValueError):
        reasons.append(f'anchor_{name}_coordinate_unreadable')
        return None


def _media(archive, members, drawing_part, embed, relationships):
    reasons = []
    result = {
        'embed_relationship_id': embed, 'media_target': None,
        'media_zip_member': None, 'media_exists': None,
        'media_sha256': None, 'media_bytes': None,
    }
    rel = relationships.get(embed)
    if not rel:
        reasons.append(f'embed_relationship_missing:{embed}')
    else:
        result['media_target'] = rel.get('Target')
        if rel.get('TargetMode', '').lower() == 'external':
            reasons.append(f'external_image_relationship:{embed}')
        elif not rel.get('Type', '').endswith('/image'):
            reasons.append(f'embed_relationship_not_image:{embed}')
        else:
            try:
                member = _member(drawing_part, rel.get('Target'))
                result['media_zip_member'] = member
                result['media_exists'] = member in members
                if member not in members:
                    reasons.append(f'image_media_missing:{member}')
                else:
                    data = archive.read(member)
                    result['media_bytes'] = len(data)
                    result['media_sha256'] = hashlib.sha256(data).hexdigest()
            except (ValueError, KeyError, OSError, RuntimeError, BadZipFile) as error:
                reasons.append(f'image_media_unreadable:{embed}:{type(error).__name__}')
    result['parse_status'] = 'unknown' if reasons else 'parsed'
    result['unresolved_reasons'] = reasons
    return result


def _sheet_image_cells(archive, sheet, workbook, reasons):
    """Keep the original image-column cell values separate from drawing objects."""
    strings = []
    if 'xl/sharedStrings.xml' in archive.namelist():
        root = _xml(archive, 'xl/sharedStrings.xml', reasons)
        if root is not None:
            strings = [''.join(node.itertext()) for node in root if _local(node.tag) == 'si']

    def value(cell):
        kind = cell.attrib.get('t')
        node = next((c for c in cell if _local(c.tag) in ('v', 'is')), None)
        text = ''.join(node.itertext()) if node is not None else ''
        if kind == 's':
            try:
                return strings[int(text)]
            except (IndexError, ValueError):
                reasons.append(f'cell_shared_string_unreadable:{cell.attrib.get("r")}')
                return None
        return text

    cells = {cell.attrib.get('r'): cell for cell in sheet.iter() if _local(cell.tag) == 'c'}
    header_columns = []
    for address, cell in cells.items():
        if address and re.fullmatch(r'[A-Z]+1', address) and value(cell) == IMAGE_HEADER:
            header_columns.append(address[:-1])
    if len(header_columns) != 1:
        reasons.append(f'image_cell_header_not_unique:{len(header_columns)}')
        return {}
    column = header_columns[0]
    workbook['image_cell_column'] = column
    result = {}
    for address, cell in cells.items():
        if address and re.fullmatch(re.escape(column) + r'\d+', address):
            result[int(address[len(column):])] = value(cell)
    return result


def inspect_images(base: Path, manifest: dict, masters: list) -> dict:
    """Inspect the strictly hashed frozen master, linking every source row.

    Hash/path failures reject the input. XML/object failures remain explicit
    unknown evidence; they must not be presented as an absence of pictures.
    """
    source = manifest['original_input_hashes']['master']
    expected = str(source.get('sha256', '')).lower()
    if not re.fullmatch(r'[0-9a-f]{64}', expected):
        raise ValueError('master_sha256_missing_or_invalid')
    base = Path(base).resolve()
    path = (base / source['frozen']).resolve()
    if not path.is_relative_to(base) or not path.is_file():
        raise ValueError('master_frozen_file_missing_or_outside_baseline')
    actual = hashlib.sha256(path.read_bytes()).hexdigest()
    if actual != expected:
        raise ValueError('master_sha256_mismatch')

    workbook = {
        'original_file': PureWindowsPath(source['path']).name,
        'original_path': source['path'], 'frozen_path': str(path), 'sha256': actual,
        'worksheet': None, 'worksheet_part': None, 'worksheet_relationship_id': None,
        'image_cell_header': IMAGE_HEADER, 'image_cell_column': None,
        'parse_status': 'parsed', 'unresolved_reasons': [],
        'scope': '冻结主库首个工作表的DrawingML锚点及嵌入图片关系；不提取展示或核验图片内容',
    }
    reasons = workbook['unresolved_reasons']
    anchors = []
    raw_cells = {}
    unlocated_reasons = []
    try:
        with ZipFile(path) as archive:
            members = set(archive.namelist())
            book = _xml(archive, 'xl/workbook.xml', reasons)
            sheet_entry = next((n for n in book.iter() if _local(n.tag) == 'sheet'), None) if book is not None else None
            rels = _relationships(archive, 'xl/workbook.xml', reasons)
            if sheet_entry is None:
                reasons.append('master_worksheet_missing')
            else:
                workbook['worksheet'] = sheet_entry.attrib.get('name')
                rid = _rel_id(sheet_entry)
                workbook['worksheet_relationship_id'] = rid
                sheet_rel = rels.get(rid)
                if not sheet_rel or not sheet_rel.get('Type', '').endswith('/worksheet'):
                    reasons.append(f'master_worksheet_relationship_invalid:{rid}')
                elif sheet_rel.get('TargetMode', '').lower() == 'external':
                    reasons.append(f'master_worksheet_relationship_external:{rid}')
                else:
                    try:
                        workbook['worksheet_part'] = _member('xl/workbook.xml', sheet_rel.get('Target'))
                    except ValueError as error:
                        reasons.append(f'master_worksheet_target_invalid:{error}')
            sheet_part = workbook['worksheet_part']
            sheet = _xml(archive, sheet_part, reasons) if sheet_part else None
            if sheet is not None:
                raw_cells = _sheet_image_cells(archive, sheet, workbook, reasons)
                drawings = [n for n in sheet.iter() if _local(n.tag) == 'drawing']
                if any(_local(n.tag) in ('legacyDrawing', 'legacyDrawingHF', 'drawingHF') for n in sheet.iter()):
                    reasons.append('unsupported_legacy_or_header_drawing')
                sheet_rels = _relationships(archive, sheet_part, reasons) if drawings else {}
                for drawing_node in drawings:
                    sheet_rid = _rel_id(drawing_node)
                    sheet_link = sheet_rels.get(sheet_rid)
                    drawing_part = None
                    if not sheet_link or not sheet_link.get('Type', '').endswith('/drawing'):
                        reasons.append(f'sheet_drawing_relationship_invalid:{sheet_rid}')
                        continue
                    if sheet_link.get('TargetMode', '').lower() == 'external':
                        reasons.append(f'sheet_drawing_relationship_external:{sheet_rid}')
                        continue
                    try:
                        drawing_part = _member(sheet_part, sheet_link.get('Target'))
                    except ValueError as error:
                        reasons.append(f'sheet_drawing_target_invalid:{sheet_rid}:{error}')
                        continue
                    drawing = _xml(archive, drawing_part, reasons)
                    if drawing is None:
                        continue
                    drawing_reasons = []
                    image_rels = _relationships(archive, drawing_part, drawing_reasons)
                    for index, anchor in enumerate(drawing, 1):
                        anchor_type = _local(anchor.tag)
                        if anchor_type not in ('twoCellAnchor', 'oneCellAnchor', 'absoluteAnchor'):
                            reasons.append(f'unsupported_drawing_node:{drawing_part}:{anchor_type}')
                            continue
                        local_reasons = list(drawing_reasons)
                        start = _position(anchor, 'from', local_reasons) if anchor_type != 'absoluteAnchor' else None
                        end = _position(anchor, 'to', local_reasons) if anchor_type == 'twoCellAnchor' else None
                        if anchor_type == 'absoluteAnchor':
                            local_reasons.append('absolute_anchor_has_no_source_row')
                        embeds = [_rel_id(n, 'embed') for n in anchor.iter()
                                  if _local(n.tag) == 'blip' and _rel_id(n, 'embed')]
                        if not embeds:
                            local_reasons.append('anchor_has_no_embedded_image_relationship')
                        media_refs = [_media(archive, members, drawing_part, embed, image_rels) for embed in embeds]
                        for media in media_refs:
                            local_reasons.extend(media['unresolved_reasons'])
                        if len(media_refs) > 1:
                            local_reasons.append('multiple_embedded_images_in_anchor')
                        single = media_refs[0] if len(media_refs) == 1 else {}
                        item = {
                            'anchor_id': f'image-anchor-{len(anchors) + 1:04d}',
                            'worksheet': workbook['worksheet'], 'worksheet_part': sheet_part,
                            'sheet_drawing_relationship_id': sheet_rid,
                            'drawing_part': drawing_part, 'anchor_index': index,
                            'anchor_type': anchor_type, 'from': start, 'to': end,
                            **{key: single.get(key) for key in (
                                'embed_relationship_id', 'media_target', 'media_zip_member',
                                'media_exists', 'media_sha256', 'media_bytes')},
                            'media_refs': media_refs, 'parse_status': 'unknown' if local_reasons else 'parsed',
                            'unresolved_reasons': _unique(local_reasons),
                        }
                        anchors.append(item)
                        if start is None:
                            unlocated_reasons.extend(f'{item["anchor_id"]}:{r}' for r in local_reasons)
    except (BadZipFile, OSError, RuntimeError) as error:
        reasons.append(f'workbook_package_unreadable:{type(error).__name__}')

    reasons[:] = _unique(reasons)
    workbook['parse_status'] = 'unknown' if reasons or any(a['parse_status'] == 'unknown' for a in anchors) else 'parsed'
    master_evidence = []
    for master in masters:
        source_rows = sorted(set(int(n) for n in master['source_rows']))
        matched = [a for a in anchors if a['from'] and a['from']['row'] in source_rows]
        found = any(any(m['media_exists'] is True and m['parse_status'] == 'parsed'
                        for m in a['media_refs']) for a in matched)
        unknowns = list(reasons) + list(unlocated_reasons)
        unknowns.extend(f'{a["anchor_id"]}:{r}' for a in matched for r in a['unresolved_reasons'])
        unknowns = _unique(unknowns)
        status = 'found' if found else 'unknown' if unknowns else 'no_found'
        cell_value = master['data'].get(IMAGE_HEADER)
        master_evidence.append({
            'master_anchor_row': master['row_index'], 'ice_code': master['ice_code'],
            'cell_value_empty': cell_value is None or str(cell_value).strip() == '',
            'cell_value': cell_value, 'source_rows_considered': source_rows,
            'cell_values_by_source_row': {str(n): raw_cells.get(n, '' if workbook['image_cell_column'] else None)
                                        for n in source_rows},
            'anchor_ids': [a['anchor_id'] for a in matched], 'object_status': status,
            'content_verified': False, 'unresolved_reasons': unknowns, 'meaning': MEANINGS[status],
        })
    summary = {
        'anchor_count': len(anchors),
        'anchor_parse_status_counts': dict(Counter(a['parse_status'] for a in anchors)),
        'master_count': len(master_evidence),
        'master_object_status_counts': dict(Counter(m['object_status'] for m in master_evidence)),
        'master_image_cell_empty_count': sum(m['cell_value_empty'] for m in master_evidence),
        'content_verified_count': sum(m['content_verified'] for m in master_evidence),
    }
    return {'workbook': workbook, 'anchors': anchors, 'masters': master_evidence, 'summary': summary}
