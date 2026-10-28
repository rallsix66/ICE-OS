"""Complete-warehouse publishing for the inventory-sync-v1 worker (repair v2 / R3).

Rules implemented here (repair contract §2):
  * a bad row that can be attributed to a warehouse (invalid quantity, duplicate SKU,
    missing SKU) blocks that **whole warehouse**; the remaining good warehouses may
    still publish independently (``partial``);
  * combo SKU rows, unattributable rows, bad headers/file validation block the
    **whole file** -- no warehouse is published;
  * rows are never filtered down and reported as a complete warehouse: every
    registered ``ok`` row of the warehouse is sent, plus ``excelRow`` so the DB can
    compare the payload with the registered run rows (``excelRow`` + ``rowHash``);
  * warehouses are attributed by stable external id from the export discovery;
    scope warehouses missing from discovery or with a changed name are blocked
    (never identified by a guessed name);
  * rows outside the configured scope (explicitly excluded / newly discovered) are
    only counted, never published and never block the file;
  * amount columns never enter a public publish payload.
"""
from __future__ import annotations

from typing import Any, Callable, Iterable

import parser as inventory_parser

LEASE_ERROR_CODES = ('INVENTORY_LEASE_LOST',)
FILE_BLOCK_CODES = (
    'INVENTORY_FILE_BLOCKED',
    'INVENTORY_ACCOUNT_IDENTITY_UNVERIFIED',
    'INVENTORY_OBSERVATION_MISSING',
)

ERROR_REASONS = {
    'INVENTORY_LEASE_LOST': '执行凭证已失效（任务可能已被其它执行者接管），本次不再发布',
    'INVENTORY_WAREHOUSE_OUT_OF_SCOPE': '该仓库已不在本次同步范围内，未发布',
    'INVENTORY_WAREHOUSE_NOT_DISCOVERED': '本次导出未发现该参与仓（稳定外部 id 缺失），未发布，待核对',
    'INVENTORY_WAREHOUSE_RENAMED': '仓库名称与登记不一致（疑似更名），未凭名称认身份，未发布',
    'INVENTORY_WAREHOUSE_BLOCKED': '该仓存在未通过校验的行（数量非法/重复 SKU/缺 SKU），整仓未发布',
    'INVENTORY_WAREHOUSE_INCOMPLETE': '发布行与该仓登记原行不一致（缺行/多行/内容不同），拒绝发布',
    'INVENTORY_FILE_BLOCKED': '整份文件校验未通过（表头/组合 SKU/无法归属仓），未发布任何仓',
    'INVENTORY_FILE_VALIDATION_BLOCKED': '数据库判定整份文件校验 blocked，未发布任何仓',
    'INVENTORY_IDENTITY_UNVERIFIED': '数据库判定来源账号身份未验证，拒绝发布',
    'INVENTORY_EXPORT_TIME_MISSING': '任务缺少来源导出完成时间（exportFinishedAt），拒绝登记/发布',
    'INVENTORY_EXPORT_MISSING': '任务尚未登记导出文件，拒绝发布',
    'INVENTORY_RUN_NOT_ACTIVE': '任务已不在可执行状态（可能已被接管/结束）',
    'INVENTORY_OUTCOME_UNKNOWN_LOCKED': '任务处于结果未知状态，只允许核对不允许发布',
    'INVENTORY_DUPLICATE_SKU': '发布行包含重复 SKU，拒绝发布',
    'INVENTORY_INVALID_ROW': '发布行不符合契约字段要求，拒绝发布',
    'INVENTORY_ACCOUNT_IDENTITY_UNVERIFIED': '来源账号身份未验证，拒绝登记/发布',
    'INVENTORY_ACCOUNT_IDENTITY_MISSING': '导出结果缺少来源账号标识，拒绝登记/发布',
    'INVENTORY_ACCOUNT_IDENTITY_MISMATCH': '导出账号与任务固定账号不一致，拒绝登记/发布',
    'INVENTORY_OBSERVATION_MISSING': '缺少来源导出完成时间（observation），拒绝发布/恢复',
    'INVENTORY_BATCH_CONFLICT': '同一任务同一仓库的内容与已发布批次冲突（不一致），拒绝重复发布',
    'INVENTORY_EXPORT_CONFLICT': '同一任务已登记过不同的导出文件，拒绝覆盖',
    'INVENTORY_REQUEST_CONFLICT': '请求回执与原始请求不一致，需要人工核对',
    'INVENTORY_MAPPING_VERSION_CONFLICT': '商品对应关系已更新，需要重新核对后再发布',
    'MALFORMED_RPC_RESULT': '数据库函数返回结果无法识别',
    'DB_RPC_ERROR': '数据库拒绝了本次发布',
}


class LeaseLostError(RuntimeError):
    """The lease was taken over; this executor must stop touching the run."""


class OutcomeUnknownError(RuntimeError):
    """A write may have been applied without a response (contract: outcome_unknown)."""

    def __init__(self, phase: str, detail: str = ''):
        super().__init__(detail or phase)
        self.phase = phase
        self.detail = detail


class FileBlockedError(RuntimeError):
    """The DB rejected the whole file (identity/file-validation) during publishing."""

    def __init__(self, code: str, detail: str = ''):
        super().__init__(f'{code}: {detail}' if detail else code)
        self.code = code
        self.detail = detail


FILE_BLOCK_DB_CODES = (
    'INVENTORY_FILE_BLOCKED',
    'INVENTORY_FILE_VALIDATION_BLOCKED',
    'INVENTORY_IDENTITY_UNVERIFIED',
    'INVENTORY_EXPORT_TIME_MISSING',
)


def describe_error(code: str | None, detail: str | None = None) -> str:
    """Readable Chinese reason for a database error code (never includes amounts)."""
    if not code:
        return '未知错误'
    reason = ERROR_REASONS.get(code)
    if not reason:
        reason = f'发布被拒绝（{code}）'
    if detail and detail not in reason:
        return f'{reason}：{_clip(detail)}'
    return reason


def _clip(text: Any, limit: int = 180) -> str:
    value = str(text).replace('\n', ' ').strip()
    return value if len(value) <= limit else value[:limit] + '…'


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


def _warehouse_id(warehouse: Any) -> str | None:
    value = _get(warehouse, 'id', 'warehouseId', 'warehouse_id')
    return str(value) if value is not None else None


def _warehouse_external_id(warehouse: Any) -> str | None:
    value = _get(warehouse, 'externalId', 'external_id')
    return str(value) if value is not None else None


def _warehouse_name(warehouse: Any) -> str:
    return str(_get(warehouse, 'name', 'external_name', default='') or '')


def discovery_index(discovery: Iterable[Any] | None) -> tuple[dict[str, dict], dict[str, list[dict]]]:
    by_id: dict[str, dict] = {}
    by_name: dict[str, list[dict]] = {}
    for item in discovery or []:
        external_id = _warehouse_external_id(item)
        name = _warehouse_name(item)
        if not external_id or not name:
            continue
        entry = {'externalId': external_id, 'name': name}
        by_id[external_id] = entry
        by_name.setdefault(inventory_parser.normalize_warehouse_name(name), []).append(entry)
    return by_id, by_name


def classify_rows(claimed_warehouses: Iterable[Any],
                  discovery: Iterable[Any] | None,
                  rows: Iterable[dict],
                  file_validation: dict | None) -> dict:
    """Attribute rows to scope warehouses and decide file/warehouse blocking."""
    claimed = list(claimed_warehouses or [])
    by_id, by_name = discovery_index(discovery)
    scope_ids = {_warehouse_external_id(warehouse) for warehouse in claimed
                 if _warehouse_external_id(warehouse)}
    by_name_scope = {
        inventory_parser.normalize_warehouse_name(_warehouse_name(warehouse)): warehouse
        for warehouse in claimed if _warehouse_name(warehouse)
    }
    by_id_scope = {_warehouse_external_id(warehouse): warehouse for warehouse in claimed
                   if _warehouse_external_id(warehouse)}

    groups: dict[str, dict] = {}
    for warehouse in claimed:
        external_id = _warehouse_external_id(warehouse)
        groups[external_id or ''] = {
            'warehouseId': _warehouse_id(warehouse),
            'externalId': external_id,
            'name': _warehouse_name(warehouse),
            'discovered': by_id.get(external_id) if external_id else None,
            'allRows': [],
            'okRows': [],
            'badRows': [],
            'excelRows': [],
            'invalidRows': 0,
            'duplicateSkuRows': 0,
            'missingSkuRows': 0,
            'notDiscovered': bool(external_id) and external_id not in by_id,
            'nameChanged': False,
            'blocked': False,
            'blockReason': None,
            'errorCode': None,
        }
        discovered = by_id.get(external_id) if external_id else None
        if discovered and _warehouse_name(warehouse):
            if (inventory_parser.normalize_warehouse_name(discovered['name'])
                    != inventory_parser.normalize_warehouse_name(_warehouse_name(warehouse))):
                groups[external_id]['nameChanged'] = True

    out_of_scope: list[dict] = []
    unattributable: list[dict] = []
    combo_rows: list[dict] = []
    for row in rows or []:
        external_id = row.get('warehouseExternalId')
        name = row.get('warehouseName')
        if not external_id:
            # fall back to exact discovery name only (never guess an id)
            candidates = by_name.get(inventory_parser.normalize_warehouse_name(str(name))) if name else None
            if candidates and len(candidates) == 1:
                external_id = candidates[0]['externalId']
        status = row.get('parseStatus')
        if status == 'combo_sku':
            combo_rows.append(row)
        if not external_id:
            unattributable.append(row)
            continue
        external_id = str(external_id)
        if external_id not in scope_ids:
            out_of_scope.append(row)
            continue
        group = by_id_scope.get(external_id)
        group_key = external_id
        target = groups.get(group_key)
        if target is None:  # pragma: no cover - defensive
            unattributable.append(row)
            continue
        target['allRows'].append(row)
        target['excelRows'].append(row.get('excelRow'))
        if status == 'ok':
            target['okRows'].append(row)
        else:
            target['badRows'].append(row)
            if status == 'invalid_quantity':
                target['invalidRows'] += 1
            elif status == 'duplicate_sku':
                target['duplicateSkuRows'] += 1
            elif status == 'missing_sku':
                target['missingSkuRows'] += 1

    file_block_reasons: list[str] = []
    validation = file_validation or {}
    if validation.get('blocked') is True or validation.get('status') not in (None, 'ok'):
        file_block_reasons.append(str(validation.get('reason') or '文件级校验未通过'))
    if combo_rows:
        file_block_reasons.append(f'文件包含 {len(combo_rows)} 行组合/Combo SKU')
    if unattributable:
        file_block_reasons.append(f'文件包含 {len(unattributable)} 行无法归属仓库')

    for group in groups.values():
        if group['notDiscovered']:
            group['blocked'] = True
            group['errorCode'] = 'INVENTORY_WAREHOUSE_NOT_DISCOVERED'
            group['blockReason'] = describe_error(
                'INVENTORY_WAREHOUSE_NOT_DISCOVERED',
                f'externalId={group["externalId"]}')
        elif group['nameChanged']:
            group['blocked'] = True
            group['errorCode'] = 'INVENTORY_WAREHOUSE_RENAMED'
            group['blockReason'] = describe_error(
                'INVENTORY_WAREHOUSE_RENAMED',
                f'externalId={group["externalId"]} registered={group["name"]} '
                f'discovered={group["discovered"]["name"] if group["discovered"] else ""}')
        elif group['badRows']:
            group['blocked'] = True
            group['errorCode'] = 'INVENTORY_WAREHOUSE_BLOCKED'
            statuses: dict[str, int] = {}
            for row in group['badRows']:
                key = str(row.get('parseStatus'))
                statuses[key] = statuses.get(key, 0) + 1
            status_text = '、'.join(f'{key}×{count}' for key, count in sorted(statuses.items()))
            group['blockReason'] = (
                f'该仓存在 {len(group["badRows"])} 行未通过校验（{status_text}；'
                f'Excel行 {",".join(str(r.get("excelRow")) for r in group["badRows"][:20])}），整仓未发布')

    return {
        'groups': [groups[key] for key in groups],
        'outOfScopeRows': out_of_scope,
        'outOfScopeWarehouseNames': sorted({
            str(row.get('warehouseName')) for row in out_of_scope if row.get('warehouseName')
        }),
        'unattributableRows': unattributable,
        'comboRows': combo_rows,
        'fileBlocked': bool(file_block_reasons),
        'fileBlockReason': '；'.join(file_block_reasons),
    }


def build_publish_rows(rows: Iterable[dict]) -> list[dict]:
    """Build the publish payload rows (no amounts; includes excelRow + rowHash).

    Any non-``ok`` or unparsable row here is a bug: the caller must block the whole
    warehouse instead of filtering it down.
    """
    payload_rows: list[dict] = []
    for row in rows:
        if row.get('parseStatus') != 'ok':
            raise ValueError(f'row {row.get("excelRow")} is not ok: {row.get("parseStatus")}')
        numbers: dict[str, int | None] = {}
        for field in inventory_parser.QUANTITY_FIELDS:
            value, invalid_raw = inventory_parser.parse_quantity(row.get(_text_key(field)))
            numbers[field] = value
            if invalid_raw is not None:
                raise ValueError(f'row {row.get("excelRow")} quantity invalid')
        payload_rows.append({
            'excelRow': row.get('excelRow'),
            'externalSku': row.get('externalSku'),
            'gtin': row.get('gtin'),
            'onHand': numbers['on_hand'],
            'orderLocked': numbers['order_locked'],
            'warehouseAvailable': numbers['warehouse_available'],
            'activityReserved': numbers['activity_reserved'],
            'inTransit': numbers['in_transit'],
            'rawOnHand': row.get('onHandText'),
            'rawOrderLocked': row.get('orderLockedText'),
            'rawWarehouseAvailable': row.get('warehouseAvailableText'),
            'rawActivityReserved': row.get('activityReservedText'),
            'rawInTransit': row.get('inTransitText'),
            'rowHash': row.get('rowHash'),
        })
    return payload_rows


def _text_key(field: str) -> str:
    return inventory_parser.TEXT_FIELD_KEYS[field]


def publish_run(
    gateway: Any,
    run_id: str,
    lease: str,
    claimed_warehouses: Iterable[Any],
    discovery: Iterable[Any] | None,
    rows: Iterable[dict],
    file_validation: dict | None,
    observation_at: str,
    *,
    already_published: dict[str, dict] | None = None,
    on_warehouse_start: Callable[[Any], None] | None = None,
) -> dict:
    """Publish every healthy scope warehouse; never filter bad rows down.

    ``already_published`` maps warehouse id -> {'batchId','rowCount',...} recovered
    from ``read_inventory_run_work``; those warehouses are not republished.
    """
    already_published = already_published or {}
    classified = classify_rows(claimed_warehouses, discovery, rows, file_validation)
    outcome: dict[str, Any] = {
        'published': [],
        'failed': [],
        'noRows': [],
        'blocked': [],
        'warehouses': [],
        'fileBlocked': classified['fileBlocked'],
        'fileBlockReason': classified['fileBlockReason'],
        'outOfScopeRows': classified['outOfScopeRows'],
        'outOfScopeWarehouseNames': classified['outOfScopeWarehouseNames'],
        'unattributableRows': classified['unattributableRows'],
    }
    if classified['fileBlocked']:
        return outcome

    for group in classified['groups']:
        warehouse_id = group.get('warehouseId')
        entry: dict[str, Any] = {
            'warehouseId': warehouse_id,
            'externalId': group.get('externalId'),
            'name': group.get('name'),
            'rowCount': 0,
            'invalidRows': group.get('invalidRows', 0),
            'duplicateSkuRows': group.get('duplicateSkuRows', 0),
            'missingSkuRows': group.get('missingSkuRows', 0),
            'excelRows': group.get('excelRows', []),
        }
        recovered = already_published.get(warehouse_id) if warehouse_id else None
        if recovered:
            entry.update({
                'status': 'published',
                'recovered': True,
                'replayed': True,
                'batchId': recovered.get('batchId'),
                'rowCount': recovered.get('rowCount'),
                'reason': '恢复时该仓已发布，跳过重复发布',
            })
            outcome['published'].append(entry)
            outcome['warehouses'].append(entry)
            continue

        if group.get('blocked'):
            entry['excelRows'] = [row.get('excelRow') for row in group.get('badRows') or []]
            entry.update({
                'status': 'blocked',
                'errorCode': group.get('errorCode'),
                'reason': group.get('blockReason') or describe_error(group.get('errorCode')),
            })
            outcome['blocked'].append(entry)
            outcome['warehouses'].append(entry)
            continue

        ok_rows = group.get('okRows') or []
        if not ok_rows:
            if group.get('allRows'):
                reason = '该仓所有行均未通过校验，整仓未发布'
            else:
                reason = '本次导出无该仓行（缺仓不等于空仓），未发布'
            entry.update({'status': 'noRows', 'reason': reason})
            outcome['noRows'].append(entry)
            outcome['warehouses'].append(entry)
            continue

        if on_warehouse_start is not None:
            on_warehouse_start(entry)

        try:
            publish_rows = build_publish_rows(ok_rows)
        except ValueError as exc:
            entry.update({
                'status': 'blocked',
                'errorCode': 'INVENTORY_WAREHOUSE_BLOCKED',
                'reason': f'该仓存在无法发布的登记行：{exc}',
            })
            outcome['blocked'].append(entry)
            outcome['warehouses'].append(entry)
            continue

        warehouse_payload = {
            'warehouseId': warehouse_id,
            'warehouseExternalId': group.get('externalId'),
            'warehouseName': group.get('name'),
            'rowCount': len(publish_rows),
            'observationAt': observation_at,
        }
        try:
            response = gateway.publish_warehouse(run_id, lease, warehouse_payload, publish_rows)
        except Exception as exc:  # noqa: BLE001 - classify explicitly
            code = getattr(exc, 'code', None) or type(exc).__name__
            if code in LEASE_ERROR_CODES:
                raise LeaseLostError(describe_error(code, getattr(exc, 'detail', ''))) from exc
            if code == 'DB_UNAVAILABLE':
                raise OutcomeUnknownError('publish', str(exc)) from exc
            if code in FILE_BLOCK_DB_CODES:
                raise FileBlockedError(code, str(getattr(exc, 'detail', '') or str(exc))) from exc
            entry.update({
                'status': 'failed',
                'errorCode': code,
                'reason': describe_error(code, getattr(exc, 'detail', '') or str(exc)),
            })
            outcome['failed'].append(entry)
            outcome['warehouses'].append(entry)
            continue

        entry.update({
            'status': 'published',
            'batchId': response.get('batchId'),
            'replayed': bool(response.get('replayed')),
            'rowCount': response.get('rowCount', len(publish_rows)),
            'adopted': response.get('adopted'),
            'unmapped': response.get('unmapped'),
            'current': response.get('current'),
            'staleObservation': response.get('staleObservation'),
        })
        outcome['published'].append(entry)
        outcome['warehouses'].append(entry)

    return outcome


def decide_status(claimed_count: int, outcome: dict) -> str:
    """success = every claimed warehouse published; partial = some; failed = none."""
    if outcome.get('fileBlocked'):
        return 'failed'
    published = len(outcome.get('published') or [])
    if claimed_count > 0 and published == claimed_count:
        return 'success'
    if published > 0:
        return 'partial'
    return 'failed'


def build_summary(outcome: dict) -> dict:
    """Compact per-run summary: counts + structured reasons, no row values/amounts."""
    warehouses = []
    for entry in outcome.get('warehouses') or []:
        warehouses.append({
            'warehouseId': entry.get('warehouseId'),
            'externalId': entry.get('externalId'),
            'name': entry.get('name'),
            'status': entry.get('status'),
            'rowCount': entry.get('rowCount'),
            'invalidRows': entry.get('invalidRows', 0),
            'duplicateSkuRows': entry.get('duplicateSkuRows', 0),
            'missingSkuRows': entry.get('missingSkuRows', 0),
            'excelRows': entry.get('excelRows', []),
            'batchId': entry.get('batchId'),
            'replayed': entry.get('replayed'),
            'recovered': entry.get('recovered'),
            'adopted': entry.get('adopted'),
            'unmapped': entry.get('unmapped'),
            'errorCode': entry.get('errorCode'),
            'reason': entry.get('reason'),
        })
    return {
        'published': len(outcome.get('published') or []),
        'failed': len(outcome.get('failed') or []),
        'noRows': len(outcome.get('noRows') or []),
        'blocked': len(outcome.get('blocked') or []),
        'warehouses': warehouses,
        'fileBlocked': bool(outcome.get('fileBlocked')),
        'fileBlockReason': outcome.get('fileBlockReason') or '',
        'outOfScopeRows': len(outcome.get('outOfScopeRows') or []),
        'outOfScopeWarehouseNames': outcome.get('outOfScopeWarehouseNames') or [],
        'unattributableRowCount': len(outcome.get('unattributableRows') or []),
    }
