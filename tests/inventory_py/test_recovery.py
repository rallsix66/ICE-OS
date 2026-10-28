"""Recovery-helper tests (pure functions; repair v2 adds work identity/time/discovery)."""
from __future__ import annotations

import hashlib
from pathlib import Path

import recovery as inventory_recovery

from fakes import (
    ACCOUNT_LABEL,
    DEFAULT_DISCOVERY,
    OBSERVATION_AT,
    RUN_ID,
    WH_A,
    WH_B,
    make_work,
)


def work_with_published(*warehouse_ids: str, status: str = 'running', file=None) -> dict:
    return {
        'runId': RUN_ID,
        'status': status,
        'publishedWarehouses': [
            {'warehouseId': warehouse_id, 'batchId': f'batch-{index}', 'rowCount': index + 1}
            for index, warehouse_id in enumerate(warehouse_ids)
        ],
        'file': file,
        'exportMark': 'mark-1',
        'exportFinishedAt': OBSERVATION_AT,
        'accountIdentity': {'status': 'verified', 'label': ACCOUNT_LABEL},
        'fileValidation': {'status': 'ok', 'reason': ''},
        'warehouseDiscovery': [dict(entry) for entry in DEFAULT_DISCOVERY],
    }


def test_published_warehouses_extraction_includes_times():
    work = work_with_published(WH_A['id'], WH_B['id'])
    work['publishedWarehouses'][0]['observationAt'] = OBSERVATION_AT
    published = inventory_recovery.published_warehouses(work)

    assert set(published) == {WH_A['id'], WH_B['id']}
    assert published[WH_A['id']]['batchId'] == 'batch-0'
    assert published[WH_A['id']]['observationAt'] == OBSERVATION_AT


def test_work_observation_at_only_from_db_fields():
    work = work_with_published(WH_A['id'])
    assert inventory_recovery.work_observation_at(work) == OBSERVATION_AT

    work['observationAt'] = '2026-10-20T01:00:00+00:00'
    assert inventory_recovery.work_observation_at(work) == OBSERVATION_AT

    missing = work_with_published(WH_A['id'])
    missing.pop('exportFinishedAt', None)
    missing.pop('observationAt', None)
    assert inventory_recovery.work_observation_at(missing) is None


def test_work_identity_and_file_validation():
    work = make_work()
    identity = inventory_recovery.work_identity(work)
    assert identity == {'status': 'verified', 'label': ACCOUNT_LABEL, 'verified': True}

    unverified = make_work(accountIdentity={'status': 'mismatch', 'label': 'other'})
    assert inventory_recovery.work_identity(unverified)['verified'] is False

    blocked = make_work(fileValidation={'status': 'blocked', 'reason': '组合 SKU'})
    assert inventory_recovery.work_file_validation(blocked)['status'] == 'blocked'


def test_work_identity_reads_db_top_level_shape():
    """The real read_inventory_run_work returns accountIdentityStatus/Label top-level."""
    work = {
        'accountIdentityStatus': 'verified',
        'accountIdentityLabel': ACCOUNT_LABEL,
        'fileValidation': {'status': 'ok', 'blocked': False, 'reason': ''},
        'warehouseDiscovery': [dict(entry) for entry in DEFAULT_DISCOVERY],
        'exportFinishedAt': OBSERVATION_AT,
    }
    identity = inventory_recovery.work_identity(work)
    assert identity['verified'] is True
    assert identity['label'] == ACCOUNT_LABEL

    work['accountIdentityStatus'] = 'mismatch'
    assert inventory_recovery.work_identity(work)['verified'] is False


def test_work_discovery_entries():
    work = make_work()
    discovery = inventory_recovery.work_discovery(work)
    assert {'externalId': WH_A['externalId'], 'name': WH_A['name']} in discovery
    assert inventory_recovery.work_discovery({'warehouseDiscovery': []}) == []


def test_plan_recovery_flags_outcome_unknown():
    normal = inventory_recovery.plan_recovery(work_with_published(WH_A['id']))
    assert normal['outcomeUnknown'] is False
    assert normal['publishedIds'] == {WH_A['id']}
    assert normal['hasFile'] is False

    unknown = inventory_recovery.plan_recovery(
        work_with_published(WH_A['id'], status='outcome_unknown',
                            file={'storageRelpath': 'x.xlsx'}))
    assert unknown['outcomeUnknown'] is True
    assert unknown['hasFile'] is True


def test_locate_recovered_file_by_path_and_sha(tmp_path):
    export_dir = tmp_path / 'inventory-work' / 'exports'
    export_dir.mkdir(parents=True)
    target = export_dir / 'bigseller-inventory-20261025-091141.xlsx'
    target.write_bytes(b'workbook-bytes')
    digest = hashlib.sha256(b'workbook-bytes').hexdigest()

    absolute = {'file': {'storageRelpath': str(target)}}
    assert inventory_recovery.locate_recovered_file(absolute, work_dir=tmp_path) == target

    relative = {'file': {'storageRelpath': 'exports/bigseller-inventory-20261025-091141.xlsx'}}
    assert inventory_recovery.locate_recovered_file(
        relative, work_dir=tmp_path / 'inventory-work') == target

    sha_only = {'file': {'sha256': digest, 'sizeBytes': len(b'workbook-bytes')}}
    assert inventory_recovery.locate_recovered_file(
        sha_only, work_dir=tmp_path / 'inventory-work', export_dir=export_dir) == target

    wrong = {'file': {'sha256': 'f' * 64, 'sizeBytes': len(b'workbook-bytes')}}
    assert inventory_recovery.locate_recovered_file(
        wrong, work_dir=tmp_path / 'inventory-work', export_dir=export_dir) is None


def test_evaluate_outcome_unknown():
    claimed = [dict(WH_A), dict(WH_B)]
    fully_published = inventory_recovery.evaluate_outcome_unknown(
        work_with_published(WH_A['id'], WH_B['id'], status='outcome_unknown'), claimed)
    assert fully_published['allPublished'] is True
    assert fully_published['publishedCount'] == 2

    partially_published = inventory_recovery.evaluate_outcome_unknown(
        work_with_published(WH_A['id'], status='outcome_unknown'), claimed)
    assert partially_published['allPublished'] is False
    assert [entry['externalId'] for entry in partially_published['missing']] == [
        WH_B['externalId']]


def test_claim_reason_and_needs_login():
    assert inventory_recovery.claim_reason({'runId': None, 'reason': 'no_due_run'}) == 'no_due_run'
    assert inventory_recovery.claim_reason({'runId': RUN_ID}) is None
    assert inventory_recovery.claim_reason(None) is None
    assert inventory_recovery.is_needs_login_reason('account_needs_login') is True
    assert inventory_recovery.is_needs_login_reason('needs_login') is True
    assert inventory_recovery.is_needs_login_reason('account_disabled') is False


def test_recovery_summary_lists_status_per_warehouse():
    plan = inventory_recovery.plan_recovery(work_with_published(WH_A['id']))
    summary = inventory_recovery.recovery_summary(plan, [WH_A, WH_B])
    statuses = {entry['externalId']: entry['status'] for entry in summary['warehouses']}

    assert statuses == {WH_A['externalId']: 'published', WH_B['externalId']: 'notPublished'}
    assert summary['published'] == 1
    assert summary['claimed'] == 2
