"""bigseller_session path resolution tests (frozen worker source / R6 integration).

The frozen worker runs from ``<run>/instance/inventory-worker-src/`` where
``Path(__file__).parents[2]`` is the run root, not the repository. The module must thus
support explicit repository/profile/evidence overrides while keeping the legacy
behaviour when no environment variable is set.
"""
from __future__ import annotations

import importlib.util
import shutil
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
SESSION_SRC = REPO_ROOT / 'tools' / 'inventory-sync' / 'bigseller_session.py'


def _load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
    finally:
        sys.modules.pop(name, None)
    return module


def _frozen_copy(tmp_path: Path) -> Path:
    """Replicate the frozen layout: <run>/instance/inventory-worker-src/bigseller_session.py."""
    target = (tmp_path / 'run-frozen' / 'instance' / 'inventory-worker-src'
              / 'bigseller_session.py')
    target.parent.mkdir(parents=True)
    shutil.copyfile(SESSION_SRC, target)
    return target


def _clear_path_env(monkeypatch) -> None:
    for name in ('INVENTORY_BS_REPO_ROOT', 'INVENTORY_BS_PROFILE_DIR',
                 'INVENTORY_BS_EVIDENCE_ROOT'):
        monkeypatch.delenv(name, raising=False)


def test_frozen_source_uses_repo_root_override(tmp_path, monkeypatch):
    _clear_path_env(monkeypatch)
    monkeypatch.setenv('INVENTORY_BS_REPO_ROOT', str(REPO_ROOT))

    module = _load_module(_frozen_copy(tmp_path), 'frozen_session_repo_root')

    assert module.REPO_ROOT == REPO_ROOT
    assert module.PROFILE_DIR == REPO_ROOT / 'tools' / 'bigseller-scraper' / 'runtime' / 'profile'
    assert module.EVIDENCE_ROOT == REPO_ROOT / '.local' / 'inventory-sync-20261025'
    assert module.SESSION_DIR == REPO_ROOT / '.local' / 'inventory-sync-20261025' / 'session'
    assert module.LOCK_FILE == (REPO_ROOT / '.local' / 'inventory-sync-20261025'
                                / 'session' / 'browser.lock')
    assert module.STATUS_FILE == (REPO_ROOT / '.local' / 'inventory-sync-20261025'
                                  / 'session' / 'session-status.json')


def test_explicit_profile_and_evidence_overrides(tmp_path, monkeypatch):
    _clear_path_env(monkeypatch)
    profile = tmp_path / 'shared-profile'
    evidence = tmp_path / 'shared-evidence'
    monkeypatch.setenv('INVENTORY_BS_REPO_ROOT', str(REPO_ROOT))
    monkeypatch.setenv('INVENTORY_BS_PROFILE_DIR', str(profile))
    monkeypatch.setenv('INVENTORY_BS_EVIDENCE_ROOT', str(evidence))

    module = _load_module(_frozen_copy(tmp_path), 'frozen_session_explicit')

    assert module.PROFILE_DIR == profile
    assert module.EVIDENCE_ROOT == evidence
    assert module.LOCK_FILE == evidence / 'session' / 'browser.lock'
    assert module.STATUS_FILE == evidence / 'session' / 'session-status.json'


def test_without_env_keeps_legacy_parents_two_behaviour(tmp_path, monkeypatch):
    _clear_path_env(monkeypatch)
    module = _load_module(_frozen_copy(tmp_path), 'frozen_session_legacy')

    fake_run_root = tmp_path / 'run-frozen'
    assert module.REPO_ROOT == fake_run_root
    assert module.PROFILE_DIR == fake_run_root / 'tools' / 'bigseller-scraper' / 'runtime' / 'profile'
    assert module.LOCK_FILE == (fake_run_root / '.local' / 'inventory-sync-20261025'
                                / 'session' / 'browser.lock')


def test_relative_repo_root_override_is_rejected(tmp_path, monkeypatch):
    _clear_path_env(monkeypatch)
    monkeypatch.setenv('INVENTORY_BS_REPO_ROOT', 'relative/not/allowed')
    with pytest.raises(RuntimeError) as excinfo:
        _load_module(_frozen_copy(tmp_path), 'frozen_session_invalid')
    assert 'INVENTORY_BS_REPO_ROOT_MUST_BE_ABSOLUTE' in str(excinfo.value)
