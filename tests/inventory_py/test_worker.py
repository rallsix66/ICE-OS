"""Worker end-to-end tests with a fake DB gateway and fake BigSeller exporter (R3/R4)."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

import parser as inventory_parser
from db_gateway import GatewayUnavailable
from worker import JsonlLogger, ShutdownRequested, Worker

from fakes import (
    ACCOUNT_LABEL,
    DEFAULT_DISCOVERY,
    OBSERVATION_AT,
    REAL_HEADER,
    REAL_ROWS,
    RUN_ID,
    STANDARD_HEADER,
    STANDARD_ROWS,
    WH_A,
    WH_B,
    WH_EXCLUDED,
    FakeExportError,
    FakeGateway,
    corrupt_dimension,
    exporter_raising,
    exporter_returning,
    exporter_writing,
    export_result_for,
    gateway_unavailable,
    make_claim,
    make_config,
    make_registration,
    make_work,
    rpc_error,
    sha256_file,
    write_workbook,
)

MIN_HEADER = ['SKU编号', '仓库', '现有库存', '订单已锁', '整仓可用', '在途中']
GOOD_A = ['WM-A', WH_A['name'], '3,793', '12', '3 781', '0']
GOOD_B = ['780103214060', WH_B['name'], '0', '0', '0', '5']
BAD_QUANTITY = ['WM-BAD', WH_A['name'], 'abc', '0', '1', '0']
DUP_A = ['WM-DUP', WH_A['name'], '1', '0', '1', '0']
MISSING_WH = ['WM-NOWH', '', '1', '0', '1', '0']
EXCLUDED_ROW = ['WM-EXCLUDED', WH_EXCLUDED['name'], '9', '0', '9', '0']
OLD_OBSERVATION = '2026-10-20T01:00:00+00:00'


def build_worker(tmp_path: Path, gateway: FakeGateway, exporter, *,
                 session_checker=None, monotonic=None, **config_overrides) -> Worker:
    config = make_config(tmp_path, **config_overrides)
    return Worker(
        config,
        gateway,
        exporter=exporter,
        session_checker=session_checker or (lambda: {'loggedIn': False}),
        monotonic=monotonic,
    )


def log_text(config) -> str:
    logger = JsonlLogger(config.log_path, worker_id=config.worker_id)
    path = logger.file_path()
    return path.read_text(encoding='utf-8') if path.exists() else ''


def register_payload(gateway: FakeGateway) -> dict:
    calls = gateway.calls_named('register_export')
    assert calls, 'register_export was not called'
    return calls[-1]['payload']


def publish_rows_by_sku(gateway: FakeGateway) -> dict[str, dict]:
    rows: dict[str, dict] = {}
    for call in gateway.publish_calls:
        for row in call['rows']:
            rows[row['externalSku']] = row
    return rows


# ---------------------------------------------------------------------------
# happy path
# ---------------------------------------------------------------------------

def test_complete_run_success_with_identity_validation_and_discovery(tmp_path):
    gateway = FakeGateway(claim=make_claim())
    worker = build_worker(tmp_path, gateway, exporter_writing(MIN_HEADER, [GOOD_A, GOOD_B]))

    outcome = worker.run_once()

    assert outcome['status'] == 'success'
    payload = register_payload(gateway)
    assert payload['accountIdentity'] == {'label': ACCOUNT_LABEL, 'verified': True}
    assert payload['warehouseDiscovery'] == [
        {'externalId': entry['externalId'], 'name': entry['name']} for entry in DEFAULT_DISCOVERY]
    assert payload['fileValidation']['status'] == 'ok'
    assert [row['parseStatus'] for row in payload['rows']] == ['ok', 'ok']
    assert payload['file']['rowCount'] == 2
    assert 'filePath' not in payload['file']

    assert len(gateway.publish_calls) == 2
    for call in gateway.publish_calls:
        assert call['warehouse']['observationAt'] == OBSERVATION_AT
        for row in call['rows']:
            assert 'totalCostText' not in row
            assert row['excelRow'] >= 2
    rows = publish_rows_by_sku(gateway)
    assert rows['WM-A']['onHand'] == 3793
    assert rows['WM-A']['warehouseAvailable'] == 3781
    assert rows['780103214060']['inTransit'] == 5

    finish = gateway.calls_named('finish_run')[0]
    assert finish['status'] == 'success'
    assert finish['summary']['published'] == 2
    assert finish['summary']['observationAt'] == OBSERVATION_AT
    assert finish['summary']['fileValidationStatus'] == 'ok'
    assert gateway.calls_named('fail_run') == []


def test_publish_uses_db_export_finished_at_not_adapter_time(tmp_path):
    db_time = '2026-10-21T02:03:04+00:00'
    gateway = FakeGateway(claim=make_claim([WH_A]),
                          work=make_work(exportFinishedAt=db_time, observationAt=db_time))
    worker = build_worker(tmp_path, gateway, exporter_writing(MIN_HEADER, [GOOD_A]))

    outcome = worker.run_once()

    assert outcome['status'] == 'success'
    assert gateway.publish_calls[0]['warehouse']['observationAt'] == db_time


def test_missing_db_observation_time_fails_without_publish(tmp_path):
    gateway = FakeGateway(claim=make_claim([WH_A]),
                          work=make_work(exportFinishedAt=None, observationAt=None))
    worker = build_worker(tmp_path, gateway, exporter_writing(MIN_HEADER, [GOOD_A]))

    outcome = worker.run_once()

    assert outcome['status'] == 'failed'
    assert outcome['errorCode'] == 'INVENTORY_OBSERVATION_MISSING'
    assert gateway.calls_named('publish_warehouse') == []
    assert gateway.calls_named('fail_run')[0]['errorCode'] == 'INVENTORY_OBSERVATION_MISSING'


# ---------------------------------------------------------------------------
# account identity
# ---------------------------------------------------------------------------

def test_account_identity_missing_fails_without_register(tmp_path):
    exporter = exporter_writing(MIN_HEADER, [GOOD_A], account_label=None)
    gateway = FakeGateway(claim=make_claim([WH_A]))
    worker = build_worker(tmp_path, gateway, exporter)

    outcome = worker.run_once()

    assert outcome['status'] == 'failed'
    assert outcome['errorCode'] == 'INVENTORY_ACCOUNT_IDENTITY_MISSING'
    assert gateway.calls_named('register_export') == []
    assert gateway.calls_named('publish_warehouse') == []


def test_account_identity_mismatch_fails_without_register(tmp_path):
    exporter = exporter_writing(MIN_HEADER, [GOOD_A], account_label='other@example')
    gateway = FakeGateway(claim=make_claim([WH_A]))
    worker = build_worker(tmp_path, gateway, exporter)

    outcome = worker.run_once()

    assert outcome['status'] == 'failed'
    assert outcome['errorCode'] == 'INVENTORY_ACCOUNT_IDENTITY_MISMATCH'
    assert gateway.calls_named('register_export') == []


# ---------------------------------------------------------------------------
# discovery / header / file-level blocks
# ---------------------------------------------------------------------------

def test_missing_warehouse_discovery_fails_without_register(tmp_path):
    base = exporter_writing(MIN_HEADER, [GOOD_A])

    def exporter(work_dir, *, timeout_seconds):
        result = base(work_dir, timeout_seconds=timeout_seconds)
        result['warehouseOptions'] = []
        return result

    gateway = FakeGateway(claim=make_claim([WH_A]))
    worker = build_worker(tmp_path, gateway, exporter)

    outcome = worker.run_once()

    assert outcome['status'] == 'failed'
    assert outcome['errorCode'] == 'INVENTORY_WAREHOUSE_DISCOVERY_MISSING'
    assert gateway.calls_named('register_export') == []


def test_header_invalid_fails_without_register(tmp_path):
    header = ['SKU编号', '仓库', '现有库存', '订单已锁', '整仓可用']  # 在途中 missing
    gateway = FakeGateway(claim=make_claim([WH_A]))
    worker = build_worker(tmp_path, gateway, exporter_writing(header, [GOOD_A]))

    outcome = worker.run_once()

    assert outcome['status'] == 'failed'
    assert outcome['errorCode'] == 'HEADER_INVALID'
    assert gateway.calls_named('register_export') == []
    assert gateway.calls_named('publish_warehouse') == []


def test_amount_column_mistaken_header_is_rejected(tmp_path):
    header = ['SKU编号', '仓库', '现有库存总成本', '订单已锁', '整仓可用', '在途中']
    gateway = FakeGateway(claim=make_claim([WH_A]))
    worker = build_worker(tmp_path, gateway, exporter_writing(
        header, [['WM-AMT', WH_A['name'], '123.45', '0', '1', '0']]))

    outcome = worker.run_once()

    assert outcome['status'] == 'failed'
    assert outcome['errorCode'] == 'HEADER_INVALID'
    assert gateway.calls_named('publish_warehouse') == []


def test_missing_warehouse_row_blocks_file_after_register(tmp_path):
    gateway = FakeGateway(claim=make_claim([WH_A]))
    worker = build_worker(tmp_path, gateway,
                          exporter_writing(MIN_HEADER, [GOOD_A, MISSING_WH]))

    outcome = worker.run_once()

    assert outcome['status'] == 'failed'
    assert outcome['errorCode'] == 'INVENTORY_FILE_BLOCKED'
    payload = register_payload(gateway)
    assert payload['fileValidation']['status'] == 'blocked'
    assert payload['fileValidation']['unattributableRowCount'] == 1
    assert gateway.calls_named('publish_warehouse') == []
    assert gateway.calls_named('finish_run') == []


def test_combo_row_blocks_whole_file(tmp_path):
    combo = list(REAL_ROWS[0])
    combo[1] = 'SKU-COMBO'
    combo[26] = 'Combo SKU'
    gateway = FakeGateway(claim=make_claim([WH_A]))
    worker = build_worker(tmp_path, gateway,
                          exporter_writing(REAL_HEADER, [combo, list(REAL_ROWS[1])]))

    outcome = worker.run_once()

    assert outcome['status'] == 'failed'
    assert outcome['errorCode'] == 'INVENTORY_FILE_BLOCKED'
    payload = register_payload(gateway)
    assert payload['fileValidation']['status'] == 'blocked'
    assert payload['fileValidation']['comboRowCount'] == 1
    assert gateway.calls_named('publish_warehouse') == []


def test_bad_row_blocks_warehouse_good_warehouse_publishes_partial(tmp_path):
    rows = [GOOD_A, BAD_QUANTITY, GOOD_B]
    gateway = FakeGateway(claim=make_claim([WH_A, WH_B]))
    worker = build_worker(tmp_path, gateway, exporter_writing(MIN_HEADER, rows))

    outcome = worker.run_once()

    assert outcome['status'] == 'partial'
    assert outcome['summary']['published'] == 1
    assert outcome['summary']['blocked'] == 1
    assert [call['warehouse']['warehouseExternalId'] for call in gateway.publish_calls] == [
        WH_B['externalId']]
    # the good row of the blocked warehouse is NOT published alone
    published_skus = [row['externalSku'] for call in gateway.publish_calls for row in call['rows']]
    assert 'WM-A' not in published_skus and 'WM-BAD' not in published_skus
    blocked = [entry for entry in outcome['summary']['warehouses']
               if entry['status'] == 'blocked'][0]
    assert blocked['externalId'] == WH_A['externalId']
    assert blocked['invalidRows'] == 1
    assert blocked['excelRows'] == [3]


def test_duplicate_sku_blocks_warehouse(tmp_path):
    gateway = FakeGateway(claim=make_claim([WH_A]))
    worker = build_worker(tmp_path, gateway,
                          exporter_writing(MIN_HEADER, [DUP_A, list(DUP_A)]))

    outcome = worker.run_once()

    assert outcome['status'] == 'failed'
    assert outcome['summary']['blocked'] == 1
    assert gateway.calls_named('publish_warehouse') == []
    blocked = outcome['summary']['warehouses'][0]
    assert blocked['duplicateSkuRows'] == 2


def test_scope_warehouse_not_discovered_blocks_that_warehouse_only(tmp_path):
    discovery = [{'externalId': WH_B['externalId'], 'name': WH_B['name']}]
    base = exporter_writing(MIN_HEADER, [GOOD_B])

    def exporter(work_dir, *, timeout_seconds):
        result = base(work_dir, timeout_seconds=timeout_seconds)
        result['warehouseOptions'] = [dict(entry) for entry in discovery]
        result['accountLabel'] = ACCOUNT_LABEL
        return result

    gateway = FakeGateway(claim=make_claim([WH_A, WH_B]),
                          work=make_work(warehouseDiscovery=discovery))
    worker = build_worker(tmp_path, gateway, exporter)

    outcome = worker.run_once()

    assert outcome['status'] == 'partial'
    assert [call['warehouse']['warehouseExternalId'] for call in gateway.publish_calls] == [
        WH_B['externalId']]
    blocked = [entry for entry in outcome['summary']['warehouses']
               if entry['status'] == 'blocked'][0]
    assert blocked['errorCode'] == 'INVENTORY_WAREHOUSE_NOT_DISCOVERED'


def test_renamed_warehouse_blocked_not_published(tmp_path):
    new_name = 'DEE-龙仔厝（新名称）'
    rows = [['WM-A', new_name, '1', '0', '1', '0'], GOOD_B]
    discovery = [
        {'externalId': WH_A['externalId'], 'name': new_name},
        {'externalId': WH_B['externalId'], 'name': WH_B['name']},
    ]
    base = exporter_writing(MIN_HEADER, rows)

    def exporter(work_dir, *, timeout_seconds):
        result = base(work_dir, timeout_seconds=timeout_seconds)
        result['warehouseOptions'] = [dict(entry) for entry in discovery]
        return result

    gateway = FakeGateway(claim=make_claim([WH_A, WH_B]),
                          work=make_work(warehouseDiscovery=discovery))
    worker = build_worker(tmp_path, gateway, exporter)

    outcome = worker.run_once()

    assert outcome['status'] == 'partial'
    assert [call['warehouse']['warehouseExternalId'] for call in gateway.publish_calls] == [
        WH_B['externalId']]
    blocked = [entry for entry in outcome['summary']['warehouses']
               if entry['status'] == 'blocked'][0]
    assert blocked['errorCode'] == 'INVENTORY_WAREHOUSE_RENAMED'


def test_out_of_scope_rows_counted_not_published(tmp_path):
    rows = [GOOD_A, GOOD_B, EXCLUDED_ROW]
    gateway = FakeGateway(claim=make_claim([WH_A, WH_B]))
    worker = build_worker(tmp_path, gateway, exporter_writing(MIN_HEADER, rows))

    outcome = worker.run_once()

    assert outcome['status'] == 'success'
    assert outcome['summary']['outOfScopeRows'] == 1
    assert outcome['summary']['outOfScopeWarehouseNames'] == [WH_EXCLUDED['name']]
    published_skus = [row['externalSku'] for call in gateway.publish_calls for row in call['rows']]
    assert 'WM-EXCLUDED' not in published_skus


# ---------------------------------------------------------------------------
# recovery / replay
# ---------------------------------------------------------------------------

def registered_rows() -> list[dict]:
    rows = []
    for index, (sku, warehouse, on_hand) in enumerate([
            ('WM-A', WH_A, '10'),
            ('780103214060', WH_B, '0')], start=2):
        rows.append({
            'excelRow': index,
            'warehouseExternalId': warehouse['externalId'],
            'warehouseName': warehouse['name'],
            'externalSku': sku,
            'productName': None,
            'gtin': None,
            'onHandText': on_hand,
            'orderLockedText': '0',
            'warehouseAvailableText': on_hand,
            'activityReservedText': None,
            'inTransitText': '0',
            'totalCostText': None,
            'rowHash': f'hash-{index}',
            'parseStatus': 'ok',
            'reason': None,
        })
    return rows


def recovered_work(tmp_path, *, published=(), file_path=None, **overrides) -> dict:
    file_path = file_path or write_workbook(
        tmp_path / 'inventory-work' / 'exports' / 'recovered.xlsx', MIN_HEADER,
        [['WM-A', WH_A['name'], '10', '0', '10', '0'],
         ['780103214060', WH_B['name'], '0', '0', '0', '5']])
    file_info = {'sha256': sha256_file(file_path),
                 'sizeBytes': file_path.stat().st_size,
                 'storageRelpath': 'exports/recovered.xlsx',
                 'rowCount': 2, 'blankRowCount': 0, 'sheetName': '单个SKU'}
    work = make_work(
        status='publishing',
        publishedWarehouses=[
            {'warehouseId': warehouse_id, 'batchId': f'batch-{index}', 'rowCount': 1}
            for index, warehouse_id in enumerate(published)],
        file=file_info,
        exportMark='original-mark',
        exportFinishedAt=OLD_OBSERVATION,
        observationAt=OLD_OBSERVATION,
    )
    work.update(overrides)
    return work


def test_recovery_replays_registered_receipt_and_keeps_original_observation(tmp_path):
    gateway = FakeGateway(claim=make_claim(), work=recovered_work(tmp_path),
                          replay_rows=registered_rows())
    export_called = {'value': False}

    def exporter(work_dir, *, timeout_seconds):
        export_called['value'] = True
        raise AssertionError('recovery must not re-export')

    worker = build_worker(tmp_path, gateway, exporter)
    outcome = worker.run_once()

    assert export_called['value'] is False
    assert outcome['status'] == 'success'
    assert len(gateway.calls_named('register_export')) == 1
    assert gateway.calls_named('register_export')[0]['payload']['rows'] == []
    assert len(gateway.publish_calls) == 2
    for call in gateway.publish_calls:
        assert call['warehouse']['observationAt'] == OLD_OBSERVATION
    assert 'recovery_replayed_register_receipt' in log_text(worker.config)


def test_recovery_falls_back_to_original_file_with_db_discovery(tmp_path):
    gateway = FakeGateway(claim=make_claim(), work=recovered_work(tmp_path))
    export_called = {'value': False}

    def exporter(work_dir, *, timeout_seconds):
        export_called['value'] = True
        raise AssertionError('recovery must not re-export')

    worker = build_worker(tmp_path, gateway, exporter)
    outcome = worker.run_once()

    assert export_called['value'] is False
    assert outcome['status'] == 'success'
    assert len(gateway.publish_calls) == 2
    for call in gateway.publish_calls:
        assert call['warehouse']['observationAt'] == OLD_OBSERVATION
    assert 'recovery_reused_export_file' in log_text(worker.config)


def test_recovery_skips_already_published_warehouse(tmp_path):
    work = recovered_work(tmp_path, published=(WH_A['id'],))
    gateway = FakeGateway(claim=make_claim(), work=work, replay_rows=registered_rows())
    worker = build_worker(tmp_path, gateway, exporter_raising(AssertionError('no export')))

    outcome = worker.run_once()

    assert outcome['status'] == 'success'
    assert [call['warehouse']['warehouseExternalId'] for call in gateway.publish_calls] == [
        WH_B['externalId']]
    assert all(call['warehouse']['observationAt'] == OLD_OBSERVATION
               for call in gateway.publish_calls)


def test_recovery_missing_observation_fails(tmp_path):
    work = recovered_work(tmp_path)
    work['exportFinishedAt'] = None
    work['observationAt'] = None
    gateway = FakeGateway(claim=make_claim(), work=work, replay_rows=registered_rows())
    worker = build_worker(tmp_path, gateway, exporter_raising(AssertionError('no export')))

    outcome = worker.run_once()

    assert outcome['status'] == 'failed'
    assert outcome['errorCode'] == 'INVENTORY_OBSERVATION_MISSING'
    assert gateway.calls_named('publish_warehouse') == []


def test_recovery_missing_discovery_fails_without_guessing(tmp_path):
    work = recovered_work(tmp_path)
    work['warehouseDiscovery'] = []
    gateway = FakeGateway(claim=make_claim(), work=work)
    worker = build_worker(tmp_path, gateway, exporter_raising(AssertionError('no export')))

    outcome = worker.run_once()

    assert outcome['status'] == 'failed'
    assert outcome['errorCode'] == 'INVENTORY_WAREHOUSE_DISCOVERY_MISSING'
    assert gateway.calls_named('publish_warehouse') == []


def test_recovery_file_missing_fails_without_reexport(tmp_path):
    work = recovered_work(tmp_path)
    work['file'] = {'sha256': 'a' * 64, 'sizeBytes': 123, 'rowCount': 2}
    gateway = FakeGateway(claim=make_claim(), work=work)
    worker = build_worker(tmp_path, gateway, exporter_raising(AssertionError('no export')))

    outcome = worker.run_once()

    assert outcome['status'] == 'failed'
    assert outcome['errorCode'] == 'RECOVERY_FILE_UNAVAILABLE'
    assert gateway.calls_named('publish_warehouse') == []


def test_recovery_blocked_file_validation_fails(tmp_path):
    work = recovered_work(tmp_path)
    work['fileValidation'] = {'status': 'blocked', 'reason': '组合 SKU'}
    gateway = FakeGateway(claim=make_claim(), work=work)
    worker = build_worker(tmp_path, gateway, exporter_raising(AssertionError('no export')))

    outcome = worker.run_once()

    assert outcome['status'] == 'failed'
    assert outcome['errorCode'] == 'INVENTORY_FILE_BLOCKED'
    assert gateway.calls_named('publish_warehouse') == []


def test_recovery_unverified_identity_fails(tmp_path):
    work = recovered_work(tmp_path)
    work['accountIdentity'] = {'status': 'mismatch', 'label': 'other'}
    gateway = FakeGateway(claim=make_claim(), work=work)
    worker = build_worker(tmp_path, gateway, exporter_raising(AssertionError('no export')))

    outcome = worker.run_once()

    assert outcome['status'] == 'failed'
    assert outcome['errorCode'] == 'INVENTORY_ACCOUNT_IDENTITY_UNVERIFIED'
    assert gateway.calls_named('publish_warehouse') == []


# ---------------------------------------------------------------------------
# outcome unknown / failures
# ---------------------------------------------------------------------------

def test_outcome_unknown_all_published_closes_success_without_republish(tmp_path):
    work = make_work(status='outcome_unknown', publishedWarehouses=[
        {'warehouseId': WH_A['id'], 'batchId': 'batch-a', 'rowCount': 1},
        {'warehouseId': WH_B['id'], 'batchId': 'batch-b', 'rowCount': 1},
    ])
    gateway = FakeGateway(claim=make_claim(), work=work)
    worker = build_worker(tmp_path, gateway, exporter_raising(AssertionError('no export')))

    outcome = worker.run_once()

    assert outcome['status'] == 'success'
    assert gateway.calls_named('publish_warehouse') == []
    assert gateway.calls_named('finish_run')[0]['status'] == 'success'


def test_outcome_unknown_unresolved_closes_partial_without_republish(tmp_path):
    work = make_work(status='outcome_unknown', publishedWarehouses=[
        {'warehouseId': WH_A['id'], 'batchId': 'batch-a', 'rowCount': 1},
    ])
    gateway = FakeGateway(claim=make_claim(), work=work)
    worker = build_worker(tmp_path, gateway, exporter_raising(AssertionError('no export')))

    outcome = worker.run_once()

    assert outcome['status'] == 'partial'
    assert outcome['reconciled'] is True
    assert gateway.calls_named('publish_warehouse') == []
    summary = gateway.calls_named('finish_run')[0]['summary']
    assert summary['reconciledWithoutRepublish'] is True


def test_publish_file_level_db_error_fails_run_without_other_publish(tmp_path):
    gateway = FakeGateway(
        claim=make_claim([WH_A, WH_B]),
        publish_errors={WH_A['externalId']: rpc_error('INVENTORY_FILE_BLOCKED', 'db 判定整文件阻断')})
    worker = build_worker(tmp_path, gateway, exporter_writing(MIN_HEADER, [GOOD_A, GOOD_B]))

    outcome = worker.run_once()

    assert outcome['status'] == 'failed'
    assert outcome['errorCode'] == 'INVENTORY_FILE_BLOCKED'
    assert len(gateway.publish_calls) == 1
    assert gateway.calls_named('finish_run') == []
    assert gateway.calls_named('fail_run')[0]['errorCode'] == 'INVENTORY_FILE_BLOCKED'


def test_publish_connection_loss_becomes_outcome_unknown(tmp_path):
    gateway = FakeGateway(claim=make_claim([WH_A]),
                          publish_errors={WH_A['externalId']: gateway_unavailable()})
    worker = build_worker(tmp_path, gateway, exporter_writing(MIN_HEADER, [GOOD_A]))

    outcome = worker.run_once()

    assert outcome['status'] == 'outcome_unknown'
    assert gateway.calls_named('fail_run')[0]['outcomeUnknown'] is True
    assert gateway.calls_named('finish_run') == []


def test_lease_lost_during_phase_stops_without_publish(tmp_path):
    gateway = FakeGateway(claim=make_claim(), phase_error=rpc_error('INVENTORY_LEASE_LOST'))
    worker = build_worker(tmp_path, gateway, exporter_writing(MIN_HEADER, [GOOD_A, GOOD_B]))

    outcome = worker.run_once()

    assert outcome['status'] == 'lease_lost'
    assert gateway.calls_named('register_export') == []
    assert gateway.calls_named('publish_warehouse') == []
    assert gateway.calls_named('finish_run') == []
    assert gateway.calls_named('fail_run') == []


def test_export_timeout_marks_failed(tmp_path):
    gateway = FakeGateway(claim=make_claim())
    worker = build_worker(tmp_path, gateway, exporter_raising(
        FakeExportError('EXPORT_TIMEOUT', '导出超时')))

    outcome = worker.run_once()

    assert outcome['status'] == 'failed'
    assert outcome['errorCode'] == 'EXPORT_TIMEOUT'
    assert gateway.calls_named('publish_warehouse') == []


# ---------------------------------------------------------------------------
# login recovery / idle
# ---------------------------------------------------------------------------

def test_account_needs_login_recovers_only_with_verified_identity(tmp_path):
    checker_calls = {'n': 0}

    def session_checker():
        checker_calls['n'] += 1
        return {'loggedIn': True, 'accountLabel': ACCOUNT_LABEL}

    gateway = FakeGateway(claim_sequence=[
        {'runId': None, 'reason': 'account_needs_login'},
        make_claim([WH_A]),
    ])
    worker = build_worker(tmp_path, gateway, exporter_writing(MIN_HEADER, [GOOD_A]),
                          session_checker=session_checker)

    outcome = worker.run_once()

    assert checker_calls['n'] == 1
    assert outcome['status'] == 'success'
    refresh_calls = gateway.calls_named('refresh_account_status')
    assert len(refresh_calls) == 1
    assert refresh_calls[0]['accountLabel'] == ACCOUNT_LABEL
    assert len(gateway.calls_named('claim_run')) == 2
    text = log_text(worker.config)
    assert 'account_relogin_checked' in text
    assert 'account_relogin_recovered' in text


def test_account_needs_login_not_recovered_when_refresh_unverified(tmp_path):
    gateway = FakeGateway(
        claim={'runId': None, 'reason': 'account_needs_login'},
        refresh_result={'verified': False, 'mismatch': True, 'status': 'needs_login'},
    )
    worker = build_worker(tmp_path, gateway, exporter_raising(AssertionError('no export')),
                          session_checker=lambda: {'loggedIn': True,
                                                   'accountLabel': ACCOUNT_LABEL})

    outcome = worker.run_once()

    assert outcome == {'status': 'idle', 'reason': 'account_needs_login'}
    assert len(gateway.calls_named('refresh_account_status')) == 1
    assert gateway.calls_named('publish_warehouse') == []
    assert 'account_relogin_rejected' in log_text(worker.config)


def test_account_relogin_with_empty_label_never_active(tmp_path):
    gateway = FakeGateway(claim={'runId': None, 'reason': 'account_needs_login'})
    worker = build_worker(tmp_path, gateway, exporter_raising(AssertionError('no export')),
                          session_checker=lambda: {'loggedIn': True, 'accountLabel': None})

    outcome = worker.run_once()

    assert outcome == {'status': 'idle', 'reason': 'account_needs_login'}
    assert gateway.calls_named('refresh_account_status') == []
    assert 'account_relogin_identity_missing' in log_text(worker.config)


def test_account_relogin_with_mismatching_label_never_active(tmp_path):
    gateway = FakeGateway(claim={'runId': None, 'reason': 'account_needs_login'})
    worker = build_worker(tmp_path, gateway, exporter_raising(AssertionError('no export')),
                          session_checker=lambda: {'loggedIn': True,
                                                   'accountLabel': 'other@example'})

    outcome = worker.run_once()

    assert outcome == {'status': 'idle', 'reason': 'account_needs_login'}
    assert gateway.calls_named('refresh_account_status') == []
    assert 'account_relogin_identity_mismatch' in log_text(worker.config)


def test_account_disabled_does_not_probe_browser(tmp_path):
    checker_calls = {'n': 0}

    def session_checker():
        checker_calls['n'] += 1
        raise AssertionError('account_disabled must not start the browser')

    gateway = FakeGateway(claim={'runId': None, 'reason': 'account_disabled'})
    worker = build_worker(tmp_path, gateway, exporter_raising(AssertionError('no export')),
                          session_checker=session_checker)

    first = worker.run_once()
    second = worker.run_once()

    assert first == {'status': 'idle', 'reason': 'account_disabled'}
    assert second == {'status': 'idle', 'reason': 'account_disabled'}
    assert checker_calls['n'] == 0
    assert log_text(worker.config).count('account_disabled_hold') == 1


def test_idle_claim_does_not_execute(tmp_path):
    gateway = FakeGateway(claim={'runId': None, 'reason': 'no_due_run'})
    worker = build_worker(tmp_path, gateway, exporter_raising(AssertionError('no export')))

    first = worker.run_once()
    second = worker.run_once()

    assert first == {'status': 'idle', 'reason': 'no_due_run'}
    assert second == {'status': 'idle', 'reason': 'no_due_run'}
    assert gateway.calls_named('read_run_work') == []
    assert gateway.calls_named('publish_warehouse') == []
    assert log_text(worker.config).count('"event": "worker_idle"') == 1


def test_db_down_on_claim_is_reported(tmp_path):
    gateway = FakeGateway(claim_error=GatewayUnavailable('db down'))
    worker = build_worker(tmp_path, gateway, exporter_raising(AssertionError('no export')))

    outcome = worker.run_once()

    assert outcome['status'] == 'db_unavailable'
    assert gateway.calls_named('publish_warehouse') == []


def test_needs_login_account_probes_even_without_due_run_and_recovers(tmp_path):
    """The operator may log in while settings are disabled: the probe must run anyway."""
    checker_calls = {'n': 0}

    def session_checker():
        checker_calls['n'] += 1
        return {'loggedIn': True, 'accountLabel': ACCOUNT_LABEL}

    gateway = FakeGateway(
        claim=make_claim([WH_A]),
        registration=make_registration('needs_login'),
    )
    worker = build_worker(tmp_path, gateway, exporter_writing(MIN_HEADER, [GOOD_A]),
                          session_checker=session_checker)

    outcome = worker.run_once()

    assert checker_calls['n'] == 1
    assert outcome['status'] == 'success'
    assert len(gateway.calls_named('refresh_account_status')) == 1
    assert len(gateway.calls_named('claim_run')) == 1
    text = log_text(worker.config)
    assert 'account_relogin_checked' in text
    assert 'account_relogin_recovered' in text


def test_needs_login_probe_without_due_run_is_rate_limited(tmp_path):
    clock = {'now': 1000.0}
    checker_calls = {'n': 0}

    def session_checker():
        checker_calls['n'] += 1
        return {'loggedIn': False}

    gateway = FakeGateway(
        claim={'runId': None, 'reason': 'no_due_run'},
        registration=make_registration('needs_login'),
    )
    worker = build_worker(tmp_path, gateway, exporter_raising(AssertionError('no export')),
                          session_checker=session_checker,
                          monotonic=lambda: clock['now'])

    first = worker.run_once()
    second = worker.run_once()  # within 60s: no second browser probe
    clock['now'] += 61
    third = worker.run_once()

    assert first == {'status': 'idle', 'reason': 'no_due_run'}
    assert second == {'status': 'idle', 'reason': 'no_due_run'}
    assert third == {'status': 'idle', 'reason': 'no_due_run'}
    assert checker_calls['n'] == 2
    assert gateway.calls_named('refresh_account_status') == []
    assert gateway.calls_named('publish_warehouse') == []


def test_export_login_required_retries_once_after_verified_recheck(tmp_path):
    export_calls = {'n': 0}

    def flaky_exporter(work_dir, *, timeout_seconds):
        export_calls['n'] += 1
        if export_calls['n'] == 1:
            raise FakeExportError('LOGIN_REQUIRED', 'transient page/login mis-detection')
        path = write_workbook(Path(work_dir) / 'retry.xlsx', MIN_HEADER, [GOOD_A])
        return export_result_for(path)

    gateway = FakeGateway(claim=make_claim([WH_A]))
    worker = build_worker(tmp_path, gateway, flaky_exporter,
                          session_checker=lambda: {'loggedIn': True,
                                                   'accountLabel': ACCOUNT_LABEL})

    outcome = worker.run_once()

    assert export_calls['n'] == 2
    assert outcome['status'] == 'success'
    assert len(gateway.calls_named('refresh_account_status')) == 1
    assert len(gateway.calls_named('register_export')) == 1
    assert len(gateway.publish_calls) == 1
    text = log_text(worker.config)
    assert 'export_login_retry' in text
    assert 'export_login_retry_succeeded' in text
    assert 'export_login_retry_failed' not in text


def test_export_login_required_retry_still_login_required_marks_needs_login(tmp_path):
    export_calls = {'n': 0}

    def always_login(work_dir, *, timeout_seconds):
        export_calls['n'] += 1
        raise FakeExportError('LOGIN_REQUIRED', 'still login page')

    gateway = FakeGateway(claim=make_claim([WH_A]))
    worker = build_worker(tmp_path, gateway, always_login,
                          session_checker=lambda: {'loggedIn': True,
                                                   'accountLabel': ACCOUNT_LABEL})

    outcome = worker.run_once()

    assert export_calls['n'] == 2  # at most two attempts, no infinite retry
    assert outcome['status'] == 'needs_login'
    assert outcome['errorCode'] == 'LOGIN_REQUIRED'
    assert gateway.calls_named('register_export') == []
    assert gateway.calls_named('publish_warehouse') == []
    assert gateway.calls_named('fail_run')[0]['needsLogin'] is True
    text = log_text(worker.config)
    assert 'export_login_retry' in text
    assert 'export_login_retry_failed' in text


def test_export_login_retry_skipped_when_session_check_not_logged_in(tmp_path):
    export_calls = {'n': 0}

    def login_required(work_dir, *, timeout_seconds):
        export_calls['n'] += 1
        raise FakeExportError('LOGIN_REQUIRED', 'page not ready')

    gateway = FakeGateway(claim=make_claim([WH_A]))
    worker = build_worker(tmp_path, gateway, login_required,
                          session_checker=lambda: {'loggedIn': False})

    outcome = worker.run_once()

    assert export_calls['n'] == 1
    assert outcome['status'] == 'needs_login'
    assert gateway.calls_named('refresh_account_status') == []
    assert 'export_login_retry_failed' in log_text(worker.config)


def test_export_login_retry_skipped_when_label_missing_or_mismatch(tmp_path):
    export_calls = {'n': 0}

    def login_required(work_dir, *, timeout_seconds):
        export_calls['n'] += 1
        raise FakeExportError('LOGIN_REQUIRED', 'page not ready')

    gateway = FakeGateway(claim=make_claim([WH_A]))
    worker = build_worker(tmp_path, gateway, login_required,
                          session_checker=lambda: {'loggedIn': True,
                                                   'accountLabel': 'other@example'})

    outcome = worker.run_once()

    assert export_calls['n'] == 1
    assert outcome['status'] == 'needs_login'
    assert gateway.calls_named('refresh_account_status') == []
    assert 'export_login_retry_failed' in log_text(worker.config)


def test_export_login_retry_second_failure_uses_retry_error_code(tmp_path):
    export_calls = {'n': 0}

    def mixed(work_dir, *, timeout_seconds):
        export_calls['n'] += 1
        if export_calls['n'] == 1:
            raise FakeExportError('LOGIN_REQUIRED', 'transient')
        raise FakeExportError('EXPORT_TIMEOUT', 'second attempt timed out')

    gateway = FakeGateway(claim=make_claim([WH_A]))
    worker = build_worker(tmp_path, gateway, mixed,
                          session_checker=lambda: {'loggedIn': True,
                                                   'accountLabel': ACCOUNT_LABEL})

    outcome = worker.run_once()

    assert export_calls['n'] == 2
    assert outcome['status'] == 'failed'
    assert outcome['errorCode'] == 'EXPORT_TIMEOUT'
    assert gateway.calls_named('fail_run')[0]['needsLogin'] is False


def test_worker_does_not_compute_schedule_times(tmp_path):
    gateway = FakeGateway(claim={'runId': None, 'reason': 'no_due_run'})
    worker = build_worker(tmp_path, gateway, exporter_raising(AssertionError('no export')))

    worker.run_once()

    assert {call['name'] for call in gateway.calls} == {'register_worker', 'claim_run'}
    assert 'nextRunAt' not in json.dumps(gateway.calls, ensure_ascii=False)


# ---------------------------------------------------------------------------
# shutdown / test hold / logs
# ---------------------------------------------------------------------------

def test_graceful_shutdown_stops_loop(tmp_path):
    gateway = FakeGateway(claim={'runId': None, 'reason': 'no_due_run'})
    config = make_config(tmp_path)
    worker = Worker(config, gateway, exporter=exporter_raising(AssertionError('no export')))
    worker._install_signal_handlers = lambda: None

    def fake_sleep(_seconds):
        worker.stop('test-signal')

    worker._sleep = fake_sleep
    worker.run_forever()

    text = log_text(config)
    assert 'worker_started' in text
    assert 'worker_stopped' in text
    assert 'worker_shutdown_requested' in text


def test_shutdown_during_export_abandons_run_without_publish(tmp_path):
    import time as _time

    import worker as worker_module

    checker_calls = {'n': 0}
    gateway = FakeGateway(claim=make_claim([WH_A]))

    def slow_exporter(work_dir, *, timeout_seconds):
        worker.stop('test-sigterm')
        _time.sleep(0.3)
        return {'exportMark': 'late-mark'}

    worker = build_worker(tmp_path, gateway, slow_exporter)
    worker._renew_interval = 0.05
    original = worker_module.SHUTDOWN_EXPORT_GRACE_SECONDS
    worker_module.SHUTDOWN_EXPORT_GRACE_SECONDS = 0.05
    try:
        with pytest.raises(ShutdownRequested):
            worker.run_once()
    finally:
        worker_module.SHUTDOWN_EXPORT_GRACE_SECONDS = original

    assert gateway.calls_named('register_export') == []
    assert gateway.calls_named('publish_warehouse') == []
    assert 'worker_shutdown_abandon_export' in log_text(worker.config)


def test_test_hold_env_pauses_and_logs(tmp_path, monkeypatch):
    gateway = FakeGateway(claim=make_claim([WH_A]))
    worker = build_worker(tmp_path, gateway, exporter_writing(MIN_HEADER, [GOOD_A]))
    monkeypatch.setenv('INVENTORY_WORKER_TEST_HOLD_PHASE', 'register')
    monkeypatch.setenv('INVENTORY_WORKER_TEST_HOLD_MS', '40')
    import time as _time
    started = _time.monotonic()

    outcome = worker.run_once()

    assert outcome['status'] == 'success'
    assert _time.monotonic() - started >= 0.03
    assert 'worker_test_hold' in log_text(worker.config)


def test_test_hold_disabled_by_default(tmp_path):
    gateway = FakeGateway(claim=make_claim([WH_A]))
    worker = build_worker(tmp_path, gateway, exporter_writing(MIN_HEADER, [GOOD_A]))

    worker.run_once()

    assert 'worker_test_hold' not in log_text(worker.config)


def test_logs_never_contain_credentials_amounts_or_account_label(tmp_path):
    gateway = FakeGateway(claim=make_claim())
    worker = build_worker(tmp_path, gateway, exporter_writing(MIN_HEADER, [GOOD_A, GOOD_B]))

    worker.run_once()

    text = log_text(worker.config)
    assert text
    for line in text.splitlines():
        record = json.loads(line)
        assert set(record) >= {'ts', 'level', 'event', 'workerId'}
    assert 'postgres://' not in text
    assert 'syncsecret' not in text
    assert 'supersecret' not in text
    assert '12.30' not in text
    assert ACCOUNT_LABEL not in text
    assert 'totalCostText' not in text


def test_register_payload_file_whitelist_and_no_local_path(tmp_path):
    gateway = FakeGateway(claim=make_claim([WH_A]))
    worker = build_worker(tmp_path, gateway, exporter_writing(MIN_HEADER, [GOOD_A]))

    worker.run_once()

    payload = register_payload(gateway)
    assert set(payload['file']) == {
        'storageRelpath', 'sha256', 'sizeBytes', 'sheetName', 'header',
        'rowCount', 'blankRowCount',
    }
    assert payload['file']['storageRelpath'] == 'exports/bigseller-inventory-test.xlsx'
    assert payload['fileValidation']['quantityHeader']['on_hand'] == '现有库存'
    assert payload['accountIdentity']['verified'] is True
