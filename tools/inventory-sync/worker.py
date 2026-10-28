"""inventory-sync-v1 background worker (persistent loop) -- repair v2 / R3+R4.

Flow once per claimed run::

    register_inventory_worker heartbeat -> claim_inventory_run
    -> export_all_warehouses (Lead adapter, real BigSeller download)
    -> strict parse (parser.py) + account identity + warehouse discovery
    -> register_inventory_export (identity / fileValidation / discovery / rows)
    -> publish_inventory_warehouse per complete healthy warehouse
       (file-level validation blocks everything; bad rows block only their warehouse;
        the DB re-checks the registered run rows and the exportFinishedAt)
    -> finish_inventory_run.

Scheduling (next_run_at/covered_slots/lease takeover/dedupe) lives entirely in the
database; this process only executes what ``claim_inventory_run`` returned.
Recovery/replay/publish always use the observation time from
``read_inventory_run_work`` (the run's ``exportFinishedAt``); ``now()`` is never
substituted. Credentials, session data, account labels and amounts are kept out of
the JSONL log.

Usage::

    python tools/inventory-sync/worker.py --config <instance>/inventory-worker.json
    python tools/inventory-sync/worker.py --config <...> --once   # one tick
"""
from __future__ import annotations

import argparse
import json
import os
import re
import signal
import socket
import sys
import threading
import time
import traceback
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

import parser as inventory_parser
import publisher as inventory_publisher
import recovery as inventory_recovery
from config import ConfigError, WorkerConfig, load_config
from db_gateway import GatewayUnavailable, RpcError, SyncDbGateway

NEEDS_LOGIN_CODES = {
    'LOGIN_REQUIRED',
    'LOGIN_EXPIRED',
    'SESSION_EXPIRED',
    'ACCOUNT_NEEDS_LOGIN',
}
LOGIN_STOP_REASONS = {'account_needs_login'}
RELOGIN_CHECK_INTERVAL_SECONDS = 60.0
SHUTDOWN_SESSION_GRACE_SECONDS = 8.0
SHUTDOWN_EXPORT_GRACE_SECONDS = 8.0

# Test-only controlled pause (R4.3 interruption/restart): disabled unless both env
# vars are set by the verification runner; never used by the normal path.
TEST_HOLD_PHASE_ENV = 'INVENTORY_WORKER_TEST_HOLD_PHASE'
TEST_HOLD_MS_ENV = 'INVENTORY_WORKER_TEST_HOLD_MS'

_SECRET_PATTERNS = (
    (re.compile(r'postgres(?:ql)?://[^\s"\'}]+'), 'postgres://***'),
    (re.compile(r'(?i)\b(password|passwd|pwd)\s*[=:]\s*[^\s,"\'}]+'), r'\1=***'),
    (re.compile(r'(?i)\b(session|sessionid|cookie)\s*[=:]\s*[^\s,"\'}]+'), r'\1=***'),
)
_AMOUNT_KEYS = {'totalcosttext', 'totalcost', 'amount', 'price', 'cost', 'total_cost_text'}
_SECRET_KEYS = {'password', 'passwd', 'pwd', 'secret', 'token', 'session', 'sessionid',
                'cookie', 'cookies', 'authorization', 'apikey', 'api_key'}
_MAX_LOG_TEXT = 800


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat()


def _clip(text: Any, limit: int = 500) -> str:
    value = str(text).replace('\r', ' ').replace('\n', ' ').strip()
    return value if len(value) <= limit else value[:limit] + '…'


def _normalise_label(value: Any) -> str:
    return str(value or '').strip().lower()


def sanitize(value: Any, *, depth: int = 0) -> Any:
    """Recursively strip credentials and amount-like values from log payloads."""
    if depth > 4:
        return '…'
    if isinstance(value, str):
        text = value
        for pattern, replacement in _SECRET_PATTERNS:
            text = pattern.sub(replacement, text)
        return text if len(text) <= _MAX_LOG_TEXT else text[:_MAX_LOG_TEXT] + '…'
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, dict):
        cleaned = {}
        for key, item in value.items():
            key_lower = str(key).lower()
            if key_lower in _AMOUNT_KEYS or key_lower in _SECRET_KEYS:
                cleaned[key] = '[redacted]'
            else:
                cleaned[key] = sanitize(item, depth=depth + 1)
        return cleaned
    if isinstance(value, (list, tuple)):
        return [sanitize(item, depth=depth + 1) for item in value]
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    return sanitize(str(value), depth=depth + 1)


class JsonlLogger:
    """Append-only JSONL logger: ``<logPath>/worker-YYYYMMDD.jsonl``."""

    def __init__(self, log_path: str | Path, *, worker_id: str,
                 clock: Callable[[], datetime] | None = None):
        self.log_dir = Path(log_path)
        self.worker_id = worker_id
        self._clock = clock or (lambda: datetime.now().astimezone())
        self._lock = threading.Lock()

    def file_path(self) -> Path:
        stamp = self._clock().strftime('%Y%m%d')
        return self.log_dir / f'worker-{stamp}.jsonl'

    def event(self, event: str, *, level: str = 'info', **fields: Any) -> None:
        record = {
            'ts': self._clock().isoformat(),
            'level': level,
            'event': event,
            'workerId': self.worker_id,
            **sanitize(fields),
        }
        line = json.dumps(record, ensure_ascii=False, default=str)
        with self._lock:
            try:
                self.log_dir.mkdir(parents=True, exist_ok=True)
                with self.file_path().open('a', encoding='utf-8') as handle:
                    handle.write(line + '\n')
            except OSError:
                sys.stderr.write('inventory-worker: log write failed\n')


@dataclass(frozen=True)
class ClaimedWarehouse:
    id: str
    external_id: str | None
    name: str | None

    def as_dict(self) -> dict:
        return {'id': self.id, 'externalId': self.external_id, 'name': self.name}


@dataclass(frozen=True)
class ClaimedRun:
    run_id: str
    lease: str
    trigger_kind: str
    planned_for: str | None
    attempt: int
    account_label: str | None
    scope_id: str | None
    scope_version: int | None
    warehouses: tuple[ClaimedWarehouse, ...]

    @classmethod
    def from_claim(cls, claim: dict) -> 'ClaimedRun':
        warehouses = []
        for raw in claim.get('warehouses') or []:
            warehouse_id = raw.get('id') or raw.get('warehouseId')
            if not warehouse_id:
                continue
            warehouses.append(ClaimedWarehouse(
                id=str(warehouse_id),
                external_id=str(raw['externalId']) if raw.get('externalId') is not None else None,
                name=raw.get('name'),
            ))
        account = claim.get('account') or {}
        label = claim.get('accountLabel') or account.get('label')
        scope = claim.get('scopeVersion')
        return cls(
            run_id=str(claim['runId']),
            lease=str(claim['leaseToken']),
            trigger_kind=str(claim.get('triggerKind') or 'unknown'),
            planned_for=claim.get('plannedFor'),
            attempt=int(claim.get('attempt') or 1),
            account_label=str(label).strip() if label else None,
            scope_id=claim.get('scopeId'),
            scope_version=int(scope) if scope is not None else None,
            warehouses=tuple(warehouses),
        )


class RunAborted(RuntimeError):
    """Internal control flow: a run was already terminated and has its result."""

    def __init__(self, result: dict):
        super().__init__(result.get('status', 'aborted'))
        self.result = result


class ShutdownRequested(RuntimeError):
    """SIGTERM/SIGINT arrived; abandon the in-flight browser export and exit."""


def _default_exporter() -> Callable[..., dict]:
    """Import the Lead-owned adapter lazily (same directory, no browser code here)."""
    def export(work_dir: str | Path, *, timeout_seconds: int) -> dict:
        from bigseller_export import export_all_warehouses
        return export_all_warehouses(work_dir, timeout_seconds=timeout_seconds)

    return export


def _default_session_checker() -> Callable[[], dict]:
    """Headless BigSeller session probe (Lead-owned helper, imported lazily)."""
    def check() -> dict:
        from bigseller_session import check as session_check
        return session_check()

    return check


class Worker:
    """Executes one database-claimed inventory synchronization run at a time."""

    def __init__(
        self,
        config: WorkerConfig,
        gateway: Any,
        *,
        exporter: Callable[..., dict] | None = None,
        session_checker: Callable[[], dict] | None = None,
        logger: JsonlLogger | None = None,
        stop_event: threading.Event | None = None,
        sleep: Callable[[float], None] | None = None,
        host: str | None = None,
        pid: int | None = None,
        monotonic: Callable[[], float] | None = None,
    ):
        self.config = config
        self.gateway = gateway
        self.exporter = exporter or _default_exporter()
        self.session_checker = session_checker or _default_session_checker()
        self.logger = logger or JsonlLogger(config.log_path, worker_id=config.worker_id)
        self._stop = stop_event or threading.Event()
        self._sleep = sleep or time.sleep
        self._monotonic = monotonic or time.monotonic
        self.host = host or socket.gethostname()
        self.pid = pid or os.getpid()
        self.lease_lost = False
        self._renew_interval = max(1.0, min(5.0, self.config.lease_seconds / 3.0))
        self._last_idle_signature: str | None = None
        self._last_account_state: str | None = None
        self._last_relogin_check_at: float | None = None
        self.relogin_check_interval = RELOGIN_CHECK_INTERVAL_SECONDS
        self._account_disabled_logged = False
        self._registered_account_label: str | None = None
        self._heartbeat_count = 0
        self._shutdown_wait_logged = False
        self._published_in_run = 0
        self.last_registration: dict | None = None

    # -- lifecycle -----------------------------------------------------------
    def stop(self, reason: str = 'requested') -> None:
        if not self._stop.is_set():
            self._stop.set()
            try:
                self.logger.event('worker_shutdown_requested', detail=reason)
            except Exception:  # noqa: BLE001
                pass

    def run_forever(self) -> None:
        self._install_signal_handlers()
        self.logger.event('worker_started', **self.config.public_summary(),
                          host=self.host, pid=self.pid)
        interval = max(1, min(self.config.heartbeat_seconds, self.config.claim_seconds))
        try:
            while not self._stop.is_set():
                try:
                    self.run_once()
                except ShutdownRequested:
                    break
                except Exception as exc:  # noqa: BLE001 - keep the daemon alive
                    self.logger.event(
                        'worker_loop_error', level='error',
                        detail=_clip(f'{type(exc).__name__}: {exc}'),
                        traceback=traceback.format_exc()[-1200:],
                    )
                if self._stop.is_set():
                    break
                self._sleep(interval)
        finally:
            self.logger.event('worker_stopped')

    def _install_signal_handlers(self) -> None:
        def handler(signum, _frame):
            self.stop(f'signal:{signum}')

        for name in ('SIGTERM', 'SIGINT'):
            signum = getattr(signal, name, None)
            if signum is None:
                continue
            try:
                signal.signal(signum, handler)
            except (ValueError, OSError):
                continue

    # -- test-only controlled pause -----------------------------------------
    def _maybe_test_hold(self, phase: str) -> None:
        """Test-only pause for the R4.3 interruption/restart verification."""
        target = (os.environ.get(TEST_HOLD_PHASE_ENV) or '').strip().lower()
        if not target or target != phase.lower():
            return
        raw = (os.environ.get(TEST_HOLD_MS_ENV) or '').strip()
        try:
            milliseconds = int(raw)
        except (TypeError, ValueError):
            return
        if milliseconds <= 0:
            return
        self.logger.event('worker_test_hold', phase=phase, ms=milliseconds)
        time.sleep(milliseconds / 1000.0)

    # -- one loop tick -------------------------------------------------------
    def run_once(self) -> dict:
        """Heartbeat, claim one run and execute it. Returns a status dict."""
        registration = self._heartbeat()
        # A needs_login account must recover as soon as the operator logs in, even when
        # no scheduled run is due (settings disabled => claim returns no_due_run).
        last_probe: dict | None = None
        if str((registration or {}).get('accountStatus') or '') == 'needs_login':
            last_probe = self._attempt_account_relogin()
            if last_probe.get('recovered'):
                self._last_relogin_check_at = None

        claim_raw = self._claim()
        if claim_raw is None:
            return {'status': 'db_unavailable'}

        reason = inventory_recovery.claim_reason(claim_raw)
        if reason == 'account_needs_login':
            if last_probe is None:
                last_probe = self._attempt_account_relogin()
                if last_probe.get('recovered'):
                    self._last_relogin_check_at = None
            if last_probe.get('recovered'):
                claim_raw = self._claim()
                if claim_raw is None:
                    return {'status': 'db_unavailable'}
                reason = inventory_recovery.claim_reason(claim_raw)
        if reason is not None:
            if reason == 'account_disabled':
                self._log_account_disabled_once()
            return self._idle(reason)

        claim = ClaimedRun.from_claim(claim_raw)
        if not claim.warehouses:
            self.logger.event('run_claim_scope_empty', level='error', runId=claim.run_id)
            return self._fail(claim, 'SCOPE_EMPTY', '任务范围为空，未执行任何仓库发布')

        self.lease_lost = False
        self._published_in_run = 0
        self.logger.event(
            'run_claimed',
            runId=claim.run_id,
            triggerKind=claim.trigger_kind,
            plannedFor=claim.planned_for,
            attempt=claim.attempt,
            warehouseCount=len(claim.warehouses),
            accountLabelPresent=bool(claim.account_label),
            accountStatus=(registration or {}).get('accountStatus'),
        )

        work = self._read_work(claim)
        if work is None:
            if self.lease_lost:
                return {'status': 'lease_lost', 'runId': claim.run_id}
            return {'status': 'deferred', 'runId': claim.run_id}
        self._maybe_test_hold('claimed')
        plan = inventory_recovery.plan_recovery(work)
        if plan['outcomeUnknown']:
            return self._recover_outcome_unknown(claim, plan)
        return self._execute(claim, plan, work)

    # -- heartbeat / claim ---------------------------------------------------
    def _heartbeat(self) -> dict | None:
        try:
            registration = self.gateway.register_worker(
                self.config.worker_id, self.host, self.pid, self.config.version)
        except (GatewayUnavailable, RpcError) as exc:
            self.logger.event('worker_heartbeat_failed', level='warn',
                              detail=_clip(getattr(exc, 'detail', '') or str(exc)))
            return None
        self.last_registration = registration
        if registration.get('accountLabel'):
            self._registered_account_label = str(registration['accountLabel']).strip()
        self._heartbeat_count += 1
        account_status = str(registration.get('accountStatus') or '')
        changed = account_status != self._last_account_state
        if changed:
            self._last_account_state = account_status
            self.logger.event('worker_heartbeat', accountStatus=account_status,
                              settings=sanitize(registration.get('settings') or {}))
        elif self._heartbeat_count % 6 == 0:
            self.logger.event('worker_heartbeat', level='debug', accountStatus=account_status)
        return registration

    def _claim(self) -> dict | None:
        try:
            claim = self.gateway.claim_run(self.config.worker_id, self.config.lease_seconds)
        except (GatewayUnavailable, RpcError) as exc:
            self.logger.event('worker_claim_failed', level='warn',
                              detail=_clip(getattr(exc, 'detail', '') or str(exc)))
            return None
        return claim if isinstance(claim, dict) else None

    def _idle(self, reason: str) -> dict:
        if reason != self._last_idle_signature:
            self._last_idle_signature = reason
            self.logger.event('worker_idle', reason=reason,
                              needsLogin=inventory_recovery.is_needs_login_reason(reason))
            if inventory_recovery.is_needs_login_reason(reason):
                self.logger.event('worker_login_required_hold',
                                  detail='账号需要人工重新登录，后台不再反复创建同步任务')
        return {'status': 'idle', 'reason': reason}

    def _log_account_disabled_once(self) -> None:
        if self._account_disabled_logged:
            return
        self._account_disabled_logged = True
        self.logger.event(
            'account_disabled_hold', level='warn',
            detail='账号已停用；不自动检查浏览器登录，保持等待（不擅自恢复）',
        )

    def _attempt_account_relogin(self, *, force: bool = False) -> dict:
        """Probe the session at most every ``relogin_check_interval`` seconds.

        Recovery is only accepted when the probe yields a **non-empty** account
        label and the DB ``refresh_inventory_account_status`` reports ``verified``.
        A missing/mismatching identity never turns the account active.
        ``force=True`` bypasses the interval (used for the one bounded retry of an
        export that reported LOGIN_REQUIRED).
        """
        now = self._monotonic()
        if (not force and self._last_relogin_check_at is not None
                and now - self._last_relogin_check_at < self.relogin_check_interval):
            return {'checked': False, 'recovered': False}
        self._last_relogin_check_at = now

        try:
            result = self._call_session_checker()
        except ShutdownRequested:
            raise
        except Exception as exc:  # noqa: BLE001 - probe failures mean "not logged in"
            self.logger.event(
                'account_relogin_check_failed', level='warn',
                detail=_clip(f'{type(exc).__name__}: {exc}'),
            )
            return {'checked': True, 'recovered': False}

        if isinstance(result, dict):
            logged_in = bool(result.get('loggedIn'))
            account_label = result.get('accountLabel')
        else:
            logged_in = bool(result)
            account_label = None
        label = str(account_label).strip() if account_label else ''
        self.logger.event('account_relogin_checked', loggedIn=logged_in,
                          accountLabelPresent=bool(label))
        if not logged_in:
            return {'checked': True, 'recovered': False}
        if not label:
            self.logger.event('account_relogin_identity_missing', level='warn',
                              detail='登录探测未取得非空来源账号标识，不转为有效登录')
            return {'checked': True, 'recovered': False}

        expected = _normalise_label(self.config.account_label or self._registered_account_label)
        if expected and _normalise_label(label) != expected:
            self.logger.event('account_relogin_identity_mismatch', level='warn',
                              detail='登录探测账号与固定账号不一致，不转为有效登录')
            return {'checked': True, 'recovered': False}

        try:
            refreshed = self.gateway.refresh_account_status(
                self.config.worker_id, True, label)
        except RpcError as exc:
            self.logger.event('account_relogin_refresh_failed', level='warn',
                              code=exc.code, detail=_clip(exc.detail))
            return {'checked': True, 'recovered': False}
        except GatewayUnavailable as exc:
            self.logger.event('account_relogin_refresh_failed', level='warn',
                              code=exc.code, detail=_clip(exc.detail))
            return {'checked': True, 'recovered': False}

        refreshed = refreshed or {}
        verified = refreshed.get('verified') is True
        mismatch = bool(refreshed.get('mismatch') or refreshed.get('accountLabelMismatch'))
        account_status = str(refreshed.get('status') or '')
        if not verified:
            self.logger.event('account_relogin_rejected', level='warn',
                              verified=False, mismatch=mismatch,
                              accountStatus=account_status or None)
            if account_status == 'disabled':
                self._log_account_disabled_once()
            return {'checked': True, 'recovered': False}
        if account_status and account_status != 'active':
            if account_status == 'disabled':
                self._log_account_disabled_once()
            self.logger.event('account_relogin_rejected', level='warn',
                              verified=True, accountStatus=account_status)
            return {'checked': True, 'recovered': False}
        self.logger.event('account_relogin_recovered', accountStatus=account_status or 'active',
                          accountLabelMismatch=mismatch)
        return {'checked': True, 'recovered': True, 'accountLabelMismatch': mismatch}

    def _call_session_checker(self) -> Any:
        """Run the blocking session probe in a thread while keeping the heartbeat fresh."""
        holder: dict[str, Any] = {}
        errors: dict[str, BaseException] = {}

        def target() -> None:
            try:
                holder['value'] = self.session_checker()
            except BaseException as exc:  # noqa: BLE001 - re-raised on the worker thread
                errors['value'] = exc

        thread = threading.Thread(target=target, name='bigseller-session-check', daemon=True)
        thread.start()
        deadline: float | None = None
        while thread.is_alive():
            thread.join(timeout=self._renew_interval)
            if not thread.is_alive():
                break
            if self._stop.is_set():
                if not self._shutdown_wait_logged:
                    self._shutdown_wait_logged = True
                    self.logger.event('worker_shutdown_waiting_session_check')
                if deadline is None:
                    deadline = self._monotonic() + SHUTDOWN_SESSION_GRACE_SECONDS
                if self._monotonic() >= deadline:
                    self.logger.event('worker_shutdown_abandon_session_check', level='warn')
                    raise ShutdownRequested('shutdown during session check')
            try:
                self._heartbeat()
            except Exception:  # noqa: BLE001
                pass
        if 'value' in errors:
            raise errors['value']
        return holder.get('value')

    def _read_work(self, claim: ClaimedRun) -> dict | None:
        try:
            return self.gateway.read_run_work(claim.run_id, claim.lease)
        except RpcError as exc:
            if exc.code == 'INVENTORY_LEASE_LOST':
                self.lease_lost = True
                self.logger.event('lease_lost', level='warn', runId=claim.run_id,
                                  detail=_clip(exc.detail))
            else:
                self.logger.event('run_work_read_failed', level='warn', runId=claim.run_id,
                                  code=exc.code, detail=_clip(exc.detail))
            return None
        except GatewayUnavailable as exc:
            self.logger.event('run_work_read_failed', level='warn', runId=claim.run_id,
                              code=exc.code, detail=_clip(exc.detail))
            return None

    # -- execution -----------------------------------------------------------
    def _execute(self, claim: ClaimedRun, plan: dict, work: dict) -> dict:
        try:
            if plan['hasFile']:
                context = self._payload_from_recovered_file(claim, plan, work)
            else:
                context = self._export_and_register(claim)
            return self._publish_and_finish(claim, context, plan)
        except ShutdownRequested:
            raise
        except RunAborted as exc:
            return exc.result
        except inventory_publisher.LeaseLostError as exc:
            self.lease_lost = True
            self.logger.event('lease_lost', level='warn', runId=claim.run_id,
                              detail=_clip(str(exc)))
            return {'status': 'lease_lost', 'runId': claim.run_id}
        except inventory_publisher.OutcomeUnknownError as exc:
            self.logger.event('publish_outcome_unknown', level='warn', runId=claim.run_id,
                              phase=exc.phase, detail=_clip(exc.detail))
            return self._fail(claim, 'PUBLISH_OUTCOME_UNKNOWN',
                              '发布请求结果未知，保留任务等待恢复核对，不重复写入',
                              outcome_unknown=True)
        except GatewayUnavailable as exc:
            self.logger.event('worker_deferred_db_unavailable', level='warn',
                              runId=claim.run_id,
                              detail=_clip(getattr(exc, 'detail', '') or str(exc)))
            return {'status': 'deferred', 'runId': claim.run_id}
        except Exception as exc:  # noqa: BLE001 - any code with .code maps to a reason
            code = getattr(exc, 'code', None) or 'WORKER_INTERNAL_ERROR'
            detail = getattr(exc, 'detail', '') or f'{type(exc).__name__}: {exc}'
            self.logger.event(
                'run_internal_error', level='error', runId=claim.run_id,
                code=code, detail=_clip(detail), traceback=traceback.format_exc()[-1200:],
            )
            return self._fail(claim, str(code), _clip(detail))

    # -- export / register (fresh run) --------------------------------------
    def _export_and_register(self, claim: ClaimedRun) -> dict:
        self._maybe_test_hold('export')
        self._update_phase(claim, 'downloading', {'phase': 'download'})
        try:
            result = self._run_export(claim)
        except ShutdownRequested:
            raise
        except (KeyboardInterrupt, SystemExit):
            raise
        except Exception as exc:  # noqa: BLE001 - adapter errors classified below
            code = getattr(exc, 'code', None)
            if code in NEEDS_LOGIN_CODES:
                # Bounded second chance: a transient page/login mis-detection must not
                # park the account in needs_login when the session is actually valid.
                result = self._retry_export_after_login(claim, exc)
            else:
                return self._abort_with_export_error(claim, exc)

        if self.lease_lost:
            raise RunAborted({'status': 'lease_lost', 'runId': claim.run_id})
        if not isinstance(result, dict):
            return self._abort_with_export_error(
                claim, inventory_parser.ParseError('INVALID_EXPORT_RESULT', '导出适配器未返回对象'))

        export_mark = result.get('exportMark')
        if not export_mark:
            return self._abort_with_export_error(
                claim, inventory_parser.ParseError('EXPORT_MARK_MISSING', '导出任务标识缺失'))

        try:
            identity = self._extract_identity(claim, result)
            discovery = self._extract_discovery(result)
        except inventory_parser.ParseError as exc:
            return self._abort_with_export_error(claim, exc)

        self._update_phase(claim, 'parsing', {'phase': 'parse'})
        try:
            parsed = self._parse_export_result(claim, result, discovery)
        except Exception as exc:  # noqa: BLE001 - ParseError / adapter shape
            return self._abort_with_export_error(claim, exc)

        payload = self._register_payload(
            parsed, export_mark=export_mark, identity=identity, discovery=discovery)
        self._update_phase(claim, 'publishing', {'phase': 'register'})
        try:
            receipt = self.gateway.register_export(claim.run_id, claim.lease, payload)
        except RpcError as exc:
            self.logger.event('register_export_failed', level='warn', runId=claim.run_id,
                              code=exc.code, detail=_clip(exc.detail))
            return self._abort_with_export_error(claim, exc)

        self.logger.event(
            'export_registered', runId=claim.run_id,
            exportMarkPrefix=str(export_mark)[:8],
            sha256Prefix=str(payload['file'].get('sha256') or '')[:12],
            rowCount=payload['file']['rowCount'],
            blankRowCount=payload['file']['blankRowCount'],
            sourceRowCount=payload['file']['rowCount'],
            parseStatusCounts=inventory_parser.summarize_parse(payload['rows']),
            fileValidationStatus=payload['fileValidation'].get('status'),
            comboRowCount=payload['fileValidation'].get('comboRowCount'),
            unattributableRowCount=payload['fileValidation'].get('unattributableRowCount'),
            discoveryCount=len(discovery),
            accountIdentity='verified',
            registerAck=sanitize({k: receipt.get(k) for k in ('fileId', 'sha256', 'rowCount')}),
        )
        self._maybe_test_hold('register')

        # The DB is authoritative for the observation time / identity / file validation.
        work = self._read_work(claim)
        if work is None:
            if self.lease_lost:
                raise RunAborted({'status': 'lease_lost', 'runId': claim.run_id})
            raise GatewayUnavailable('registered export but could not read run work')
        return self._context_from_work(claim, work, rows=payload['rows'],
                                       discovery=payload['warehouseDiscovery'],
                                       file_info=payload['file'], source='fresh')

    def _retry_export_after_login(self, claim: ClaimedRun, first_exc: BaseException) -> dict:
        """One bounded recheck + one export retry after a LOGIN_REQUIRED-class failure.

        Total export attempts stay at two; if the session/identity cannot be proven, or
        the retry still fails, the run is failed as needs_login (or with the retry's
        own error code if it is not a login error).
        """
        first_code = getattr(first_exc, 'code', None) or 'LOGIN_REQUIRED'
        self.logger.event('export_login_retry', runId=claim.run_id,
                          firstCode=first_code, retryAttempt=2)
        recovery = self._attempt_account_relogin(force=True)
        if not recovery.get('recovered'):
            self.logger.event(
                'export_login_retry_failed', level='warn', runId=claim.run_id,
                reason='session not verified or account identity missing/mismatch',
                retryAttempt=2,
            )
            result = self._abort_with_export_error(claim, first_exc)
            raise RunAborted(result) from first_exc
        try:
            self._update_phase(claim, 'downloading', {'phase': 'export_retry'})
            result = self._run_export(claim)
        except ShutdownRequested:
            raise
        except (KeyboardInterrupt, SystemExit):
            raise
        except Exception as exc:  # noqa: BLE001
            code = getattr(exc, 'code', None) or 'WORKER_EXPORT_ERROR'
            self.logger.event(
                'export_login_retry_failed', level='warn', runId=claim.run_id,
                code=code, retryAttempt=2,
                needsLogin=code in NEEDS_LOGIN_CODES,
            )
            result = self._abort_with_export_error(claim, exc)
            raise RunAborted(result) from exc
        self.logger.event('export_login_retry_succeeded', runId=claim.run_id, retryAttempt=2)
        return result

    def _parse_export_result(self, claim: ClaimedRun, result: dict,
                             discovery: list[dict]) -> dict:
        if isinstance(result.get('rows'), list) and result['rows']:
            file_info = result.get('file') or {}
            rows, validation = inventory_parser.parse_adapter_rows(
                result['rows'], blank_row_count=int(file_info.get('blankRowCount') or 0),
                warehouse_discovery=discovery)
            return {
                'exportMark': result.get('exportMark'),
                'exportStartedAt': result.get('exportStartedAt'),
                'exportFinishedAt': result.get('exportFinishedAt'),
                'file': {
                    'storageRelpath': file_info.get('storageRelpath') or '',
                    'sha256': file_info.get('sha256') or '',
                    'sizeBytes': file_info.get('sizeBytes') or 0,
                    'sheetName': file_info.get('sheetName') or '',
                    'header': file_info.get('header') or [],
                    'rowCount': len(rows),
                    'blankRowCount': int(file_info.get('blankRowCount') or 0),
                },
                'rows': rows,
                'blankRowCount': int(file_info.get('blankRowCount') or 0),
                'fileValidation': validation,
            }
        file_info = result.get('file') if isinstance(result.get('file'), dict) else {}
        file_path = inventory_parser.find_export_file(
            result, work_dir=self.config.work_dir, export_dir=self.config.export_dir)
        if file_path is None:
            raise inventory_parser.ParseError('FILE_MISSING', '导出适配器未返回可读取的导出文件')
        return inventory_parser.parse_export_file(
            file_path,
            warehouse_discovery=discovery,
            expected_sha256=file_info.get('sha256'),
            storage_relpath=inventory_parser.storage_relpath_for(file_path, self.config.work_dir),
            export_mark=result.get('exportMark'),
            export_started_at=result.get('exportStartedAt'),
            export_finished_at=result.get('exportFinishedAt'),
        )

    def _extract_identity(self, claim: ClaimedRun, result: dict) -> dict:
        label = str(result.get('accountLabel') or '').strip()
        expected = str(claim.account_label or self.config.account_label or '').strip()
        if not label:
            raise inventory_parser.ParseError(
                'INVENTORY_ACCOUNT_IDENTITY_MISSING',
                '导出结果缺少来源账号标识，拒绝登记/发布')
        if not expected:
            raise inventory_parser.ParseError(
                'INVENTORY_ACCOUNT_IDENTITY_UNVERIFIED',
                '任务未提供固定账号标识，无法核验来源账号')
        if _normalise_label(label) != _normalise_label(expected):
            raise inventory_parser.ParseError(
                'INVENTORY_ACCOUNT_IDENTITY_MISMATCH',
                '导出账号与任务固定账号不一致，拒绝登记/发布')
        return {'label': label, 'verified': True}

    def _extract_discovery(self, result: dict) -> list[dict]:
        raw = result.get('warehouseOptions') or result.get('warehouseDiscovery') or []
        entries: list[dict] = []
        seen: dict[str, str] = {}
        for item in raw:
            if not isinstance(item, dict):
                continue
            external_id = item.get('id', item.get('externalId'))
            name = item.get('name')
            if external_id is None or not name:
                continue
            external_id = str(external_id)
            name = str(name)
            if external_id in seen and seen[external_id] != name:
                raise inventory_parser.ParseError(
                    'INVENTORY_WAREHOUSE_DISCOVERY_INVALID',
                    f'仓库发现结果中有冲突的名称（externalId={external_id}）')
            seen[external_id] = name
            entries.append({'externalId': external_id, 'name': name})
        if not entries:
            raise inventory_parser.ParseError(
                'INVENTORY_WAREHOUSE_DISCOVERY_MISSING',
                '导出结果未返回仓库发现清单（稳定 externalId + name）')
        return entries

    def _register_payload(self, parsed: dict, *, export_mark: str | None,
                          identity: dict, discovery: list[dict]) -> dict:
        file_info = dict(parsed.get('file') or {})
        file_payload = {
            'storageRelpath': file_info.get('storageRelpath') or '',
            'sha256': file_info.get('sha256') or '',
            'sizeBytes': int(file_info.get('sizeBytes') or 0),
            'sheetName': file_info.get('sheetName') or '',
            'header': file_info.get('header') or [],
            'rowCount': int(file_info.get('rowCount') or len(parsed.get('rows') or [])),
            'blankRowCount': int(file_info.get('blankRowCount') or parsed.get('blankRowCount') or 0),
        }
        return {
            'exportMark': export_mark or '',
            'exportStartedAt': parsed.get('exportStartedAt'),
            'exportFinishedAt': parsed.get('exportFinishedAt'),
            'file': file_payload,
            'rows': parsed.get('rows') or [],
            'blankRowCount': file_payload['blankRowCount'],
            'fileValidation': parsed.get('fileValidation') or inventory_parser.empty_file_validation(),
            'accountIdentity': identity,
            'warehouseDiscovery': discovery,
        }

    def _run_export(self, claim: ClaimedRun) -> dict:
        """Run the blocking browser export while keeping the lease alive."""
        holder: dict[str, Any] = {}
        errors: dict[str, BaseException] = {}

        def target() -> None:
            try:
                holder['value'] = self.exporter(
                    Path(self.config.export_dir),
                    timeout_seconds=self.config.export_timeout_seconds,
                )
            except BaseException as exc:  # noqa: BLE001
                errors['value'] = exc

        thread = threading.Thread(target=target, name='bigseller-export', daemon=True)
        thread.start()
        interval = self._renew_interval
        shutdown_deadline: float | None = None
        while thread.is_alive():
            thread.join(timeout=interval)
            if not thread.is_alive():
                break
            if self._stop.is_set():
                if not self._shutdown_wait_logged:
                    self._shutdown_wait_logged = True
                    self.logger.event('worker_shutdown_waiting_export', runId=claim.run_id)
                if shutdown_deadline is None:
                    shutdown_deadline = time.monotonic() + SHUTDOWN_EXPORT_GRACE_SECONDS
                if time.monotonic() >= shutdown_deadline:
                    self.logger.event(
                        'worker_shutdown_abandon_export', level='warn', runId=claim.run_id,
                        detail='导出未在退出宽限期内完成，放弃本次执行；任务租约保留，由下次启动接管',
                    )
                    raise ShutdownRequested('shutdown during export')
            self._renew_lease(claim, 'downloading')
        if 'value' in errors:
            raise errors['value']
        return holder.get('value')

    # -- recovery / context --------------------------------------------------
    def _context_from_work(self, claim: ClaimedRun, work: dict, *,
                           rows: list[dict] | None,
                           discovery: list[dict] | None,
                           file_info: dict | None,
                           source: str) -> dict:
        identity = inventory_recovery.work_identity(work)
        if not identity['verified']:
            raise inventory_parser.ParseError(
                'INVENTORY_ACCOUNT_IDENTITY_UNVERIFIED',
                f'账号身份状态为 {identity["status"] or "unknown"}，拒绝登记/发布')
        validation = inventory_recovery.work_file_validation(work)
        observation = inventory_recovery.work_observation_at(work)
        if not observation:
            raise inventory_parser.ParseError(
                'INVENTORY_OBSERVATION_MISSING',
                '数据库任务缺少来源导出完成时间（exportFinishedAt），拒绝发布/恢复')
        work_discovery = inventory_recovery.work_discovery(work)
        effective_discovery = work_discovery or list(discovery or [])
        if not effective_discovery:
            raise inventory_parser.ParseError(
                'INVENTORY_WAREHOUSE_DISCOVERY_MISSING',
                '恢复/发布需要本次导出的仓库发现清单，数据库中缺失')
        return {
            'rows': rows or [],
            'fileValidation': validation,
            'warehouseDiscovery': effective_discovery,
            'observationAt': observation,
            'exportMark': work.get('exportMark') or '',
            'file': file_info or (work.get('file') or {}),
            'blankRowCount': int((file_info or {}).get('blankRowCount') or 0),
            'source': source,
        }

    def _payload_from_recovered_file(self, claim: ClaimedRun, plan: dict,
                                     work: dict) -> dict:
        """Recover using the DB-registered rows/receipt first, then the original file."""
        identity = inventory_recovery.work_identity(work)
        if not identity['verified']:
            raise inventory_parser.ParseError(
                'INVENTORY_ACCOUNT_IDENTITY_UNVERIFIED',
                f'恢复任务的账号身份状态为 {identity["status"] or "unknown"}，不发布')
        validation = inventory_recovery.work_file_validation(work)
        if validation.get('blocked') is True or validation.get('status') not in (None, 'ok'):
            raise inventory_parser.ParseError(
                'INVENTORY_FILE_BLOCKED',
                str(validation.get('reason') or '恢复任务的整文件校验为 blocked，不发布'))
        observation = inventory_recovery.work_observation_at(work)
        if not observation:
            raise inventory_parser.ParseError(
                'INVENTORY_OBSERVATION_MISSING',
                '恢复任务缺少原 exportFinishedAt，不能用当前时间代替')
        file_info = plan.get('file') or {}
        sha = file_info.get('sha256') if isinstance(file_info, dict) else None
        if not sha:
            raise inventory_parser.ParseError(
                'RECOVERY_FILE_UNAVAILABLE', '恢复任务缺少已登记文件的 sha256')
        discovery = inventory_recovery.work_discovery(work)

        replay_rows = self._replay_registered_export(claim, work, sha, file_info, discovery)
        if replay_rows is not None:
            return self._context_from_work(
                claim, work, rows=replay_rows, discovery=discovery,
                file_info=file_info, source='replay')

        if not discovery:
            raise inventory_parser.ParseError(
                'INVENTORY_WAREHOUSE_DISCOVERY_MISSING',
                '恢复时需要数据库返回本次导出仓库发现清单（stable externalId+name）')
        path = inventory_recovery.locate_recovered_file(
            {'file': file_info}, work_dir=self.config.work_dir,
            export_dir=self.config.export_dir)
        if path is None:
            raise inventory_parser.ParseError(
                'RECOVERY_FILE_UNAVAILABLE',
                '恢复时找不到本任务已登记的导出文件（不重新导出，避免覆盖已登记文件）')
        parsed = inventory_parser.parse_export_file(
            path,
            warehouse_discovery=discovery,
            expected_sha256=sha,
            storage_relpath=inventory_parser.storage_relpath_for(path, self.config.work_dir),
            export_mark=work.get('exportMark'),
            export_started_at=inventory_recovery.work_export_times(work).get('exportStartedAt'),
            export_finished_at=inventory_recovery.work_export_times(work).get('exportFinishedAt'),
        )
        self.logger.event(
            'recovery_reused_export_file', runId=claim.run_id,
            sha256Prefix=str(parsed['file']['sha256'])[:12],
            rowCount=parsed['file']['rowCount'],
            blankRowCount=parsed['file']['blankRowCount'],
            parseStatusCounts=inventory_parser.summarize_parse(parsed['rows']),
            source='file',
        )
        return self._context_from_work(
            claim, work, rows=parsed['rows'], discovery=discovery,
            file_info=parsed['file'], source='reparse')

    def _replay_registered_export(self, claim: ClaimedRun, work: dict, sha: str,
                                  file_info: dict, discovery: list[dict]) -> list[dict] | None:
        """Same run + same sha -> the DB returns the original receipt (incl. rows)."""
        replay_payload = {
            'exportMark': work.get('exportMark') or '',
            'exportStartedAt': inventory_recovery.work_export_times(work).get('exportStartedAt'),
            'exportFinishedAt': inventory_recovery.work_export_times(work).get('exportFinishedAt'),
            'file': {
                'storageRelpath': (file_info or {}).get('storageRelpath') or f'recovered/{sha}.xlsx',
                'sha256': sha,
                'sizeBytes': int((file_info or {}).get('sizeBytes') or 0),
                'sheetName': (file_info or {}).get('sheetName') or '',
                'header': (file_info or {}).get('header') or [],
                'rowCount': int((file_info or {}).get('rowCount') or 0),
                'blankRowCount': int((file_info or {}).get('blankRowCount') or 0),
            },
            'rows': [],
            'blankRowCount': int((file_info or {}).get('blankRowCount') or 0),
            'accountIdentity': {'label': inventory_recovery.work_identity(work).get('label'),
                                'verified': True},
            'warehouseDiscovery': discovery or [],
            'fileValidation': inventory_recovery.work_file_validation(work),
        }
        try:
            receipt = self.gateway.register_export(claim.run_id, claim.lease, replay_payload)
        except RpcError as exc:
            if exc.code in ('INVENTORY_EXPORT_INVALID', 'INVENTORY_INVALID_INPUT',
                            'INVENTORY_INVALID_ROW', 'DB_RPC_ERROR', 'MALFORMED_RPC_RESULT'):
                self.logger.event('recovery_replay_unavailable', level='warn',
                                  runId=claim.run_id, code=exc.code)
                return None
            raise
        rows = receipt.get('rows') if isinstance(receipt, dict) else None
        if not isinstance(rows, list) or not rows:
            return None
        normalized: list[dict] = []
        for raw in rows:
            if not isinstance(raw, dict):
                continue
            normalized.append({
                'excelRow': raw.get('excelRow'),
                'warehouseExternalId': raw.get('warehouseExternalId'),
                'warehouseName': raw.get('warehouseName'),
                'externalSku': raw.get('externalSku'),
                'productName': raw.get('productName'),
                'gtin': raw.get('gtin'),
                'onHandText': raw.get('onHandText'),
                'orderLockedText': raw.get('orderLockedText'),
                'warehouseAvailableText': raw.get('warehouseAvailableText'),
                'activityReservedText': raw.get('activityReservedText'),
                'inTransitText': raw.get('inTransitText'),
                'totalCostText': raw.get('totalCostText'),
                'rowHash': raw.get('rowHash'),
                'parseStatus': raw.get('parseStatus') or 'ok',
                'reason': raw.get('reason'),
            })
        self.logger.event('recovery_replayed_register_receipt', runId=claim.run_id,
                          rowCount=len(normalized))
        return normalized

    # -- publishing ----------------------------------------------------------
    def _renew_lease(self, claim: ClaimedRun, phase: str) -> None:
        if self.lease_lost:
            return
        try:
            self.gateway.update_phase(claim.run_id, claim.lease, phase, {'heartbeat': True})
            self.gateway.register_worker(
                self.config.worker_id, self.host, self.pid, self.config.version)
        except RpcError as exc:
            if exc.code == 'INVENTORY_LEASE_LOST':
                self.lease_lost = True
                self.logger.event('lease_lost', level='warn', runId=claim.run_id,
                                  detail='续期时发现任务已被接管')
            else:
                self.logger.event('lease_renew_failed', level='warn', runId=claim.run_id,
                                  code=exc.code, detail=_clip(exc.detail))
        except GatewayUnavailable as exc:
            self.logger.event('lease_renew_failed', level='warn', runId=claim.run_id,
                              code=exc.code, detail=_clip(exc.detail))
        except Exception as exc:  # noqa: BLE001
            self.logger.event('lease_renew_failed', level='warn', runId=claim.run_id,
                              code=type(exc).__name__, detail=_clip(exc))

    def _update_phase(self, claim: ClaimedRun, phase: str, detail: dict) -> None:
        if self.lease_lost:
            raise RunAborted({'status': 'lease_lost', 'runId': claim.run_id})
        try:
            self.gateway.update_phase(claim.run_id, claim.lease, phase, detail)
        except RpcError as exc:
            if exc.code == 'INVENTORY_LEASE_LOST':
                self.lease_lost = True
                raise inventory_publisher.LeaseLostError('更新任务阶段时租约已失效') from exc
            self.logger.event('run_phase_failed', level='warn', runId=claim.run_id,
                              phase=phase, code=exc.code, detail=_clip(exc.detail))
        except GatewayUnavailable as exc:
            self.logger.event('run_phase_deferred', level='warn', runId=claim.run_id,
                              phase=phase, detail=_clip(exc.detail))

    def _on_warehouse_start(self, claim: ClaimedRun) -> Callable[[Any], None]:
        def callback(_entry: Any) -> None:
            if self._published_in_run > 0:
                self._maybe_test_hold('publish')
            self._published_in_run += 1
            self._renew_lease(claim, 'publishing')
        return callback

    def _publish_and_finish(self, claim: ClaimedRun, context: dict, plan: dict) -> dict:
        rows = context.get('rows') or []
        observation_at = context.get('observationAt')
        if not observation_at:
            raise inventory_parser.ParseError(
                'INVENTORY_OBSERVATION_MISSING',
                '缺少来源导出完成时间（observation），拒绝发布')
        self._maybe_test_hold('publish')
        self._update_phase(claim, 'publishing', {'phase': 'publish'})
        outcome = inventory_publisher.publish_run(
            self.gateway,
            claim.run_id,
            claim.lease,
            [warehouse.as_dict() for warehouse in claim.warehouses],
            context.get('warehouseDiscovery') or [],
            rows,
            context.get('fileValidation') or {},
            observation_at=observation_at,
            already_published=plan.get('publishedWarehouses') or {},
            on_warehouse_start=self._on_warehouse_start(claim),
        )
        if outcome.get('fileBlocked'):
            reason = str(outcome.get('fileBlockReason') or '整份文件校验未通过')
            self.logger.event('run_file_blocked', level='warn', runId=claim.run_id,
                              reason=reason,
                              outOfScopeRows=len(outcome.get('outOfScopeRows') or []))
            return self._fail(claim, 'INVENTORY_FILE_BLOCKED', reason)

        status = inventory_publisher.decide_status(len(claim.warehouses), outcome)
        summary = inventory_publisher.build_summary(outcome)
        summary['parseStatusCounts'] = inventory_parser.summarize_parse(rows)
        summary['blankRowCount'] = int(context.get('blankRowCount') or 0)
        summary['fileSha256Prefix'] = str((context.get('file') or {}).get('sha256') or '')[:12]
        summary['triggerKind'] = claim.trigger_kind
        summary['observationAt'] = observation_at
        summary['fileValidationStatus'] = (context.get('fileValidation') or {}).get('status')
        self._maybe_test_hold('finish')
        try:
            response = self.gateway.finish_run(claim.run_id, claim.lease, status, summary)
        except RpcError as exc:
            if exc.code == 'INVENTORY_LEASE_LOST':
                self.lease_lost = True
                raise inventory_publisher.LeaseLostError('结单时租约已失效') from exc
            self.logger.event('finish_run_failed', level='warn', runId=claim.run_id,
                              code=exc.code, detail=_clip(exc.detail))
            raise RunAborted({'status': 'error', 'runId': claim.run_id,
                              'errorCode': exc.code, 'summary': summary}) from exc
        except GatewayUnavailable as exc:
            self.logger.event('finish_run_deferred', level='warn', runId=claim.run_id,
                              detail=_clip(exc.detail))
            return {'status': 'deferred', 'runId': claim.run_id, 'summary': summary}

        self.logger.event(
            'run_finished', runId=claim.run_id, status=status,
            published=summary['published'], failed=summary['failed'],
            blocked=summary['blocked'], noRows=summary['noRows'],
            outOfScopeRows=summary['outOfScopeRows'],
            observationAt=observation_at,
            scopeAllSuccess=bool(response.get('scopeAllSuccess')),
        )
        return {
            'status': status,
            'runId': claim.run_id,
            'summary': summary,
            'scopeAllSuccess': bool(response.get('scopeAllSuccess')),
        }

    # -- recovery ------------------------------------------------------------
    def _recover_outcome_unknown(self, claim: ClaimedRun, plan: dict) -> dict:
        """Only inspect committed batches; never re-publish."""
        evaluation = inventory_recovery.evaluate_outcome_unknown(
            {'status': plan.get('status'), 'publishedWarehouses': [
                {'warehouseId': warehouse_id, **batch}
                for warehouse_id, batch in (plan.get('publishedWarehouses') or {}).items()
            ]},
            [warehouse.as_dict() for warehouse in claim.warehouses],
        )
        self.logger.event(
            'outcome_unknown_recovery_check', runId=claim.run_id,
            claimed=evaluation['claimedCount'], published=evaluation['publishedCount'],
            missing=evaluation['missing'],
        )
        if evaluation['allPublished']:
            summary = inventory_recovery.recovery_summary(plan, [
                warehouse.as_dict() for warehouse in claim.warehouses])
            try:
                response = self.gateway.finish_run(claim.run_id, claim.lease, 'success', summary)
            except RpcError as exc:
                if exc.code == 'INVENTORY_LEASE_LOST':
                    self.lease_lost = True
                    return {'status': 'lease_lost', 'runId': claim.run_id}
                self.logger.event('finish_run_failed', level='warn', runId=claim.run_id,
                                  code=exc.code, detail=_clip(exc.detail))
                return {'status': 'error', 'runId': claim.run_id, 'errorCode': exc.code}
            except GatewayUnavailable as exc:
                self.logger.event('finish_run_deferred', level='warn', runId=claim.run_id,
                                  detail=_clip(exc.detail))
                return {'status': 'deferred', 'runId': claim.run_id}
            self.logger.event('run_finished', runId=claim.run_id, status='success',
                              recovered=True, scopeAllSuccess=bool(response.get('scopeAllSuccess')))
            return {'status': 'success', 'runId': claim.run_id, 'summary': summary,
                    'scopeAllSuccess': bool(response.get('scopeAllSuccess'))}

        summary = inventory_recovery.recovery_summary(plan, [
            warehouse.as_dict() for warehouse in claim.warehouses])
        summary.update({
            'reconciledOutcomeUnknown': True,
            'reconciledWithoutRepublish': True,
            'reconciledPublishedWarehouses': evaluation['present'],
            'reconciledMissingWarehouses': evaluation['missing'],
        })
        try:
            response = self.gateway.finish_run(claim.run_id, claim.lease, 'partial', summary)
        except RpcError as exc:
            if exc.code == 'INVENTORY_LEASE_LOST':
                self.lease_lost = True
                return {'status': 'lease_lost', 'runId': claim.run_id}
            self.logger.event('outcome_unknown_reconcile_failed', level='warn',
                              runId=claim.run_id, code=exc.code, detail=_clip(exc.detail))
            return {'status': 'error', 'runId': claim.run_id, 'errorCode': exc.code}
        except GatewayUnavailable as exc:
            self.logger.event('outcome_unknown_reconcile_deferred', level='warn',
                              runId=claim.run_id, detail=_clip(exc.detail))
            return {'status': 'deferred', 'runId': claim.run_id}
        final_status = str(response.get('status') or 'partial')
        self.logger.event('outcome_unknown_reconciled', runId=claim.run_id,
                          status=final_status, published=evaluation['publishedCount'],
                          missing=len(evaluation['missing']))
        return {'status': final_status, 'runId': claim.run_id, 'summary': summary,
                'reconciled': True,
                'scopeAllSuccess': bool(response.get('scopeAllSuccess'))}

    # -- failure helpers -----------------------------------------------------
    def _abort_with_export_error(self, claim: ClaimedRun, exc: BaseException) -> dict:
        code = getattr(exc, 'code', None) or 'WORKER_EXPORT_ERROR'
        detail = getattr(exc, 'detail', '') or f'{type(exc).__name__}: {exc}'
        needs_login = code in NEEDS_LOGIN_CODES
        self.logger.event(
            'run_export_failed', level='warn', runId=claim.run_id,
            code=code, detail=_clip(detail), needsLogin=needs_login,
        )
        result = self._fail(claim, str(code), _clip(detail), needs_login=needs_login)
        raise RunAborted(result) from exc

    def _fail(self, claim: ClaimedRun, code: str, detail: str, *,
              needs_login: bool = False, outcome_unknown: bool = False) -> dict:
        code = str(code)
        detail = _clip(sanitize(detail))
        try:
            self.gateway.fail_run(claim.run_id, claim.lease, code, detail,
                                  needs_login, outcome_unknown)
            logged = True
        except RpcError as exc:
            logged = False
            if exc.code == 'INVENTORY_LEASE_LOST':
                self.lease_lost = True
            self.logger.event('fail_run_failed', level='warn', runId=claim.run_id,
                              requestedCode=code, code=exc.code, detail=_clip(exc.detail))
        except GatewayUnavailable as exc:
            logged = False
            self.logger.event('fail_run_deferred', level='warn', runId=claim.run_id,
                              requestedCode=code, detail=_clip(exc.detail))
        status = 'needs_login' if needs_login else ('outcome_unknown' if outcome_unknown else 'failed')
        self.logger.event('run_failed', runId=claim.run_id, status=status, code=code,
                          detail=detail, needsLogin=needs_login,
                          outcomeUnknown=outcome_unknown, recorded=logged)
        return {'status': status, 'runId': claim.run_id, 'errorCode': code,
                'needsLogin': needs_login, 'recorded': logged}


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    argument_parser = argparse.ArgumentParser(description='inventory-sync-v1 background worker')
    argument_parser.add_argument('--config', required=True, help='inventory-worker.json 路径')
    argument_parser.add_argument('--once', action='store_true',
                                 help='只执行一次心跳/领取/执行后退出（联调/自验用）')
    args = argument_parser.parse_args(argv)

    try:
        config = load_config(args.config)
    except ConfigError as exc:
        print(f'inventory worker config error: {exc}', file=sys.stderr)
        return 2

    gateway = SyncDbGateway(config.sync_db_url)
    worker = Worker(config, gateway)
    try:
        if args.once:
            try:
                outcome = worker.run_once()
            except ShutdownRequested:
                print('inventory worker once: shutdown requested', file=sys.stderr)
                return 0
            print('inventory worker once: ' + json.dumps(sanitize(outcome), ensure_ascii=False))
            return 0
        worker.run_forever()
        return 0
    finally:
        gateway.close()


if __name__ == '__main__':
    sys.exit(main())
