"""pytest bootstrap for the inventory-sync-v1 Python worker tests.

The worker modules live in ``tools/inventory-sync`` (a hyphenated directory, so they
are imported as plain modules the same way ``worker.py`` is launched).
"""
from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
TOOLS_DIR = REPO_ROOT / 'tools' / 'inventory-sync'
for entry in (str(TOOLS_DIR), str(REPO_ROOT)):
    if entry not in sys.path:
        sys.path.insert(0, entry)
