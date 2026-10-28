"""Independent raw-file check for the R1 fixed samples.

Reads the newest real export registered by the repair instance **directly from the workbook** (not
through the database read model), extracts the target SKUs' on-hand values per warehouse, and writes a
small JSON that the Node verifier compares against the list/detail RPC numbers.

Usage: python .local/inventory-sync-repair-20261026/verify-raw-vs-detail.py --run-id <run>
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / 'tools' / 'inventory-sync'))

import parser as inventory_parser  # noqa: E402
import psycopg  # noqa: E402

TARGET_SKUS = {
    '6974674957325', '6973517482611', '6973517484967',
    '757577983013', 'ICEWM0026', '757577407113', 'WM0049',
}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--run-id', required=True)
    args = ap.parse_args()
    root = REPO_ROOT / '.local' / 'catalog' / args.run_id
    instance_dir = root / 'instance'
    env = json.loads((instance_dir / 'env.inventory.json').read_text(encoding='utf-8'))
    marker = json.loads((instance_dir / 'inventory-instance.json').read_text(encoding='utf-8'))
    work_dir = Path(env['workDir'])
    with psycopg.connect(env['ownerDbUrl']) as conn:
        with conn.cursor() as cur:
            # R4 (repair v4): prove the live server identity READ ONLY before reading this instance's
            # data, so a stale/overridden connection string cannot silently inspect another database.
            cur.execute('BEGIN READ ONLY')
            cur.execute('SELECT current_database(), inet_server_addr()::text, inet_server_port()')
            live_db, live_addr, live_port = cur.fetchone()
            cur.execute('ROLLBACK')
            expected_db = marker['database']['name']
            expected_port = int(marker['database']['port'])
            if (live_db != expected_db or int(live_port) != expected_port
                    or (live_addr is not None and not str(live_addr).startswith(('127.', '::1', '::ffff:127.')))):
                raise SystemExit(
                    'INVENTORY_TEST_TARGET_DB_VERIFY_MISMATCH:'
                    f'raw-vs-detail live={live_db}@{live_addr}:{live_port} '
                    f'marker={expected_db}@{expected_port}')
            cur.execute(
                """SELECT r.id, f.storage_relpath, f.sha256, f.row_count, r.export_finished_at
                   FROM catalog.inventory_sync_run r
                   JOIN catalog.inventory_export_file f ON f.id = r.file_id
                   WHERE r.status = 'success'
                   ORDER BY r.export_finished_at DESC NULLS LAST, r.created_at DESC LIMIT 1""")
            run_id, relpath, sha, row_count, finished = cur.fetchone()
            cur.execute('SELECT external_warehouse_id, external_name FROM catalog.inventory_warehouse')
            warehouses = cur.fetchall()
            name_to_external = {name: external for external, name in warehouses}
            discovery = [{'externalId': external, 'name': name} for external, name in warehouses]
            cur.execute(
                """SELECT w.external_warehouse_id, b.id
                   FROM catalog.inventory_batch b
                   JOIN catalog.inventory_warehouse w ON w.id = b.warehouse_id
                   WHERE b.run_id = %s""", (run_id,))
            batch_by_external = {external: str(batch) for external, batch in cur.fetchall()}
    file_path = work_dir / relpath
    parsed = inventory_parser.parse_export_file(file_path, warehouse_discovery=discovery)
    rows = []
    for row in parsed['rows']:
        sku = str(row.get('externalSku') or '')
        if sku not in TARGET_SKUS:
            continue
        warehouse_name = str(row.get('warehouseName') or '')
        external = name_to_external.get(warehouse_name)
        if external is None:
            continue
        rows.append({
            'sku': sku,
            'warehouseExternalId': external,
            'warehouseName': warehouse_name,
            'onHandText': row.get('onHandText'),
            'onHand': inventory_parser.parse_quantity(row.get('onHandText'))[0],
            'parseStatus': row.get('parseStatus'),
            'excelRow': row.get('excelRow'),
        })
    output = {
        'runId': args.run_id,
        'sourceRunId': run_id,
        'file': {'storageRelpath': relpath, 'sha256': sha, 'rowCount': row_count,
                 'exportFinishedAt': finished.isoformat() if finished else None},
        'batches': batch_by_external,
        'rows': rows,
        'header': parsed.get('headerMapping'),
    }
    out_path = root / 'verify' / 'raw-fixed-samples.json'
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(output, ensure_ascii=False, indent=2, default=str), encoding='utf-8')
    print(json.dumps({'out': str(out_path), 'rows': len(rows), 'file': output['file']}, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())





