"""同步 Dry Run / Plan 只读数据入口：P0-02 走 PostgreSQL，否则 Supabase REST。"""
from __future__ import annotations

import os

from .p0_02_connection_boundary import independent_p0_02_enabled, sync_database_url_from_env


def _legacy_supabase_path() -> bool:
    if independent_p0_02_enabled():
        return False
    return not sync_database_url_from_env()


def fetch_warehouse():
    if not _legacy_supabase_path():
        from .postgres_gateway import fetch_warehouse as pg_fetch

        return pg_fetch()
    from .supabase_gateway import fetch_warehouse as sb_fetch

    return sb_fetch()


def fetch_variants():
    if not _legacy_supabase_path():
        from .postgres_gateway import fetch_variants as pg_fetch

        return pg_fetch()
    from .supabase_gateway import fetch_variants as sb_fetch

    return sb_fetch()


def fetch_inventory_by_warehouse(warehouse_id: str):
    if not _legacy_supabase_path():
        from .postgres_gateway import fetch_inventory_by_warehouse as pg_fetch

        return pg_fetch(warehouse_id)
    from .supabase_gateway import fetch_inventory_by_warehouse as sb_fetch

    return sb_fetch(warehouse_id)
