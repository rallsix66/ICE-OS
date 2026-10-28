"""inventory-sync-v1 background worker package (Python).

Modules:
    config       -- --config JSON loading/validation (never logs DSNs)
    db_gateway   -- psycopg calls to the sync-role ``catalog.*`` RPCs
    parser       -- header-by-meaning Excel parsing, amount isolation
    publisher    -- per-warehouse grouping/publishing, failure isolation
    recovery     -- restart recovery / outcome_unknown / needs_login handling
    worker       -- persistent loop, JSONL logging, SIGTERM/SIGINT shutdown
"""
from __future__ import annotations

__all__ = ['config', 'db_gateway', 'parser', 'publisher', 'recovery', 'worker']
__version__ = 'inv-sync-v1'
