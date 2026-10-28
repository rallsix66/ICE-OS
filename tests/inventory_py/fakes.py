"""Shared fakes/helpers for the inventory worker unit tests (no real database/browser)."""
from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from pathlib import Path

from openpyxl import Workbook

from config import WorkerConfig
from db_gateway import GatewayUnavailable, RpcError

WH_A = {
    'id': '11111111-1111-4111-8111-111111111111',
    'externalId': '56673',
    'name': 'DEE-龙仔厝（ICE专属）',
}
WH_B = {
    'id': '22222222-2222-4222-8222-222222222222',
    'externalId': '52074',
    'name': 'DEE泰国海外仓(曼谷仓）',
}
# Explicitly excluded / out-of-scope warehouse (kept in discovery, never published).
WH_EXCLUDED = {
    'id': '44444444-4444-4444-8444-444444444444',
    'externalId': '48787',
    'name': '昕兰PH自建仓(弃用）',
}
# Newly discovered warehouse not yet in scope.
WH_NEW = {
    'id': '55555555-5555-4555-8555-555555555555',
    'externalId': '59999',
    'name': '新发现仓库',
}
DEFAULT_DISCOVERY = [
    {'externalId': WH_A['externalId'], 'name': WH_A['name']},
    {'externalId': WH_B['externalId'], 'name': WH_B['name']},
    {'externalId': WH_EXCLUDED['externalId'], 'name': WH_EXCLUDED['name']},
]
RUN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
LEASE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
ACCOUNT_LABEL = 'laiguoyong@KNZX019402'
OBSERVATION_AT = '2026-10-25T17:35:05+08:00'

STANDARD_HEADER = [
    'GTIN',
    '商品名称',
    '仓库',
    '现有库存',
    '订单已锁',
    '整仓可用',
    '在途中',
    '总成本价',
    'SKU信息',
]

STANDARD_ROWS = [
    ['6974674958025', '测试商品A', WH_A['name'], '3,793', '12', '3 781', '0', 'MYR 12.30', 'WM0043'],
    ['6974674958026', '测试商品B', WH_B['name'], '0', '', '0', '5', 'MYR 0.50', '780103214060'],
]

# Real 2026-10 BigSeller export header (28 columns, sheet 单个SKU, 728 data rows).
REAL_HEADER = [
    'Image URL', 'SKU编号', '名称', 'GTIN', '重量(g)', '长(cm)', '宽(cm)', '高(cm)',
    '仓库', '库区', '货架位', '现有库存', '订单已锁', '整仓可用', '活动预留', '在途中',
    '在途总成本', '警戒库存', '预测日销量', '预计可售天数', '加权成本价', '总成本价',
    '销售状态', '一级分类', '二级分类', '三级分类', 'SKU类型', '备注',
]

REAL_ROWS = [
    [
        'https://res.bigseller.pro/sku/images/1.jpg', '780103214060', '测试商品A',
        '6974674958025', '120.00', '15.00', '5.00', '5.00', WH_A['name'], '默认库区', 'A-01',
        '3,793', '12', '0.0', '--', '0', '0.00', '10', '0.00', '--', '1.23', 'MYR 12.30',
        '正常', '彩妆', '护肤', '面霜', 'Single SKU', '',
    ],
    [
        'https://res.bigseller.pro/sku/images/2.jpg', 'WM0111', '测试商品B',
        '', '10.00', '0.00', '0.00', '0.00', WH_B['name'], '', '',
        '0.0', '--', '0', '0', '--', '0.00', '0', '0.00', '--', '0.50', '',
        '下架', '彩妆', '护肤', '精华', 'Single SKU', '备注',
    ],
]


def corrupt_dimension(path: Path) -> Path:
    """Rewrite the worksheet <dimension> to A1, reproducing the BigSeller export bug."""
    import re
    import shutil
    import zipfile

    temporary = path.with_suffix('.corrupt.tmp')
    with zipfile.ZipFile(path) as source, zipfile.ZipFile(temporary, 'w', zipfile.ZIP_DEFLATED) as target:
        for item in source.infolist():
            data = source.read(item.filename)
            if item.filename == 'xl/worksheets/sheet1.xml':
                text = data.decode('utf-8')
                text = re.sub(r'<dimension ref="[^"]*"\s*/>', '<dimension ref="A1"/>', text)
                data = text.encode('utf-8')
            target.writestr(item, data)
    shutil.move(str(temporary), str(path))
    return path


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def write_workbook(path: Path, header: list, rows: list[list], *,
                   title_rows: list[list] | None = None,
                   sheet_name: str = '单个SKU') -> Path:
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = sheet_name
    for title_row in title_rows or []:
        sheet.append(title_row)
    sheet.append(header)
    for row in rows:
        sheet.append(row)
    path.parent.mkdir(parents=True, exist_ok=True)
    workbook.save(str(path))
    workbook.close()
    return path


def make_config(tmp_path: Path, **overrides) -> WorkerConfig:
    work_dir = Path(overrides.pop('work_dir', tmp_path / 'inventory-work'))
    log_path = Path(overrides.pop('log_path', work_dir / 'logs'))
    export_dir = Path(overrides.pop('export_dir', work_dir / 'exports'))
    log_path.mkdir(parents=True, exist_ok=True)
    export_dir.mkdir(parents=True, exist_ok=True)
    values = dict(
        run_id='run-20261025T165600Z-test',
        app_db_url='postgres://app_runner:secret@127.0.0.1:65535/testdb',
        sync_db_url='postgres://sync_runner:supersecret@127.0.0.1:65535/testdb',
        work_dir=work_dir,
        worker_id='test-worker',
        version='inv-sync-v1-test',
        lease_seconds=120,
        export_timeout_seconds=60,
        heartbeat_seconds=10,
        claim_seconds=10,
        log_path=log_path,
        export_dir=export_dir,
        account_label=ACCOUNT_LABEL,
    )
    values.update(overrides)
    return WorkerConfig(**values)


def make_claim(warehouses: list[dict] | None = None, **overrides) -> dict:
    claim = {
        'runId': RUN_ID,
        'leaseToken': LEASE,
        'triggerKind': 'manual',
        'plannedFor': now_iso(),
        'attempt': 1,
        'account': {'label': ACCOUNT_LABEL},
        'warehouses': [dict(warehouse) for warehouse in (warehouses or [WH_A, WH_B])],
        'scopeId': 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        'scopeVersion': 1,
    }
    claim.update(overrides)
    return claim


def make_work(**overrides) -> dict:
    work = {
        'runId': RUN_ID,
        'status': 'running',
        'publishedWarehouses': [],
        'file': None,
        'exportMark': None,
        'exportStartedAt': '2026-10-25T17:35:02+08:00',
        'exportFinishedAt': OBSERVATION_AT,
        'observationAt': OBSERVATION_AT,
        'downloadedAt': '2026-10-25T17:35:06+08:00',
        'accountIdentity': {'status': 'verified', 'label': ACCOUNT_LABEL},
        'fileValidation': {
            'status': 'ok', 'blocked': False, 'missingColumns': [], 'ambiguousColumns': [],
            'duplicateColumns': [], 'quantityHeader': {}, 'comboRowCount': 0,
            'unattributableRowCount': 0, 'reason': '',
        },
        'warehouseDiscovery': [dict(entry) for entry in DEFAULT_DISCOVERY],
    }
    work.update(overrides)
    return work


def export_result_for(path: Path, *, export_mark: str = 'mark-test-123456',
                      discovery: list[dict] | None = None,
                      account_label: str | None = ACCOUNT_LABEL,
                      export_started_at: str | None = None,
                      export_finished_at: str | None = None) -> dict:
    return {
        'exportMark': export_mark,
        'exportStartedAt': export_started_at or now_iso(),
        'exportFinishedAt': export_finished_at or now_iso(),
        'file': {
            'filePath': str(path),
            'storageRelpath': str(path),
            'sha256': sha256_file(path),
            'sizeBytes': path.stat().st_size,
            'sheetName': '单个SKU',
            'header': [],
        },
        'warehouseOptions': [
            {'id': entry['externalId'], 'name': entry['name']}
            for entry in (discovery if discovery is not None else DEFAULT_DISCOVERY)
        ],
        'selectedWarehouses': [],
        'singleSkuOnly': True,
        'accountLabel': account_label,
    }


def exporter_returning(result: dict):
    def export(work_dir, *, timeout_seconds):
        assert timeout_seconds > 0
        return result
    return export


def exporter_writing(header: list, rows: list[list], *, title_rows=None,
                     export_mark: str = 'mark-test-123456',
                     discovery: list[dict] | None = None,
                     account_label: str | None = ACCOUNT_LABEL):
    """Fake adapter: writes a workbook into the run export dir like the real adapter."""
    def export(work_dir, *, timeout_seconds):
        assert timeout_seconds > 0
        path = Path(work_dir) / 'bigseller-inventory-test.xlsx'
        write_workbook(path, header, rows, title_rows=title_rows)
        return export_result_for(path, export_mark=export_mark, discovery=discovery,
                                 account_label=account_label)
    return export


def exporter_raising(exc: BaseException):
    def export(work_dir, *, timeout_seconds):
        raise exc
    return export


class FakeExportError(RuntimeError):
    """Same shape as bigseller_export.ExportError (code/detail)."""

    def __init__(self, code: str, detail: str = '', *, fatal: bool = True):
        super().__init__(f'{code}: {detail}')
        self.code = code
        self.detail = detail
        self.fatal = fatal


def make_registration(account_status: str = 'active', **overrides) -> dict:
    registration = {
        'accountId': 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        'settings': {'enabled': True, 'intervalMinutes': 60, 'nextRunAt': now_iso(),
                     'scopeEmpty': False},
        'warehouseIds': [WH_A['id'], WH_B['id']],
        'warehouses': [
            {'id': WH_A['id'], 'externalId': WH_A['externalId'], 'name': WH_A['name'],
             'market': None},
            {'id': WH_B['id'], 'externalId': WH_B['externalId'], 'name': WH_B['name'],
             'market': None},
        ],
        'accountStatus': account_status,
        'accountLabel': ACCOUNT_LABEL,
    }
    registration.update(overrides)
    return registration


class FakeGateway:
    """In-memory stand-in for SyncDbGateway (contract §3.2)."""

    def __init__(self, *, claim: dict | None = None, work: dict | None = None,
                 registration: dict | None = None,
                 claim_sequence: list[dict] | None = None,
                 claim_error: BaseException | None = None,
                 heartbeat_error: BaseException | None = None,
                 read_error: BaseException | None = None,
                 register_export_error: BaseException | None = None,
                 publish_errors: dict[str, BaseException] | None = None,
                 finish_error: BaseException | None = None,
                 fail_error: BaseException | None = None,
                 phase_error: BaseException | None = None,
                 refresh_result: dict | None = None,
                 refresh_error: BaseException | None = None,
                 replay_rows: list[dict] | None = None):
        self.claim_value = claim if claim is not None else {'runId': None, 'reason': 'no_due_run'}
        self.claim_sequence = list(claim_sequence) if claim_sequence else None
        self.work_value = work if work is not None else make_work()
        self.registration = registration or make_registration()
        self.claim_error = claim_error
        self.heartbeat_error = heartbeat_error
        self.read_error = read_error
        self.register_export_error = register_export_error
        self.publish_errors = dict(publish_errors or {})
        self.finish_error = finish_error
        self.fail_error = fail_error
        self.phase_error = phase_error
        self.refresh_result = refresh_result or {
            'verified': True, 'status': 'active', 'mismatch': False,
        }
        self.refresh_error = refresh_error
        self.replay_rows = replay_rows
        self.calls: list[dict] = []

    def _record(self, name: str, **payload):
        self.calls.append({'name': name, **payload})

    # -- RPCs ---------------------------------------------------------------
    def register_worker(self, worker_id, host, pid, version):
        self._record('register_worker', workerId=worker_id, host=host, pid=pid, version=version)
        if self.heartbeat_error:
            raise self.heartbeat_error
        return self.registration

    def claim_run(self, worker_id, lease_seconds):
        self._record('claim_run', workerId=worker_id, leaseSeconds=lease_seconds)
        if self.claim_error:
            raise self.claim_error
        if self.claim_sequence:
            if len(self.claim_sequence) > 1:
                return self.claim_sequence.pop(0)
            return self.claim_sequence[0]
        return self.claim_value

    def read_run_work(self, run_id, lease):
        self._record('read_run_work', runId=run_id, lease=lease)
        if self.read_error:
            raise self.read_error
        return self.work_value

    def update_phase(self, run_id, lease, phase, detail):
        self._record('update_phase', runId=run_id, lease=lease, phase=phase, detail=detail)
        if self.phase_error:
            raise self.phase_error
        return {'ok': True}

    def register_export(self, run_id, lease, payload):
        self._record('register_export', runId=run_id, lease=lease, payload=payload)
        if self.register_export_error:
            raise self.register_export_error
        if not payload.get('rows') and self.replay_rows is not None:
            return {
                'ok': True,
                'fileId': 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
                'sha256': payload.get('file', {}).get('sha256'),
                'rowCount': len(self.replay_rows),
                'rows': list(self.replay_rows),
            }
        return {
            'ok': True,
            'fileId': 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
            'sha256': payload.get('file', {}).get('sha256'),
            'rowCount': payload.get('file', {}).get('rowCount'),
            'rows': [],
        }

    def publish_warehouse(self, run_id, lease, warehouse, rows):
        self._record('publish_warehouse', runId=run_id, lease=lease,
                     warehouse=warehouse, rows=rows)
        external_id = warehouse.get('warehouseExternalId')
        error = self.publish_errors.get(str(external_id))
        if error is not None:
            raise error
        return {
            'ok': True,
            'batchId': f'batch-{external_id}',
            'rowCount': len(rows),
            'adopted': len(rows),
            'unmapped': 0,
            'replayed': False,
        }

    def finish_run(self, run_id, lease, status, summary):
        self._record('finish_run', runId=run_id, lease=lease, status=status, summary=summary)
        if self.finish_error:
            raise self.finish_error
        return {'ok': True, 'status': status, 'runId': run_id, 'scopeAllSuccess': True}

    def fail_run(self, run_id, lease, error_code, error_detail, needs_login, outcome_unknown):
        self._record('fail_run', runId=run_id, lease=lease, errorCode=error_code,
                     errorDetail=error_detail, needsLogin=needs_login,
                     outcomeUnknown=outcome_unknown)
        if self.fail_error:
            raise self.fail_error
        return {'ok': True}

    def reconcile_request(self, request_id, intent):
        self._record('reconcile_request', requestId=request_id, intent=intent)
        return {'found': False, 'response': None}

    def refresh_account_status(self, worker_id, logged_in, account_label=None):
        self._record('refresh_account_status', workerId=worker_id,
                     loggedIn=logged_in, accountLabel=account_label)
        if self.refresh_error:
            raise self.refresh_error
        return self.refresh_result

    # -- convenience --------------------------------------------------------
    def calls_named(self, name: str) -> list[dict]:
        return [call for call in self.calls if call['name'] == name]

    @property
    def publish_calls(self) -> list[dict]:
        return self.calls_named('publish_warehouse')

    @property
    def export_mark(self):
        calls = self.calls_named('register_export')
        return calls[0]['payload'].get('exportMark') if calls else None


def rpc_error(code: str, detail: str = '') -> RpcError:
    return RpcError(code, detail)


def gateway_unavailable(detail: str = 'connection lost') -> GatewayUnavailable:
    return GatewayUnavailable(detail)
