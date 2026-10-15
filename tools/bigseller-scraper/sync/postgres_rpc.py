"""P0-02 sync runner：经 libpq 调用 public.sync_warehouse_inventory 与 sync_log 写入。"""
from __future__ import annotations

import json
from typing import Any


def _import_psycopg():
    try:
        import psycopg
    except ImportError as exc:
        raise RuntimeError(
            'P0-02 PostgreSQL RPC 需要 psycopg（pip install "psycopg[binary]"）',
        ) from exc
    return psycopg


def call_sync_warehouse_inventory_rpc(
    warehouse_id: str,
    p_variants: list,
    p_inventory: list,
    p_warehouse_name: str,
) -> dict:
    from .p0_02_connection_boundary import connect_validated_sync

    psycopg = _import_psycopg()
    conn = connect_validated_sync(import_psycopg=psycopg)
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT set_config('p0_02.sync.mode', 'warehouse', true)")
            cur.execute(
                "SELECT set_config('p0_02.sync.warehouse_id', %s, true)",
                (warehouse_id,),
            )
            cur.execute(
                """
                SELECT public.sync_warehouse_inventory(
                  %s::uuid,
                  %s::jsonb,
                  %s::jsonb,
                  %s
                )
                """,
                (
                    warehouse_id,
                    json.dumps(p_variants),
                    json.dumps(p_inventory),
                    p_warehouse_name,
                ),
            )
            row = cur.fetchone()
            if row is None:
                conn.commit()
                return {}
            payload = row[0] if not isinstance(row, dict) else row[list(row.keys())[0]]
            conn.commit()
            if isinstance(payload, dict):
                return payload
            if isinstance(payload, str):
                return json.loads(payload)
            return {}
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def write_sync_log_postgres(
    warehouse_id: str,
    status: str,
    new_variants_count: int,
    error_message: str | None,
    started_at: str,
    finished_at: str,
    *,
    sync_run_id: str | None = None,
    triggered_by: str | None = None,
) -> dict[str, Any]:
    from .p0_02_connection_boundary import connect_validated_sync

    psycopg = _import_psycopg()
    conn = connect_validated_sync(import_psycopg=psycopg)
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT set_config('p0_02.sync.mode', 'warehouse', true)")
            cur.execute(
                "SELECT set_config('p0_02.sync.warehouse_id', %s, true)",
                (warehouse_id,),
            )
            cur.execute(
                """
                INSERT INTO public.sync_log (
                  warehouse_id, status, new_variants_count,
                  error_message, started_at, finished_at,
                  sync_run_id, triggered_by
                ) VALUES (
                  %s::uuid, %s, %s, %s, %s::timestamptz, %s::timestamptz,
                  %s::uuid, %s::uuid
                )
                RETURNING id::text, status, warehouse_id::text, sync_run_id::text
                """,
                (
                    warehouse_id,
                    status,
                    new_variants_count,
                    error_message,
                    started_at,
                    finished_at,
                    sync_run_id,
                    triggered_by,
                ),
            )
            row = cur.fetchone()
            if row is None:
                raise RuntimeError('sync_log INSERT 未返回行')
            if isinstance(row, dict):
                record = {
                    'id': row['id'],
                    'status': row['status'],
                    'warehouse_id': row['warehouse_id'],
                }
            else:
                record = {'id': row[0], 'status': row[1], 'warehouse_id': row[2]}
        conn.commit()
        return record
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
