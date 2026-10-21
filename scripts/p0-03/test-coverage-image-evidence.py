"""Focused negative tests using disposable synthetic OOXML, never business files."""
from __future__ import annotations

import hashlib
import importlib.util
import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile


MODULE_PATH = Path(__file__).with_name('coverage_image_evidence.py')
SPEC = importlib.util.spec_from_file_location('coverage_image_evidence', MODULE_PATH)
images = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(images)

SHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
DRAWING_NS = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing'
ART_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main'
REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
PACKAGE_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'


def relationships(*items):
    return f'<Relationships xmlns="{PACKAGE_NS}">' + ''.join(items) + '</Relationships>'


def relationship(rid, kind, target):
    return f'<Relationship Id="{rid}" Type="{REL_NS}/{kind}" Target="{target}"/>'


def anchor(row):
    return (
        '<xdr:twoCellAnchor>'
        f'<xdr:from><xdr:col>5</xdr:col><xdr:row>{row - 1}</xdr:row></xdr:from>'
        f'<xdr:to><xdr:col>6</xdr:col><xdr:row>{row}</xdr:row></xdr:to>'
        '<xdr:pic><xdr:blipFill><a:blip r:embed="imageRel"/></xdr:blipFill></xdr:pic>'
        '</xdr:twoCellAnchor>'
    )


def fixture(folder, *, anchor_rows=(5,), include_media=True, include_image_rel=True,
            include_drawing_rel=True, include_sheet_rel=True, malformed_drawing=False):
    """Make a minimal package with dummy media bytes, not an extracted picture."""
    path = folder / 'synthetic-master.xlsx'
    drawing_link = '<drawing r:id="drawingRel"/>' if anchor_rows is not None else ''
    sheet = (
        f'<worksheet xmlns="{SHEET_NS}" xmlns:r="{REL_NS}"><sheetData>'
        '<row r="1"><c r="F1" t="inlineStr"><is><t>产品图片</t></is></c></row>'
        '<row r="5"><c r="F5"/></row><row r="9"><c r="F9"/></row>'
        f'</sheetData>{drawing_link}</worksheet>'
    )
    drawing = (
        f'<xdr:wsDr xmlns:xdr="{DRAWING_NS}" xmlns:a="{ART_NS}" xmlns:r="{REL_NS}">'
        + ''.join(anchor(row) for row in (anchor_rows or ())) + '</xdr:wsDr>'
    )
    parts = {
        'xl/workbook.xml': f'<workbook xmlns="{SHEET_NS}" xmlns:r="{REL_NS}"><sheets><sheet name="商品库" sheetId="1" r:id="sheetRel"/></sheets></workbook>',
        'xl/_rels/workbook.xml.rels': relationships(*(
            [relationship('sheetRel', 'worksheet', 'worksheets/sheet1.xml')] if include_sheet_rel else [])),
        'xl/worksheets/sheet1.xml': sheet,
        'xl/worksheets/_rels/sheet1.xml.rels': relationships(*(
            [relationship('drawingRel', 'drawing', '../drawings/drawing1.xml')] if include_drawing_rel else [])),
        'xl/drawings/drawing1.xml': '<broken' if malformed_drawing else drawing,
        'xl/drawings/_rels/drawing1.xml.rels': relationships(*(
            [relationship('imageRel', 'image', '../media/dummy.png')] if include_image_rel else [])),
    }
    with ZipFile(path, 'w') as archive:
        for part, value in parts.items():
            archive.writestr(part, value)
        if include_media:
            archive.writestr('xl/media/dummy.png', b'synthetic fixture bytes; not a picture')
    manifest = {'original_input_hashes': {'master': {
        'path': r'C:\synthetic-only\master.xlsx', 'frozen': path.name,
        'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
    }}}
    master = {'row_index': 5, 'ice_code': 'TEST0001', 'primary_row': 5,
              'source_rows': [5, 9], 'data': {'产品图片': ''}}
    return manifest, [master]


class ImageObjectEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='iceos-image-evidence-test-')
        self.addCleanup(self.temporary.cleanup)
        self.folder = Path(self.temporary.name)

    def inspect(self, **options):
        manifest, masters = fixture(self.folder, **options)
        return images.inspect_images(self.folder, manifest, masters)

    def assertUnknown(self, result, reason):
        item = result['masters'][0]
        self.assertEqual(item['object_status'], 'unknown')
        self.assertFalse(item['content_verified'])
        self.assertTrue(any(reason in value for value in item['unresolved_reasons']), item)

    def test_blank_cell_with_embedded_object_is_found_without_content_verification(self):
        result = self.inspect()
        item = result['masters'][0]
        self.assertTrue(item['cell_value_empty'])
        self.assertEqual(item['object_status'], 'found')
        self.assertFalse(item['content_verified'])
        found = result['anchors'][0]
        self.assertEqual((found['from']['row'], found['from']['column']), (5, 6))
        self.assertEqual((found['from']['row_raw0'], found['from']['column_raw0']), (4, 5))
        self.assertEqual((found['to']['row'], found['to']['column']), (6, 7))
        self.assertEqual(found['media_zip_member'], 'xl/media/dummy.png')
        self.assertEqual(found['media_bytes'], len(b'synthetic fixture bytes; not a picture'))

    def test_secondary_source_row_is_considered_even_without_primary_row_object(self):
        result = self.inspect(anchor_rows=(9,))
        item = result['masters'][0]
        self.assertEqual(item['source_rows_considered'], [5, 9])
        self.assertEqual(item['object_status'], 'found')
        self.assertEqual(len(item['anchor_ids']), 1)
        self.assertEqual(result['anchors'][0]['from']['row'], 9)

    def test_two_source_row_objects_cover_one_master_and_have_unique_ids(self):
        result = self.inspect(anchor_rows=(5, 9))
        self.assertEqual(result['summary']['anchor_count'], 2)
        self.assertEqual(result['summary']['master_object_status_counts'], {'found': 1})
        self.assertEqual(len(result['masters']), 1)
        self.assertEqual(len(set(result['masters'][0]['anchor_ids'])), 2)

    def test_no_object_means_not_found_without_proving_no_picture(self):
        result = self.inspect(anchor_rows=None)
        item = result['masters'][0]
        self.assertEqual(item['object_status'], 'no_found')
        self.assertFalse(item['content_verified'])
        self.assertEqual(item['anchor_ids'], [])
        self.assertIn('不证明商品无图片', item['meaning'])

    def test_missing_embed_relationship_is_unknown_with_reason(self):
        self.assertUnknown(self.inspect(include_image_rel=False), 'embed_relationship_missing')

    def test_missing_media_target_is_unknown_with_reason(self):
        result = self.inspect(include_media=False)
        self.assertUnknown(result, 'image_media_missing')
        self.assertFalse(result['anchors'][0]['media_exists'])

    def test_unresolvable_sheet_drawing_relation_is_unknown(self):
        self.assertUnknown(self.inspect(include_drawing_rel=False), 'sheet_drawing_relationship_invalid')

    def test_unresolvable_workbook_sheet_relation_is_unknown(self):
        self.assertUnknown(self.inspect(include_sheet_rel=False), 'master_worksheet_relationship_invalid')

    def test_malformed_drawing_is_unknown_instead_of_no_found(self):
        self.assertUnknown(self.inspect(malformed_drawing=True), 'xml_unreadable:xl/drawings/drawing1.xml')

    def test_wrong_input_hash_is_rejected(self):
        manifest, masters = fixture(self.folder)
        manifest['original_input_hashes']['master']['sha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'master_sha256_mismatch'):
            images.inspect_images(self.folder, manifest, masters)


if __name__ == '__main__':
    unittest.main(verbosity=2)
