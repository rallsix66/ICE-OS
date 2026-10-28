"""BigSeller automatic export adapter (read-only on the BigSeller side).

The page's own 导入&导出 -> 按全部页导出 flow issues these XHRs (captured from the live page on
2026-10-25 and replayed here with the same authenticated session):

  POST /api/v1/excel/inventory/exportAllInventoryList.json
       pageNo=1&pageSize=50&searchType=title&searchContent=&inquireType=0&stockStatus=
       &isGroup=0&orderBy=&desc=&fullCid=&queryDistribution=1&saleState=&zoneId=
       &openFlag=false&hideZeroInventorySku=0&warehouseIds=<全部仓库 id 逗号串>
       -> {"data": "<exportMark>"}
  GET  /api/v1/excel/inventory/getWarehouseListExportProgress.json?exportMark=<mark>
       -> {"data":{"status":"finish","totalNum":728,
                   "downloadUrls":"https://.../库存清单....xlsx","details":{...}}}
  GET  <downloadUrls>   (temporary signed object URL)

`isGroup=0` is the 单个SKU filter the page sets when the 单个SKU tab is active, so combo SKUs are
excluded at the source. The export is still triggered through the same authenticated browser
session; nothing on the BigSeller side is modified.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from bigseller_session import (
    WAREHOUSE_API,
    acquire_browser_lock,
    detect_account_label,
    is_login_page,
    launch_context,
    open_inventory,
    persist_cookies,
    release_browser_lock,
)

EXPORT_API = 'https://www.bigseller.pro/api/v1/excel/inventory/exportAllInventoryList.json'
PROGRESS_API = 'https://www.bigseller.pro/api/v1/excel/inventory/getWarehouseListExportProgress.json'

EXPORT_FORM_BASE = {
    'pageNo': '1',
    'pageSize': '50',
    'searchType': 'title',
    'searchContent': '',
    'inquireType': '0',
    'stockStatus': '',
    'isGroup': '0',  # 单个SKU：排除组合SKU
    'orderBy': '',
    'desc': '',
    'fullCid': '',
    'queryDistribution': '1',
    'saleState': '',
    'zoneId': '',
    'openFlag': 'false',
    'hideZeroInventorySku': '0',  # 不隐藏 0 库存行
}

KNOWN_WAREHOUSE_NAMES = (
    'DEE-龙仔厝（ICE专属）',
    'DEE泰国海外仓(曼谷仓）',
    'PH-彩妆日均万单简简单单仓',
    '印尼-DEE仓库',
    '喜运达MY仓',
    '昕兰PH自建仓(弃用）',
    '菲律宾-新创启辰自建仓',
    '越南青林湾仓库',
)

SAFE_FILENAME = re.compile(r'[^0-9A-Za-z\u4e00-\u9fff._-]+')


class ExportError(RuntimeError):
    """Structured export failure. `code` is stable for the worker's error mapping."""

    def __init__(self, code: str, detail: str = '', *, fatal: bool = True):
        super().__init__(f'{code}: {detail}')
        self.code = code
        self.detail = detail
        self.fatal = fatal


def _now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def inspect_workbook(path: Path) -> dict:
    """Sheet name + header row + data row count (row extraction belongs to the worker parser).

    The file is loaded fully rather than in read_only mode: BigSeller writes a wrong worksheet
    dimension, so read_only iteration silently truncates columns (verified 2026-10-25: a 28-column
    export appeared as 1 column). Files are small (hundreds of rows).
    """
    from openpyxl import load_workbook
    workbook = load_workbook(filename=str(path), data_only=True)
    try:
        sheet = workbook[workbook.sheetnames[0]]
        header = []
        first = next(sheet.iter_rows(min_row=1, max_row=1, values_only=True), tuple())
        for index, value in enumerate(first):
            header.append({'index': index, 'name': '' if value is None else str(value).strip()})
        data_rows = 0
        blank_rows = 0
        for row in sheet.iter_rows(min_row=2, values_only=True):
            if any(cell is not None and str(cell).strip() != '' for cell in row):
                data_rows += 1
            else:
                blank_rows += 1
        return {'sheetName': sheet.title, 'header': header, 'dataRowCount': data_rows,
                'blankRowCount': blank_rows, 'sheetNames': list(workbook.sheetnames)}
    finally:
        workbook.close()


def _warehouse_options(context) -> list[dict]:
    response = context.request.get(WAREHOUSE_API, timeout=30000)
    if not response.ok:
        raise ExportError('WAREHOUSE_LIST_FAILED', f'HTTP {response.status}')
    rows = (response.json() or {}).get('data') or []
    return [{'id': str(row.get('id')), 'name': row.get('name')} for row in rows]


def _trigger_export(context, warehouse_ids: list[str]) -> str:
    form = dict(EXPORT_FORM_BASE)
    form['warehouseIds'] = ','.join(warehouse_ids)
    response = context.request.post(EXPORT_API, form=form, timeout=60000)
    if not response.ok:
        raise ExportError('EXPORT_REQUEST_FAILED', f'HTTP {response.status}')
    payload = response.json() or {}
    if payload.get('code') not in (0, '0'):
        raise ExportError('EXPORT_REQUEST_REJECTED', json.dumps(payload, ensure_ascii=False)[:400])
    mark = payload.get('data')
    if not isinstance(mark, str) or not mark.strip():
        raise ExportError('EXPORT_MARK_MISSING', json.dumps(payload, ensure_ascii=False)[:400])
    return mark.strip()


def _wait_export(context, mark: str, timeout_seconds: int) -> dict:
    deadline = time.time() + timeout_seconds
    last: dict = {}
    while time.time() < deadline:
        response = context.request.get(f'{PROGRESS_API}?exportMark={mark}', timeout=30000)
        if response.ok:
            last = response.json() or {}
            data = last.get('data') or {}
            status = str(data.get('status') or '').lower()
            if status in ('finish', 'finished', 'success', 'done', 'complete'):
                download_urls = data.get('downloadUrls')
                if not download_urls:
                    raise ExportError('EXPORT_NO_DOWNLOAD_URL', json.dumps(last, ensure_ascii=False)[:400])
                return data
            if status in ('fail', 'failed', 'error'):
                raise ExportError('EXPORT_GENERATION_FAILED', json.dumps(last, ensure_ascii=False)[:400])
        time.sleep(2)
    raise ExportError('EXPORT_TIMEOUT', json.dumps(last, ensure_ascii=False)[:400])


def _download(context, url: str, work_dir: Path, mark: str) -> Path:
    response = context.request.get(url, timeout=180000)
    if not response.ok:
        raise ExportError('DOWNLOAD_FAILED', f'HTTP {response.status}')
    body = response.body()
    if not body:
        raise ExportError('DOWNLOAD_EMPTY_FILE', url[:200])
    name = Path(str(url).split('?')[0]).name or f'{mark}.xlsx'
    target = work_dir / SAFE_FILENAME.sub('_', name)
    target.write_bytes(body)
    if target.stat().st_size != len(body):
        raise ExportError('DOWNLOAD_WRITE_MISMATCH', str(target))
    return target


def export_all_warehouses(work_dir, *, timeout_seconds: int = 300,
                          expected_warehouses=None) -> dict:
    """Run one real automatic export and return file evidence (no rows; the worker parses them).

    Raises ExportError with codes LOGIN_REQUIRED / INVENTORY_PAGE_UNAVAILABLE /
    WAREHOUSE_LIST_* / EXPORT_* / DOWNLOAD_*.
    """
    work_dir = Path(work_dir)
    work_dir.mkdir(parents=True, exist_ok=True)
    token = acquire_browser_lock('export', wait_seconds=120)
    from playwright.sync_api import sync_playwright
    try:
        with sync_playwright() as p:
            context = launch_context(p, headless=os.environ.get('INVENTORY_BS_HEADLESS', '1') != '0')
            page = context.pages[0] if context.pages else context.new_page()
            try:
                if not open_inventory(page):
                    if is_login_page(page):
                        raise ExportError('LOGIN_REQUIRED', 'BigSeller 登录已失效，需要人工登录')
                    raise ExportError('INVENTORY_PAGE_UNAVAILABLE', page.url)
                account_label = detect_account_label(page)
                options = _warehouse_options(context)
                if not options:
                    raise ExportError('WAREHOUSE_LIST_EMPTY', '账号没有可见仓库')
                warehouse_ids = [option['id'] for option in options]
                started = _now()
                mark = _trigger_export(context, warehouse_ids)
                progress = _wait_export(context, mark, timeout_seconds)
                finished = _now()
                file_path = _download(context, progress['downloadUrls'], work_dir, mark)
                workbook_info = inspect_workbook(file_path)
                total = progress.get('totalNum')
                expected_total = int(total) if str(total).isdigit() else workbook_info['dataRowCount']
                if expected_total != workbook_info['dataRowCount']:
                    raise ExportError(
                        'FILE_ROW_COUNT_MISMATCH',
                        f'source totalNum={expected_total} workbook data rows={workbook_info["dataRowCount"]}')
                persist_cookies(context)
                return {
                    'exportMark': mark,
                    'exportStartedAt': started,
                    'exportFinishedAt': finished,
                    'exportTotalNum': expected_total,
                    'file': {
                        'filePath': str(file_path),
                        'storageRelpath': str(file_path),
                        'sha256': _sha256_file(file_path),
                        'sizeBytes': file_path.stat().st_size,
                        'sheetName': workbook_info['sheetName'],
                        'header': workbook_info['header'],
                        'blankRowCount': workbook_info['blankRowCount'],
                        'dataRowCount': workbook_info['dataRowCount'],
                    },
                    'warehouseOptions': options,
                    'selectedWarehouseIds': warehouse_ids,
                    'selectedWarehouses': [option['name'] for option in options],
                    'singleSkuOnly': True,
                    'accountLabel': account_label,
                }
            finally:
                try:
                    context.close()
                except Exception:
                    pass
    finally:
        release_browser_lock(token)


def _trial(argv: list[str]) -> int:
    work_dir = Path(argv[argv.index('--work-dir') + 1]) if '--work-dir' in argv else Path('.local/inventory-sync-20261025/probe/export-trial')
    work_dir.mkdir(parents=True, exist_ok=True)
    if '--check-session' in argv:
        from bigseller_session import check
        print(json.dumps(check(), ensure_ascii=False, indent=2))
        return 0
    try:
        result = export_all_warehouses(work_dir, timeout_seconds=420)
    except ExportError as error:
        payload = {'ok': False, 'code': error.code, 'detail': error.detail}
        (work_dir / 'export-trial-result.json').write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(payload, ensure_ascii=False))
        return 2
    payload = {'ok': True, **result}
    (work_dir / 'export-trial-result.json').write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({k: v for k, v in payload.items() if k not in ('warehouseOptions',)}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(_trial(sys.argv[1:]))
