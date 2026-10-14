#!/usr/bin/env python3
"""P5-SY3B/P5-SY4C 菲律宾 Inventory 写入与 SyncLog — CLI。

P5-SY3B Dry Run（仅查询，不写入，不写 sync_log）：
    python -m tools.bigseller-scraper.sync.cli_execute \\
      --input-json tools/bigseller-scraper/runtime/output/bigseller-inventory-20260612-110740.json \\
      --dry-run-report tools/bigseller-scraper/runtime/p5-sy3a-dry-run-20260612-114902.json \\
      --execute --confirm P5-SY3B-PH

P5-SY4C 真实写入（RPC 事务 + SyncLog）：
    python -m tools.bigseller-scraper.sync.cli_execute \\
      --input-json tools/bigseller-scraper/runtime/output/bigseller-inventory-20260612-110740.json \\
      --dry-run-report tools/bigseller-scraper/runtime/p5-sy3a-dry-run-20260612-114902.json \\
      --execute --confirm P5-SY3B-PH --no-dry-run

安全门：
- 必须同时传入 --execute、--confirm P5-SY3B-PH、--input-json 和 --dry-run-report
- 执行前从输入 JSON 重新生成计划，与存储的 Dry Run 报告逐项比较
- 任一项漂移立即 fail-fast，不进入写入
- 默认 --dry-run（只读查询，不写入，使用旧 execute_plan）
- 真实写入需要显式 --no-dry-run（使用 execute_plan_v2 + RPC 事务）
- 非 Dry Run 模式禁止 --no-sync-log

P5-SY4C 执行顺序：
1. 加载输入 JSON 和 Dry Run 报告
2. 重新查询 Supabase 当前状态（只读）
3. 重新生成写入计划 + 计划漂移检测
4. 构建 RPC 参数 → 调用 sync_warehouse_inventory RPC（单次事务）
5. RPC 成功后 Phase G/I 只读二次审计
6. 审计通过后写入 sync_log（success）；失败则分类写入 sync_log（failed/network_timeout）
7. sync_log 写入失败时保存本地 fallback JSON

退出码：
  0 — 成功（RPC + 审计 + sync_log 全部通过）
  1 — RPC 失败 / 网络超时 / 审计失败
  2 — RPC 成功但 sync_log 写入失败（已保存 fallback）
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
        description='Inventory 实际写入与新 SKU 创建（多国家海外仓）'
    )
    parser.add_argument(
        '--input-json',
        required=True,
        metavar='PATH',
        help='BigSeller 抓取 JSON 文件路径（必须显式指定）',
    )
    parser.add_argument(
        '--dry-run-report',
        required=True,
        metavar='PATH',
        help='Dry Run 报告 JSON 路径（来自 P5-SY3A / P5-SY8A）',
    )
    parser.add_argument(
        '--execute',
        action='store_true',
        default=False,
        help='启用执行模式（必须与 --confirm 同时使用）',
    )
    parser.add_argument(
        '--confirm',
        default=None,
        metavar='TOKEN',
        help='确认令牌（有效值: P5-SY3B-PH | P5-SY8B-VN | P5-SY8C-TH | P5-SY8D-TH | P5-SY8F-MY | P5-SY8G-ID | P5-SY8H-ID）',
    )
    mode_group = parser.add_mutually_exclusive_group()
    mode_group.add_argument(
        '--dry-run',
        action='store_true',
        default=False,
        help='Dry Run 模式（只读查询，不写入）。默认行为，可省略。',
    )
    mode_group.add_argument(
        '--no-dry-run',
        action='store_true',
        default=False,
        help='执行真实写入（RPC 事务 + SyncLog）',
    )
    parser.add_argument(
        '--sync-log',
        action='store_true',
        default=True,
        dest='sync_log',
        help='写入 sync_log（默认行为）',
    )
    parser.add_argument(
        '--no-sync-log',
        action='store_false',
        dest='sync_log',
        help='跳过 sync_log 写入（仅 Dry Run 模式允许）',
    )
    from .config import WAREHOUSE_COUNTRY

    args = parser.parse_args()

    # =========================================================================
    # 安全门
    # =========================================================================
    # 令牌必须绑定目标国家：当前 WAREHOUSE_COUNTRY 只允许对应令牌
    _TOKEN_COUNTRY_MAP = {
        'P5-SY3B-PH': 'PH',
        'P5-SY8B-VN': 'VN',
        'P5-SY8C-TH': 'TH',
        'P5-SY8D-TH': 'TH',
        'P5-SY8E-MY': 'MY',
        'P5-SY8F-MY': 'MY',
        'P5-SY8G-ID': 'ID',
        'P5-SY8H-ID': 'ID',
    }

    if not args.execute:
        expected_token = [t for t, c in _TOKEN_COUNTRY_MAP.items() if c == WAREHOUSE_COUNTRY]
        print('错误: 必须传入 --execute 标志')
        print(f'用法: --input-json <path> --dry-run-report <path> --execute --confirm <TOKEN> [--dry-run | --no-dry-run]')
        print(f'当前 WAREHOUSE_COUNTRY={WAREHOUSE_COUNTRY}，期望令牌: {expected_token}')
        sys.exit(1)

    # 1) 令牌是否已知
    token_country = _TOKEN_COUNTRY_MAP.get(args.confirm)
    if token_country is None:
        expected_token = [t for t, c in _TOKEN_COUNTRY_MAP.items() if c == WAREHOUSE_COUNTRY]
        print(f'错误: 确认令牌不匹配')
        print(f'  收到: "{args.confirm}"')
        print(f'  当前 WAREHOUSE_COUNTRY={WAREHOUSE_COUNTRY}')
        print(f'  期望令牌: {expected_token}')
        print(f'用法: --execute --confirm <TOKEN>')
        sys.exit(1)

    # 2) 令牌国家必须与当前 WAREHOUSE_COUNTRY 一致
    if token_country != WAREHOUSE_COUNTRY:
        expected_token = [t for t, c in _TOKEN_COUNTRY_MAP.items() if c == WAREHOUSE_COUNTRY]
        print(f'错误: 令牌国家与当前 WAREHOUSE_COUNTRY 不一致')
        print(f'  收到: "{args.confirm}" (绑定国家: {token_country})')
        print(f'  当前 WAREHOUSE_COUNTRY={WAREHOUSE_COUNTRY}')
        print(f'  期望令牌: {expected_token}')
        print(f'用法: --execute --confirm <TOKEN>')
        sys.exit(1)

    is_dry_run = not args.no_dry_run

    # P5-SY4C: 非 Dry Run 模式禁止 --no-sync-log
    if not is_dry_run and not args.sync_log:
        print('错误: 非 Dry Run 模式禁止使用 --no-sync-log')
        print('sync_log 是真实写入的强制安全记录，不得跳过。')
        sys.exit(1)

    # P5-SY8D: 令牌—模式强制绑定
    # P5-SY8C-TH → 仅 --dry-run（拒绝 --no-dry-run）
    # P5-SY8D-TH → 唯一可执行 --no-dry-run 的令牌（同时允许 --dry-run）
    # 错误组合必须在任何文件 I/O、查询或 RPC 前拒绝。
    _DRY_RUN_ONLY_TOKENS = {'P5-SY8C-TH', 'P5-SY8E-MY', 'P5-SY8G-ID'}
    _NO_DRY_RUN_EXCLUSIVE_TOKENS = {'P5-SY8D-TH', 'P5-SY8F-MY', 'P5-SY8H-ID'}
    _PENDING_WRITE_TOKENS = {}

    if args.confirm in _DRY_RUN_ONLY_TOKENS and not is_dry_run:
        write_tokens = [t for t in _NO_DRY_RUN_EXCLUSIVE_TOKENS if _TOKEN_COUNTRY_MAP.get(t) == WAREHOUSE_COUNTRY]
        if not write_tokens:
            write_tokens = _PENDING_WRITE_TOKENS.get(WAREHOUSE_COUNTRY, [])
        write_hint = ' 或 '.join(write_tokens) if write_tokens else 'N/A'
        print(f'错误: 令牌 {args.confirm} 仅支持 --dry-run 模式（只读抓取与 Dry Run）')
        print(f'该令牌绑定为只读方案专用，不得执行真实写入。')
        print(f'如需真实写入，请使用 {write_hint} 令牌。')
        sys.exit(1)

    print('=' * 60)
    print('Inventory 写入与 SyncLog')
    if is_dry_run:
        if args.dry_run:
            print('*** DRY RUN 模式（--dry-run 显式指定）— 仅查询，不写入 ***')
        else:
            print('*** DRY RUN 模式（默认）— 仅查询，不写入 ***')
    else:
        print('*** 真实写入模式 (--no-dry-run + RPC 事务 + SyncLog) ***')
    print(f'确认令牌: {args.confirm}')
    print(f'输入 JSON:  {args.input_json}')
    print(f'Dry Run 报告: {args.dry_run_report}')
    print(f'SyncLog:    {"启用" if args.sync_log else "禁用"}')
    if is_dry_run and args.sync_log:
        print('             (Dry Run 模式下 sync_log 不会实际写入)')
    print('=' * 60)
    print()

    # =========================================================================
    # 验证文件存在
    # =========================================================================
    if not os.path.isfile(args.input_json):
        print(f'错误: 输入 JSON 文件不存在 — {args.input_json}')
        sys.exit(1)
    if not os.path.isfile(args.dry_run_report):
        print(f'错误: Dry Run 报告不存在 — {args.dry_run_report}')
        sys.exit(1)

    # =========================================================================
    # 1. 加载输入 JSON 和 Dry Run 报告
    # =========================================================================
    print('[步骤 1/4] 加载文件...')
    with open(args.input_json, 'r', encoding='utf-8') as f:
        input_data = json.load(f)
    print(f'  输入 JSON: warehouse={input_data.get("warehouse")}, '
          f'row_count={input_data.get("row_count")}')

    with open(args.dry_run_report, 'r', encoding='utf-8') as f:
        stored_plan = json.load(f)

    stored_counts = stored_plan.get('counts', {})
    print(f'  Dry Run 报告: input_rows={stored_counts.get("input_rows")}, '
          f'new_variants={stored_counts.get("new_variants")}, '
          f'inventory_after={stored_counts.get("inventory_after_variant_create")}')
    print()

    # =========================================================================
    # 2. 输入校验
    # =========================================================================
    print('[步骤 2/4] 验证输入数据...')
    from .input_validator import validate_json, ValidationError
    try:
        rows = validate_json(input_data)
    except ValidationError as e:
        print(f'  校验失败:\n{e}')
        sys.exit(1)
    print(f'  校验通过: {len(rows)} 行')
    print()

    # =========================================================================
    # 3. 重新查询 Supabase + 重新生成计划 + 计划漂移比较
    # =========================================================================
    print('[步骤 3/4] 重新生成当前计划并比较漂移...')
    from .db_read_gateway import (
        fetch_warehouse,
        fetch_variants,
        fetch_inventory_by_warehouse,
    )

    try:
        warehouse = fetch_warehouse()
    except RuntimeError as e:
        print(f'  Warehouse 查询失败:\n{e}')
        sys.exit(1)
    print(f'  {warehouse.get("country")} overseas warehouse: id={warehouse.get("id")}, '
          f'name="{warehouse.get("name")}"')

    time.sleep(0.3)
    variants = fetch_variants()
    print(f'  {warehouse.get("country")} product_variants: {len(variants)} 条')

    time.sleep(0.3)
    inventories = fetch_inventory_by_warehouse(warehouse['id'])
    print(f'  Inventory (wh={warehouse["id"][:8]}...): {len(inventories)} 条')

    # 重新生成计划
    from .plan_generator import generate_plan
    generated_plan = generate_plan(rows, {
        'warehouse': warehouse,
        'variants': variants,
        'inventories': inventories,
    })

    # 比较漂移
    from .verifier import compare_plans, orchestrate_drift_decision
    diffs = compare_plans(generated_plan, stored_plan)

    if diffs:
        print()
        print('=' * 60)
        print('计划漂移检测: 发现差异')
        print(f'重新生成的计划与存储的 Dry Run 报告不一致 ({len(diffs)} 项差异):')
        print('=' * 60)
        for d in diffs:
            print(f'  [DIFF] {d}')
        print()
        if is_dry_run:
            print('DRY RUN 模式: 漂移仅作警告，继续只读验证...')
            print('可能原因:')
            print('  - 数据库在 Dry Run 后已写入数据（预期行为）')
            print('  - 输入 JSON 与 Dry Run 报告基于的数据不同')
            print()
    else:
        print(f'  计划漂移检测: 通过 — 重新生成的计划与存储报告一致')
    print(f'    new_variants: {len(generated_plan["new_variants"])} SKU')
    print(f'    inventory_after_variant_create: '
          f'{len(generated_plan["inventory_after_variant_create"])} 条')
    print(f'    warehouse_id: {warehouse["id"]}')
    rename = generated_plan.get('warehouse_rename_required') or {}
    print(f'    warehouse 改名: action={rename.get("action")}, '
          f'target={rename.get("target_name")}')
    print()

    # 计划漂移状态（基于实际 diffs，不硬编码）
    plan_drift_check = 'PASS' if not diffs else 'DRIFT_DETECTED'
    plan_drift_count = len(diffs)
    plan_drift_differences = [str(d) for d in diffs]

    # =========================================================================
    # 4. 执行（dry-run 或真实写入）
    # =========================================================================
    print('[步骤 4/4] 执行写入计划...')
    print()

    if is_dry_run:
        # P5-SY3B: 旧 execute_plan（REST 分批写入，不写 sync_log）
        from .executor import execute_plan

        try:
            decision = orchestrate_drift_decision(
                diffs,
                is_dry_run,
                lambda: execute_plan(
                    args.dry_run_report,
                    confirm=args.confirm,
                    dry_run=True,
                ),
            )
        except RuntimeError as e:
            print(f'\n执行失败: {e}')
            sys.exit(1)

        if decision['blocked']:
            print()
            print('=' * 60)
            print('已阻止执行。可能原因:')
            print('  - 输入 JSON 与 Dry Run 报告基于的数据不同')
            print('  - 数据库在 Dry Run 后发生了变更')
            print()
            print('请确认文件路径正确，或重新运行 P5-SY3A Dry Run 生成新报告。')
            sys.exit(1)

        result = decision['execute_result']

    else:
        # P5-SY4C: 新 execute_plan_v2（单次 RPC 事务 + sync_log）
        from .executor import execute_plan_v2
        from .config import TARGET_WAREHOUSE_NAME  # noqa: F811
        from .verifier import should_block_on_drift

        if should_block_on_drift(diffs, is_dry_run):
            print()
            print('=' * 60)
            print('已阻止真实写入。可能原因:')
            print('  - 输入 JSON 与 Dry Run 报告基于的数据不同')
            print('  - 数据库在 Dry Run 后发生了变更')
            print('  - 使用的输入 JSON 或 Dry Run 报告不正确')
            print()
            print('请确认文件路径正确，或重新运行 P5-SY3A Dry Run 生成新报告。')
            sys.exit(1)

        last_sync_at = datetime.now().astimezone().isoformat(timespec='seconds')

        try:
            result_v2 = execute_plan_v2(
                generated_plan,
                sync_log_enabled=args.sync_log,
                last_sync_at=last_sync_at,
            )
        except RuntimeError as e:
            print(f'\n执行失败: {e}')
            sys.exit(1)

        # 非 Dry Run 模式：检查 sync_log 写入状态
        # RPC 成功但 sync_log 未写入 → exit 2（不依赖 fallback_path 是否存在）
        if result_v2.get('rpc_summary') is not None and not result_v2.get('sync_log_written'):
            print()
            print('=' * 60)
            print('RPC 写入成功但 sync_log 记录失败')
            fb_path = result_v2.get('sync_log_fallback_path')
            if fb_path:
                print(f'Fallback 日志已保存: {fb_path}')
            else:
                print('Fallback 日志保存也失败（见执行报告的 errors 列表）')
            print('请检查数据库 sync_log 表权限或网络连接。')
            print('=' * 60)
            sys.exit(2)

        # 转换为统一 result 格式（与旧 execute_plan 输出兼容）
        rpc = result_v2.get('rpc_summary', {})
        result = {
            'started_at': result_v2.get('started_at'),
            'finished_at': result_v2.get('finished_at'),
            'warehouse_id': result_v2['warehouse_id'],
            'warehouse_name_before': warehouse.get('name'),
            'warehouse_name_after': TARGET_WAREHOUSE_NAME,
            'warehouse_renamed': rpc.get('warehouse_renamed', False),
            'variants_before': len(variants),
            'variants_created': rpc.get('variants_created', 0),
            'variants_skipped': len(new_variants_plan := generated_plan.get('new_variants', [])) - rpc.get('variants_created', 0),
            'variants_total': len(variants) + rpc.get('variants_created', 0),
            'inventory_before': len(inventories),
            'inventory_inserted': rpc.get('inventory_inserted', 0),
            'inventory_updated': rpc.get('inventory_updated', 0),
            'inventory_total': rpc.get('inventory_received', 0),
            'inventory_unchanged': rpc.get('inventory_unchanged', 0),
            'inventory_write_actions': rpc.get('inventory_inserted', 0) + rpc.get('inventory_updated', 0),
            'rpc_summary': rpc,
            'phase_g_verified': result_v2['phase_g_verified'],
            'phase_i_verified': result_v2['phase_i_verified'],
            'sync_log_written': result_v2['sync_log_written'],
            'sync_log_fallback_path': result_v2['sync_log_fallback_path'],
            'errors': result_v2.get('errors', []),
        }

    # =========================================================================
    # sync_log 摘要（在所有输出前计算）
    # =========================================================================
    if is_dry_run:
        if args.sync_log:
            sync_log_reason = 'Dry Run 模式下不执行实际写入'
        else:
            sync_log_reason = '已通过 --no-sync-log 禁用'
    else:
        sync_log_reason = None  # 真实写入模式，reason 不适用

    sync_log_summary = {
        'enabled': args.sync_log,
        'written': not is_dry_run and result.get('sync_log_written', False),
        'reason': sync_log_reason,
    }

    # =========================================================================
    # 输出结果
    # =========================================================================
    print()
    print('=' * 60)
    print('执行结果')
    print('=' * 60)
    print(f'  模式:              {"DRY RUN (只读)" if is_dry_run else "真实写入 (RPC 事务)"}')
    print(f'  计划漂移:          {plan_drift_check}')
    if plan_drift_differences:
        print(f'  漂移差异数:        {plan_drift_count}')
    print(f'  Warehouse ID:      {result["warehouse_id"]}')
    print(f'  Warehouse 原名:    {result["warehouse_name_before"]}')
    print(f'  --- Variant ---')
    print(f'  执行前:            {result["variants_before"]}')
    print(f'  新创建:            {result["variants_created"]}')
    print(f'  跳过(已存在):      {result["variants_skipped"]}')
    print(f'  总计:              {result["variants_total"]}')
    print(f'  --- Inventory ---')
    print(f'  执行前:            {result["inventory_before"]}')
    print(f'  新增:              {result["inventory_inserted"]}')
    print(f'  更新:              {result["inventory_updated"]}')
    if 'inventory_unchanged' in result:
        print(f'  不变 (unchanged):  {result["inventory_unchanged"]}')
    print(f'  写入动作总计:      {result.get("inventory_write_actions", "?")}')
    print(f'  写后总计:          {result["inventory_total"]}')
    print(f'  --- Warehouse ---')
    print(f'  已改名:            {result["warehouse_renamed"]}')
    print(f'  最终名称:          {result["warehouse_name_after"]}')
    if not is_dry_run:
        print(f'  --- 审计与日志 ---')
        print(f'  Phase G (Inventory): {"通过" if result.get("phase_g_verified") else "失败"}')
        print(f'  Phase I (Warehouse): {"通过" if result.get("phase_i_verified") else "失败"}')
        print(f'  SyncLog 写入:     {"已写入" if result.get("sync_log_written") else "未写入"}')
        if result.get('sync_log_fallback_path'):
            print(f'  Fallback 日志:    {result["sync_log_fallback_path"]}')

    # sync_log 摘要（所有模式均显示）
    print(f'  --- SyncLog ---')
    print(f'  启用:              {sync_log_summary["enabled"]}')
    print(f'  已写入:            {sync_log_summary["written"]}')
    if sync_log_summary.get('reason'):
        print(f'  说明:              {sync_log_summary["reason"]}')

    if result.get('errors'):
        print(f'\n  警告/错误 ({len(result["errors"])} 项):')
        for e in result['errors']:
            print(f'    - {e}')

    # =========================================================================
    # 核对
    # =========================================================================
    print()
    planned_inv = stored_counts.get('total_inventory_actions', 91)
    actual_inv = result.get('inventory_write_actions', 0)
    inv_ok = actual_inv == planned_inv

    print(f'  核对:')
    print(f'    Inventory 动作: 计划 {planned_inv} == 实际 {actual_inv}  '
          f'[{"OK" if inv_ok else "MISMATCH!"}]')

    if not inv_ok and not is_dry_run:
        print('\n错误: Inventory 写入动作数与计划不一致！')
        sys.exit(1)

    # =========================================================================
    # 保存执行报告（不含密钥）
    # =========================================================================
    report = {
        'task': args.confirm,
        'generated_at': datetime.now().astimezone().isoformat(timespec='seconds'),
        'confirm_token': args.confirm,
        'dry_run': is_dry_run,
        'input_json_source': args.input_json,
        'dry_run_report_source': args.dry_run_report,
        'plan_drift_check': plan_drift_check,
        'plan_drift_count': plan_drift_count,
        'plan_drift_differences': plan_drift_differences,
        'result': {
            'started_at': result.get('started_at'),
            'finished_at': result.get('finished_at'),
            'warehouse_id': result['warehouse_id'],
            'warehouse_name_before': result['warehouse_name_before'],
            'warehouse_name_after': result['warehouse_name_after'],
            'warehouse_renamed': result['warehouse_renamed'],
            'variants_before': result['variants_before'],
            'variants_created': result['variants_created'],
            'variants_skipped': result['variants_skipped'],
            'variants_total': result['variants_total'],
            'inventory_before': result['inventory_before'],
            'inventory_inserted': result['inventory_inserted'],
            'inventory_updated': result['inventory_updated'],
            'inventory_unchanged': result.get('inventory_unchanged'),
            'inventory_total': result['inventory_total'],
            'inventory_write_actions': result.get('inventory_write_actions', 0),
            'rpc_summary': result.get('rpc_summary'),
            'phase_g_verified': result.get('phase_g_verified'),
            'phase_i_verified': result.get('phase_i_verified'),
            'sync_log_written': result.get('sync_log_written'),
            'sync_log_fallback_path': result.get('sync_log_fallback_path'),
        },
        'errors': result.get('errors', []),
        'sync_log': sync_log_summary,
    }

    os.makedirs(RUNTIME_DIR, exist_ok=True)
    timestamp = datetime.now().strftime('%Y%m%d-%H%M%S')
    task_id = args.confirm.lower()
    mode = 'dry-run' if is_dry_run else 'execute'
    report_name = f'{task_id}-{mode}-{timestamp}.json'
    report_path = os.path.join(RUNTIME_DIR, report_name)
    with open(report_path, 'w', encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    print(f'\n执行报告已保存: {report_path}')

    if is_dry_run:
        print(f'\n===== Dry Run 完成 =====')
        print(f'未执行任何数据库写入。')
        print(f'确认无误后，重新运行并添加 --no-dry-run 执行真实写入（RPC 事务 + SyncLog）。')
    else:
        print(f'\n===== 执行完成 ({args.confirm}) =====')
        print(f'Variant: 创建 {result["variants_created"]}, 跳过 {result["variants_skipped"]}')
        print(f'Inventory: 新增 {result["inventory_inserted"]}, 更新 {result["inventory_updated"]}, 不变 {result.get("inventory_unchanged", "?")}')
        print(f'Warehouse 改名: {"是" if result["warehouse_renamed"] else "否/已是目标名称"}')
        print(f'SyncLog: {"已写入" if result.get("sync_log_written") else "未写入 (fallback: " + str(result.get("sync_log_fallback_path", "N/A")) + ")"}')

    # 退出码：1=RPC 失败已由 RuntimeError 处理；到达此处为成功路径
    # 若 sync_log 写入失败但 RPC 已成功，已在非 dry-run 分支中 exit(2)
    sys.exit(0)


if __name__ == '__main__':
    main()
