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
        'evidence_reason': None,
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

    return finalize_committed_evidence(
        outcome,
        expected_quantity=expected_quantity,
        sync_run_id=sync_run_id,
    )


def finalize_committed_evidence(
    outcome: dict[str, Any],
    *,
    expected_quantity: int | None,
    sync_run_id: str | None,
) -> dict[str, Any]:
    if expected_quantity is None or not sync_run_id:
        outcome['evidence_reason'] = 'missing_expected_quantity_or_sync_run_id'
        outcome['committed_evidence'] = False
        return outcome

    if outcome['inventory_quantity'] is None:
        outcome['evidence_reason'] = 'inventory_row_missing'
        outcome['committed_evidence'] = False
        return outcome

    if not outcome['inventory_matches_expected']:
        outcome['evidence_reason'] = 'inventory_quantity_mismatch'
        outcome['committed_evidence'] = False
        return outcome

    if not outcome['success_log_present']:
        outcome['evidence_reason'] = 'success_log_missing'
        outcome['committed_evidence'] = False
        return outcome

    if outcome['success_log_sync_run_id'] != sync_run_id:
        outcome['evidence_reason'] = 'success_log_run_id_mismatch'
        outcome['committed_evidence'] = False
        return outcome

    outcome['evidence_reason'] = 'ok'
    outcome['committed_evidence'] = True
    return outcome
