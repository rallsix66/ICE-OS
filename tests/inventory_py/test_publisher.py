"""Publisher tests (repair v2 / R3): complete-warehouse blocking, no filtered success."""
from __future__ import annotations

import json

import pytest

import publisher as inventory_publisher

from fakes import (
    DEFAULT_DISCOVERY,
    WH_A,
    WH_B,
    WH_EXCLUDED,
    FakeGateway,
    gateway_unavailable,
    rpc_error,
)

OBSERVATION_AT = '2026-10-25T17:35:05+08:00'
OK_VALIDATION = {'status': 'ok', 'comboRowCount': 0, 'unattributableRowCount': 0, 'reason': ''}


def make_row(**overrides) -> dict:
    row = {
        'excelRow': 2,
        'warehouseExternalId': WH_A['externalId'],
        'warehouseName': WH_A['name'],
        'externalSku': 'WM0043',
        'productName': '测试商品',
        'gtin': '6974674958025',
        'onHandText': '3,793',
        'orderLockedText': '12',
        'warehouseAvailableText': '3 781',
        'activityReservedText': '',
        'inTransitText': '0',
        'totalCostText': 'MYR 12.30',
        'rowHash': 'hash-1',
        'parseStatus': 'ok',
        'reason': None,
    }
    row.update(overrides)
    return row


def publish(gateway, claim, rows, validation=None, *, already_published=None):
    return inventory_publisher.publish_run(
        gateway, 'run-1', 'lease-1', claim, DEFAULT_DISCOVERY, rows,
        validation if validation is not None else OK_VALIDATION,
        observation_at=OBSERVATION_AT,
        already_published=already_published,
    )


# -- classification ---------------------------------------------------------

def test_classify_rows_groups_scope_and_excluded_rows():
    rows = [
        make_row(excelRow=2),
        make_row(excelRow=3, warehouseExternalId=WH_B['externalId'],
                 warehouseName=WH_B['name'], externalSku='780103214060'),
        make_row(excelRow=4, warehouseExternalId=WH_EXCLUDED['externalId'],
                 warehouseName=WH_EXCLUDED['name'], externalSku='WM-EXCLUDED'),
    ]
    classified = inventory_publisher.classify_rows([WH_A, WH_B], DEFAULT_DISCOVERY, rows,
                                                   OK_VALIDATION)

    groups = {group['externalId']: group for group in classified['groups']}
    assert len(groups[WH_A['externalId']]['okRows']) == 1
    assert len(groups[WH_B['externalId']]['okRows']) == 1
    assert len(classified['outOfScopeRows']) == 1
    assert classified['outOfScopeWarehouseNames'] == [WH_EXCLUDED['name']]
    assert classified['fileBlocked'] is False


def test_bad_row_blocks_only_its_warehouse():
    rows = [
        make_row(excelRow=2),
        make_row(excelRow=3, externalSku='WM-BAD', onHandText='abc',
                 parseStatus='invalid_quantity'),
        make_row(excelRow=4, warehouseExternalId=WH_B['externalId'],
                 warehouseName=WH_B['name'], externalSku='780103214060'),
    ]
    classified = inventory_publisher.classify_rows([WH_A, WH_B], DEFAULT_DISCOVERY, rows,
                                                   OK_VALIDATION)
    groups = {group['externalId']: group for group in classified['groups']}

    assert groups[WH_A['externalId']]['blocked'] is True
    assert groups[WH_A['externalId']]['errorCode'] == 'INVENTORY_WAREHOUSE_BLOCKED'
    assert groups[WH_A['externalId']]['invalidRows'] == 1
    assert groups[WH_B['externalId']]['blocked'] is False
    assert classified['fileBlocked'] is False


def test_duplicate_sku_blocks_warehouse():
    rows = [
        make_row(excelRow=2, externalSku='WM-DUP'),
        make_row(excelRow=3, externalSku='WM-DUP', parseStatus='duplicate_sku'),
    ]
    classified = inventory_publisher.classify_rows([WH_A], DEFAULT_DISCOVERY, rows,
                                                   OK_VALIDATION)
    group = classified['groups'][0]
    assert group['blocked'] is True
    assert group['duplicateSkuRows'] == 1


def test_missing_sku_blocks_warehouse():
    rows = [
        make_row(excelRow=2),
        make_row(excelRow=3, warehouseExternalId=WH_A['externalId'],
                 warehouseName=WH_A['name'], externalSku=None, parseStatus='missing_sku'),
    ]
    classified = inventory_publisher.classify_rows([WH_A], DEFAULT_DISCOVERY, rows,
                                                   OK_VALIDATION)
    assert classified['groups'][0]['blocked'] is True
    assert classified['groups'][0]['missingSkuRows'] == 1


def test_missing_warehouse_row_blocks_file():
    rows = [
        make_row(excelRow=2),
        make_row(excelRow=3, warehouseExternalId=None, warehouseName=None,
                 parseStatus='missing_warehouse'),
    ]
    classified = inventory_publisher.classify_rows([WH_A], DEFAULT_DISCOVERY, rows,
                                                   OK_VALIDATION)
    assert classified['fileBlocked'] is True
    assert '无法归属仓库' in classified['fileBlockReason']
    assert len(classified['unattributableRows']) == 1


def test_combo_row_blocks_file_even_with_good_rows():
    rows = [
        make_row(excelRow=2),
        make_row(excelRow=3, externalSku='WM-COMBO', parseStatus='combo_sku'),
    ]
    classified = inventory_publisher.classify_rows([WH_A], DEFAULT_DISCOVERY, rows,
                                                   OK_VALIDATION)
    assert classified['fileBlocked'] is True
    assert '组合' in classified['fileBlockReason']


def test_file_validation_blocked_blocks_file():
    rows = [make_row()]
    validation = {**OK_VALIDATION, 'status': 'blocked', 'blocked': True, 'reason': '表头问题'}
    classified = inventory_publisher.classify_rows([WH_A], DEFAULT_DISCOVERY, rows, validation)
    assert classified['fileBlocked'] is True
    assert '表头问题' in classified['fileBlockReason']

    only_blocked_flag = {'blocked': True, 'reason': 'DB 判定 blocked'}
    classified = inventory_publisher.classify_rows(
        [WH_A], DEFAULT_DISCOVERY, rows, only_blocked_flag)
    assert classified['fileBlocked'] is True


def test_scope_warehouse_not_discovered_is_blocked():
    rows = [make_row(excelRow=2)]
    claim = [dict(WH_A), dict(WH_B)]
    discovery = [{'externalId': WH_A['externalId'], 'name': WH_A['name']}]
    classified = inventory_publisher.classify_rows(claim, discovery, rows, OK_VALIDATION)
    groups = {group['externalId']: group for group in classified['groups']}
    assert groups[WH_B['externalId']]['blocked'] is True
    assert groups[WH_B['externalId']]['errorCode'] == 'INVENTORY_WAREHOUSE_NOT_DISCOVERED'
    assert groups[WH_A['externalId']]['blocked'] is False


def test_renamed_warehouse_is_blocked_not_published():
    rows = [make_row(excelRow=2)]
    discovery = [{'externalId': WH_A['externalId'], 'name': 'DEE-龙仔厝改名仓'}]
    classified = inventory_publisher.classify_rows([WH_A], discovery, rows, OK_VALIDATION)
    group = classified['groups'][0]
    assert group['blocked'] is True
    assert group['errorCode'] == 'INVENTORY_WAREHOUSE_RENAMED'


# -- publishing -------------------------------------------------------------

def test_publish_run_publishes_all_ok_rows_with_excel_row_and_no_amounts():
    rows = [
        make_row(excelRow=2, externalSku='WM-1'),
        make_row(excelRow=3, externalSku='WM-2'),
    ]
    gateway = FakeGateway()
    outcome = publish(gateway, [WH_A], rows)

    assert len(outcome['published']) == 1
    assert len(gateway.publish_calls) == 1
    call = gateway.publish_calls[0]
    assert call['warehouse']['observationAt'] == OBSERVATION_AT
    assert [row['excelRow'] for row in call['rows']] == [2, 3]
    for row in call['rows']:
        assert 'totalCostText' not in row
        assert '12.30' not in json.dumps(row, ensure_ascii=False)
    assert call['rows'][0]['onHand'] == 3793
    assert call['rows'][0]['gtin'] == '6974674958025'
    assert inventory_publisher.decide_status(1, outcome) == 'success'


def test_bad_warehouse_not_published_good_warehouse_succeeds_partial():
    rows = [
        make_row(excelRow=2),
        make_row(excelRow=3, externalSku='WM-BAD', onHandText='abc',
                 parseStatus='invalid_quantity'),
        make_row(excelRow=4, warehouseExternalId=WH_B['externalId'],
                 warehouseName=WH_B['name'], externalSku='780103214060'),
    ]
    gateway = FakeGateway()
    outcome = publish(gateway, [WH_A, WH_B], rows)

    published_warehouses = [call['warehouse']['warehouseExternalId']
                            for call in gateway.publish_calls]
    assert published_warehouses == [WH_B['externalId']]
    assert outcome['failed'] == []
    assert len(outcome['blocked']) == 1
    assert outcome['blocked'][0]['externalId'] == WH_A['externalId']
    assert inventory_publisher.decide_status(2, outcome) == 'partial'
    summary = inventory_publisher.build_summary(outcome)
    assert summary['published'] == 1
    assert summary['blocked'] == 1
    assert summary['warehouses'][0]['status'] == 'blocked'
    assert summary['warehouses'][0]['invalidRows'] == 1


def test_all_warehouses_blocked_status_failed():
    rows = [make_row(excelRow=2, onHandText='abc', parseStatus='invalid_quantity')]
    gateway = FakeGateway()
    outcome = publish(gateway, [WH_A], rows)

    assert gateway.publish_calls == []
    assert inventory_publisher.decide_status(1, outcome) == 'failed'
    assert len(outcome['blocked']) == 1


def test_file_blocked_returns_without_any_publish():
    rows = [make_row(excelRow=2), make_row(excelRow=3, parseStatus='combo_sku')]
    gateway = FakeGateway()
    outcome = publish(gateway, [WH_A], rows)

    assert outcome['fileBlocked'] is True
    assert gateway.publish_calls == []
    assert inventory_publisher.decide_status(1, outcome) == 'failed'


def test_missing_warehouse_blocks_entire_file_even_for_other_good_warehouses():
    rows = [
        make_row(excelRow=2),
        make_row(excelRow=3, warehouseExternalId=None, warehouseName=None,
                 parseStatus='missing_warehouse'),
    ]
    gateway = FakeGateway()
    outcome = publish(gateway, [WH_A], rows)
    assert outcome['fileBlocked'] is True
    assert gateway.publish_calls == []


def test_scope_warehouse_missing_from_file_is_no_rows_not_success():
    rows = [make_row(excelRow=2)]
    gateway = FakeGateway()
    outcome = publish(gateway, [WH_A, WH_B], rows)

    assert len(gateway.publish_calls) == 1
    assert len(outcome['noRows']) == 1
    assert inventory_publisher.decide_status(2, outcome) == 'partial'


def test_already_published_warehouse_is_skipped():
    rows = [
        make_row(excelRow=2),
        make_row(excelRow=3, warehouseExternalId=WH_B['externalId'],
                 warehouseName=WH_B['name'], externalSku='780103214060'),
    ]
    gateway = FakeGateway()
    outcome = publish(gateway, [WH_A, WH_B], rows,
                      already_published={WH_A['id']: {'batchId': 'batch-old', 'rowCount': 1}})

    assert len(outcome['published']) == 2
    assert outcome['published'][0]['recovered'] is True
    assert [call['warehouse']['warehouseExternalId'] for call in gateway.publish_calls] == [
        WH_B['externalId']]


def test_publish_lease_lost_aborts():
    rows = [
        make_row(excelRow=2),
        make_row(excelRow=3, warehouseExternalId=WH_B['externalId'],
                 warehouseName=WH_B['name'], externalSku='780103214060'),
    ]
    gateway = FakeGateway(publish_errors={WH_A['externalId']: rpc_error('INVENTORY_LEASE_LOST')})
    with pytest.raises(inventory_publisher.LeaseLostError):
        publish(gateway, [WH_A, WH_B], rows)
    assert len(gateway.publish_calls) == 1


def test_publish_db_unavailable_means_outcome_unknown():
    gateway = FakeGateway(publish_errors={WH_A['externalId']: gateway_unavailable()})
    with pytest.raises(inventory_publisher.OutcomeUnknownError):
        publish(gateway, [WH_A], [make_row()])


def test_publish_warehouse_incomplete_is_recorded_as_failed():
    gateway = FakeGateway(publish_errors={
        WH_A['externalId']: rpc_error('INVENTORY_WAREHOUSE_INCOMPLETE', '登记原行不一致')})
    outcome = publish(gateway, [WH_A], [make_row()])

    assert len(outcome['failed']) == 1
    assert outcome['failed'][0]['errorCode'] == 'INVENTORY_WAREHOUSE_INCOMPLETE'
    assert '不一致' in outcome['failed'][0]['reason']


def test_out_of_scope_rows_counted_not_published():
    rows = [
        make_row(excelRow=2),
        make_row(excelRow=3, warehouseExternalId=WH_EXCLUDED['externalId'],
                 warehouseName=WH_EXCLUDED['name'], externalSku='WM-EXCLUDED'),
    ]
    gateway = FakeGateway()
    outcome = publish(gateway, [WH_A], rows)
    summary = inventory_publisher.build_summary(outcome)

    assert summary['outOfScopeRows'] == 1
    assert summary['outOfScopeWarehouseNames'] == [WH_EXCLUDED['name']]
    published_skus = [row['externalSku'] for call in gateway.publish_calls for row in call['rows']]
    assert 'WM-EXCLUDED' not in published_skus


def test_build_publish_rows_rejects_bad_status_instead_of_filtering():
    with pytest.raises(ValueError):
        inventory_publisher.build_publish_rows([make_row(parseStatus='invalid_quantity')])


def test_publish_db_file_block_aborts_all_warehouses():
    rows = [
        make_row(excelRow=2),
        make_row(excelRow=3, warehouseExternalId=WH_B['externalId'],
                 warehouseName=WH_B['name'], externalSku='780103214060'),
    ]
    gateway = FakeGateway(publish_errors={
        WH_A['externalId']: rpc_error('INVENTORY_FILE_BLOCKED', 'run rows 含 combo')})
    with pytest.raises(inventory_publisher.FileBlockedError) as excinfo:
        publish(gateway, [WH_A, WH_B], rows)
    assert excinfo.value.code == 'INVENTORY_FILE_BLOCKED'
    assert len(gateway.publish_calls) == 1


def test_describe_error_mapping():
    assert '范围' in inventory_publisher.describe_error('INVENTORY_WAREHOUSE_OUT_OF_SCOPE')
    assert '未发现' in inventory_publisher.describe_error('INVENTORY_WAREHOUSE_NOT_DISCOVERED')
    assert '更名' in inventory_publisher.describe_error('INVENTORY_WAREHOUSE_RENAMED')
    assert '整仓' in inventory_publisher.describe_error('INVENTORY_WAREHOUSE_BLOCKED')
    assert '整份文件' in inventory_publisher.describe_error('INVENTORY_FILE_BLOCKED')
    assert '导出完成时间' in inventory_publisher.describe_error('INVENTORY_OBSERVATION_MISSING')
    assert '账号' in inventory_publisher.describe_error('INVENTORY_ACCOUNT_IDENTITY_MISSING')
    assert 'UNKNOWN_CODE' in inventory_publisher.describe_error('UNKNOWN_CODE')
