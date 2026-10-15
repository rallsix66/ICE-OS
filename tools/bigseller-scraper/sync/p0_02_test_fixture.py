"""P0-02 独占测试 fixture 登记与恢复（精确 UUID，禁止前缀扫描删除）。"""
from __future__ import annotations

import json
import sys
from dataclasses import dataclass, field
from typing import Any


@dataclass
class OwnedFixtureRegistry:
    dsn: str
    warehouse_ids: list[str] = field(default_factory=list)
    variant_ids: list[str] = field(default_factory=list)
    inventory_ids: list[str] = field(default_factory=list)
    sync_run_ids: list[str] = field(default_factory=list)
    preference_keys: list[tuple[str, str]] = field(default_factory=list)
    owned_skus: list[tuple[str, str]] = field(default_factory=list)
    _baseline_sentinels: dict[str, list[tuple]] | None = None
    _baseline_counts: dict[str, int] | None = None

    def _connect(self):
        import psycopg

        return psycopg.connect(self.dsn)

    def capture_baseline(self) -> None:
        import psycopg

        conn = self._connect()
        try:
            with conn.cursor() as cur:
                counts: dict[str, int] = {}
                for table in (
                    'product_variant',
                    'inventory',
                    'sync_run',
                    'sync_log',
                    'user_variant_preference',
                ):
                    cur.execute(f'SELECT COUNT(*)::int FROM public.{table}')
                    counts[table] = int(cur.fetchone()[0])
                self._baseline_counts = counts
        finally:
            conn.close()

    def register_warehouse(self, warehouse_id: str) -> None:
        if warehouse_id not in self.warehouse_ids:
            self.warehouse_ids.append(warehouse_id)

    def register_variant(self, variant_id: str) -> None:
        if variant_id not in self.variant_ids:
            self.variant_ids.append(variant_id)

    def register_inventory(self, inventory_id: str) -> None:
        if inventory_id not in self.inventory_ids:
            self.inventory_ids.append(inventory_id)

    def register_sync_run(self, run_id: str) -> None:
        if run_id not in self.sync_run_ids:
            self.sync_run_ids.append(run_id)

    def register_preference(self, user_id: str, variant_id: str) -> None:
        key = (user_id, variant_id)
        if key not in self.preference_keys:
            self.preference_keys.append(key)

    def register_owned_sku(self, sku: str, warehouse_id: str) -> None:
        key = (sku, warehouse_id)
        if key not in self.owned_skus:
            self.owned_skus.append(key)

    def capture_sentinel_snapshot(self, warehouse_ids: list[str]) -> None:
        import psycopg

        conn = self._connect()
        try:
            with conn.cursor() as cur:
                sentinels: dict[str, list[tuple]] = {}
                for wh in warehouse_ids:
                    cur.execute(
                        """
                        SELECT w.id::text, w.name, w.country, w.is_active,
                               COALESCE(
                                 json_agg(
                                   json_build_object(
                                     'variant_id', v.id::text,
                                     'sku', v.sku,
                                     'quantity', i.quantity::int
                                   )
                                   ORDER BY v.sku
                                 ) FILTER (WHERE v.id IS NOT NULL),
                                 '[]'::json
                               ) AS inv
                        FROM public.warehouse w
                        LEFT JOIN public.inventory i ON i.warehouse_id = w.id
                        LEFT JOIN public.product_variant v ON v.id = i.variant_id
                        WHERE w.id = %s::uuid
                        GROUP BY w.id, w.name, w.country, w.is_active
                        """,
                        (wh,),
                    )
                    row = cur.fetchone()
                    if row is not None:
                        sentinels[wh] = [row]
                self._baseline_sentinels = sentinels
        finally:
            conn.close()

    def assert_sentinels_unchanged(self, warehouse_ids: list[str]) -> None:
        if self._baseline_sentinels is None:
            return
        import psycopg

        conn = self._connect()
        try:
            with conn.cursor() as cur:
                for wh in warehouse_ids:
                    cur.execute(
                        """
                        SELECT w.id::text, w.name, w.country, w.is_active,
                               COALESCE(
                                 json_agg(
                                   json_build_object(
                                     'variant_id', v.id::text,
                                     'sku', v.sku,
                                     'quantity', i.quantity::int
                                   )
                                   ORDER BY v.sku
                                 ) FILTER (WHERE v.id IS NOT NULL),
                                 '[]'::json
                               ) AS inv
                        FROM public.warehouse w
                        LEFT JOIN public.inventory i ON i.warehouse_id = w.id
                        LEFT JOIN public.product_variant v ON v.id = i.variant_id
                        WHERE w.id = %s::uuid
                        GROUP BY w.id, w.name, w.country, w.is_active
                        """,
                        (wh,),
                    )
                    row = cur.fetchone()
                    baseline = self._baseline_sentinels.get(wh)
                    if baseline != [row]:
                        raise AssertionError(
                            f'sentinel warehouse changed: wh={wh} baseline={baseline} current={[row]}',
                        )
        finally:
            conn.close()

    def resolve_and_register_variant_by_sku(
        self,
        sku: str,
        warehouse_id: str,
    ) -> str | None:
        import psycopg

        conn = self._connect()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT v.id::text
                    FROM public.product_variant v
                    JOIN public.inventory i ON i.variant_id = v.id
                    WHERE v.sku = %s AND i.warehouse_id = %s::uuid
                    LIMIT 1
                    """,
                    (sku, warehouse_id),
                )
                row = cur.fetchone()
                if row is None:
                    return None
                variant_id = row[0]
                self.register_variant(variant_id)
                return variant_id
        finally:
            conn.close()

    def _resolve_owned_variant(self, cur, sku: str, warehouse_id: str) -> tuple[str | None, str | None]:
        cur.execute(
            """
            SELECT v.id::text
            FROM public.product_variant v
            JOIN public.inventory i ON i.variant_id = v.id
            WHERE v.sku = %s AND i.warehouse_id = %s::uuid
            LIMIT 1
            """,
            (sku, warehouse_id),
        )
        joined = cur.fetchone()
        if joined is not None:
            return joined[0], None
        cur.execute(
            'SELECT id::text FROM public.product_variant WHERE sku = %s LIMIT 1',
            (sku,),
        )
        variant_only = cur.fetchone()
        if variant_only is None:
            return None, 'absent'
        return variant_only[0], 'missing_inventory_link'

    def cleanup_owned_skus(self) -> list[str]:
        import psycopg

        errors: list[str] = []
        pending = list(self.owned_skus)
        removed_skus: list[tuple[str, str]] = []
        removed_variants: list[str] = []
        conn = self._connect()
        try:
            with conn.cursor() as cur:
                for sku, warehouse_id in pending:
                    variant_id, lookup_state = self._resolve_owned_variant(cur, sku, warehouse_id)
                    if lookup_state == 'missing_inventory_link':
                        errors.append(
                            f'owned sku {sku}@{warehouse_id}: variant exists but inventory link missing',
                        )
                        continue
                    if variant_id is None:
                        removed_skus.append((sku, warehouse_id))
                        continue
                    cur.execute(
                        'DELETE FROM public.inventory WHERE variant_id = %s::uuid',
                        (variant_id,),
                    )
                    cur.execute(
                        'DELETE FROM public.product_variant WHERE id = %s::uuid',
                        (variant_id,),
                    )
                    removed_skus.append((sku, warehouse_id))
                    removed_variants.append(variant_id)
            conn.commit()
            for key in removed_skus:
                if key in self.owned_skus:
                    self.owned_skus.remove(key)
            for variant_id in removed_variants:
                if variant_id in self.variant_ids:
                    self.variant_ids.remove(variant_id)
        except Exception as exc:
            conn.rollback()
            errors.append(str(exc))
        finally:
            conn.close()
        return errors

    def class_cleanup(self, *, verify_counts: bool = True) -> dict[str, Any]:
        sku_errors = self.cleanup_owned_skus()
        report = self.restore(verify_counts=verify_counts)
        if sku_errors:
            report.setdefault('errors', []).extend(sku_errors)
            report['integrity_ok'] = False
        return report

    def restore(self, *, verify_counts: bool = True) -> dict[str, Any]:
        import psycopg

        errors: list[str] = []
        conn = self._connect()
        try:
            with conn.cursor() as cur:
                for user_id, variant_id in self.preference_keys:
                    cur.execute(
                        """
                        DELETE FROM public.user_variant_preference
                        WHERE user_id = %s::uuid AND variant_id = %s::uuid
                          AND preference_type = 'favorited'
                        """,
                        (user_id, variant_id),
                    )
                for wh in self.warehouse_ids:
                    cur.execute(
                        'DELETE FROM public.sync_log WHERE warehouse_id = %s::uuid',
                        (wh,),
                    )
                for inv_id in self.inventory_ids:
                    cur.execute('DELETE FROM public.inventory WHERE id = %s::uuid', (inv_id,))
                for wh in self.warehouse_ids:
                    cur.execute('DELETE FROM public.inventory WHERE warehouse_id = %s::uuid', (wh,))
                for run_id in self.sync_run_ids:
                    cur.execute('DELETE FROM public.sync_run WHERE id = %s::uuid', (run_id,))
                for variant_id in self.variant_ids:
                    cur.execute(
                        'DELETE FROM public.inventory WHERE variant_id = %s::uuid',
                        (variant_id,),
                    )
                    cur.execute(
                        'DELETE FROM public.product_variant WHERE id = %s::uuid',
                        (variant_id,),
                    )
                for wh in self.warehouse_ids:
                    cur.execute(
                        'DELETE FROM public.sync_warehouse_lock WHERE warehouse_id = %s::uuid',
                        (wh,),
                    )
                    cur.execute('DELETE FROM public.warehouse WHERE id = %s::uuid', (wh,))
            conn.commit()
        except Exception as exc:
            conn.rollback()
            errors.append(str(exc))
        finally:
            conn.close()

        integrity_ok = True
        after_counts: dict[str, int] | None = None
        if verify_counts and self._baseline_counts is not None:
            conn = self._connect()
            try:
                with conn.cursor() as cur:
                    after_counts = {}
                    for table in self._baseline_counts:
                        cur.execute(f'SELECT COUNT(*)::int FROM public.{table}')
                        after_counts[table] = int(cur.fetchone()[0])
                integrity_ok = after_counts == self._baseline_counts
                if not integrity_ok:
                    errors.append(
                        'fixture 完整性不一致: '
                        f'baseline={json.dumps(self._baseline_counts)} '
                        f'after={json.dumps(after_counts)}',
                    )
            finally:
                conn.close()

        report = {
            'errors': errors,
            'integrity_ok': integrity_ok and not errors,
            'after_counts': after_counts,
        }
        if not report['integrity_ok']:
            print(f'[p0_02_test_fixture] restore failed: {report}', file=sys.stderr)
        return report
