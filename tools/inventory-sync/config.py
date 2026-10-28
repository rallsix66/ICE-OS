"""Worker configuration loader for the inventory-sync-v1 background program.

The JSON file is produced by ``scripts/inventory/prepare-instance.mjs`` (Lead-owned).
The worker never invents or assembles database URLs; it only reads the ones given by
that instance file. Credentials must never appear in logs or exception messages,
therefore the URL fields are excluded from ``repr()``.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

CONFIG_REQUIRED_KEYS = ('syncDbUrl', 'workDir', 'workerId')
DEFAULT_HEARTBEAT_SECONDS = 10
DEFAULT_CLAIM_SECONDS = 10
DEFAULT_LEASE_SECONDS = 120
DEFAULT_EXPORT_TIMEOUT_SECONDS = 300
MIN_LEASE_SECONDS = 30
MAX_LEASE_SECONDS = 3600
MIN_EXPORT_TIMEOUT_SECONDS = 30
MAX_EXPORT_TIMEOUT_SECONDS = 3600


class ConfigError(RuntimeError):
    """Raised when the --config JSON cannot be used to run the worker."""


@dataclass(frozen=True)
class WorkerConfig:
    run_id: str
    app_db_url: str = field(repr=False)
    sync_db_url: str = field(repr=False)
    work_dir: Path
    worker_id: str
    version: str = 'inv-sync-v1'
    lease_seconds: int = DEFAULT_LEASE_SECONDS
    export_timeout_seconds: int = DEFAULT_EXPORT_TIMEOUT_SECONDS
    heartbeat_seconds: int = DEFAULT_HEARTBEAT_SECONDS
    claim_seconds: int = DEFAULT_CLAIM_SECONDS
    log_path: Path = field(default_factory=lambda: Path('.'))
    export_dir: Path = field(default_factory=lambda: Path('.'))
    account_label: str | None = None
    source_path: Path | None = None

    def public_summary(self) -> dict[str, Any]:
        """Configuration facts that are safe to write to the JSONL log."""
        return {
            'runId': self.run_id,
            'workerId': self.worker_id,
            'version': self.version,
            'workDir': str(self.work_dir),
            'logPath': str(self.log_path),
            'exportDir': str(self.export_dir),
            'leaseSeconds': self.lease_seconds,
            'exportTimeoutSeconds': self.export_timeout_seconds,
        }


def _require_str(raw: dict[str, Any], key: str) -> str:
    value = raw.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ConfigError(f'CONFIG_INVALID: 缺少字符串字段 {key}')
    return value.strip()


def _optional_str(raw: dict[str, Any], key: str, default: str = '') -> str:
    value = raw.get(key)
    if value is None:
        return default
    if not isinstance(value, str):
        raise ConfigError(f'CONFIG_INVALID: 字段 {key} 必须是字符串')
    return value.strip()


def _bounded_int(raw: dict[str, Any], key: str, default: int, minimum: int, maximum: int) -> int:
    value = raw.get(key, default)
    if isinstance(value, str) and value.strip().isdigit():
        value = int(value.strip())
    if isinstance(value, bool) or not isinstance(value, int):
        raise ConfigError(f'CONFIG_INVALID: 字段 {key} 必须是整数')
    if value < minimum or value > maximum:
        raise ConfigError(f'CONFIG_INVALID: 字段 {key} 必须在 {minimum}..{maximum} 之间')
    return value


def load_config(path: str | Path) -> WorkerConfig:
    """Read and validate the worker JSON config file."""
    config_path = Path(path)
    if not config_path.is_file():
        raise ConfigError(f'CONFIG_MISSING: {config_path}')
    try:
        raw = json.loads(config_path.read_text(encoding='utf-8-sig'))
    except (OSError, ValueError) as exc:
        raise ConfigError(f'CONFIG_INVALID: 无法解析 {config_path.name}: {type(exc).__name__}') from exc
    if not isinstance(raw, dict):
        raise ConfigError('CONFIG_INVALID: 配置根节点必须是对象')

    missing = [key for key in CONFIG_REQUIRED_KEYS if not raw.get(key)]
    if missing:
        raise ConfigError(f'CONFIG_INVALID: 缺少字段 {", ".join(missing)}')

    sync_db_url = _require_str(raw, 'syncDbUrl')
    app_db_url = _optional_str(raw, 'appDbUrl')
    work_dir = Path(_require_str(raw, 'workDir'))
    worker_id = _require_str(raw, 'workerId')

    log_path_raw = _optional_str(raw, 'logPath')
    export_dir_raw = _optional_str(raw, 'exportDir')
    log_path = Path(log_path_raw) if log_path_raw else work_dir / 'logs'
    export_dir = Path(export_dir_raw) if export_dir_raw else work_dir / 'exports'

    return WorkerConfig(
        run_id=_optional_str(raw, 'runId'),
        app_db_url=app_db_url,
        sync_db_url=sync_db_url,
        work_dir=work_dir,
        worker_id=worker_id,
        version=_optional_str(raw, 'version', 'inv-sync-v1') or 'inv-sync-v1',
        lease_seconds=_bounded_int(raw, 'leaseSeconds', DEFAULT_LEASE_SECONDS,
                                   MIN_LEASE_SECONDS, MAX_LEASE_SECONDS),
        export_timeout_seconds=_bounded_int(raw, 'exportTimeoutSeconds',
                                            DEFAULT_EXPORT_TIMEOUT_SECONDS,
                                            MIN_EXPORT_TIMEOUT_SECONDS, MAX_EXPORT_TIMEOUT_SECONDS),
        heartbeat_seconds=_bounded_int(raw, 'heartbeatSeconds', DEFAULT_HEARTBEAT_SECONDS, 1, 600),
        claim_seconds=_bounded_int(raw, 'claimSeconds', DEFAULT_CLAIM_SECONDS, 1, 600),
        log_path=log_path,
        export_dir=export_dir,
        account_label=_optional_str(raw, 'accountLabel') or None,
        source_path=config_path,
    )
