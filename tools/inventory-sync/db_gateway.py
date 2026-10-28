"""Thin psycopg gateway for the sync-role inventory RPCs (contract §3.2).

Every call is a single ``SELECT catalog.<fn>(...) AS result`` statement. The SQL
functions are SECURITY DEFINER and own their transactions, so the connection is
used in autocommit mode; the worker never writes tables directly.

Two failure classes are distinguished:
  * ``RpcError``          -- the database answered with a structured error (e.g.
                             INVENTORY_LEASE_LOST, INVENTORY_BATCH_CONFLICT);
  * ``GatewayUnavailable`` -- the connection failed, so a write may or may not have
                             been committed (treated as "outcome unknown" by callers).

The DSN is never included in exception text or logs.
"""
from __future__ import annotations

import json
import re
from typing import Any, Iterable

try:  # psycopg is an existing project dependency; tests inject a fake gateway.
    import psycopg
    from psycopg import errors as pg_errors
except Exception:  # pragma: no cover - only when the dependency is absent
    psycopg = None
    pg_errors = None

_RPC_CODE_RE = re.compile(r'^([A-Z][A-Z0-9_]{2,})\b')
_CONNECTION_SQLSTATE_PREFIXES = ('08',)
_CONNECTION_MESSAGE_MARKERS = (
    'connection', 'server closed', 'terminating connection', 'could not connect',
    'timeout expired', 'broken pipe', 'network', 'ssl', 'socket',
)


class RpcError(RuntimeError):
    """A structured database error (business error code)."""

    def __init__(self, code: str, detail: str = '', sqlstate: str | None = None):
        super().__init__(f'{code}: {detail}' if detail else code)
        self.code = code
        self.detail = detail
        self.sqlstate = sqlstate


class GatewayUnavailable(RuntimeError):
    """The connection failed; a write may have been applied without a response."""

    def __init__(self, detail: str = '', sqlstate: str | None = None):
        super().__init__(f'DB_UNAVAILABLE: {detail}' if detail else 'DB_UNAVAILABLE')
        self.code = 'DB_UNAVAILABLE'
        self.detail = detail
        self.sqlstate = sqlstate


def _extract_code(message: str, fallback: str) -> str:
    match = _RPC_CODE_RE.match((message or '').strip())
    return match.group(1) if match else fallback


def _extract_detail(message: str, code: str) -> str:
    text = (message or '').strip()
    if text.startswith(code):
        text = text[len(code):].lstrip(': ').strip()
    return text[:500]


class SyncDbGateway:
    """Calls the sync-role functions with short reconnect/retry semantics."""

    def __init__(self, dsn: str, *, connect_timeout: int = 10, retry_unavailable: int = 1):
        self._dsn = dsn
        self._connect_timeout = connect_timeout
        self._retry_unavailable = retry_unavailable
        self._conn = None

    # -- connection management ------------------------------------------------
    def connect(self):
        if psycopg is None:
            raise GatewayUnavailable('psycopg 未安装')
        if self._conn is not None and not getattr(self._conn, 'closed', True):
            return self._conn
        try:
            self._conn = psycopg.connect(
                self._dsn,
                autocommit=True,
                connect_timeout=self._connect_timeout,
                application_name='inventory-sync-worker',
            )
        except Exception as exc:  # noqa: BLE001 - normalise everything
            self._conn = None
            raise GatewayUnavailable(_connection_detail(exc), _sqlstate(exc)) from None
        return self._conn

    def close(self) -> None:
        conn, self._conn = self._conn, None
        if conn is not None:
            try:
                conn.close()
            except Exception:  # noqa: BLE001
                pass

    @property
    def connected(self) -> bool:
        return self._conn is not None and not getattr(self._conn, 'closed', True)

    # -- low level ------------------------------------------------------------
    def _call(self, sql: str, params: Iterable[Any], *, retry_unavailable: int | None = None) -> dict:
        attempts = self._retry_unavailable if retry_unavailable is None else retry_unavailable
        last_error: GatewayUnavailable | None = None
        for attempt in range(attempts + 1):
            try:
                conn = self.connect()
                with conn.cursor() as cursor:
                    cursor.execute(sql, tuple(params))
                    row = cursor.fetchone()
                if row is None or row[0] is None:
                    raise RpcError('MALFORMED_RPC_RESULT', '数据库函数未返回结果', None)
                result = row[0]
                if isinstance(result, str):
                    try:
                        result = json.loads(result)
                    except ValueError:
                        raise RpcError('MALFORMED_RPC_RESULT', '返回结果不是 JSON', None) from None
                if not isinstance(result, dict):
                    raise RpcError('MALFORMED_RPC_RESULT', '返回结果不是对象', None)
                return result
            except GatewayUnavailable as exc:
                last_error = exc
                self.close()
                if attempt < attempts:
                    continue
                raise last_error from None
            except RpcError:
                raise
            except Exception as exc:  # noqa: BLE001
                message = str(exc)
                sqlstate = _sqlstate(exc)
                self.close()
                if _is_connection_error(exc, message, sqlstate):
                    last_error = GatewayUnavailable(_connection_detail(exc), sqlstate)
                    if attempt < attempts:
                        continue
                    raise last_error from None
                code = _extract_code(message, 'DB_RPC_ERROR')
                raise RpcError(code, _extract_detail(message, code), sqlstate) from None
        raise last_error or GatewayUnavailable('DB_UNAVAILABLE')

    # -- contract §3.2 functions ---------------------------------------------
    def register_worker(self, worker_id: str, host: str, pid: int, version: str) -> dict:
        return self._call(
            'SELECT catalog.register_inventory_worker(%s, %s, %s, %s) AS result',
            (worker_id, host, pid, version),
        )

    def claim_run(self, worker_id: str, lease_seconds: int) -> dict:
        return self._call(
            'SELECT catalog.claim_inventory_run(%s, %s) AS result',
            (worker_id, lease_seconds),
        )

    def update_phase(self, run_id: str, lease: str, phase: str, detail: dict) -> dict:
        return self._call(
            'SELECT catalog.update_inventory_run_phase(%s::uuid, %s::uuid, %s, %s::jsonb) AS result',
            (run_id, lease, phase, json.dumps(detail, ensure_ascii=False)),
        )

    def register_export(self, run_id: str, lease: str, payload: dict) -> dict:
        return self._call(
            'SELECT catalog.register_inventory_export(%s::uuid, %s::uuid, %s::jsonb) AS result',
            (run_id, lease, json.dumps(payload, ensure_ascii=False)),
        )

    def publish_warehouse(self, run_id: str, lease: str, warehouse: dict, rows: list) -> dict:
        return self._call(
            'SELECT catalog.publish_inventory_warehouse(%s::uuid, %s::uuid, %s::jsonb, %s::jsonb) AS result',
            (run_id, lease, json.dumps(warehouse, ensure_ascii=False),
             json.dumps(rows, ensure_ascii=False)),
        )

    def finish_run(self, run_id: str, lease: str, status: str, summary: dict) -> dict:
        return self._call(
            'SELECT catalog.finish_inventory_run(%s::uuid, %s::uuid, %s, %s::jsonb) AS result',
            (run_id, lease, status, json.dumps(summary, ensure_ascii=False)),
        )

    def fail_run(self, run_id: str, lease: str, error_code: str, error_detail: str,
                 needs_login: bool, outcome_unknown: bool) -> dict:
        return self._call(
            'SELECT catalog.fail_inventory_run(%s::uuid, %s::uuid, %s, %s, %s, %s) AS result',
            (run_id, lease, error_code, error_detail, needs_login, outcome_unknown),
        )

    def read_run_work(self, run_id: str, lease: str) -> dict:
        return self._call(
            'SELECT catalog.read_inventory_run_work(%s::uuid, %s::uuid) AS result',
            (run_id, lease),
        )

    def reconcile_request(self, request_id: str, intent: str) -> dict:
        return self._call(
            'SELECT catalog.reconcile_inventory_request(%s::uuid, %s) AS result',
            (request_id, intent),
        )

    def refresh_account_status(self, worker_id: str, logged_in: bool,
                               account_label: str | None = None) -> dict:
        """Re-activate a needs_login account after a successful manual login."""
        return self._call(
            'SELECT catalog.refresh_inventory_account_status(%s::text, %s::boolean, %s::text) AS result',
            (worker_id, logged_in, account_label),
        )


def _sqlstate(exc: Exception) -> str | None:
    for attr in ('sqlstate', 'pgcode'):
        value = getattr(exc, attr, None)
        if isinstance(value, str) and value:
            return value
    return None


def _is_connection_error(exc: Exception, message: str, sqlstate: str | None) -> bool:
    if pg_errors is not None:
        for name in ('OperationalError', 'InterfaceError'):
            cls = getattr(pg_errors, name, None)
            if cls is not None and isinstance(exc, cls):
                return True
    if sqlstate and sqlstate[:2] in _CONNECTION_SQLSTATE_PREFIXES:
        return True
    lowered = message.lower()
    return any(marker in lowered for marker in _CONNECTION_MESSAGE_MARKERS)


def _connection_detail(exc: Exception) -> str:
    name = type(exc).__name__
    message = str(exc).replace('\n', ' ').strip()
    return f'{name}: {message[:300]}' if message else name
