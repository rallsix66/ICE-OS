"""P0-02 发布结果只读核对：commit 回执丢失时不得误报已回滚。"""
from __future__ import annotations

from typing import Any


def verify_publish_state(
    *,
    warehouse_id: str,
    sync_run_id: str | None,
    inventory_id: str | None,
    expected_quantity: int | None,
    sku: str | None,
) -> dict[str, Any]:
    """独立连接只读核对库存与 success sync_log（不依赖可能已损坏的发布连接）。"""
    from .p0_02_connection_boundary import connect_validated_sync

    psycopg = __import__('psycopg')
    conn = connect_validated_sync(import_psycopg=psycopg)
    outcome: dict[str, Any] = {
        'inventory_quantity': None,
        'inventory_matches_expected': False,
        'success_log_present': False,
        'success_log_sync_run_id': None,
        'committed_evidence': False,
    }
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT set_config('p0_02.sync.mode', 'warehouse', true)")
            cur.execute(
                "SELECT set_config('p0_02.sync.warehouse_id', %s, true)",
                (warehouse_id,),
            )
            if inventory_id:
                cur.execute(
                    'SELECT quantity::int FROM public.inventory WHERE id = %s::uuid',
                    (inventory_id,),
                )
                row = cur.fetchone()
                if row is not None:
                    outcome['inventory_quantity'] = int(row[0])
                    if expected_quantity is not None:
                        outcome['inventory_matches_expected'] = (
                            outcome['inventory_quantity'] == expected_quantity
                        )
            elif sku:
                cur.execute(
                    """
                    SELECT i.quantity::int
                    FROM public.inventory i
                    JOIN public.product_variant v ON v.id = i.variant_id
                    WHERE i.warehouse_id = %s::uuid AND v.sku = %s
                    LIMIT 1
                    """,
                    (warehouse_id, sku),
                )
                row = cur.fetchone()
                if row is not None:
                    outcome['inventory_quantity'] = int(row[0])
                    if expected_quantity is not None:
                        outcome['inventory_matches_expected'] = (
                            outcome['inventory_quantity'] == expected_quantity
                        )

            if sync_run_id:
                cur.execute(
                    """
                    SELECT status, sync_run_id::text
                    FROM public.sync_log
                    WHERE warehouse_id = %s::uuid AND sync_run_id = %s::uuid
                    ORDER BY finished_at DESC NULLS LAST
                    LIMIT 1
                    """,
                    (warehouse_id, sync_run_id),
                )
                log_row = cur.fetchone()
                if log_row is not None:
                    status, run_text = log_row[0], log_row[1]
                    outcome['success_log_sync_run_id'] = run_text
                    outcome['success_log_present'] = status == 'success'
    finally:
        conn.close()

    inv_ok = (
        expected_quantity is None
        or outcome['inventory_matches_expected']
    )
    log_ok = sync_run_id is None or outcome['success_log_present']
    outcome['committed_evidence'] = inv_ok and log_ok
    return outcome
