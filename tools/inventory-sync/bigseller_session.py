"""BigSeller session helpers shared by the login helper and the export adapter.

The login state lives in the Playwright persistent profile created by the earlier read-only
scraper (tools/bigseller-scraper/runtime/profile). This module never stores a password: when the
session expires the operator signs in personally in the headed window opened by `--login`.

A tiny PID lock file serialises browser usage because Chromium refuses two processes on one
profile directory.

Path resolution: the worker may run from a frozen copy under
<run>/instance/inventory-worker-src/, where ``__file__`` no longer points into the
repository. ``INVENTORY_BS_REPO_ROOT`` (absolute) overrides the repository root; then
``INVENTORY_BS_PROFILE_DIR`` / ``INVENTORY_BS_EVIDENCE_ROOT`` (absolute) may override the
profile/evidence locations explicitly. Without these variables the historical
``Path(__file__).parents[2]`` behaviour is kept, so running the repository scripts
directly (``--check`` / ``--login``) is unchanged.
"""
from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

INVENTORY_URL = 'https://www.bigseller.pro/web/inventory/index.htm'
DOWNLOAD_CENTER_URL = 'https://www.bigseller.pro/web/download/center/index.htm'
WAREHOUSE_API = 'https://www.bigseller.pro/api/v1/warehouse/getWarehouseInfoVoList.json?defaultWareHouseFirst=1'


def _env_absolute_path(name: str) -> Path | None:
    """Read an optional absolute path override; a relative value is a hard error."""
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return None
    path = Path(raw.strip())
    if not path.is_absolute():
        raise RuntimeError(f'{name}_MUST_BE_ABSOLUTE')
    return path


REPO_ROOT = _env_absolute_path('INVENTORY_BS_REPO_ROOT') or Path(__file__).resolve().parents[2]
PROFILE_DIR = (_env_absolute_path('INVENTORY_BS_PROFILE_DIR')
               or REPO_ROOT / 'tools' / 'bigseller-scraper' / 'runtime' / 'profile')
EVIDENCE_ROOT = (_env_absolute_path('INVENTORY_BS_EVIDENCE_ROOT')
                 or REPO_ROOT / '.local' / 'inventory-sync-20261025')
SESSION_DIR = EVIDENCE_ROOT / 'session'
LOCK_FILE = SESSION_DIR / 'browser.lock'
STATUS_FILE = SESSION_DIR / 'session-status.json'

CHROME_CANDIDATES = (
    r'C:\Program Files\Google\Chrome\Application\chrome.exe',
    r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
)


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat()


def chrome_path() -> str | None:
    for candidate in CHROME_CANDIDATES:
        if os.path.exists(candidate):
            return candidate
    return None


def _pid_alive(pid: int) -> bool:
    if not pid:
        return False
    try:
        if os.name == 'nt':
            import subprocess
            out = subprocess.run(
                ['powershell.exe', '-NoProfile', '-Command',
                 f'(Get-Process -Id {pid} -ErrorAction SilentlyContinue).Id'],
                capture_output=True, text=True, timeout=15)
            return out.stdout.strip() == str(pid)
        os.kill(pid, 0)
        return True
    except Exception:
        return False


def acquire_browser_lock(purpose: str, wait_seconds: int = 90) -> str:
    """Create the single-owner browser lock. Returns the owner token."""
    SESSION_DIR.mkdir(parents=True, exist_ok=True)
    deadline = time.time() + wait_seconds
    token = f'{purpose}-{os.getpid()}-{int(time.time())}'
    while True:
        try:
            fd = os.open(str(LOCK_FILE), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(fd, json.dumps({'purpose': purpose, 'pid': os.getpid(), 'token': token,
                                     'acquiredAt': now_iso()}).encode('utf-8'))
            os.close(fd)
            return token
        except FileExistsError:
            try:
                holder = json.loads(LOCK_FILE.read_text(encoding='utf-8'))
            except Exception:
                holder = {}
            if not _pid_alive(int(holder.get('pid') or 0)):
                try:
                    LOCK_FILE.unlink()
                except FileNotFoundError:
                    pass
                continue
            if time.time() >= deadline:
                raise RuntimeError(f'BROWSER_LOCKED:{holder.get("purpose")}:pid={holder.get("pid")}')
            time.sleep(2)


def release_browser_lock(token: str) -> None:
    try:
        holder = json.loads(LOCK_FILE.read_text(encoding='utf-8'))
    except Exception:
        return
    if holder.get('token') == token:
        try:
            LOCK_FILE.unlink()
        except FileNotFoundError:
            pass


def write_status(**payload) -> None:
    SESSION_DIR.mkdir(parents=True, exist_ok=True)
    STATUS_FILE.write_text(json.dumps({'updated_at': now_iso(), **payload}, ensure_ascii=False, indent=2),
                           encoding='utf-8')


def is_login_page(page) -> bool:
    try:
        url = (page.url or '').lower()
        if 'login' in url or 'signin' in url:
            return True
        return bool(page.evaluate("""() => !!(document.querySelector('input[type=password]')
                                     && !document.querySelector('table.vxe-table--body'))"""))
    except Exception:
        return True


def launch_context(playwright, *, headless: bool, accept_downloads: bool = True):
    args = ['--disable-blink-features=AutomationControlled', '--no-sandbox',
            '--disable-extensions', '--no-first-run', '--disable-gpu', '--window-size=1680,1050']
    return playwright.chromium.launch_persistent_context(
        user_data_dir=str(PROFILE_DIR),
        headless=headless,
        executable_path=chrome_path(),
        args=args,
        ignore_https_errors=True,
        viewport={'width': 1680, 'height': 1050},
        accept_downloads=accept_downloads,
    )


def open_inventory(page, timeout_ms: int = 60000) -> bool:
    """Navigate to the inventory list. Returns True when logged in and the table rendered."""
    page.goto(INVENTORY_URL, wait_until='commit', timeout=timeout_ms)
    page.wait_for_timeout(6000)
    if is_login_page(page):
        return False
    for _ in range(20):
        try:
            if page.evaluate("() => !!document.querySelector('table.vxe-table--body')"):
                return True
        except Exception:
            pass
        page.wait_for_timeout(1500)
    return False


def detect_account_label(page) -> str | None:
    try:
        text = page.evaluate("() => (document.body.innerText || '')")
        for line in text.splitlines():
            line = line.strip()
            if '@' in line and len(line) < 80 and ' ' not in line:
                return line
    except Exception:
        pass
    return None


def persist_cookies(context) -> int:
    """Extend BigSeller session cookies so they survive browser restarts; returns changed count."""
    try:
        cookies = context.cookies()
    except Exception:
        return 0
    future = int(time.time()) + 90 * 24 * 3600
    changed = 0
    for cookie in cookies:
        if 'bigseller' in cookie.get('domain', '') and cookie.get('expires', 0) <= 0:
            cookie['expires'] = future
            changed += 1
    if changed:
        context.add_cookies(cookies)
    return changed


def login(wait_seconds: int = 1800) -> int:
    from playwright.sync_api import sync_playwright
    token = acquire_browser_lock('login', wait_seconds=30)
    try:
        with sync_playwright() as p:
            context = launch_context(p, headless=False)
            page = context.pages[0] if context.pages else context.new_page()
            try:
                page.goto(INVENTORY_URL, wait_until='commit', timeout=60000)
                page.wait_for_timeout(5000)
                if is_login_page(page):
                    write_status(status='waiting_for_login', detail='请在打开的窗口中手动登录 BigSeller')
                    print('[login] 请在打开的 Chrome 窗口里手动登录 BigSeller（含滑块验证）', flush=True)
                    deadline = time.time() + wait_seconds
                    while time.time() < deadline:
                        page.wait_for_timeout(3000)
                        try:
                            if not is_login_page(page):
                                break
                        except Exception:
                            break
                    else:
                        write_status(status='login_timeout')
                        print('[login] 等待超时，会话未刷新', flush=True)
                        return 2
                    if 'inventory' not in (page.url or '').lower():
                        page.goto(INVENTORY_URL, wait_until='commit', timeout=60000)
                    page.wait_for_timeout(5000)
                logged_in = open_inventory(page)
                if not logged_in:
                    write_status(status='login_failed', detail='登录后仍无法打开库存页')
                    print('[login] 登录后仍无法打开库存页', flush=True)
                    return 3
                changed = persist_cookies(context)
                label = detect_account_label(page)
                write_status(status='logged_in', accountLabel=label, cookiesPersisted=changed,
                             checkedAt=now_iso())
                print(f'[login] 登录有效，账号 {label or "unknown"}，会话已持久化（{changed} 个 cookie 续期）', flush=True)
                return 0
            finally:
                try:
                    context.close()
                except Exception:
                    pass
    finally:
        release_browser_lock(token)


def check() -> dict:
    from playwright.sync_api import sync_playwright
    token = acquire_browser_lock('check', wait_seconds=45)
    result: dict = {'checkedAt': now_iso(), 'loggedIn': False}
    try:
        with sync_playwright() as p:
            context = launch_context(p, headless=True, accept_downloads=False)
            page = context.pages[0] if context.pages else context.new_page()
            try:
                result['loggedIn'] = open_inventory(page)
                result['url'] = page.url
                if result['loggedIn']:
                    result['accountLabel'] = detect_account_label(page)
            finally:
                try:
                    context.close()
                except Exception:
                    pass
    finally:
        release_browser_lock(token)
    write_status(status='logged_in' if result['loggedIn'] else 'needs_login', **result)
    return result


def main(argv: list[str]) -> int:
    if '--login' in argv:
        index = argv.index('--wait-seconds')
        wait = int(argv[index + 1]) if index >= 0 else 1800
        return login(wait)
    result = check()
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get('loggedIn') else 3


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
