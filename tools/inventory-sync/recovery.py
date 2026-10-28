"""Restart/recovery helpers for the inventory-sync-v1 worker.

Contract §1 / §4:
  * before doing new work, call ``read_inventory_run_work`` and skip warehouses that
    already have a published batch for this run;
  * a run whose status is ``outcome_unknown`` must not be re-published: only the
    already-committed database state may be inspected, and the run is then closed
    without new writes (or left as outcome_unknown when it cannot be resolved);
  * ``needs_login`` means stop retrying and mark the account as needing a login;
    the worker must not loop on the failed run.

This module is deliberately pure (no DB or browser calls) so it can be unit tested.
"""
from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

OUTCOME_UNKNOWN = 'outcome_unknown'
NEEDS_LOGIN_REASONS = ('account_needs_login', 'needs_login')


def _get(mapping: Any, *names: str, default: Any = None) -> Any:
    if isinstance(mapping, dict):
        for name in names:
            if mapping.get(name) is not None:
                return mapping[name]
        return default
    for name in names:
        value = getattr(mapping, name, None)
        if value is not None:
            return value
    return default


def published_warehouses(work: dict | None) -> dict[str, dict]:
    """Map warehouse id -> {'batchId','rowCount','observationAt','current'}."""
    result: dict[str, dict] = {}
    for item in (work or {}).get('publishedWarehouses') or []:
        warehouse_id = _get(item, 'warehouseId', 'warehouse_id')
        if not warehouse_id:
            continue
        result[str(warehouse_id)] = {
            'batchId': _get(item, 'batchId', 'batch_id'),
            'rowCount': _get(item, 'rowCount', 'row_count'),
            'observationAt': _get(item, 'observationAt', 'observation_at'),
            'publishedAt': _get(item, 'publishedAt', 'published_at'),
            'current': _get(item, 'current'),
        }
    return result


def work_observation_at(work: dict | None) -> str | None:
    """Authoritative observation time: only the DB run's exportFinishedAt/observationAt."""
    work = work or {}
    value = (work.get('exportFinishedAt') or work.get('observationAt')
             or work.get('export_finished_at') or work.get('observation_at'))
    if value:
        return str(value)
    file_info = work.get('file') or {}
    value = (file_info.get('exportFinishedAt') if isinstance(file_info, dict) else None)
    return str(value) if value else None


def work_export_times(work: dict | None) -> dict:
    work = work or {}
    return {
        'exportStartedAt': work.get('exportStartedAt') or work.get('export_started_at'),
        'exportFinishedAt': work.get('exportFinishedAt') or work.get('export_finished_at'),
        'downloadedAt': work.get('downloadedAt') or work.get('downloaded_at'),
        'observationAt': work_observation_at(work),
    }


def work_identity(work: dict | None) -> dict:
    """``accountIdentity`` from read_inventory_run_work.

    The DB returns ``accountIdentityStatus`` / ``accountIdentityLabel`` at the top
    level; older fakes/tests may provide a nested ``accountIdentity`` object.
    """
    work = work or {}
    raw = work.get('accountIdentity') or work.get('account_identity')
    status = _get(raw, 'status', default=None) if raw else None
    label = _get(raw, 'label') if raw else None
    if status is None:
        status = work.get('accountIdentityStatus') or work.get('account_identity_status')
    if label is None:
        label = work.get('accountIdentityLabel') or work.get('account_identity_label')
    status = str(status or '')
    return {
        'status': status,
        'label': str(label) if label is not None else None,
        'verified': status == 'verified',
    }


def work_file_validation(work: dict | None) -> dict:
    raw = (work or {}).get('fileValidation') or (work or {}).get('file_validation') or {}
    return raw if isinstance(raw, dict) else {}


def work_discovery(work: dict | None) -> list[dict]:
    """Discovery entries recorded with the run (required to re-parse a recovered file)."""
    raw = ((work or {}).get('warehouseDiscovery')
           or (work or {}).get('warehouse_discovery')
           or (work or {}).get('discoveredWarehouses')
           or [])
    result: list[dict] = []
    for item in raw if isinstance(raw, list) else []:
        external_id = _get(item, 'externalId', 'external_id', 'id')
        name = _get(item, 'name')
        if external_id is None or name is None:
            continue
        result.append({'externalId': str(external_id), 'name': str(name)})
    return result


def plan_recovery(work: dict | None) -> dict:
    """Turn a read_inventory_run_work result into an execution plan."""
    work = work or {}
    published = published_warehouses(work)
    status = str(work.get('status') or '')
    return {
        'status': status,
        'publishedWarehouses': published,
        'publishedIds': set(published),
        'outcomeUnknown': status == OUTCOME_UNKNOWN,
        'file': work.get('file'),
        'exportMark': work.get('exportMark'),
        'hasFile': bool(work.get('file')),
    }


def locate_recovered_file(work: dict | None, *, work_dir: str | Path,
                          export_dir: str | Path | None = None) -> Path | None:
    """Find the already-downloaded workbook recorded by the run.

    ``read_inventory_run_work`` returns the file's sha256/sizeBytes (and may return
    storageRelpath). When only the hash is available, the file is located by exact
    sha256 inside the run export directory -- never by "newest file" guessing.
    """
    file_info = _get((work or {}), 'file') or {}
    raw = _get(file_info, 'storageRelpath', 'storage_relpath', 'filePath', 'file_path')
    roots = [Path(work_dir)]
    if export_dir:
        roots.append(Path(export_dir))
    options: list[Path] = []
    if raw:
        candidate = Path(str(raw))
        if candidate.is_absolute():
            options.append(candidate)
        else:
            options.extend(root / candidate for root in roots)
            options.append(candidate)
        for option in options:
            try:
                if option.is_file():
                    return option
            except OSError:  # pragma: no cover
                continue

    expected_sha = _get(file_info, 'sha256')
    if not expected_sha:
        return None
    expected_size = _get(file_info, 'sizeBytes', 'size_bytes')
    for root in roots:
        try:
            if not root.is_dir():
                continue
            candidates = sorted(root.glob('*.xlsx'))
        except OSError:  # pragma: no cover
            continue
        for candidate in candidates:
            try:
                if expected_size is not None and candidate.stat().st_size != int(expected_size):
                    continue
                if _sha256_file(candidate) == expected_sha:
                    return candidate
            except (OSError, ValueError):  # pragma: no cover
                continue
    return None


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def claim_reason(claim: dict | None) -> str | None:
    """Reason string for an idle claim (e.g. no_due_run / account_needs_login)."""
    if not claim or claim.get('runId'):
        return None
    return str(claim.get('reason') or 'unknown')


def is_needs_login_reason(reason: str | None) -> bool:
    return str(reason or '') in NEEDS_LOGIN_REASONS


def evaluate_outcome_unknown(work: dict | None, claimed_warehouses: list[Any]) -> dict:
    """Compare published batches against the claimed scope without publishing."""
    plan = plan_recovery(work)
    published = plan['publishedWarehouses']
    missing: list[dict] = []
    present: list[dict] = []
    for warehouse in claimed_warehouses or []:
        warehouse_id = _get(warehouse, 'id', 'warehouseId', 'warehouse_id')
        entry = {
            'warehouseId': str(warehouse_id) if warehouse_id else None,
            'externalId': _get(warehouse, 'externalId', 'external_id'),
            'name': _get(warehouse, 'name'),
        }
        if warehouse_id and str(warehouse_id) in published:
            present.append({**entry, **published[str(warehouse_id)]})
        else:
            missing.append(entry)
    all_published = bool(claimed_warehouses) and not missing
    return {
        'allPublished': all_published,
        'present': present,
        'missing': missing,
        'publishedCount': len(present),
        'claimedCount': len(claimed_warehouses or []),
    }


def recovery_summary(plan: dict, claimed_warehouses: list[Any]) -> dict:
    """Summary used when a recovered run is finished without new publishes."""
    return {
        'recovered': True,
        'outcomeUnknown': bool(plan.get('outcomeUnknown')),
        'published': len(plan.get('publishedWarehouses') or {}),
        'claimed': len(claimed_warehouses or []),
        'warehouses': [
            {
                'warehouseId': str(_get(warehouse, 'id', 'warehouseId', 'warehouse_id') or '') or None,
                'externalId': _get(warehouse, 'externalId', 'external_id'),
                'name': _get(warehouse, 'name'),
                'status': 'published' if str(_get(warehouse, 'id') or '') in plan.get('publishedIds', set())
                else 'notPublished',
            }
            for warehouse in (claimed_warehouses or [])
        ],
    }
