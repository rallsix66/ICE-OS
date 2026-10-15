"""P0-02 只读 PostgreSQL 网关 — sync runner 连接，替代 Supabase REST 读路径。"""
from __future__ import annotations

from contextlib import contextmanager
from typing import Any, Iterator

from .config import WAREHOUSE_COUNTRY, WAREHOUSE_TYPE
from .p0_02_connection_boundary import connect_validated_sync, independent_p0_02_enabled
from .postgres_dto import row_to_gateway_dto, rows_to_gateway_dtos


def _import_psycopg():
    try:
        import psycopg
        from psycopg.rows import dict_row
    except ImportError as exc:
        raise RuntimeError(
            'P0-02 PostgreSQL 网关需要 psycopg（pip install "psycopg[binary]"）',
        ) from exc
    return psycopg, dict_row


def _warehouse_id_text(warehouse_id: str | None) -> str:
    if warehouse_id is None:
        return ''
    return str(warehouse_id)


@contextmanager
def _sync_scope(mode: str, warehouse_id: str | None = None) -> Iterator[Any]:
    from .p0_02_connection_boundary import (
        assert_connection_contract,
        assert_no_libpq_target_overrides,
        require_sync_database_url,
    )

    url = require_sync_database_url()
    assert_no_libpq_target_overrides()
    assert_connection_contract(url, 'P0_02_SYNC_DATABASE_URL')
    psycopg, dict_row = _import_psycopg()
    conn = connect_validated_sync(import_psycopg=psycopg)
    conn.row_factory = dict_row
    wh_text = _warehouse_id_text(warehouse_id)
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT set_config('p0_02.sync.mode', %s, true)", (mode,))
            cur.execute("SELECT set_config('p0_02.sync.warehouse_id', %s, true)", (wh_text,))
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _query(sql: str, params: tuple[Any, ...] = (), *, mode: str, warehouse_id: str | None = None) -> list[dict]:
    with _sync_scope(mode, warehouse_id) as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            rows = cur.fetchall()
            return rows_to_gateway_dtos([dict(row) for row in rows])


def fetch_warehouse() -> dict:
    rows = _query(
        """
        SELECT id, name, country, type, is_active
        FROM public.warehouse
        WHERE country = %s AND type = %s
        """,
        (WAREHOUSE_COUNTRY, WAREHOUSE_TYPE),
        mode='discover',
    )
    active = [r for r in rows if r.get('is_active') is True]
    if len(active) == 0:
        if len(rows) == 0:
            raise RuntimeError(
                f'未找到 country={WAREHOUSE_COUNTRY} type={WAREHOUSE_TYPE} 的仓库',
            )
        raise RuntimeError(
            f'已找到 {len(rows)} 个 {WAREHOUSE_COUNTRY} overseas 仓库，但全部 is_active=false',
        )
    if len(active) > 1:
        names = [r.get('name', '?') for r in active]
        raise RuntimeError(
            f'预期 1 个活跃 {WAREHOUSE_COUNTRY} overseas 仓库，实际 {len(active)} 个: {names}',
        )
    return row_to_gateway_dto(active[0])


def fetch_variants() -> list[dict]:
    warehouse = fetch_warehouse()
    warehouse_id = warehouse['id']
    return _query(
        """
        SELECT id, sku, country, name, product_id, match_status
        FROM public.product_variant
        WHERE country = %s
        """,
        (WAREHOUSE_COUNTRY,),
        mode='warehouse',
        warehouse_id=warehouse_id,
    )


def fetch_warehouse_by_id(warehouse_id: str) -> dict:
    wh_text = _warehouse_id_text(warehouse_id)
    rows = _query(
        """
        SELECT id, name, country, type, is_active
        FROM public.warehouse
        WHERE id = %s::uuid
        """,
        (wh_text,),
        mode='warehouse',
        warehouse_id=wh_text,
    )
    if not rows:
        raise RuntimeError(f'未找到 warehouse_id={warehouse_id}')
    return row_to_gateway_dto(rows[0])


def fetch_inventory_by_warehouse(warehouse_id: str) -> list[dict]:
    wh_text = _warehouse_id_text(warehouse_id)
    return _query(
        """
        SELECT id, variant_id, warehouse_id, quantity
        FROM public.inventory
        WHERE warehouse_id = %s::uuid
        """,
        (wh_text,),
        mode='warehouse',
        warehouse_id=wh_text,
    )


def fetch_inventory_by_warehouse_conn(conn, warehouse_id: str) -> list[dict]:
    """同一 libpq 连接内只读 inventory（发布事务内审计）。"""
    from .postgres_rpc import _apply_sync_scope

    psycopg, dict_row = _import_psycopg()
    conn.row_factory = dict_row
    wh_text = _warehouse_id_text(warehouse_id)
    with conn.cursor() as cur:
        _apply_sync_scope(cur, wh_text)
        cur.execute(
            """
            SELECT id, variant_id, warehouse_id, quantity
            FROM public.inventory
            WHERE warehouse_id = %s::uuid
            """,
            (wh_text,),
        )
        rows = cur.fetchall()
        return rows_to_gateway_dtos([dict(row) for row in rows])


def fetch_variants_conn(conn, *, warehouse_id: str) -> list[dict]:
    from .postgres_rpc import _apply_sync_scope

    psycopg, dict_row = _import_psycopg()
    conn.row_factory = dict_row
    wh_text = _warehouse_id_text(warehouse_id)
    with conn.cursor() as cur:
        _apply_sync_scope(cur, wh_text)
        cur.execute(
            """
            SELECT id, sku, country, name, product_id, match_status
            FROM public.product_variant
            WHERE country = %s
            """,
            (WAREHOUSE_COUNTRY,),
        )
        rows = cur.fetchall()
        return rows_to_gateway_dtos([dict(row) for row in rows])


def fetch_warehouse_by_id_conn(conn, warehouse_id: str) -> dict:
    from .postgres_rpc import _apply_sync_scope

    psycopg, dict_row = _import_psycopg()
    conn.row_factory = dict_row
    wh_text = _warehouse_id_text(warehouse_id)
    with conn.cursor() as cur:
        _apply_sync_scope(cur, wh_text)
        cur.execute(
            """
            SELECT id, name, country, type, is_active
            FROM public.warehouse
            WHERE id = %s::uuid
            """,
            (wh_text,),
        )
        rows = cur.fetchall()
    if not rows:
        raise RuntimeError(f'未找到 warehouse_id={warehouse_id}')
    return row_to_gateway_dto(dict(rows[0]))


def assert_independent_gateway_ready() -> None:
    """Import-time guard when P0-02 is enabled (no Supabase fallback)."""
    if independent_p0_02_enabled():
        from .p0_02_connection_boundary import require_sync_database_url

        require_sync_database_url()
