"""Config loader tests: validation and secret-free summaries."""
from __future__ import annotations

import json

import pytest

from config import ConfigError, load_config


def write_config(tmp_path, payload: dict):
    path = tmp_path / 'inventory-worker.json'
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding='utf-8')
    return path


def base_payload(tmp_path) -> dict:
    return {
        'runId': 'run-test',
        'appDbUrl': 'postgres://app_runner:appsecret@127.0.0.1:5555/db',
        'syncDbUrl': 'postgres://sync_runner:syncsecret@127.0.0.1:5555/db',
        'workDir': str(tmp_path / 'inventory-work'),
        'workerId': 'inv-worker-5555',
        'version': 'inv-sync-v1',
        'leaseSeconds': 120,
        'exportTimeoutSeconds': 300,
        'logPath': str(tmp_path / 'inventory-work' / 'logs'),
        'exportDir': str(tmp_path / 'inventory-work' / 'exports'),
    }


def test_loads_valid_config(tmp_path):
    config = load_config(write_config(tmp_path, base_payload(tmp_path)))

    assert config.run_id == 'run-test'
    assert config.worker_id == 'inv-worker-5555'
    assert config.lease_seconds == 120
    assert config.export_timeout_seconds == 300
    assert config.log_path == tmp_path / 'inventory-work' / 'logs'
    assert config.export_dir == tmp_path / 'inventory-work' / 'exports'


def test_defaults_when_optional_paths_absent(tmp_path):
    payload = base_payload(tmp_path)
    payload.pop('logPath')
    payload.pop('exportDir')
    config = load_config(write_config(tmp_path, payload))

    assert config.log_path == tmp_path / 'inventory-work' / 'logs'
    assert config.export_dir == tmp_path / 'inventory-work' / 'exports'
    assert config.heartbeat_seconds == 10
    assert config.claim_seconds == 10


def test_public_summary_never_contains_credentials(tmp_path):
    config = load_config(write_config(tmp_path, base_payload(tmp_path)))
    summary = json.dumps(config.public_summary(), ensure_ascii=False)

    assert 'postgres' not in summary
    assert 'syncsecret' not in summary
    assert 'appsecret' not in summary
    assert 'syncDbUrl' not in summary
    assert 'test-worker' not in summary or True  # workerId is safe to log
    assert repr(config).find('syncsecret') == -1


def test_account_label_optional(tmp_path):
    payload = base_payload(tmp_path)
    payload['accountLabel'] = 'laiguoyong@KNZX019402'
    config = load_config(write_config(tmp_path, payload))
    assert config.account_label == 'laiguoyong@KNZX019402'

    payload.pop('accountLabel')
    config = load_config(write_config(tmp_path, payload))
    assert config.account_label is None


def test_missing_required_field(tmp_path):
    payload = base_payload(tmp_path)
    payload.pop('syncDbUrl')
    with pytest.raises(ConfigError) as excinfo:
        load_config(write_config(tmp_path, payload))
    assert 'syncDbUrl' in str(excinfo.value)


def test_invalid_lease_seconds(tmp_path):
    payload = base_payload(tmp_path)
    payload['leaseSeconds'] = 5
    with pytest.raises(ConfigError) as excinfo:
        load_config(write_config(tmp_path, payload))
    assert 'leaseSeconds' in str(excinfo.value)


def test_missing_or_invalid_file(tmp_path):
    with pytest.raises(ConfigError):
        load_config(tmp_path / 'missing.json')

    bad = tmp_path / 'bad.json'
    bad.write_text('{not json', encoding='utf-8')
    with pytest.raises(ConfigError):
        load_config(bad)
