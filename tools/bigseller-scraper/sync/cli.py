#!/usr/bin/env python3
"""P5-SY3A 菲律宾库存写入映射 — 只读 Dry Run CLI。

用法：
    python -m tools.bigseller-scraper.sync.cli --json <path-to-bigseller-json>

严格只读：不执行任何 INSERT/UPDATE/UPSERT/DELETE/RPC。
输出 Dry Run 报告到 runtime/ 目录。
"""
import argparse
import json
import os
import sys
import time
from datetime import datetime

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNTIME_DIR = os.path.join(BASE_DIR, 'runtime')


def main():
    parser = argparse.ArgumentParser(
        description='P5-SY3A 菲律宾库存写入映射 — 只读 Dry Run'
    )
    parser.add_argument(
        '--json',
        required=True,
        metavar='PATH',
        help='BigSeller 抓取 JSON 文件路径（必须显式指定，不自动选择最新文件）',
    )
    args = parser.parse_args()

    json_path = args.json
    if not os.path.isfile(json_path):
        print(f'错误: 文件不存在 — {json_path}')
        sys.exit(1)

    print(f'输入文件: {json_path}')
    print()

    # 1. 加载 JSON
    print('1. 加载输入 JSON...')
    with open(json_path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    print(f'   已加载: warehouse={data.get("warehouse")}, row_count={data.get("row_count")}')

    # 2. 输入校验
    print('2. 验证输入数据...')
    from .input_validator import validate_json, ValidationError
    try:
        rows = validate_json(data)
    except ValidationError as e:
        print(f'   校验失败:\n{e}')
        sys.exit(1)
    print(f'   校验通过: {len(rows)} 行，SKU 无重复，数量无非负整数')

    # 3. 只读查询 Supabase
    print('3. 查询 Supabase（只读）...')
    from .db_read_gateway import (
        fetch_warehouse,
        fetch_variants,
        fetch_inventory_by_warehouse,
    )

    try:
        warehouse = fetch_warehouse()
    except RuntimeError as e:
        print(f'   Warehouse 查询失败:\n{e}')
        sys.exit(1)
    print(f'   {warehouse.get("country")} overseas warehouse: id={warehouse.get("id")}, name="{warehouse.get("name")}", active={warehouse.get("is_active")}')

    time.sleep(0.3)
    variants = fetch_variants()
    print(f'   {warehouse.get("country")} product_variants: {len(variants)} 条')

    time.sleep(0.3)
    inventories = fetch_inventory_by_warehouse(warehouse['id'])
    print(f'   Inventory (warehouse_id={warehouse["id"]}): {len(inventories)} 条')

    # 4. 生成写入计划
    print('4. 生成写入计划...')
    from .plan_generator import generate_plan

    plan = generate_plan(rows, {
        'warehouse': warehouse,
        'variants': variants,
        'inventories': inventories,
    })

    # 5. 汇总统计
    rename = plan['warehouse_rename_required']
    new_variants = plan['new_variants']
    inserts = plan['inventory_inserts']
    updates = plan['inventory_updates']
    unchanged = plan['inventory_unchanged']
    after_variant = plan['inventory_after_variant_create']
    rejected = plan['rejected_rows']

    # 分类统计：每行输入必须归入且仅归入一个分类
    total_classified = (
        len(new_variants) + len(inserts) + len(updates)
        + len(unchanged) + len(rejected)
    )
    # Inventory 写入动作总数：P5-SY3B 必须执行的 inventory 操作
    total_inventory_actions = (
        len(inserts) + len(updates) + len(after_variant)
    )

    print(f'\n===== Dry Run 计划汇总 =====')
    print(f'  输入行数:              {len(rows)}')

    if rename and rename.get('action') != 'none':
        print(f'  [!] warehouse_rename:  {rename.get("action")} — {rename.get("message")}')
    else:
        print(f'  warehouse 改名:       无需（{rename.get("message") if rename else "N/A"}）')

    print(f'  --- 输入行分类 ---')
    print(f'  新 SKU (new_variants):                  {len(new_variants)}')
    print(f'  Inventory 新增 (inserts):               {len(inserts)}')
    print(f'  Inventory 更新 (updates):               {len(updates)}')
    print(f'  Inventory 不变 (unchanged):             {len(unchanged)}')
    print(f'  Inventory 后建 (after_variant_create):  {len(after_variant)}')
    print(f'  拒绝行 (rejected):                      {len(rejected)}')
    print(f'  -----------------------------------')
    print(f'  输入行分类总计:          {total_classified}')
    ok1 = 'OK' if total_classified == len(rows) else 'MISMATCH!'
    print(f'  核对: {len(rows)} input == {total_classified} classified  [{ok1}]')
    print()
    print(f'  --- Inventory 写入动作 ---')
    print(f'  inventory_inserts:                {len(inserts)}')
    print(f'  inventory_updates:                {len(updates)}')
    print(f'  inventory_after_variant_create:   {len(after_variant)}')
    print(f'  -----------------------------------')
    print(f'  Inventory 动作总计:      {total_inventory_actions}')
    ok2 = 'OK' if total_inventory_actions == len(rows) else 'INFO'
    print(f'  核对: {len(rows)} input -> {total_inventory_actions} inventory actions  [{ok2}]')

    if total_classified != len(rows):
        print('\n错误: 分类总数与输入行数不一致，存在静默丢行！')
        sys.exit(1)

    # 6. 输出详情摘要
    if new_variants:
        print(f'\n--- 新 SKU（前 5 条）---')
        for v in new_variants[:5]:
            print(f'  {v["sku"]:30s} {v["name"][:40]:40s} qty={v["target_quantity"]:,}')

    if after_variant:
        print(f'\n--- Inventory 后建动作（前 5 条）---')
        for a in after_variant[:5]:
            print(f'  {a["sku"]:30s} new_qty={a["new_quantity"]:,}  depends_on={a["depends_on"]}')

    if updates:
        print(f'\n--- Inventory 更新（前 5 条）---')
        for u in updates[:5]:
            print(f'  {u["sku"]:30s} {u["old_quantity"]:>8,} -> {u["new_quantity"]:>8,} (delta={u["delta"]:+,})')

    if rejected:
        print(f'\n--- 拒绝行 ---')
        for r in rejected:
            print(f'  {r.get("reason")}: {r.get("row", {}).get("sku", "?")}')
    else:
        print(f'\n  无拒绝行 [OK]')

    # 7. 保存报告
    print('\n5. 保存 Dry Run 报告...')
    report = {
        'generated_at': datetime.now().astimezone().isoformat(timespec='seconds'),
        'input_file': json_path,
        'warehouse_name_in_db': warehouse.get('name'),
        'warehouse_rename_required': rename,
        'counts': {
            'input_rows': len(rows),
            'new_variants': len(new_variants),
            'inventory_inserts': len(inserts),
            'inventory_updates': len(updates),
            'inventory_unchanged': len(unchanged),
            'inventory_after_variant_create': len(after_variant),
            'rejected_rows': len(rejected),
            'total_classified': total_classified,
            'total_inventory_actions': total_inventory_actions,
        },
        'new_variants': new_variants,
        'inventory_inserts': inserts,
        'inventory_updates': updates,
        'inventory_after_variant_create': after_variant,
        'inventory_unchanged': [  # 摘要化：只保留关键字段
            {'sku': u['sku'], 'product_name': u['product_name'],
             'quantity': u['quantity']}
            for u in unchanged
        ],
        'rejected_rows': rejected,
    }

    os.makedirs(RUNTIME_DIR, exist_ok=True)
    report_name = f'p5-sy3a-dry-run-{datetime.now().strftime("%Y%m%d-%H%M%S")}.json'
    report_path = os.path.join(RUNTIME_DIR, report_name)
    with open(report_path, 'w', encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    print(f'   报告已保存: {report_path}')
    print(f'\n===== P5-SY3A Dry Run 完成 =====')
    print(f'未执行任何数据库写入。')


if __name__ == '__main__':
    main()
