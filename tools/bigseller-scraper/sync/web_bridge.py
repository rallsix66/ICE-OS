#!/usr/bin/env python3
"""Web Bridge — Next.js 网页端调用入口。

通过环境变量传递仓库参数，依次执行：
  1. BigSeller 页面抓取 → 输出 JSON 文件
  2. 计划生成 + Dry Run 基线
  3. 真实写入 RPC + SyncLog（--no-dry-run 模式）

用法:
  python -m tools.bigseller-scraper.sync.web_bridge \
    --warehouse-id <UUID> \
    --warehouse-name "印尼-DEE仓库" \
    --old-name "印尼仓" \
    --country ID \
    --token P5-SY8H-ID \
    --mode dry_run

输出: JSON 到 stdout
退出码: 0=成功, 1=失败
"""

import argparse
import json
import os
import sys
import time
import traceback
from datetime import datetime, timezone

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def evaluate_real_write_bridge_outcome(result: dict, rpc_result: dict) -> None:
    """根据 executor 回执设置 bridge success/exit_code（含 commit_outcome）。"""
    rpc_summary = rpc_result.get('rpc_summary', {}) or {}
    result['summary'] = {
        'variants_created': rpc_summary.get('variants_created', 0),
        'variants_skipped': rpc_summary.get('variants_skipped', 0),
        'inventory_inserted': rpc_summary.get('inventory_inserted', 0),
        'inventory_updated': rpc_summary.get('inventory_updated', 0),
        'inventory_unchanged': rpc_summary.get('inventory_unchanged', 0),
        'warehouse_renamed': rpc_summary.get('warehouse_renamed', False),
    }
    result['sync_log_written'] = bool(rpc_result.get('sync_log_written'))
    result['publish_committed'] = bool(rpc_result.get('publish_committed'))
    commit_outcome = rpc_result.get('commit_outcome')
    result['commit_outcome'] = commit_outcome
    bridge_errors = list(rpc_result.get('errors') or [])
    if bridge_errors:
        result['errors'].extend(bridge_errors)

    publish_ok = (
        rpc_result.get('phase_g_verified')
        and rpc_result.get('phase_i_verified')
        and rpc_result.get('publish_committed')
    )
    log_ok = not rpc_result.get('sync_log_enabled') or rpc_result.get('sync_log_written')
    if commit_outcome == 'unknown':
        result['success'] = False
        result['exit_code'] = 2
        result['errors'].append('发布 commit 结果未知')
    elif publish_ok and log_ok:
        result['success'] = True
        result['exit_code'] = 0
    else:
        result['success'] = False
        result['exit_code'] = 1
        if not log_ok:
            result['errors'].append('sync_log 未成功写入')
        if not publish_ok:
            result['errors'].append('发布未完成或审计未通过')


# ============================================================
# CLI
# ============================================================
def main():
    parser = argparse.ArgumentParser(description='Web Bridge — 网页端同步入口')
    parser.add_argument('--warehouse-id', required=True, help='Supabase warehouse UUID')
    parser.add_argument('--warehouse-name', required=True, help='BigSeller 仓库显示名称')
    parser.add_argument('--old-name', required=True, help='数据库旧仓库名称')
    parser.add_argument('--country', required=True, help='国家代码 PH/VN/TH/MY/ID')
    parser.add_argument('--token', required=True, help='确认令牌')
    parser.add_argument('--mode', choices=['dry_run', 'real_write'], required=True)
    parser.add_argument('--prior-dry-run-path', default=None,
                        help='real_write 模式下的前一次 Dry Run 基线 JSON 路径（用于计划漂移比较）')
    args = parser.parse_args()

    # ── 设置环境变量（config.py / bigseller_scraper.py 会读取） ──
    os.environ['BS_TARGET_WAREHOUSE_NAME'] = args.warehouse_name
    os.environ['BS_OLD_WAREHOUSE_NAME'] = args.old_name
    os.environ['BS_WAREHOUSE_COUNTRY'] = args.country
    os.environ['BS_NEW_VARIANT_COUNTRY'] = args.country
    os.environ['P0_02_TARGET_WAREHOUSE_ID'] = args.warehouse_id
    os.environ['BS_REPORT_OUTPUT_DIR'] = 'runtime'
    os.environ['BS_HEADLESS'] = '1'  # 网页端调用使用 headless 模式，依赖持久化 profile 认证

    started_at = datetime.now(timezone.utc).isoformat()
    result = {
        'success': False,
        'exit_code': 1,
        'warehouse_id': args.warehouse_id,
        'warehouse_name': args.warehouse_name,
        'country': args.country,
        'mode': args.mode,
        'started_at': started_at,
        'finished_at': None,
        'errors': [],
        'summary': {
            'variants_created': 0,
            'variants_skipped': 0,
            'inventory_inserted': 0,
            'inventory_updated': 0,
            'inventory_unchanged': 0,
            'warehouse_renamed': False,
        },
        'plan_drift_check': None,
        'plan_drift_count': 0,
        'plan_drift_differences': [],
    }

    try:
        # ============================================================
        # Phase 1: BigSeller 抓取
        # ============================================================
        sys.path.insert(0, BASE_DIR)

        from sync.p0_02_connection_boundary import independent_p0_02_enabled

        fixture_input_path = os.environ.get('P0_02_FIXTURE_INPUT_PATH', '').strip()
        if fixture_input_path and independent_p0_02_enabled():
            if not os.path.exists(fixture_input_path):
                result['errors'].append(
                    f'P0_02 fixture 输入不存在: {fixture_input_path}',
                )
                _write_result(result)
                sys.exit(1)
            with open(fixture_input_path, 'r', encoding='utf-8') as f:
                normalized_data = json.load(f)
            input_rows = normalized_data.get('rows') or normalized_data
            metadata = normalized_data.get('metadata') or {}
            invalid_sku_rows = normalized_data.get('invalid_sku_rows') or []
            output_path = fixture_input_path
            result['raw_row_count'] = metadata.get('raw_row_count', len(input_rows))
            result['valid_sku_count'] = metadata.get('valid_sku_count', len(input_rows))
            result['invalid_sku_count'] = metadata.get(
                'invalid_sku_count',
                len(invalid_sku_rows),
            )
            print(
                f'[web_bridge] 使用 P0-02 fixture 输入: {len(input_rows)} 行',
                file=sys.stderr,
            )
        else:
            from bigseller_scraper import scrape, save_json

            print(f'[web_bridge] 开始抓取 BigSeller: {args.warehouse_name}', file=sys.stderr)
            rows, metadata, invalid_sku_rows, combo_sku_rows = scrape()

            if not rows:
                result['errors'].append(
                    'BigSeller 抓取返回 0 行数据，可能是登录会话已过期或需要验证码。'
                    '请在库存同步页面点击「重新建立登录会话」按钮，系统会自动打开浏览器供您完成登录和验证码，'
                    '登录成功后网页端同步即可恢复正常。'
                )
                _write_result(result)
                sys.exit(1)

            output_path = save_json(rows, metadata, invalid_sku_rows, combo_sku_rows)
            print(f'[web_bridge] 抓取完成: {len(rows)} 行 → {output_path}', file=sys.stderr)

            result['raw_row_count'] = (metadata or {}).get('raw_row_count', len(rows))
            result['valid_sku_count'] = (metadata or {}).get('valid_sku_count', len(rows))
            result['invalid_sku_count'] = (metadata or {}).get(
                'invalid_sku_count',
                len(invalid_sku_rows) if invalid_sku_rows else 0,
            )

            with open(output_path, 'r', encoding='utf-8') as f:
                normalized_data = json.load(f)
            input_rows = normalized_data['rows']

        # ============================================================
        # Phase 2: Dry Run 基线
        # ============================================================
        from sync.config import REPORT_OUTPUT_DIR
        from sync.plan_generator import generate_plan
        from sync.db_read_gateway import (
            fetch_warehouse as fetch_wh,
            fetch_variants,
            fetch_inventory_by_warehouse,
        )
        from sync.verifier import compare_plans

        wh = fetch_wh()
        variants = fetch_variants()
        inventory = fetch_inventory_by_warehouse(wh['id'])

        plan = generate_plan(input_rows, {
            'warehouse': wh,
            'variants': variants,
            'inventories': inventory,
        })

        print(f'[web_bridge] Dry Run 计划: variants_new={len(plan.get("new_variants",[]))}, '
              f'inventory_inserts={len(plan.get("inventory_inserts",[]))}, '
              f'inventory_updates={len(plan.get("inventory_updates",[]))}, '
              f'inventory_unchanged={len(plan.get("inventory_unchanged",[]))}',
              file=sys.stderr)

        # 保存 Dry Run 基线报告
        runtime_dir = os.path.join(BASE_DIR, REPORT_OUTPUT_DIR)
        os.makedirs(runtime_dir, exist_ok=True)
        timestamp = datetime.now().strftime('%Y%m%d-%H%M%S')
        dry_run_path = os.path.join(runtime_dir, f'web-dry-run-{timestamp}.json')

        plan_summary = {
            'generated_at': datetime.now(timezone.utc).isoformat(),
            'warehouse_id': wh['id'],
            'warehouse_name': wh.get('name', args.warehouse_name),
            'country': args.country,
            'input_rows': len(input_rows),
            **plan,
        }
        with open(dry_run_path, 'w', encoding='utf-8') as f:
            json.dump(plan_summary, f, ensure_ascii=False, indent=2)
        print(f'[web_bridge] Dry Run 基线已保存: {dry_run_path}', file=sys.stderr)

        # ============================================================
        # Phase 3: 计划漂移检查
        # ============================================================
        if args.mode == 'real_write':
            if not args.prior_dry_run_path:
                result['errors'].append(
                    'real_write 模式必须提供 --prior-dry-run-path（前一次 Dry Run 基线路径）'
                )
                _write_result(result)
                sys.exit(1)

            # 加载前一次 Dry Run 基线报告作为存储计划
            if not os.path.exists(args.prior_dry_run_path):
                result['errors'].append(
                    f'前一次 Dry Run 基线文件不存在: {args.prior_dry_run_path}'
                )
                _write_result(result)
                sys.exit(1)

            try:
                with open(args.prior_dry_run_path, 'r', encoding='utf-8') as f:
                    stored_data = json.load(f)
            except Exception as load_err:
                result['errors'].append(
                    f'无法读取前一次 Dry Run 基线: {load_err}'
                )
                _write_result(result)
                sys.exit(1)

            # 从存储基线中提取计划部分（去除顶层元数据键）
            stored_plan = {
                k: v for k, v in stored_data.items()
                if k not in ('generated_at', 'warehouse_id', 'warehouse_name',
                             'country', 'input_rows', 'dry_run_run_id')
            }

            # 真实差异比较：生成计划 vs 存储基线计划
            diffs = compare_plans(plan, stored_plan)
            if diffs:
                result['plan_drift_check'] = 'DRIFT_DETECTED'
                result['plan_drift_count'] = len(diffs)
                result['plan_drift_differences'] = [str(d) for d in diffs]
                result['errors'].append(f'计划漂移 ({len(diffs)} 项差异)')
                _write_result(result)
                sys.exit(1)
            else:
                result['plan_drift_check'] = 'PASS'
                result['plan_drift_count'] = 0
        else:
            # Dry Run: 无基线比较，标记为 PASS（首次运行无漂移概念）
            result['plan_drift_check'] = 'PASS'
            result['plan_drift_count'] = 0

        # 填入摘要
        result['summary']['variants_created'] = len(plan.get('new_variants', []))
        result['summary']['inventory_inserted'] = len(plan.get('inventory_inserts', []))
        result['summary']['inventory_updated'] = len(plan.get('inventory_updates', []))
        result['summary']['inventory_unchanged'] = len(plan.get('inventory_unchanged', []))
        result['summary']['warehouse_renamed'] = plan.get('warehouse_rename_required', {}).get('action') == 'rename'

        # P5-SY9D rework: 暴露完整 Dry Run plan artifact（含元数据），
        # 供 TypeScript 层存储为 plan artifact 并在 Real Write 绑定校验中使用。
        # plan_summary 包含 generated_at / warehouse_id / warehouse_name /
        # country / input_rows + plan 所有字段（new_variants / inventory_inserts /
        # inventory_updates / inventory_unchanged / warehouse_rename_required）
        result['plan'] = plan_summary

        # ============================================================
        # Phase 4: 真实写入（仅 --no-dry-run）
        # ============================================================
        if args.mode == 'real_write':
            from sync.executor import execute_plan_v2

            rpc_result = execute_plan_v2(
                plan=plan,
                sync_log_enabled=True,
                sync_run_id=os.environ.get('P0_02_SYNC_RUN_ID'),
                triggered_by=os.environ.get('P0_02_SYNC_TRIGGERED_BY'),
            )

            evaluate_real_write_bridge_outcome(result, rpc_result)
            print(f'[web_bridge] RPC 写入完成: {json.dumps(result["summary"])}', file=sys.stderr)
        else:
            result['success'] = True
            result['exit_code'] = 0

    except Exception as e:
        from sync.publish_errors import PublishCommitUnknownError

        if isinstance(e, PublishCommitUnknownError):
            evaluate_real_write_bridge_outcome(result, e.rpc_result)
            result['errors'].append(f'{type(e).__name__}: {e}')
        else:
            result['success'] = False
            result['exit_code'] = 1
            result['errors'].append(f'{type(e).__name__}: {e}')
            traceback.print_exc(file=sys.stderr)

    result['finished_at'] = datetime.now(timezone.utc).isoformat()
    _write_result(result)
    sys.exit(int(result.get('exit_code', 0 if result['success'] else 1)))


def _write_result(result):
    # ensure_ascii=True to avoid Windows GBK console encoding errors.
    # python-bridge.ts JSON.parse handles unicode escapes correctly.
    try:
        print(json.dumps(result, ensure_ascii=True))
    except UnicodeEncodeError:
        safe = {'success': False, 'exit_code': 1, 'errors': ['UnicodeEncodeError in _write_result']}
        print(json.dumps(safe, ensure_ascii=True))


if __name__ == '__main__':
    main()
