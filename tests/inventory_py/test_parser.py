"""Strict parser tests (repair v2 / R3): exact headers, file validation, discovery."""
from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

import parser as inventory_parser

from fakes import (
    DEFAULT_DISCOVERY,
    REAL_HEADER,
    REAL_ROWS,
    STANDARD_HEADER,
    WH_A,
    WH_B,
    WH_EXCLUDED,
    corrupt_dimension,
    write_workbook,
)

MIN_HEADER = ['SKU编号', '仓库', '现有库存', '订单已锁', '整仓可用', '在途中']


def build(tmp_path: Path, header: list, rows: list[list], **kwargs) -> Path:
    return write_workbook(tmp_path / 'export.xlsx', header, rows, **kwargs)


def parse(path: Path, **kwargs):
    kwargs.setdefault('warehouse_discovery', DEFAULT_DISCOVERY)
    return inventory_parser.parse_export_file(path, **kwargs)


def test_standard_header_by_exact_alias_and_reordered_columns(tmp_path):
    parsed = parse(build(tmp_path, STANDARD_HEADER, [
        ['6974674958025', '测试商品A', WH_A['name'], '3,793', '12', '3 781', '0', 'MYR 12.30', 'WM0043'],
    ]))

    assert parsed['file']['rowCount'] == 1
    assert parsed['fileValidation']['status'] == 'ok'
    assert parsed['fileValidation']['quantityHeader'] == {
        'on_hand': '现有库存', 'order_locked': '订单已锁',
        'warehouse_available': '整仓可用', 'in_transit': '在途中',
    }
    row = parsed['rows'][0]
    assert row['externalSku'] == 'WM0043'
    assert row['warehouseExternalId'] == WH_A['externalId']
    assert row['warehouseName'] == WH_A['name']
    assert row['onHandText'] == '3,793'
    assert row['orderLockedText'] == '12'
    assert row['warehouseAvailableText'] == '3 781'
    assert row['inTransitText'] == '0'
    assert row['totalCostText'] == 'MYR 12.30'
    assert row['parseStatus'] == 'ok'
    assert row['rowHash']
    assert parsed['headerMapping']['on_hand'] == '现有库存'


def test_legacy_column_names_are_exact_aliases(tmp_path):
    header = ['SKU信息', '仓库', '当前库存', '锁定库存', '可用库存', '在途库存', '成本']
    rows = [['WM0001', WH_A['name'], '1,234', '5', '1,229', '7', '12.00']]
    parsed = parse(build(tmp_path, header, rows))

    row = parsed['rows'][0]
    assert row['onHandText'] == '1,234'
    assert row['orderLockedText'] == '5'
    assert row['warehouseAvailableText'] == '1,229'
    assert row['inTransitText'] == '7'
    assert row['totalCostText'] == '12.00'
    assert row['parseStatus'] == 'ok'


def test_header_row_after_title_rows(tmp_path):
    rows = [['WM0002', WH_A['name'], '3', '0', '3', '0']]
    path = build(tmp_path, MIN_HEADER, rows,
                 title_rows=[['BigSeller 全仓单SKU库存'], ['导出时间 2026-10-25'], []])
    parsed = parse(path)

    assert parsed['headerRow'] == 4
    assert parsed['rows'][0]['excelRow'] == 5


def test_empty_vs_zero_vs_thousands_and_dash(tmp_path):
    rows = [
        ['WM-EMPTY', WH_A['name'], '', None, '  ', None],
        ['WM-ZERO', WH_A['name'], '0', '0.0', '0', '0'],
        ['WM-THOUSANDS', WH_A['name'], '3,793', '1 234', '2，500', '10 000'],
        ['WM-DASH', WH_A['name'], '--', '-', '—', None],
    ]
    parsed = parse(build(tmp_path, MIN_HEADER, rows))
    by_sku = {row['externalSku']: row for row in parsed['rows']}

    assert by_sku['WM-EMPTY']['onHandText'] is None
    assert inventory_parser.parse_quantity(by_sku['WM-EMPTY']['onHandText']) == (None, None)
    assert by_sku['WM-ZERO']['onHandText'] == '0'
    assert inventory_parser.parse_quantity(by_sku['WM-ZERO']['orderLockedText']) == (0, None)
    assert inventory_parser.parse_quantity(by_sku['WM-THOUSANDS']['onHandText']) == (3793, None)
    assert inventory_parser.parse_quantity(
        by_sku['WM-THOUSANDS']['warehouseAvailableText']) == (2500, None)
    assert inventory_parser.parse_quantity(by_sku['WM-DASH']['onHandText']) == (None, None)
    assert inventory_parser.parse_quantity(by_sku['WM-DASH']['orderLockedText']) == (None, None)


def test_numeric_cells_are_text_normalised(tmp_path):
    rows = [[780103214060, WH_A['name'], 3793, 12, 3781, 0]]
    parsed = parse(build(tmp_path, MIN_HEADER, rows))
    row = parsed['rows'][0]

    assert row['externalSku'] == '780103214060'
    assert row['onHandText'] == '3793'
    assert inventory_parser.parse_quantity(row['onHandText']) == (3793, None)


def test_invalid_quantity_marks_row(tmp_path):
    rows = [
        ['WM-BAD', WH_A['name'], 'abc', '2', '2', '0'],
        ['WM-FRACTION', WH_A['name'], '3.5', '2', '2', '0'],
    ]
    parsed = parse(build(tmp_path, MIN_HEADER, rows))
    for row in parsed['rows']:
        assert row['parseStatus'] == 'invalid_quantity'
        assert '现有库存' in (row['reason'] or '')


def test_missing_warehouse_and_missing_sku(tmp_path):
    rows = [
        ['', WH_A['name'], '1', '0', '1', '0'],
        ['WM-NOWH', '', '1', '0', '1', '0'],
        ['WM-OK', WH_A['name'], '1', '0', '1', '0'],
    ]
    parsed = parse(build(tmp_path, MIN_HEADER, rows))
    by_status = {row['parseStatus']: row for row in parsed['rows']}

    assert by_status['missing_sku']['externalSku'] is None
    assert by_status['missing_warehouse']['warehouseName'] is None
    assert by_status['ok']['externalSku'] == 'WM-OK'
    assert parsed['fileValidation']['status'] == 'blocked'
    assert parsed['fileValidation']['unattributableRowCount'] == 1


def test_unknown_warehouse_name_blocks_file(tmp_path):
    rows = [['WM-UNKNOWN', '不存在的仓库', '1', '0', '1', '0']]
    parsed = parse(build(tmp_path, MIN_HEADER, rows))

    assert parsed['rows'][0]['parseStatus'] == 'missing_warehouse'
    assert parsed['fileValidation']['status'] == 'blocked'
    assert '不在本次导出发现中' in (parsed['rows'][0]['reason'] or '')


def test_excluded_warehouse_rows_are_attributed_not_blocked(tmp_path):
    rows = [['WM-EXCLUDED', WH_EXCLUDED['name'], '9', '0', '9', '0']]
    parsed = parse(build(tmp_path, MIN_HEADER, rows))

    row = parsed['rows'][0]
    assert row['parseStatus'] == 'ok'
    assert row['warehouseExternalId'] == WH_EXCLUDED['externalId']
    assert parsed['fileValidation']['status'] == 'ok'


def test_duplicate_discovery_names_are_unattributable(tmp_path):
    duplicate_discovery = list(DEFAULT_DISCOVERY) + [
        {'externalId': '99999', 'name': WH_A['name']},
    ]
    rows = [['WM-DUPNAME', WH_A['name'], '1', '0', '1', '0']]
    parsed = inventory_parser.parse_export_file(
        build(tmp_path, MIN_HEADER, rows), warehouse_discovery=duplicate_discovery)

    assert parsed['rows'][0]['parseStatus'] == 'missing_warehouse'
    assert parsed['fileValidation']['status'] == 'blocked'


def test_combo_sku_type_blocks_whole_file(tmp_path):
    combo = list(REAL_ROWS[0])
    combo[1] = 'SKU-COMBO'
    combo[26] = 'Combo SKU'
    parsed = inventory_parser.parse_export_file(
        build(tmp_path, REAL_HEADER, [combo, list(REAL_ROWS[1])]),
        warehouse_discovery=DEFAULT_DISCOVERY)

    combo_row = [row for row in parsed['rows'] if row['externalSku'] == 'SKU-COMBO'][0]
    assert combo_row['parseStatus'] == 'combo_sku'
    assert parsed['fileValidation']['status'] == 'blocked'
    assert parsed['fileValidation']['blocked'] is True
    assert parsed['fileValidation']['comboRowCount'] == 1
    assert '组合' in parsed['fileValidation']['reason']


def test_combo_type_is_recognised_from_product_type(tmp_path):
    header = ['SKU编号', '仓库', '现有库存', '订单已锁', '整仓可用', '在途中', '商品类型']
    rows = [['WM-COMBO', WH_A['name'], '1', '0', '1', '0', '组合装']]
    parsed = parse(build(tmp_path, header, rows))
    assert parsed['rows'][0]['parseStatus'] == 'combo_sku'
    assert parsed['fileValidation']['status'] == 'blocked'


def test_duplicate_sku_marked_not_summed(tmp_path):
    rows = [
        ['WM-DUP', WH_A['name'], '10', '0', '10', '0'],
        ['WM-DUP', WH_A['name'], '20', '0', '20', '0'],
        ['WM-DUP', WH_B['name'], '5', '0', '5', '0'],
    ]
    parsed = parse(build(tmp_path, MIN_HEADER, rows))
    statuses = [row['parseStatus'] for row in parsed['rows']]

    assert statuses == ['duplicate_sku', 'duplicate_sku', 'ok']
    assert '重复' in (parsed['rows'][0]['reason'] or '')


def test_blank_rows_only_counted(tmp_path):
    rows = [
        ['WM-1', WH_A['name'], '1', '0', '1', '0'],
        [None, None, None, None, None, None],
        ['', ' ', '', '', '', ''],
        ['WM-2', WH_A['name'], '2', '0', '2', '0'],
    ]
    parsed = parse(build(tmp_path, MIN_HEADER, rows))

    assert parsed['file']['rowCount'] == 2
    assert parsed['file']['blankRowCount'] == 2
    assert [row['excelRow'] for row in parsed['rows']] == [2, 5]


def test_amount_columns_isolated_from_quantities(tmp_path):
    parsed = parse(build(tmp_path, STANDARD_HEADER, [
        ['6974674958025', '测试商品A', WH_A['name'], '3,793', '12', '3 781', '0', 'MYR 12.30', 'WM0043'],
    ]))
    row = parsed['rows'][0]

    assert row['totalCostText'] == 'MYR 12.30'
    for key, value in row.items():
        if key == 'totalCostText':
            continue
        assert '12.30' not in str(value), f'amount leaked into {key}'


def test_amount_header_with_inventory_words_is_not_on_hand(tmp_path):
    """'现有库存总成本' must not satisfy the on_hand column (no substring matching)."""
    header = ['SKU编号', '仓库', '现有库存总成本', '订单已锁', '整仓可用', '在途中']
    rows = [['WM-AMT', WH_A['name'], '123.45', '0', '1', '0']]
    with pytest.raises(inventory_parser.ParseError) as excinfo:
        parse(build(tmp_path, header, rows))
    assert excinfo.value.code == 'HEADER_INVALID'
    assert '现有库存' in excinfo.value.detail


def test_duplicate_required_header_rejected(tmp_path):
    header = ['SKU编号', '仓库', '现有库存', '订单已锁', '整仓可用', '在途中', '现有库存']
    with pytest.raises(inventory_parser.ParseError) as excinfo:
        parse(build(tmp_path, header, [['WM-1', WH_A['name'], '1', '0', '1', '0', '9']]))
    assert excinfo.value.code == 'HEADER_INVALID'
    assert '重名' in excinfo.value.detail or '歧义' in excinfo.value.detail


def test_ambiguous_synonym_headers_rejected(tmp_path):
    header = ['SKU编号', 'SKU信息', '仓库', '现有库存', '订单已锁', '整仓可用', '在途中']
    with pytest.raises(inventory_parser.ParseError) as excinfo:
        parse(build(tmp_path, header, [['WM-1', 'WM-1', WH_A['name'], '1', '0', '1', '0']]))
    assert excinfo.value.code == 'HEADER_INVALID'
    assert '歧义' in excinfo.value.detail


def test_missing_required_header_rejected(tmp_path):
    header = ['SKU编号', '仓库', '现有库存', '订单已锁', '整仓可用']  # 在途中 missing
    with pytest.raises(inventory_parser.ParseError) as excinfo:
        parse(build(tmp_path, header, [['WM-1', WH_A['name'], '1', '0', '1']]))
    assert excinfo.value.code == 'HEADER_INVALID'
    assert '在途中' in excinfo.value.detail


def test_real_2026_10_header_with_wrong_dimension_reads_all_columns(tmp_path):
    path = write_workbook(tmp_path / 'real.xlsx', REAL_HEADER, REAL_ROWS)
    corrupt_dimension(path)
    parsed = inventory_parser.parse_export_file(path, warehouse_discovery=DEFAULT_DISCOVERY)

    assert [item['name'] for item in parsed['file']['header']] == REAL_HEADER
    assert parsed['file']['rowCount'] == 2
    first, second = parsed['rows']
    assert first['externalSku'] == '780103214060'
    assert first['productName'] == '测试商品A'
    assert first['warehouseExternalId'] == WH_A['externalId']
    assert inventory_parser.parse_quantity(first['onHandText']) == (3793, None)
    assert inventory_parser.parse_quantity(first['warehouseAvailableText']) == (0, None)
    assert first['totalCostText'] == 'MYR 12.30'
    assert first['parseStatus'] == 'ok'
    assert second['totalCostText'] == '0.50'
    for row in parsed['rows']:
        for key, value in row.items():
            if key == 'totalCostText':
                continue
            for amount in ('12.30', '0.50', '1.23'):
                assert amount not in str(value)


def test_gtin_kept_as_string_with_leading_zeros(tmp_path):
    header = MIN_HEADER + ['GTIN']
    rows = [
        ['WM-GTIN', WH_A['name'], '1', '0', '1', '0', '0006974674958025'],
        ['WM-NOGTIN', WH_A['name'], '1', '0', '1', '0', ''],
    ]
    parsed = parse(build(tmp_path, header, rows))
    assert parsed['rows'][0]['gtin'] == '0006974674958025'
    assert parsed['rows'][1]['gtin'] is None


def test_sku_keeps_leading_zero_and_numeric_string(tmp_path):
    rows = [
        ['000123', WH_A['name'], '1', '0', '1', '0'],
        [780103214220, WH_A['name'], '1', '0', '1', '0'],
    ]
    parsed = parse(build(tmp_path, MIN_HEADER, rows))
    assert [row['externalSku'] for row in parsed['rows']] == ['000123', '780103214220']


def test_explicit_sku_code_column_keeps_internal_spaces(tmp_path):
    """R2：明确 SKU编号 列是完整标识，不按空格/标点分词截断（真实 clean brush 样本）。"""
    rows = [
        ['clean brush', WH_A['name'], '0', '0', '0', '0'],
        ['AB 12,CD;E', WH_A['name'], '1', '0', '1', '0'],
        [' 000 123 ', WH_A['name'], '1', '0', '1', '0'],
    ]
    parsed = parse(build(tmp_path, MIN_HEADER, rows))
    assert [row['externalSku'] for row in parsed['rows']] == ['clean brush', 'AB 12,CD;E', '000 123']


def test_legacy_mixed_sku_info_column_still_parses_tokens(tmp_path):
    """旧混合 SKU信息 列保留原分词兼容；只对明确 SKU编号 列改为原字符串。"""
    header = ['SKU信息', '仓库', '当前库存', '锁定库存', '可用库存', '在途库存']
    rows = [['WM-LEGACY 黑色 M', WH_A['name'], '1', '0', '1', '0']]
    parsed = parse(build(tmp_path, header, rows))
    assert parsed['rows'][0]['externalSku'] == 'WM-LEGACY'


def test_row_hash_stable_and_content_sensitive(tmp_path):
    first = parse(build(tmp_path / 'a', MIN_HEADER,
                        [['WM-H', WH_A['name'], '1', '0', '1', '0']]))['rows'][0]['rowHash']
    second = parse(build(tmp_path / 'b', MIN_HEADER,
                         [['WM-H', WH_A['name'], '1', '0', '1', '0']]))['rows'][0]['rowHash']
    changed = parse(build(tmp_path / 'c', MIN_HEADER,
                          [['WM-H', WH_A['name'], '2', '0', '2', '0']]))['rows'][0]['rowHash']
    assert first == second
    assert first != changed


def test_reparse_with_same_discovery_reproduces_hash(tmp_path):
    path = build(tmp_path, MIN_HEADER, [['WM-H', WH_A['name'], '1', '0', '1', '0']])
    assert parse(path)['rows'][0]['rowHash'] == parse(path)['rows'][0]['rowHash']


def test_parse_requires_warehouse_discovery(tmp_path):
    path = build(tmp_path, MIN_HEADER, [['WM-1', WH_A['name'], '1', '0', '1', '0']])
    with pytest.raises(inventory_parser.ParseError) as excinfo:
        inventory_parser.parse_export_file(path)
    assert excinfo.value.code == 'INVENTORY_WAREHOUSE_DISCOVERY_MISSING'


def test_file_empty_missing_corrupt_sha(tmp_path):
    with pytest.raises(inventory_parser.ParseError) as excinfo:
        parse(tmp_path / 'nope.xlsx')
    assert excinfo.value.code == 'FILE_MISSING'

    empty = tmp_path / 'empty.xlsx'
    empty.write_bytes(b'')
    with pytest.raises(inventory_parser.ParseError) as excinfo:
        parse(empty)
    assert excinfo.value.code == 'FILE_EMPTY'

    garbage = tmp_path / 'garbage.xlsx'
    garbage.write_bytes(b'not-an-xlsx')
    with pytest.raises(inventory_parser.ParseError) as excinfo:
        parse(garbage)
    assert excinfo.value.code == 'FILE_CORRUPT'

    path = build(tmp_path, MIN_HEADER, [['WM-1', WH_A['name'], '1', '0', '1', '0']])
    with pytest.raises(inventory_parser.ParseError) as excinfo:
        inventory_parser.parse_export_file(
            path, warehouse_discovery=DEFAULT_DISCOVERY,
            expected_sha256=hashlib.sha256(b'other').hexdigest())
    assert excinfo.value.code == 'FILE_CORRUPT'


def test_header_with_no_data_rows_is_file_empty(tmp_path):
    path = build(tmp_path, MIN_HEADER, [])
    with pytest.raises(inventory_parser.ParseError) as excinfo:
        parse(path)
    assert excinfo.value.code == 'FILE_EMPTY'


def test_summarize_parse_counts():
    rows = [{'parseStatus': 'ok'}, {'parseStatus': 'ok'}, {'parseStatus': 'invalid_quantity'}]
    assert inventory_parser.summarize_parse(rows) == {'ok': 2, 'invalid_quantity': 1}
