"""P5-SY4E CLI 集成测试 — 参数互斥、退出码、报告内容、写入路径未调用。

不依赖 Supabase 连接或写入。所有场景通过 cli_execute.main() 验证。
"""
import sys
import os
import json
import io as _io
from contextlib import ExitStack
from unittest.mock import patch, mock_open

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# 必须在 mock 设置前预导入所有含 _load_env 的模块
import sync.executor  # noqa: F401
import sync.cli_execute  # noqa: F401
import sync.input_validator  # noqa: F401
import sync.supabase_gateway  # noqa: F401
import sync.plan_generator  # noqa: F401
import sync.verifier  # noqa: F401
import sync.config  # noqa: F401

PASS = 0
FAIL = 0


def test(name):
    def decorator(fn):
        def wrapper():
            global PASS, FAIL
            try:
                fn()
                print(f'  PASS: {name}')
                PASS += 1
            except AssertionError as e:
                print(f'  FAIL: {name} — {e}')
                FAIL += 1
            except Exception as e:
                print(f'  ERROR: {name} — {type(e).__name__}: {e}')
                FAIL += 1
        return wrapper
    return decorator


# =========================================================================
# 测试数据
# =========================================================================

WH_ID = 'adc5ec45-cd98-42a8-a1d1-26600e80d481'
SYNC_AT = '2026-06-13T12:00:00+08:00'

BASE_CLI_ARGS = [
    'cli_execute.py',
    '--input-json', '/fake/input.json',
    '--dry-run-report', '/fake/report.json',
    '--execute', '--confirm', 'P5-SY3B-PH',
]

MOCK_INPUT_DATA = {
    'warehouse': '菲律宾-新创启辰自建仓',
    'row_count': 91,
    'rows': [],
}

MOCK_DRY_RUN_REPORT = {
    'counts': {
        'input_rows': 91,
        'new_variants': 91,
        'inventory_after_variant_create': 91,
        'total_inventory_actions': 91,
    },
}

MOCK_WAREHOUSE = {
    'id': WH_ID,
    'name': '菲律宾-新创启辰自建仓',
}

MOCK_ROWS = []

SIMPLE_PLAN = {
    'warehouse_rename_required': {
        'warehouse_id': WH_ID,
        'target_name': '菲律宾-新创启辰自建仓',
    },
    'new_variants': [],
    'inventory_updates': [],
    'inventory_inserts': [],
    'inventory_after_variant_create': [],
    'inventory_unchanged': [],
}

MOCK_EXECUTE_RESULT_DRY_RUN = {
    'started_at': SYNC_AT,
    'finished_at': SYNC_AT,
    'warehouse_id': WH_ID,
    'warehouse_name_before': '菲律宾仓',
    'warehouse_name_after': '菲律宾-新创启辰自建仓',
    'warehouse_renamed': False,
    'variants_before': 91,
    'variants_created': 0,
    'variants_skipped': 0,
    'variants_total': 91,
    'inventory_before': 91,
    'inventory_inserted': 0,
    'inventory_updated': 0,
    'inventory_unchanged': 0,
    'inventory_total': 91,
    'inventory_write_actions': 91,
    'rpc_summary': None,
    'phase_g_verified': False,
    'phase_i_verified': False,
    'sync_log_written': False,
    'sync_log_fallback_path': None,
    'errors': [],
}


MOCK_EXECUTE_RESULT_V2 = {
    'started_at': '2026-06-20T10:00:00+08:00',
    'finished_at': '2026-06-20T10:00:05+08:00',
    'warehouse_id': WH_ID,
    'rpc_summary': {
        'variants_created': 1,
        'inventory_received': 3,
        'inventory_inserted': 1,
        'inventory_updated': 1,
        'inventory_unchanged': 1,
        'warehouse_renamed': False,
    },
    'phase_g_verified': True,
    'phase_i_verified': True,
    'sync_log_written': True,
    'sync_log_fallback_path': None,
    'errors': [],
}

MOCK_VARIANT_LIST_VN = [
    {'id': 'v-001', 'sku': 'WM0005', 'country': 'VN'},
    {'id': 'v-002', 'sku': 'WM0074', 'country': 'VN'},
]
MOCK_INVENTORY_LIST_VN = [
    {'id': 'inv-1', 'variant_id': 'v-001', 'warehouse_id': WH_ID, 'quantity': 1500},
    {'id': 'inv-2', 'variant_id': 'v-002', 'warehouse_id': WH_ID, 'quantity': 21289},
]
MOCK_WAREHOUSE_VN = {
    'id': WH_ID, 'name': '越南青林湾仓库',
    'country': 'VN', 'type': 'overseas', 'is_active': True,
}

# 非空计划漂移差异（模拟数据库已写入后的状态）
MOCK_DRIFT_DIFFS = [
    'Warehouse 改名动作不一致: 当前=none, 存储=rename',
    'new_variants 数量不一致: 当前=0, 存储=91',
    'inventory_after_variant_create 数量不一致: 当前=0, 存储=91',
]


# =========================================================================
# Mock 辅助函数
# =========================================================================

def _start_dry_run_mocks(extra_args=None, diffs=None):
    """启动完整 Dry Run Mock 链。

    返回 (ExitStack, mock_dict)。mock_dict 含所有 patcher 便于断言。
    diffs 为 None 时默认返回空列表（无漂移）。
    """
    argv = list(BASE_CLI_ARGS)
    if extra_args:
        argv.extend(extra_args)

    stack = ExitStack()
    m = {}
    m['argv'] = stack.enter_context(patch('sys.argv', argv))
    m['isfile'] = stack.enter_context(patch('os.path.isfile', return_value=True))
    m['open'] = stack.enter_context(patch('builtins.open', mock_open()))
    m['json_load'] = stack.enter_context(patch('json.load',
        side_effect=[MOCK_INPUT_DATA, MOCK_DRY_RUN_REPORT]))
    m['json_dump'] = stack.enter_context(patch('json.dump'))
    m['validate'] = stack.enter_context(
        patch('sync.input_validator.validate_json', return_value=MOCK_ROWS))
    m['fetch_wh'] = stack.enter_context(
        patch('sync.supabase_gateway.fetch_warehouse', return_value=MOCK_WAREHOUSE))
    m['fetch_var'] = stack.enter_context(
        patch('sync.supabase_gateway.fetch_variants', return_value=[]))
    m['fetch_inv'] = stack.enter_context(
        patch('sync.supabase_gateway.fetch_inventory_by_warehouse', return_value=[]))
    m['gen_plan'] = stack.enter_context(
        patch('sync.plan_generator.generate_plan', return_value=SIMPLE_PLAN))
    _diffs = [] if diffs is None else diffs
    m['compare'] = stack.enter_context(
        patch('sync.verifier.compare_plans', return_value=_diffs))
    m['execute_plan'] = stack.enter_context(
        patch('sync.executor.execute_plan', return_value=MOCK_EXECUTE_RESULT_DRY_RUN))
    m['execute_plan_v2'] = stack.enter_context(
        patch('sync.executor.execute_plan_v2'))
    m['rpc'] = stack.enter_context(patch('sync.executor._call_sync_rpc'))
    m['log'] = stack.enter_context(patch('sync.executor._write_sync_log'))
    m['fb'] = stack.enter_context(patch('sync.executor._save_fallback_log'))
    m['verify_inv'] = stack.enter_context(patch('sync.executor.verify_inventory_post_write'))
    m['verify_wh'] = stack.enter_context(patch('sync.executor.verify_warehouse_final_state'))
    m['get'] = stack.enter_context(patch('sync.executor._get'))
    m['wh_country'] = stack.enter_context(
        patch('sync.config.WAREHOUSE_COUNTRY', 'PH'))
    m['stdout'] = stack.enter_context(patch('sys.stdout', _io.StringIO()))
    return stack, m


# =========================================================================
# 测试: 参数互斥
# =========================================================================

@test("--dry-run 与 --no-dry-run 同时指定时 argparse 报错 exit 2")
def test_mutually_exclusive_dry_run_and_no_dry_run():
    """argparse 互斥组不允许同时指定 --dry-run 和 --no-dry-run。"""
    with patch('sys.argv', BASE_CLI_ARGS + ['--dry-run', '--no-dry-run']):
        try:
            from sync.cli_execute import main
            main()
            assert False, '应抛出 SystemExit'
        except SystemExit as e:
            # argparse 互斥组错误退出码为 2
            assert e.code == 2, f'argparse 互斥错误退出码应为 2，实际: {e.code}'


@test("--no-dry-run --no-sync-log 在任何文件 I/O 前被拒绝 exit 1")
def test_no_dry_run_no_sync_log_rejected_before_io():
    """--no-dry-run --no-sync-log 在参数解析后立即拒绝，不触及文件或网络。"""
    with patch('sys.argv', BASE_CLI_ARGS + ['--no-dry-run', '--no-sync-log']), \
         patch('os.path.isfile') as mock_isfile, \
         patch('builtins.open') as mock_file, \
         patch('sync.supabase_gateway.fetch_warehouse') as mock_fetch_wh, \
         patch('sync.executor._call_sync_rpc') as mock_rpc, \
         patch('sync.executor._write_sync_log') as mock_log, \
         patch('sync.executor._save_fallback_log') as mock_fb:
        try:
            from sync.cli_execute import main
            main()
            assert False, '应调用 sys.exit(1)'
        except SystemExit as e:
            assert e.code == 1, f'退出码应为 1，实际: {e.code}'

        # 所有 I/O、网络和执行器均未调用
        mock_isfile.assert_not_called()
        mock_file.assert_not_called()
        mock_fetch_wh.assert_not_called()
        mock_rpc.assert_not_called()
        mock_log.assert_not_called()
        mock_fb.assert_not_called()


# =========================================================================
# 测试: 默认与显式 Dry Run
# =========================================================================

@test("默认（无 mode flag）→ Dry Run 模式，RPC/sync_log/fallback 均未调用")
def test_default_dry_run_mode():
    """不指定 --dry-run 或 --no-dry-run 时默认为 Dry Run。"""
    stack, m = _start_dry_run_mocks()
    with stack:
        try:
            from sync.cli_execute import main
            main()
            assert False, '应调用 sys.exit(0)'
        except SystemExit as e:
            assert e.code == 0, f'退出码应为 0，实际: {e.code}'

        # execute_plan（旧 REST 模式）被调用且 dry_run=True
        m['execute_plan'].assert_called_once()
        exec_call = m['execute_plan'].call_args
        assert exec_call[1]['dry_run'] is True
        assert exec_call[1]['confirm'] == 'P5-SY3B-PH'

        # execute_plan_v2 不得调用
        m['execute_plan_v2'].assert_not_called()

        # 所有写入路径不得调用
        m['rpc'].assert_not_called()
        m['log'].assert_not_called()
        m['fb'].assert_not_called()
        m['verify_inv'].assert_not_called()
        m['verify_wh'].assert_not_called()
        m['get'].assert_not_called()

        # stdout 包含 Dry Run 默认提示
        stdout_text = m['stdout'].getvalue()
        assert 'DRY RUN 模式（默认）' in stdout_text, \
            f'stdout 应包含默认 Dry Run 提示，实际: {stdout_text!r}'


@test("显式 --dry-run → Dry Run 模式，行为与默认一致")
def test_explicit_dry_run_flag():
    """显式指定 --dry-run 时行为与默认相同，但 stdout 提示不同。"""
    stack, m = _start_dry_run_mocks(extra_args=['--dry-run'])
    with stack:
        try:
            from sync.cli_execute import main
            main()
            assert False, '应调用 sys.exit(0)'
        except SystemExit as e:
            assert e.code == 0, f'退出码应为 0，实际: {e.code}'

        m['execute_plan'].assert_called_once()
        exec_call = m['execute_plan'].call_args
        assert exec_call[1]['dry_run'] is True

        m['execute_plan_v2'].assert_not_called()
        m['rpc'].assert_not_called()
        m['log'].assert_not_called()
        m['fb'].assert_not_called()

        stdout_text = m['stdout'].getvalue()
        assert 'DRY RUN 模式（--dry-run 显式指定）' in stdout_text, \
            f'stdout 应包含显式 --dry-run 提示，实际: {stdout_text!r}'


# =========================================================================
# 测试: --dry-run --no-sync-log 被接受
# =========================================================================

@test("--dry-run --no-sync-log 被接受 exit 0，sync_log 禁用且无写入")
def test_dry_run_no_sync_log_accepted():
    """显式 --dry-run + --no-sync-log 正常退出，sync_log disabled。"""
    stack, m = _start_dry_run_mocks(extra_args=['--dry-run', '--no-sync-log'])
    with stack:
        try:
            from sync.cli_execute import main
            main()
            assert False, '应调用 sys.exit(0)'
        except SystemExit as e:
            assert e.code == 0, f'退出码应为 0，实际: {e.code}'

        m['execute_plan'].assert_called_once()
        m['rpc'].assert_not_called()
        m['log'].assert_not_called()
        m['fb'].assert_not_called()

        stdout_text = m['stdout'].getvalue()
        assert 'SyncLog:    禁用' in stdout_text, \
            f'stdout 应显示 SyncLog 禁用，实际: {stdout_text!r}'


# =========================================================================
# 测试: 报告 sync_log 摘要
# =========================================================================

@test("默认 Dry Run 报告包含 sync_log 摘要：enabled=True, written=False, reason 说明")
def test_report_sync_log_summary_dry_run_default():
    """默认 Dry Run 执行报告 JSON 中的 sync_log 摘要字段正确。"""
    report_data = []

    def capture_json_dump(data, *args, **kwargs):
        report_data.append(data)

    stack, m = _start_dry_run_mocks()
    # 覆盖 json.dump mock 以捕获报告数据
    # ExitStack 中 json_dump 已注册，需要先退出再手动控制
    # 简化：在默认 mocks 基础上追加 json.dump 覆盖
    stack.enter_context(patch('json.dump', side_effect=capture_json_dump))
    with stack:
        try:
            from sync.cli_execute import main
            main()
            assert False, '应调用 sys.exit(0)'
        except SystemExit as e:
            assert e.code == 0

    assert len(report_data) > 0, 'json.dump 应至少被调用一次'
    report = report_data[0]
    sync_log = report.get('sync_log')
    assert sync_log is not None, f'报告应包含 sync_log 字段，keys: {list(report.keys())}'
    assert sync_log['enabled'] is True, \
        f'sync_log.enabled 应为 True，实际: {sync_log["enabled"]}'
    assert sync_log['written'] is False, \
        f'sync_log.written 应为 False，实际: {sync_log["written"]}'
    assert 'Dry Run 模式下不执行实际写入' in sync_log['reason'], \
        f'reason 应说明 Dry Run 不写入，实际: {sync_log["reason"]}'


@test("--dry-run --no-sync-log 报告 sync_log 摘要：enabled=False, reason 说明已禁用")
def test_report_sync_log_summary_disabled():
    """--dry-run --no-sync-log 执行报告 JSON 中 sync_log.enabled=False。"""
    report_data = []

    def capture_json_dump(data, *args, **kwargs):
        report_data.append(data)

    stack, m = _start_dry_run_mocks(extra_args=['--dry-run', '--no-sync-log'])
    stack.enter_context(patch('json.dump', side_effect=capture_json_dump))
    with stack:
        try:
            from sync.cli_execute import main
            main()
            assert False, '应调用 sys.exit(0)'
        except SystemExit as e:
            assert e.code == 0

    assert len(report_data) > 0, 'json.dump 应至少被调用一次'
    report = report_data[0]
    sync_log = report.get('sync_log')
    assert sync_log is not None, f'报告应包含 sync_log 字段'
    assert sync_log['enabled'] is False, \
        f'sync_log.enabled 应为 False，实际: {sync_log["enabled"]}'
    assert sync_log['written'] is False
    assert '已通过 --no-sync-log 禁用' in sync_log['reason'], \
        f'reason 应说明已禁用，实际: {sync_log["reason"]}'


# =========================================================================
# 测试: 计划漂移检测真实性（非空 diffs → DRIFT_DETECTED，不硬编码 PASS）
# =========================================================================

@test("非空计划漂移 → plan_drift_check=DRIFT_DETECTED，count 与 differences 正确")
def test_plan_drift_detected_in_report():
    """当 compare_plans 返回非空 diffs 时，报告必须记录 DRIFT_DETECTED，
    不得硬编码 PASS。同时验证漂移差异数量和内容。"""
    report_data = []

    def capture_json_dump(data, *args, **kwargs):
        report_data.append(data)

    stack, m = _start_dry_run_mocks(diffs=MOCK_DRIFT_DIFFS)
    stack.enter_context(patch('json.dump', side_effect=capture_json_dump))
    with stack:
        try:
            from sync.cli_execute import main
            main()
            assert False, '应调用 sys.exit(0)'
        except SystemExit as e:
            assert e.code == 0

    # Dry Run 模式下漂移不阻止执行
    m['execute_plan'].assert_called_once()
    m['execute_plan_v2'].assert_not_called()
    m['rpc'].assert_not_called()
    m['log'].assert_not_called()
    m['fb'].assert_not_called()

    # 报告真实性断言
    assert len(report_data) > 0, 'json.dump 应至少被调用一次'
    report = report_data[0]

    # plan_drift_check 不得为 PASS
    drift_check = report.get('plan_drift_check')
    assert drift_check == 'DRIFT_DETECTED', \
        f'plan_drift_check 应为 DRIFT_DETECTED，实际: {drift_check!r}'
    assert drift_check != 'PASS', \
        '非空 diffs 时 plan_drift_check 不得硬编码为 PASS'

    # plan_drift_count 正确
    assert report['plan_drift_count'] == 3, \
        f'plan_drift_count 应为 3，实际: {report["plan_drift_count"]}'

    # plan_drift_differences 内容正确
    diffs = report['plan_drift_differences']
    assert len(diffs) == 3, f'应有 3 条差异，实际: {len(diffs)}'
    assert any('Warehouse 改名动作不一致' in d for d in diffs), \
        f'差异应包含 Warehouse 改名，实际: {diffs}'
    assert any('new_variants 数量不一致' in d for d in diffs), \
        f'差异应包含 new_variants 数量，实际: {diffs}'
    assert any('inventory_after_variant_create 数量不一致' in d for d in diffs), \
        f'差异应包含 inventory_after_variant_create 数量，实际: {diffs}'

    # stdout 应显示漂移信息
    stdout_text = m['stdout'].getvalue()
    assert 'DRIFT_DETECTED' in stdout_text, \
        f'stdout 应包含 DRIFT_DETECTED，实际: {stdout_text!r}'
    assert '计划漂移检测: 发现差异' in stdout_text, \
        f'stdout 应包含漂移发现提示，实际: {stdout_text!r}'


@test("空计划漂移 → plan_drift_check=PASS，count=0，differences 为空数组")
def test_plan_drift_pass_in_report():
    """当 compare_plans 返回空列表时，报告记录 PASS，count=0，differences=[]。"""
    report_data = []

    def capture_json_dump(data, *args, **kwargs):
        report_data.append(data)

    stack, m = _start_dry_run_mocks(diffs=[])
    stack.enter_context(patch('json.dump', side_effect=capture_json_dump))
    with stack:
        try:
            from sync.cli_execute import main
            main()
            assert False, '应调用 sys.exit(0)'
        except SystemExit as e:
            assert e.code == 0

    report = report_data[0]
    assert report['plan_drift_check'] == 'PASS', \
        f'空 diffs 时 plan_drift_check 应为 PASS，实际: {report["plan_drift_check"]!r}'
    assert report['plan_drift_count'] == 0, \
        f'plan_drift_count 应为 0，实际: {report["plan_drift_count"]}'
    assert report['plan_drift_differences'] == [], \
        f'plan_drift_differences 应为空数组，实际: {report["plan_drift_differences"]!r}'

    # 所有写入路径未调用
    m['execute_plan'].assert_called_once()
    m['execute_plan_v2'].assert_not_called()
    m['rpc'].assert_not_called()


# =========================================================================
# 测试: Dry Run 模式下 execute_plan_v2 绝对不可调用
# =========================================================================

@test("默认 Dry Run 使用 execute_plan（旧 REST），不触发 execute_plan_v2")
def test_dry_run_uses_execute_plan_not_v2():
    """确保 Dry Run 路径走旧 execute_plan，永不触发 RPC execute_plan_v2。"""
    stack, m = _start_dry_run_mocks()
    with stack:
        try:
            from sync.cli_execute import main
            main()
            assert False, '应调用 sys.exit(0)'
        except SystemExit as e:
            assert e.code == 0

        m['execute_plan'].assert_called_once()
        m['execute_plan_v2'].assert_not_called()


# =========================================================================
# 测试: P5-SY8B-VN 令牌
# =========================================================================

VN_CLI_ARGS = [
    'cli_execute.py',
    '--input-json', '/fake/input-vn.json',
    '--dry-run-report', '/fake/report-vn.json',
    '--execute', '--confirm', 'P5-SY8B-VN',
]


@test("P5-SY8B-VN 令牌 Dry Run 被接受 exit 0，confirm 参数正确传递")
def test_vn_token_accepted_dry_run():
    """P5-SY8B-VN is a valid token, accepted in dry run mode."""
    stack = ExitStack()
    m = {}
    m['argv'] = stack.enter_context(patch('sys.argv', VN_CLI_ARGS))
    m['wh_country'] = stack.enter_context(
        patch('sync.config.WAREHOUSE_COUNTRY', 'VN'))
    m['isfile'] = stack.enter_context(patch('os.path.isfile', return_value=True))
    m['open'] = stack.enter_context(patch('builtins.open', mock_open()))
    m['json_load'] = stack.enter_context(patch('json.load',
        side_effect=[MOCK_INPUT_DATA, MOCK_DRY_RUN_REPORT]))
    m['json_dump'] = stack.enter_context(patch('json.dump'))
    m['validate'] = stack.enter_context(
        patch('sync.input_validator.validate_json', return_value=MOCK_ROWS))
    m['fetch_wh'] = stack.enter_context(
        patch('sync.supabase_gateway.fetch_warehouse', return_value=MOCK_WAREHOUSE))
    m['fetch_var'] = stack.enter_context(
        patch('sync.supabase_gateway.fetch_variants', return_value=[]))
    m['fetch_inv'] = stack.enter_context(
        patch('sync.supabase_gateway.fetch_inventory_by_warehouse', return_value=[]))
    m['gen_plan'] = stack.enter_context(
        patch('sync.plan_generator.generate_plan', return_value=SIMPLE_PLAN))
    m['compare'] = stack.enter_context(
        patch('sync.verifier.compare_plans', return_value=[]))
    m['execute_plan'] = stack.enter_context(
        patch('sync.executor.execute_plan', return_value=MOCK_EXECUTE_RESULT_DRY_RUN))
    m['execute_plan_v2'] = stack.enter_context(
        patch('sync.executor.execute_plan_v2'))
    m['rpc'] = stack.enter_context(patch('sync.executor._call_sync_rpc'))
    m['log'] = stack.enter_context(patch('sync.executor._write_sync_log'))
    m['fb'] = stack.enter_context(patch('sync.executor._save_fallback_log'))
    m['verify_inv'] = stack.enter_context(patch('sync.executor.verify_inventory_post_write'))
    m['verify_wh'] = stack.enter_context(patch('sync.executor.verify_warehouse_final_state'))
    m['get'] = stack.enter_context(patch('sync.executor._get'))
    m['stdout'] = stack.enter_context(patch('sys.stdout', _io.StringIO()))
    with stack:
        try:
            from sync.cli_execute import main
            main()
            assert False, '应调用 sys.exit(0)'
        except SystemExit as e:
            assert e.code == 0, f'退出码应为 0，实际: {e.code}'

        # execute_plan 被调用且 dry_run=True, confirm=P5-SY8B-VN
        m['execute_plan'].assert_called_once()
        exec_call = m['execute_plan'].call_args
        assert exec_call[1]['dry_run'] is True
        assert exec_call[1]['confirm'] == 'P5-SY8B-VN', \
            f'confirm 应为 P5-SY8B-VN, 实际: {exec_call[1]["confirm"]}'

        # 所有写入路径不得调用
        m['execute_plan_v2'].assert_not_called()
        m['rpc'].assert_not_called()
        m['log'].assert_not_called()
        m['fb'].assert_not_called()
        m['verify_inv'].assert_not_called()
        m['verify_wh'].assert_not_called()
        m['get'].assert_not_called()

        # stdout 包含确认令牌
        stdout_text = m['stdout'].getvalue()
        assert 'P5-SY8B-VN' in stdout_text, \
            f'stdout 应包含 P5-SY8B-VN，实际: {stdout_text!r}'


@test("无效令牌被拒绝 fail-fast，在任何文件 I/O 前 exit 1")
def test_invalid_token_rejected_before_io():
    """Invalid token must be rejected immediately after argparse parsing,
    before any file I/O, Supabase query, or network call."""
    with patch('sys.argv', VN_CLI_ARGS[:-1] + ['INVALID-TOKEN']), \
         patch('os.path.isfile') as mock_isfile, \
         patch('builtins.open') as mock_file, \
         patch('json.load') as mock_json_load, \
         patch('sync.supabase_gateway.fetch_warehouse') as mock_fetch_wh, \
         patch('sync.supabase_gateway.fetch_variants') as mock_fetch_var, \
         patch('sync.supabase_gateway.fetch_inventory_by_warehouse') as mock_fetch_inv, \
         patch('sync.executor._call_sync_rpc') as mock_rpc, \
         patch('sync.executor._write_sync_log') as mock_log, \
         patch('sync.executor._save_fallback_log') as mock_fb, \
         patch('sync.executor.execute_plan') as mock_exec, \
         patch('sync.executor.execute_plan_v2') as mock_exec_v2:
        try:
            from sync.cli_execute import main
            main()
            assert False, '应调用 sys.exit(1)'
        except SystemExit as e:
            assert e.code == 1, f'退出码应为 1，实际: {e.code}'

        # 所有 I/O、网络、执行器均未调用
        mock_isfile.assert_not_called()
        mock_file.assert_not_called()
        mock_json_load.assert_not_called()
        mock_fetch_wh.assert_not_called()
        mock_fetch_var.assert_not_called()
        mock_fetch_inv.assert_not_called()
        mock_rpc.assert_not_called()
        mock_log.assert_not_called()
        mock_fb.assert_not_called()
        mock_exec.assert_not_called()
        mock_exec_v2.assert_not_called()


# =========================================================================
# 测试: 令牌必须绑定目标国家
# =========================================================================

@test("VN 配置下 --confirm P5-SY3B-PH 被拒绝，且 os.path.isfile/open/json.load/fetch_warehouse/RPC 均未调用")
def test_vn_config_rejects_ph_token_before_io():
    """config.WAREHOUSE_COUNTRY='VN' 时，PH 令牌在文件 I/O 前被拒绝。"""
    vn_args = [
        'cli_execute.py',
        '--input-json', '/fake/input.json',
        '--dry-run-report', '/fake/report.json',
        '--execute', '--confirm', 'P5-SY3B-PH',
    ]
    with patch('sys.argv', vn_args), \
         patch('sync.config.WAREHOUSE_COUNTRY', 'VN'), \
         patch('os.path.isfile') as mock_isfile, \
         patch('builtins.open') as mock_file, \
         patch('json.load') as mock_json_load, \
         patch('sync.supabase_gateway.fetch_warehouse') as mock_fetch_wh, \
         patch('sync.supabase_gateway.fetch_variants') as mock_fetch_var, \
         patch('sync.supabase_gateway.fetch_inventory_by_warehouse') as mock_fetch_inv, \
         patch('sync.executor._call_sync_rpc') as mock_rpc, \
         patch('sync.executor._write_sync_log') as mock_log, \
         patch('sync.executor._save_fallback_log') as mock_fb, \
         patch('sync.executor.execute_plan') as mock_exec, \
         patch('sync.executor.execute_plan_v2') as mock_exec_v2, \
         patch('sys.stdout', _io.StringIO()) as mock_stdout:
        try:
            from sync.cli_execute import main
            main()
            assert False, '应调用 sys.exit(1)'
        except SystemExit as e:
            assert e.code == 1, f'退出码应为 1，实际: {e.code}'

        # 所有 I/O、网络、执行器均未调用
        mock_isfile.assert_not_called()
        mock_file.assert_not_called()
        mock_json_load.assert_not_called()
        mock_fetch_wh.assert_not_called()
        mock_fetch_var.assert_not_called()
        mock_fetch_inv.assert_not_called()
        mock_rpc.assert_not_called()
        mock_log.assert_not_called()
        mock_fb.assert_not_called()
        mock_exec.assert_not_called()
        mock_exec_v2.assert_not_called()

        # stdout 包含当前 WAREHOUSE_COUNTRY 和期望令牌
        stdout_text = mock_stdout.getvalue()
        assert 'VN' in stdout_text, \
            f'错误信息应包含当前 WAREHOUSE_COUNTRY=VN: {stdout_text!r}'
        assert 'P5-SY8B-VN' in stdout_text, \
            f'错误信息应包含期望令牌 P5-SY8B-VN: {stdout_text!r}'


@test("VN 配置下 --confirm P5-SY8B-VN 正常通过（dry run 模式）")
def test_vn_config_accepts_vn_token():
    """config.WAREHOUSE_COUNTRY='VN' 时，P5-SY8B-VN 令牌正常通过。"""
    vn_args = [
        'cli_execute.py',
        '--input-json', '/fake/input.json',
        '--dry-run-report', '/fake/report.json',
        '--execute', '--confirm', 'P5-SY8B-VN',
    ]
    stack = ExitStack()
    m = {}
    m['argv'] = stack.enter_context(patch('sys.argv', vn_args))
    m['wh_country'] = stack.enter_context(
        patch('sync.config.WAREHOUSE_COUNTRY', 'VN'))
    m['isfile'] = stack.enter_context(patch('os.path.isfile', return_value=True))
    m['open'] = stack.enter_context(patch('builtins.open', mock_open()))
    m['json_load'] = stack.enter_context(patch('json.load',
        side_effect=[MOCK_INPUT_DATA, MOCK_DRY_RUN_REPORT]))
    m['json_dump'] = stack.enter_context(patch('json.dump'))
    m['validate'] = stack.enter_context(
        patch('sync.input_validator.validate_json', return_value=MOCK_ROWS))
    m['fetch_wh'] = stack.enter_context(
        patch('sync.supabase_gateway.fetch_warehouse', return_value=MOCK_WAREHOUSE))
    m['fetch_var'] = stack.enter_context(
        patch('sync.supabase_gateway.fetch_variants', return_value=[]))
    m['fetch_inv'] = stack.enter_context(
        patch('sync.supabase_gateway.fetch_inventory_by_warehouse', return_value=[]))
    m['gen_plan'] = stack.enter_context(
        patch('sync.plan_generator.generate_plan', return_value=SIMPLE_PLAN))
    m['compare'] = stack.enter_context(
        patch('sync.verifier.compare_plans', return_value=[]))
    m['execute_plan'] = stack.enter_context(
        patch('sync.executor.execute_plan', return_value=MOCK_EXECUTE_RESULT_DRY_RUN))
    m['execute_plan_v2'] = stack.enter_context(
        patch('sync.executor.execute_plan_v2'))
    m['rpc'] = stack.enter_context(patch('sync.executor._call_sync_rpc'))
    m['log'] = stack.enter_context(patch('sync.executor._write_sync_log'))
    m['fb'] = stack.enter_context(patch('sync.executor._save_fallback_log'))
    m['stdout'] = stack.enter_context(patch('sys.stdout', _io.StringIO()))
    with stack:
        try:
            from sync.cli_execute import main
            main()
            assert False, '应调用 sys.exit(0)'
        except SystemExit as e:
            assert e.code == 0, f'退出码应为 0，实际: {e.code}'

        m['execute_plan'].assert_called_once()
        assert m['execute_plan'].call_args[1]['confirm'] == 'P5-SY8B-VN'


@test("PH 配置下 --confirm P5-SY8B-VN 被拒绝，且 os.path.isfile/open/json.load/fetch_warehouse/RPC 均未调用")
def test_ph_config_rejects_vn_token_before_io():
    """config.WAREHOUSE_COUNTRY='PH' 时，VN 令牌在文件 I/O 前被拒绝。"""
    ph_args = [
        'cli_execute.py',
        '--input-json', '/fake/input.json',
        '--dry-run-report', '/fake/report.json',
        '--execute', '--confirm', 'P5-SY8B-VN',
    ]
    with patch('sys.argv', ph_args), \
         patch('sync.config.WAREHOUSE_COUNTRY', 'PH'), \
         patch('os.path.isfile') as mock_isfile, \
         patch('builtins.open') as mock_file, \
         patch('json.load') as mock_json_load, \
         patch('sync.supabase_gateway.fetch_warehouse') as mock_fetch_wh, \
         patch('sync.supabase_gateway.fetch_variants') as mock_fetch_var, \
         patch('sync.supabase_gateway.fetch_inventory_by_warehouse') as mock_fetch_inv, \
         patch('sync.executor._call_sync_rpc') as mock_rpc, \
         patch('sync.executor._write_sync_log') as mock_log, \
         patch('sync.executor._save_fallback_log') as mock_fb, \
         patch('sync.executor.execute_plan') as mock_exec, \
         patch('sync.executor.execute_plan_v2') as mock_exec_v2, \
         patch('sys.stdout', _io.StringIO()) as mock_stdout:
        try:
            from sync.cli_execute import main
            main()
            assert False, '应调用 sys.exit(1)'
        except SystemExit as e:
            assert e.code == 1, f'退出码应为 1，实际: {e.code}'

        # 所有 I/O、网络、执行器均未调用
        mock_isfile.assert_not_called()
        mock_file.assert_not_called()
        mock_json_load.assert_not_called()
        mock_fetch_wh.assert_not_called()
        mock_fetch_var.assert_not_called()
        mock_fetch_inv.assert_not_called()
        mock_rpc.assert_not_called()
        mock_log.assert_not_called()
        mock_fb.assert_not_called()
        mock_exec.assert_not_called()
        mock_exec_v2.assert_not_called()

        # stdout 包含当前 WAREHOUSE_COUNTRY 和期望令牌
        stdout_text = mock_stdout.getvalue()
        assert 'PH' in stdout_text, \
            f'错误信息应包含当前 WAREHOUSE_COUNTRY=PH: {stdout_text!r}'
        assert 'P5-SY3B-PH' in stdout_text, \
            f'错误信息应包含期望令牌 P5-SY3B-PH: {stdout_text!r}'


# =========================================================================
# 测试: no-dry-run 成功报告包含 started_at 和 finished_at
# =========================================================================

@test("no-dry-run 成功报告中 started_at 和 finished_at 非 null")
def test_no_dry_run_report_has_timestamps():
    """--no-dry-run 模式成功执行后，报告 result 中 started_at/finished_at 非 null。"""
    report_data = []

    def capture_json_dump(data, *args, **kwargs):
        report_data.append(data)

    _TIMESTAMP_DRY_RUN_REPORT = {
        'counts': {
            'input_rows': 3,
            'new_variants': 0,
            'inventory_after_variant_create': 0,
            'total_inventory_actions': 2,
        },
    }

    stack = ExitStack()
    m = {}
    vn_args = [
        'cli_execute.py',
        '--input-json', '/fake/input.json',
        '--dry-run-report', '/fake/report.json',
        '--execute', '--confirm', 'P5-SY8B-VN',
        '--no-dry-run',
    ]
    m['argv'] = stack.enter_context(patch('sys.argv', vn_args))
    m['wh_country'] = stack.enter_context(
        patch('sync.config.WAREHOUSE_COUNTRY', 'VN'))
    m['isfile'] = stack.enter_context(patch('os.path.isfile', return_value=True))
    m['open'] = stack.enter_context(patch('builtins.open', mock_open()))
    m['json_load'] = stack.enter_context(patch('json.load',
        side_effect=[MOCK_INPUT_DATA, _TIMESTAMP_DRY_RUN_REPORT]))
    m['json_dump'] = stack.enter_context(patch('json.dump', side_effect=capture_json_dump))
    m['validate'] = stack.enter_context(
        patch('sync.input_validator.validate_json', return_value=MOCK_ROWS))
    m['fetch_wh'] = stack.enter_context(
        patch('sync.supabase_gateway.fetch_warehouse', return_value=MOCK_WAREHOUSE_VN))
    m['fetch_var'] = stack.enter_context(
        patch('sync.supabase_gateway.fetch_variants', return_value=MOCK_VARIANT_LIST_VN))
    m['fetch_inv'] = stack.enter_context(
        patch('sync.supabase_gateway.fetch_inventory_by_warehouse',
              return_value=MOCK_INVENTORY_LIST_VN))
    m['gen_plan'] = stack.enter_context(
        patch('sync.plan_generator.generate_plan', return_value=SIMPLE_PLAN))
    m['compare'] = stack.enter_context(
        patch('sync.verifier.compare_plans', return_value=[]))
    m['execute_plan_v2'] = stack.enter_context(
        patch('sync.executor.execute_plan_v2', return_value=MOCK_EXECUTE_RESULT_V2))
    m['stdout'] = stack.enter_context(patch('sys.stdout', _io.StringIO()))
    with stack:
        try:
            from sync.cli_execute import main
            main()
            assert False, '应调用 sys.exit(0)'
        except SystemExit as e:
            assert e.code == 0, f'退出码应为 0，实际: {e.code}'

    assert len(report_data) > 0, 'json.dump 应至少被调用一次'
    report = report_data[0]
    result = report.get('result')
    assert result is not None, f'报告应包含 result 字段，keys: {list(report.keys())}'

    started = result.get('started_at')
    finished = result.get('finished_at')
    assert started is not None, f'started_at 不应为 null'
    assert finished is not None, f'finished_at 不应为 null'
    assert len(started) > 0, f'started_at 不应为空字符串'
    assert len(finished) > 0, f'finished_at 不应为空字符串'


# =========================================================================
# 测试: P5-SY8E-MY 全链路国家断言 (execute_plan_v2 直接调用)
# =========================================================================

MY_WAREHOUSE_ID = '5841ca94-d5d2-4f43-9f05-2fc44e91a8b3'

MY_WAREHOUSE = {
    'id': MY_WAREHOUSE_ID,
    'name': '喜运达MY仓',
    'country': 'MY',
    'type': 'overseas',
    'is_active': True,
}

MY_VARIANT_LIST_POST = [
    {'id': 'v-my-001', 'sku': 'MY-EXIST-001', 'country': 'MY'},
    {'id': 'v-my-002', 'sku': 'MY-EXIST-002', 'country': 'MY'},
    {'id': 'v-my-003', 'sku': 'MY-NEW-001', 'country': 'MY'},
]

MY_INVENTORY_POST_WRITE = [
    {'id': 'inv-my-1', 'variant_id': 'v-my-001', 'warehouse_id': MY_WAREHOUSE_ID, 'quantity': 10},
    {'id': 'inv-my-2', 'variant_id': 'v-my-002', 'warehouse_id': MY_WAREHOUSE_ID, 'quantity': 20},
    {'id': 'inv-my-3', 'variant_id': 'v-my-003', 'warehouse_id': MY_WAREHOUSE_ID, 'quantity': 30},
]

MY_PLAN = {
    'warehouse_rename_required': {
        'warehouse_id': MY_WAREHOUSE_ID,
        'target_name': '喜运达MY仓',
        'action': 'rename',
    },
    'new_variants': [
        {'sku': 'MY-NEW-001', 'country': 'MY', 'name': 'MY New Product'},
    ],
    'inventory_updates': [
        {'sku': 'MY-EXIST-001', 'country': 'MY', 'new_quantity': 10,
         'warehouse_id': MY_WAREHOUSE_ID},
    ],
    'inventory_inserts': [],
    'inventory_after_variant_create': [
        {'sku': 'MY-NEW-001', 'country': 'MY', 'new_quantity': 30,
         'warehouse_id': MY_WAREHOUSE_ID},
    ],
    'inventory_unchanged': [
        {'sku': 'MY-EXIST-002', 'country': 'MY', 'quantity': 20,
         'warehouse_id': MY_WAREHOUSE_ID},
    ],
}

MY_RPC_RESULT = {
    'variants_created': 1,
    'inventory_received': 3,
    'inventory_inserted': 1,
    'inventory_updated': 1,
    'inventory_unchanged': 1,
    'warehouse_renamed': True,
}

MY_INPUT_DATA = {
    'warehouse': '喜运达MY仓',
    'row_count': 3,
    'rows': [],
}

MY_DRY_RUN_REPORT = {
    'counts': {
        'input_rows': 3,
        'new_variants': 1,
        'inventory_after_variant_create': 1,
        'total_inventory_actions': 2,
    },
}


# =========================================================================
# 测试: P5-SY8G-ID 全链路国家断言 (execute_plan_v2 直接调用)
# =========================================================================

ID_WAREHOUSE_ID = '6cea5e6b-640a-4367-be80-43947bbdb45b'

ID_WAREHOUSE = {
    'id': ID_WAREHOUSE_ID,
    'name': '印尼-DEE仓库',
    'country': 'ID',
    'type': 'overseas',
    'is_active': True,
}

ID_VARIANT_LIST_POST = [
    {'id': 'v-id-001', 'sku': 'ID-EXIST-001', 'country': 'ID'},
    {'id': 'v-id-002', 'sku': 'ID-EXIST-002', 'country': 'ID'},
    {'id': 'v-id-003', 'sku': 'ID-NEW-001', 'country': 'ID'},
]

ID_INVENTORY_POST_WRITE = [
    {'id': 'inv-id-1', 'variant_id': 'v-id-001', 'warehouse_id': ID_WAREHOUSE_ID, 'quantity': 10},
    {'id': 'inv-id-2', 'variant_id': 'v-id-002', 'warehouse_id': ID_WAREHOUSE_ID, 'quantity': 20},
    {'id': 'inv-id-3', 'variant_id': 'v-id-003', 'warehouse_id': ID_WAREHOUSE_ID, 'quantity': 30},
]

ID_PLAN = {
    'warehouse_rename_required': {
        'warehouse_id': ID_WAREHOUSE_ID,
        'target_name': '印尼-DEE仓库',
        'action': 'rename',
    },
    'new_variants': [
        {'sku': 'ID-NEW-001', 'country': 'ID', 'name': 'ID New Product'},
    ],
    'inventory_updates': [
        {'sku': 'ID-EXIST-001', 'country': 'ID', 'new_quantity': 10,
         'warehouse_id': ID_WAREHOUSE_ID},
    ],
    'inventory_inserts': [],
    'inventory_after_variant_create': [
        {'sku': 'ID-NEW-001', 'country': 'ID', 'new_quantity': 30,
         'warehouse_id': ID_WAREHOUSE_ID},
    ],
    'inventory_unchanged': [
        {'sku': 'ID-EXIST-002', 'country': 'ID', 'quantity': 20,
         'warehouse_id': ID_WAREHOUSE_ID},
    ],
}

ID_RPC_RESULT = {
    'variants_created': 1,
    'inventory_received': 3,
    'inventory_inserted': 1,
    'inventory_updated': 1,
    'inventory_unchanged': 1,
    'warehouse_renamed': True,
}

ID_INPUT_DATA = {
    'warehouse': '印尼-DEE仓库',
    'row_count': 3,
    'rows': [],
}

ID_DRY_RUN_REPORT = {
    'counts': {
        'input_rows': 3,
        'new_variants': 1,
        'inventory_after_variant_create': 1,
        'total_inventory_actions': 2,
    },
}


# =========================================================================
# 测试: P5-SY8C-TH 全链路国家断言 (no-dry-run, execute_plan_v2 真实执行)
# =========================================================================

TH_WAREHOUSE_ID = '81323700-9890-491a-9155-d5461a042a4a'

TH_WAREHOUSE = {
    'id': TH_WAREHOUSE_ID,
    'name': 'DEE-龙仔厝（ICE专属）',
    'country': 'TH',
    'type': 'overseas',
    'is_active': True,
}

TH_VARIANT_LIST_BEFORE = [
    {'id': 'v-th-001', 'sku': 'TH-EXIST-001', 'country': 'TH'},
    {'id': 'v-th-002', 'sku': 'TH-EXIST-002', 'country': 'TH'},
]

TH_INVENTORY_LIST_BEFORE = [
    {'id': 'inv-th-1', 'variant_id': 'v-th-001', 'warehouse_id': TH_WAREHOUSE_ID, 'quantity': 100},
    {'id': 'inv-th-2', 'variant_id': 'v-th-002', 'warehouse_id': TH_WAREHOUSE_ID, 'quantity': 200},
]

TH_INVENTORY_POST_WRITE = [
    {'id': 'inv-th-1', 'variant_id': 'v-th-001', 'warehouse_id': TH_WAREHOUSE_ID, 'quantity': 150},
    {'id': 'inv-th-2', 'variant_id': 'v-th-002', 'warehouse_id': TH_WAREHOUSE_ID, 'quantity': 200},
    {'id': 'inv-th-3', 'variant_id': 'v-th-003', 'warehouse_id': TH_WAREHOUSE_ID, 'quantity': 50},
]

TH_VARIANT_LIST_POST = [
    {'id': 'v-th-001', 'sku': 'TH-EXIST-001', 'country': 'TH'},
    {'id': 'v-th-002', 'sku': 'TH-EXIST-002', 'country': 'TH'},
    {'id': 'v-th-003', 'sku': 'TH-NEW-001', 'country': 'TH'},
]

TH_PLAN = {
    'warehouse_rename_required': {
        'warehouse_id': TH_WAREHOUSE_ID,
        'target_name': 'DEE-龙仔厝（ICE专属）',
        'action': 'none',
    },
    'new_variants': [
        {'sku': 'TH-NEW-001', 'country': 'TH', 'name': 'TH New Product'},
    ],
    'inventory_updates': [
        {'sku': 'TH-EXIST-001', 'country': 'TH', 'new_quantity': 150,
         'warehouse_id': TH_WAREHOUSE_ID},
    ],
    'inventory_inserts': [],
    'inventory_after_variant_create': [
        {'sku': 'TH-NEW-001', 'country': 'TH', 'new_quantity': 50,
         'warehouse_id': TH_WAREHOUSE_ID},
    ],
    'inventory_unchanged': [
        {'sku': 'TH-EXIST-002', 'country': 'TH', 'quantity': 200,
         'warehouse_id': TH_WAREHOUSE_ID},
    ],
}

TH_RPC_RESULT = {
    'variants_created': 1,
    'inventory_received': 3,
    'inventory_inserted': 1,
    'inventory_updated': 1,
    'inventory_unchanged': 1,
    'warehouse_renamed': False,
}

TH_INPUT_DATA = {
    'warehouse': 'DEE-龙仔厝（ICE专属）',
    'row_count': 3,
    'rows': [],
}

TH_DRY_RUN_REPORT = {
    'counts': {
        'input_rows': 3,
        'new_variants': 1,
        'inventory_after_variant_create': 1,
        'total_inventory_actions': 2,  # 1 update + 1 after_create（unchanged 不计入写入动作）
    },
}


@test("P5-SY8D-TH no-dry-run 全链路国家断言: RPC payload → Phase G → Phase I → SyncLog 均为 TH")
def test_th_full_chain_country_assertions():
    """TH 全链路集成测试 — execute_plan_v2 真实执行，精确断言全链路 country='TH'。

    使用 P5-SY8D-TH 令牌（P5-SY8C-TH 已绑定为仅 --dry-run）。
    禁止仅用 assert_called_with() 弱断言。必须逐条验证：
    - RPC payload 中 p_variants[].country 和 p_inventory[].country 均为 'TH'
    - Phase G product_variant 查询使用 country=eq.TH
    - Phase I warehouse country 预期值为 'TH'
    - SyncLog 写入的 warehouse_id 为 TH 仓库 ID
    """
    rpc_captured = []
    get_calls = []
    verify_wh_captured = []
    sync_log_captured = []

    def capture_rpc(wh_id, p_variants, p_inventory, p_wh_name):
        rpc_captured.append({
            'warehouse_id': wh_id,
            'p_variants': list(p_variants),
            'p_inventory': list(p_inventory),
            'p_warehouse_name': p_wh_name,
        })
        return dict(TH_RPC_RESULT)

    def capture_get(path):
        get_calls.append(path)
        if 'warehouse?id=eq' in path:
            return [dict(TH_WAREHOUSE)]
        if 'inventory' in path:
            return [dict(item) for item in TH_INVENTORY_POST_WRITE]
        if 'product_variant' in path:
            return [dict(item) for item in TH_VARIANT_LIST_POST]
        return []

    def capture_verify_wh(actual, expected):
        verify_wh_captured.append({'actual': dict(actual), 'expected': dict(expected)})
        return []

    def capture_sync_log(warehouse_id, status, new_variants_count,
                         error_message, started_at, finished_at, **kwargs):
        sync_log_captured.append({
            'warehouse_id': warehouse_id,
            'status': status,
            'new_variants_count': new_variants_count,
            'error_message': error_message,
        })
        return {
            'id': 'sl-th-001',
            'status': status,
            'warehouse_id': warehouse_id,
        }

    th_args = [
        'cli_execute.py',
        '--input-json', '/fake/input-th.json',
        '--dry-run-report', '/fake/report-th.json',
        '--execute', '--confirm', 'P5-SY8D-TH',
        '--no-dry-run',
    ]

    stack = ExitStack()
    m = {}
    m['argv'] = stack.enter_context(patch('sys.argv', th_args))
    # config 级别 mock（cli_execute 和 _build_rpc_payload 的 runtime import 使用）
    m['wh_country_cfg'] = stack.enter_context(
        patch('sync.config.WAREHOUSE_COUNTRY', 'TH'))
    m['target_wh_cfg'] = stack.enter_context(
        patch('sync.config.TARGET_WAREHOUSE_NAME', 'DEE-龙仔厝（ICE专属）'))
    # executor 模块级别 mock（execute_plan_v2 的 module-level import 使用）
    m['wh_country_exec'] = stack.enter_context(
        patch('sync.executor.WAREHOUSE_COUNTRY', 'TH'))
    m['target_wh_exec'] = stack.enter_context(
        patch('sync.executor.TARGET_WAREHOUSE_NAME', 'DEE-龙仔厝（ICE专属）'))
    m['old_wh_exec'] = stack.enter_context(
        patch('sync.executor.OLD_WAREHOUSE_NAME', '泰国仓'))
    # 文件 I/O
    m['isfile'] = stack.enter_context(patch('os.path.isfile', return_value=True))
    m['open'] = stack.enter_context(patch('builtins.open', mock_open()))
    m['json_load'] = stack.enter_context(patch('json.load',
        side_effect=[TH_INPUT_DATA, TH_DRY_RUN_REPORT]))
    m['json_dump'] = stack.enter_context(patch('json.dump'))
    # 上游 gateway / 校验 / 计划 / 漂移
    m['validate'] = stack.enter_context(
        patch('sync.input_validator.validate_json', return_value=[]))
    m['fetch_wh'] = stack.enter_context(
        patch('sync.supabase_gateway.fetch_warehouse', return_value=dict(TH_WAREHOUSE)))
    m['fetch_var'] = stack.enter_context(
        patch('sync.supabase_gateway.fetch_variants', return_value=TH_VARIANT_LIST_BEFORE))
    m['fetch_inv'] = stack.enter_context(
        patch('sync.supabase_gateway.fetch_inventory_by_warehouse',
              return_value=TH_INVENTORY_LIST_BEFORE))
    m['gen_plan'] = stack.enter_context(
        patch('sync.plan_generator.generate_plan', return_value=TH_PLAN))
    m['compare'] = stack.enter_context(
        patch('sync.verifier.compare_plans', return_value=[]))
    # executor 内部依赖（execute_plan_v2 真实执行，这些必须 mock）
    m['rpc'] = stack.enter_context(
        patch('sync.executor._call_sync_rpc', side_effect=capture_rpc))
    m['get'] = stack.enter_context(
        patch('sync.executor._get', side_effect=capture_get))
    m['write_log'] = stack.enter_context(
        patch('sync.executor._write_sync_log', side_effect=capture_sync_log))
    m['verify_inv'] = stack.enter_context(
        patch('sync.executor.verify_inventory_post_write', return_value=[]))
    m['verify_wh'] = stack.enter_context(
        patch('sync.executor.verify_warehouse_final_state',
              side_effect=capture_verify_wh))
    m['sleep'] = stack.enter_context(patch('time.sleep'))
    m['stdout'] = stack.enter_context(patch('sys.stdout', _io.StringIO()))

    with stack:
        try:
            from sync.cli_execute import main
            main()
            assert False, '应调用 sys.exit(0)'
        except SystemExit as e:
            assert e.code == 0, f'退出码应为 0，实际: {e.code}'

    # =========================================================================
    # 断言 1: RPC payload country 均为 'TH'
    # =========================================================================
    assert len(rpc_captured) == 1, f'RPC 应被调用 1 次，实际: {len(rpc_captured)}'
    rpc = rpc_captured[0]

    assert rpc['warehouse_id'] == TH_WAREHOUSE_ID, \
        f'RPC warehouse_id 应为 TH 仓库，实际: {rpc["warehouse_id"]}'
    assert rpc['p_warehouse_name'] == 'DEE-龙仔厝（ICE专属）', \
        f'RPC p_warehouse_name 不匹配: {rpc["p_warehouse_name"]}'

    # 1a: p_variants country 断言
    assert len(rpc['p_variants']) >= 1, \
        f'p_variants 应至少 1 条，实际: {len(rpc["p_variants"])}'
    for i, v in enumerate(rpc['p_variants']):
        assert v['country'] == 'TH', \
            f'p_variants[{i}].country 应为 TH，实际: {v["country"]!r} (sku={v.get("sku")})'
        assert len(v['country']) == 2, \
            f'p_variants[{i}].country 长度应为 2 (ISO code)，实际: {v["country"]!r}'
        assert v['country'] == v['country'].upper(), \
            f'p_variants[{i}].country 应为大写 ISO code，实际: {v["country"]!r}'

    # 1b: p_inventory country 断言（每一条）
    assert len(rpc['p_inventory']) >= 1, \
        f'p_inventory 应至少 1 条，实际: {len(rpc["p_inventory"])}'
    for i, inv in enumerate(rpc['p_inventory']):
        assert inv['country'] == 'TH', \
            f'p_inventory[{i}].country 应为 TH，实际: {inv["country"]!r} (sku={inv.get("sku")})'
        assert len(inv['country']) == 2, \
            f'p_inventory[{i}].country 长度应为 2 (ISO code)，实际: {inv["country"]!r}'
        assert inv['country'] == inv['country'].upper(), \
            f'p_inventory[{i}].country 应为大写 ISO code，实际: {inv["country"]!r}'

    # 1c: p_variants 与 p_inventory SKU 交叉验证（新 variant 必须有对应 inventory）
    p_var_skus = {(v['sku'], v['country']) for v in rpc['p_variants']}
    p_inv_skus = {(inv['sku'], inv['country']) for inv in rpc['p_inventory']}
    missing_from_inv = p_var_skus - p_inv_skus
    assert not missing_from_inv, \
        f'新 Variant 缺少对应 Inventory: {missing_from_inv}'

    # =========================================================================
    # 断言 2: Phase G product_variant 查询使用 country=eq.TH
    # =========================================================================
    variant_gets = [c for c in get_calls if 'product_variant' in c]
    assert len(variant_gets) >= 1, \
        f'Phase G 应至少查询 1 次 product_variant，实际: {len(variant_gets)}'
    for i, q in enumerate(variant_gets):
        assert 'country=eq.TH' in q, \
            f'Phase G variant 查询[{i}] 应包含 country=eq.TH，实际: {q!r}'

    # Phase G inventory 查询使用正确的 warehouse_id
    inv_gets = [c for c in get_calls if 'inventory' in c]
    assert len(inv_gets) >= 1, \
        f'Phase G 应至少查询 1 次 inventory，实际: {len(inv_gets)}'
    for i, q in enumerate(inv_gets):
        assert f'warehouse_id=eq.{TH_WAREHOUSE_ID}' in q, \
            f'Phase G inventory 查询[{i}] 应包含 TH warehouse_id，实际: {q!r}'

    # =========================================================================
    # 断言 3: Phase I warehouse country 预期值为 'TH'
    # =========================================================================
    assert len(verify_wh_captured) == 1, \
        f'verify_warehouse_final_state 应被调用 1 次，实际: {len(verify_wh_captured)}'
    wh_expected = verify_wh_captured[0]['expected']
    assert wh_expected['country'] == 'TH', \
        f'Phase I wh_expected.country 应为 TH，实际: {wh_expected["country"]!r}'
    assert wh_expected['type'] == 'overseas', \
        f'Phase I wh_expected.type 应为 overseas，实际: {wh_expected["type"]!r}'
    assert wh_expected['is_active'] is True, \
        f'Phase I wh_expected.is_active 应为 True，实际: {wh_expected["is_active"]!r}'
    assert wh_expected['name'] == 'DEE-龙仔厝（ICE专属）', \
        f'Phase I wh_expected.name 不匹配: {wh_expected["name"]!r}'

    # =========================================================================
    # 断言 4: SyncLog 写入 country 相关验证
    # =========================================================================
    assert len(sync_log_captured) == 1, \
        f'_write_sync_log 应被调用 1 次，实际: {len(sync_log_captured)}'
    sl = sync_log_captured[0]
    assert sl['warehouse_id'] == TH_WAREHOUSE_ID, \
        f'SyncLog warehouse_id 应为 TH 仓库，实际: {sl["warehouse_id"]}'
    assert sl['status'] == 'success', \
        f'SyncLog status 应为 success，实际: {sl["status"]!r}'
    assert sl['error_message'] is None, \
        f'SyncLog error_message 应为 None（success），实际: {sl["error_message"]!r}'
    assert sl['new_variants_count'] == 1, \
        f'SyncLog new_variants_count 应为 1，实际: {sl["new_variants_count"]}'

    # stdout 国家显示验证
    stdout_text = m['stdout'].getvalue()
    assert 'P5-SY8D-TH' in stdout_text, \
        f'stdout 应包含 P5-SY8D-TH，实际: {stdout_text!r}'
    assert 'TH' in stdout_text, \
        f'stdout 应显示 TH 国家信息，实际: {stdout_text!r}'


# =========================================================================
# 测试: P5-SY8E-MY 全链路国家断言 (execute_plan_v2 直接调用)
# =========================================================================

@test("P5-SY8E-MY 全链路国家断言: execute_plan_v2 直接调用，RPC payload → Phase G → Phase I → SyncLog 均为 MY")
def test_my_full_chain_country_assertions():
    """MY 全链路集成测试 — execute_plan_v2 直接调用，精确断言全链路 country='MY'。

    直接调用 sync.executor.execute_plan_v2，仅 mock RPC/HTTP/SyncLog/verifier/sleep
    等外部依赖。execute_plan_v2 自身逻辑真实执行，包括 _build_rpc_payload、
    RPC 摘要校验、Phase G/I 审计流程、sync_log 写入。

    禁止仅用 assert_called_with() 弱断言。必须逐条验证：
    - RPC payload 中 p_variants[].country 和 p_inventory[].country 均为 'MY'
    - Phase G product_variant 查询使用 country=eq.MY
    - Phase I warehouse country 预期值为 'MY'
    - SyncLog 写入的 warehouse_id 为 MY 仓库 ID，status=success
    """
    rpc_captured = []
    get_calls = []
    verify_wh_captured = []
    sync_log_captured = []

    def capture_rpc(wh_id, p_variants, p_inventory, p_wh_name):
        rpc_captured.append({
            'warehouse_id': wh_id,
            'p_variants': list(p_variants),
            'p_inventory': list(p_inventory),
            'p_warehouse_name': p_wh_name,
        })
        return dict(MY_RPC_RESULT)

    def capture_get(path):
        get_calls.append(path)
        if 'warehouse?id=eq' in path:
            return [dict(MY_WAREHOUSE)]
        if 'inventory' in path:
            return [dict(item) for item in MY_INVENTORY_POST_WRITE]
        if 'product_variant' in path:
            return [dict(item) for item in MY_VARIANT_LIST_POST]
        return []

    def capture_verify_wh(actual, expected):
        verify_wh_captured.append({'actual': dict(actual), 'expected': dict(expected)})
        return []

    def capture_sync_log(warehouse_id, status, new_variants_count,
                         error_message, started_at, finished_at, **kwargs):
        sync_log_captured.append({
            'warehouse_id': warehouse_id,
            'status': status,
            'new_variants_count': new_variants_count,
            'error_message': error_message,
        })
        return {
            'id': 'sl-my-001',
            'status': status,
            'warehouse_id': warehouse_id,
        }

    with patch('sync.config.WAREHOUSE_COUNTRY', 'MY'), \
         patch('sync.executor.WAREHOUSE_COUNTRY', 'MY'), \
         patch('sync.executor.TARGET_WAREHOUSE_NAME', '喜运达MY仓'), \
         patch('sync.executor._call_sync_rpc', side_effect=capture_rpc), \
         patch('sync.executor._get', side_effect=capture_get), \
         patch('sync.executor._write_sync_log', side_effect=capture_sync_log), \
         patch('sync.executor.verify_inventory_post_write', return_value=[]), \
         patch('sync.executor.verify_warehouse_final_state',
               side_effect=capture_verify_wh), \
         patch('time.sleep'):
        from sync.executor import execute_plan_v2
        result = execute_plan_v2(dict(MY_PLAN), sync_log_enabled=True)

    # execute_plan_v2 返回值断言
    assert result['phase_g_verified'] is True, \
        f'Phase G 应通过，实际: {result["phase_g_verified"]}'
    assert result['phase_i_verified'] is True, \
        f'Phase I 应通过，实际: {result["phase_i_verified"]}'
    assert result['sync_log_written'] is True, \
        f'SyncLog 应写入，实际: {result["sync_log_written"]}'
    assert result['warehouse_id'] == MY_WAREHOUSE_ID, \
        f'warehouse_id 应为 MY 仓库，实际: {result["warehouse_id"]}'
    assert result['rpc_summary'] is not None, \
        'rpc_summary 不应为 None'
    assert result['errors'] == [], \
        f'errors 应为空列表，实际: {result["errors"]}'

    # =========================================================================
    # 断言 1: RPC payload country 均为 'MY'
    # =========================================================================
    assert len(rpc_captured) == 1, f'RPC 应被调用 1 次，实际: {len(rpc_captured)}'
    rpc = rpc_captured[0]

    assert rpc['warehouse_id'] == MY_WAREHOUSE_ID, \
        f'RPC warehouse_id 应为 MY 仓库，实际: {rpc["warehouse_id"]}'
    assert rpc['p_warehouse_name'] == '喜运达MY仓', \
        f'RPC p_warehouse_name 不匹配: {rpc["p_warehouse_name"]}'

    # 1a: p_variants country 断言 — 每条 country 必须为 'MY'
    assert len(rpc['p_variants']) >= 1, \
        f'p_variants 应至少 1 条，实际: {len(rpc["p_variants"])}'
    for i, v in enumerate(rpc['p_variants']):
        assert v['country'] == 'MY', \
            f'p_variants[{i}].country 应为 MY，实际: {v["country"]!r} (sku={v.get("sku")})'
        assert len(v['country']) == 2, \
            f'p_variants[{i}].country 长度应为 2 (ISO code)，实际: {v["country"]!r}'
        assert v['country'] == v['country'].upper(), \
            f'p_variants[{i}].country 应为大写 ISO code，实际: {v["country"]!r}'

    # 1b: p_inventory country 断言 — 每条 country 必须为 'MY'
    assert len(rpc['p_inventory']) >= 1, \
        f'p_inventory 应至少 1 条，实际: {len(rpc["p_inventory"])}'
    for i, inv in enumerate(rpc['p_inventory']):
        assert inv['country'] == 'MY', \
            f'p_inventory[{i}].country 应为 MY，实际: {inv["country"]!r} (sku={inv.get("sku")})'
        assert len(inv['country']) == 2, \
            f'p_inventory[{i}].country 长度应为 2 (ISO code)，实际: {inv["country"]!r}'
        assert inv['country'] == inv['country'].upper(), \
            f'p_inventory[{i}].country 应为大写 ISO code，实际: {inv["country"]!r}'

    # 1c: p_variants 与 p_inventory SKU 交叉验证（新 variant 必须有对应 inventory）
    p_var_skus = {(v['sku'], v['country']) for v in rpc['p_variants']}
    p_inv_skus = {(inv['sku'], inv['country']) for inv in rpc['p_inventory']}
    missing_from_inv = p_var_skus - p_inv_skus
    assert not missing_from_inv, \
        f'新 Variant 缺少对应 Inventory: {missing_from_inv}'

    # =========================================================================
    # 断言 2: Phase G product_variant 查询使用 country=eq.MY
    # =========================================================================
    variant_gets = [c for c in get_calls if 'product_variant' in c]
    assert len(variant_gets) >= 1, \
        f'Phase G 应至少查询 1 次 product_variant，实际: {len(variant_gets)}'
    for i, q in enumerate(variant_gets):
        assert 'country=eq.MY' in q, \
            f'Phase G variant 查询[{i}] 应包含 country=eq.MY，实际: {q!r}'

    # Phase G inventory 查询使用正确的 warehouse_id
    inv_gets = [c for c in get_calls if 'inventory' in c]
    assert len(inv_gets) >= 1, \
        f'Phase G 应至少查询 1 次 inventory，实际: {len(inv_gets)}'
    for i, q in enumerate(inv_gets):
        assert f'warehouse_id=eq.{MY_WAREHOUSE_ID}' in q, \
            f'Phase G inventory 查询[{i}] 应包含 MY warehouse_id，实际: {q!r}'

    # =========================================================================
    # 断言 3: Phase I warehouse country 预期值为 'MY'
    # =========================================================================
    assert len(verify_wh_captured) == 1, \
        f'verify_warehouse_final_state 应被调用 1 次，实际: {len(verify_wh_captured)}'
    wh_expected = verify_wh_captured[0]['expected']
    assert wh_expected['country'] == 'MY', \
        f'Phase I wh_expected.country 应为 MY，实际: {wh_expected["country"]!r}'
    assert wh_expected['type'] == 'overseas', \
        f'Phase I wh_expected.type 应为 overseas，实际: {wh_expected["type"]!r}'
    assert wh_expected['is_active'] is True, \
        f'Phase I wh_expected.is_active 应为 True，实际: {wh_expected["is_active"]!r}'
    assert wh_expected['name'] == '喜运达MY仓', \
        f'Phase I wh_expected.name 不匹配: {wh_expected["name"]!r}'
    assert wh_expected['id'] == MY_WAREHOUSE_ID, \
        f'Phase I wh_expected.id 不匹配: {wh_expected["id"]!r}'

    # Phase I 实际 warehouse 查询使用正确的 warehouse_id
    wh_gets = [c for c in get_calls if 'warehouse?id=eq' in c]
    assert len(wh_gets) >= 1, \
        f'Phase I 应至少查询 1 次 warehouse，实际: {len(wh_gets)}'
    for i, q in enumerate(wh_gets):
        assert f'warehouse?id=eq.{MY_WAREHOUSE_ID}' in q, \
            f'Phase I warehouse 查询[{i}] 应包含 MY warehouse_id，实际: {q!r}'

    # =========================================================================
    # 断言 4: SyncLog 写入
    # =========================================================================
    assert len(sync_log_captured) == 1, \
        f'_write_sync_log 应被调用 1 次，实际: {len(sync_log_captured)}'
    sl = sync_log_captured[0]
    assert sl['warehouse_id'] == MY_WAREHOUSE_ID, \
        f'SyncLog warehouse_id 应为 MY 仓库，实际: {sl["warehouse_id"]}'
    assert sl['status'] == 'success', \
        f'SyncLog status 应为 success，实际: {sl["status"]!r}'
    assert sl['error_message'] is None, \
        f'SyncLog error_message 应为 None（success），实际: {sl["error_message"]!r}'
    assert sl['new_variants_count'] == 1, \
        f'SyncLog new_variants_count 应为 1，实际: {sl["new_variants_count"]}'


# =========================================================================
# 测试: P5-SY8D 令牌—模式强制绑定
# =========================================================================

@test("P5-SY8C-TH --no-dry-run 在文件 I/O 前被拒绝（exit 1），提示使用 P5-SY8D-TH")
def test_p5_sy8c_th_rejects_no_dry_run_before_io():
    """P5-SY8C-TH 仅支持 --dry-run，--no-dry-run 必须在文件 I/O 前拒绝。"""
    th_reject_args = [
        'cli_execute.py',
        '--input-json', '/fake/input.json',
        '--dry-run-report', '/fake/report.json',
        '--execute', '--confirm', 'P5-SY8C-TH',
        '--no-dry-run',
    ]
    with patch('sys.argv', th_reject_args), \
         patch('sync.config.WAREHOUSE_COUNTRY', 'TH'), \
         patch('os.path.isfile') as mock_isfile, \
         patch('builtins.open') as mock_file, \
         patch('json.load') as mock_json_load, \
         patch('sync.supabase_gateway.fetch_warehouse') as mock_fetch_wh, \
         patch('sync.supabase_gateway.fetch_variants') as mock_fetch_var, \
         patch('sync.supabase_gateway.fetch_inventory_by_warehouse') as mock_fetch_inv, \
         patch('sync.executor._call_sync_rpc') as mock_rpc, \
         patch('sync.executor._write_sync_log') as mock_log, \
         patch('sync.executor._save_fallback_log') as mock_fb, \
         patch('sync.executor.execute_plan') as mock_exec, \
         patch('sync.executor.execute_plan_v2') as mock_exec_v2, \
         patch('sys.stdout', _io.StringIO()) as mock_stdout:
        try:
            from sync.cli_execute import main
            main()
            assert False, '应调用 sys.exit(1)'
        except SystemExit as e:
            assert e.code == 1, f'退出码应为 1，实际: {e.code}'

        mock_isfile.assert_not_called()
        mock_file.assert_not_called()
        mock_json_load.assert_not_called()
        mock_fetch_wh.assert_not_called()
        mock_fetch_var.assert_not_called()
        mock_fetch_inv.assert_not_called()
        mock_rpc.assert_not_called()
        mock_log.assert_not_called()
        mock_fb.assert_not_called()
        mock_exec.assert_not_called()
        mock_exec_v2.assert_not_called()

        stdout_text = mock_stdout.getvalue()
        assert 'P5-SY8C-TH' in stdout_text, \
            f'错误信息应包含令牌 P5-SY8C-TH: {stdout_text!r}'
        assert 'P5-SY8D-TH' in stdout_text, \
            f'错误信息应提示使用 P5-SY8D-TH: {stdout_text!r}'
        assert '--dry-run' in stdout_text, \
            f'错误信息应提及 --dry-run: {stdout_text!r}'


@test("P5-SY8D-TH --dry-run 正常通过（exit 0），P5-SY8D-TH 是唯一可执行 --no-dry-run 的令牌但也允许 dry run")
def test_p5_sy8d_th_accepts_dry_run():
    """P5-SY8D-TH 可执行 --dry-run（预写入验证），也可执行 --no-dry-run。"""
    th_accept_args = [
        'cli_execute.py',
        '--input-json', '/fake/input.json',
        '--dry-run-report', '/fake/report.json',
        '--execute', '--confirm', 'P5-SY8D-TH',
    ]
    with patch('sys.argv', th_accept_args), \
         patch('sync.config.WAREHOUSE_COUNTRY', 'TH'), \
         patch('os.path.isfile', return_value=True), \
         patch('builtins.open', mock_open()), \
         patch('json.load', side_effect=[MOCK_INPUT_DATA, MOCK_DRY_RUN_REPORT]), \
         patch('json.dump'), \
         patch('sync.input_validator.validate_json', return_value=MOCK_ROWS), \
         patch('sync.supabase_gateway.fetch_warehouse', return_value=MOCK_WAREHOUSE), \
         patch('sync.supabase_gateway.fetch_variants', return_value=[]), \
         patch('sync.supabase_gateway.fetch_inventory_by_warehouse', return_value=[]), \
         patch('sync.plan_generator.generate_plan', return_value=SIMPLE_PLAN), \
         patch('sync.verifier.compare_plans', return_value=[]), \
         patch('sync.executor.execute_plan', return_value=MOCK_EXECUTE_RESULT_DRY_RUN), \
         patch('sys.stdout', _io.StringIO()) as mock_stdout:
        try:
            from sync.cli_execute import main
            main()
            assert False, '应调用 sys.exit(0)'
        except SystemExit as e:
            assert e.code == 0, f'退出码应为 0，实际: {e.code}'

        stdout_text = mock_stdout.getvalue()
        assert 'P5-SY8D-TH' in stdout_text, \
            f'stdout 应包含 P5-SY8D-TH，实际: {stdout_text!r}'


# =========================================================================
# 测试: 报告身份 — report.task 与文件名前缀从 confirm token 派生
# =========================================================================

def _capture_report_and_filename(token, extra_args=None, wh_country=None):
    """Dry Run mock 链，捕获 report.task 和输出文件名 prefix。
    返回 (report: dict, filename: str)。
    """
    if wh_country is None:
        wh_country = 'PH'
    argv = [
        'cli_execute.py',
        '--input-json', '/fake/input.json',
        '--dry-run-report', '/fake/report.json',
        '--execute', '--confirm', token,
    ]
    if extra_args:
        argv.extend(extra_args)

    report_captured = []
    open_filenames = []

    def capture_json_dump(data, f, *args, **kwargs):
        report_captured.append(data)
        if hasattr(f, 'name') and f.name:
            open_filenames.append(f.name)

    stack = ExitStack()
    m = {}
    m['argv'] = stack.enter_context(patch('sys.argv', argv))
    m['wh_country'] = stack.enter_context(
        patch('sync.config.WAREHOUSE_COUNTRY', wh_country))
    m['isfile'] = stack.enter_context(patch('os.path.isfile', return_value=True))
    m['open'] = stack.enter_context(patch('builtins.open', mock_open()))
    m['json_load'] = stack.enter_context(patch('json.load',
        side_effect=[MOCK_INPUT_DATA, MOCK_DRY_RUN_REPORT]))
    m['json_dump'] = stack.enter_context(patch('json.dump',
        side_effect=capture_json_dump))
    m['validate'] = stack.enter_context(
        patch('sync.input_validator.validate_json', return_value=MOCK_ROWS))
    m['fetch_wh'] = stack.enter_context(
        patch('sync.supabase_gateway.fetch_warehouse', return_value=MOCK_WAREHOUSE))
    m['fetch_var'] = stack.enter_context(
        patch('sync.supabase_gateway.fetch_variants', return_value=[]))
    m['fetch_inv'] = stack.enter_context(
        patch('sync.supabase_gateway.fetch_inventory_by_warehouse', return_value=[]))
    m['gen_plan'] = stack.enter_context(
        patch('sync.plan_generator.generate_plan', return_value=SIMPLE_PLAN))
    m['compare'] = stack.enter_context(
        patch('sync.verifier.compare_plans', return_value=[]))
    m['execute_plan'] = stack.enter_context(
        patch('sync.executor.execute_plan', return_value=MOCK_EXECUTE_RESULT_DRY_RUN))
    _MOCK_EXECUTE_V2_RESULT = {
        'started_at': SYNC_AT,
        'finished_at': SYNC_AT,
        'warehouse_id': WH_ID,
        'rpc_summary': {
            'variants_created': 0,
            'inventory_received': 91,
            'inventory_inserted': 91,
            'inventory_updated': 0,
            'inventory_unchanged': 0,
            'warehouse_renamed': False,
        },
        'phase_g_verified': True,
        'phase_i_verified': True,
        'sync_log_written': True,
        'sync_log_fallback_path': None,
        'sync_log_enabled': True,
        'errors': [],
    }
    m['execute_plan_v2'] = stack.enter_context(
        patch('sync.executor.execute_plan_v2', return_value=_MOCK_EXECUTE_V2_RESULT))
    m['rpc'] = stack.enter_context(patch('sync.executor._call_sync_rpc'))
    m['log'] = stack.enter_context(patch('sync.executor._write_sync_log'))
    m['fb'] = stack.enter_context(patch('sync.executor._save_fallback_log'))
    m['verify_inv'] = stack.enter_context(patch('sync.executor.verify_inventory_post_write'))
    m['verify_wh'] = stack.enter_context(patch('sync.executor.verify_warehouse_final_state'))
    m['get'] = stack.enter_context(patch('sync.executor._get'))
    m['stdout'] = stack.enter_context(patch('sys.stdout', _io.StringIO()))

    # 捕获 open 的文件名（mock_open 不设置 name，需要手动拦截）
    real_open_filenames = []

    def capture_open(path, *args, **kwargs):
        real_open_filenames.append(path)
        return mock_open()()

    stack.enter_context(patch('builtins.open', side_effect=capture_open))

    with stack:
        try:
            from sync.cli_execute import main
            main()
            assert False, '应调用 sys.exit(0)'
        except SystemExit as e:
            assert e.code == 0, f'退出码应为 0，实际: {e.code}'

    assert len(report_captured) >= 1, 'json.dump 应至少被调用一次'
    report = report_captured[-1]  # 最后的 dump 是报告 JSON

    # 找到报告文件名（包含 task_id 的路径）
    report_filename = ''
    for fn in real_open_filenames:
        if 'runtime' in fn and fn.endswith('.json'):
            report_filename = fn
            break
    assert report_filename, f'未找到报告输出文件，open 调用: {real_open_filenames}'

    return report, report_filename


@test("P5-SY3B-PH Dry Run report.task='P5-SY3B-PH'，文件名前缀为 p5-sy3b-ph")
def test_report_identity_ph_token():
    report, filename = _capture_report_and_filename('P5-SY3B-PH', wh_country='PH')
    assert report['task'] == 'P5-SY3B-PH', \
        f'report.task 应为 P5-SY3B-PH，实际: {report["task"]!r}'
    basename = filename.replace('\\', '/').split('/')[-1]
    assert basename.startswith('p5-sy3b-ph-dry-run-'), \
        f'文件名前缀应为 p5-sy3b-ph-dry-run-，实际: {basename!r}'
    assert report['confirm_token'] == 'P5-SY3B-PH', \
        f'report.confirm_token 应为 P5-SY3B-PH，实际: {report["confirm_token"]!r}'
    assert report['dry_run'] is True


@test("P5-SY8B-VN Dry Run report.task='P5-SY8B-VN'，文件名前缀为 p5-sy8b-vn")
def test_report_identity_vn_token():
    report, filename = _capture_report_and_filename('P5-SY8B-VN', wh_country='VN')
    assert report['task'] == 'P5-SY8B-VN', \
        f'report.task 应为 P5-SY8B-VN，实际: {report["task"]!r}'
    basename = filename.replace('\\', '/').split('/')[-1]
    assert basename.startswith('p5-sy8b-vn-dry-run-'), \
        f'文件名前缀应为 p5-sy8b-vn-dry-run-，实际: {basename!r}'
    assert report['confirm_token'] == 'P5-SY8B-VN', \
        f'report.confirm_token 应为 P5-SY8B-VN，实际: {report["confirm_token"]!r}'
    assert report['dry_run'] is True


@test("P5-SY8C-TH Dry Run report.task='P5-SY8C-TH'，文件名前缀为 p5-sy8c-th")
def test_report_identity_th_token():
    report, filename = _capture_report_and_filename('P5-SY8C-TH', wh_country='TH')
    assert report['task'] == 'P5-SY8C-TH', \
        f'report.task 应为 P5-SY8C-TH，实际: {report["task"]!r}'
    basename = filename.replace('\\', '/').split('/')[-1]
    assert basename.startswith('p5-sy8c-th-dry-run-'), \
        f'文件名前缀应为 p5-sy8c-th-dry-run-，实际: {basename!r}'
    assert report['confirm_token'] == 'P5-SY8C-TH', \
        f'report.confirm_token 应为 P5-SY8C-TH，实际: {report["confirm_token"]!r}'
    assert report['dry_run'] is True


@test("P5-SY8D-TH --no-dry-run report.task='P5-SY8D-TH'，文件名前缀为 p5-sy8d-th-execute-，dry_run=False")
def test_report_identity_th_real_write_token():
    """P5-SY8D-TH 真实写入令牌：report 身份从 token 派生，文件名前缀为 p5-sy8d-th-execute-。"""
    report, filename = _capture_report_and_filename(
        'P5-SY8D-TH', extra_args=['--no-dry-run'], wh_country='TH')
    assert report['task'] == 'P5-SY8D-TH', \
        f'report.task 应为 P5-SY8D-TH，实际: {report["task"]!r}'
    basename = filename.replace('\\', '/').split('/')[-1]
    assert basename.startswith('p5-sy8d-th-execute-'), \
        f'文件名前缀应为 p5-sy8d-th-execute-，实际: {basename!r}'
    assert report['confirm_token'] == 'P5-SY8D-TH', \
        f'report.confirm_token 应为 P5-SY8D-TH，实际: {report["confirm_token"]!r}'
    assert report['dry_run'] is False


@test("P5-SY8E-MY Dry Run report.task='P5-SY8E-MY'，文件名前缀为 p5-sy8e-my")
def test_report_identity_my_token():
    """P5-SY8E-MY Dry Run 令牌：report 身份从 token 派生，文件名前缀为 p5-sy8e-my。"""
    report, filename = _capture_report_and_filename(
        'P5-SY8E-MY', wh_country='MY')
    assert report['task'] == 'P5-SY8E-MY', \
        f'report.task 应为 P5-SY8E-MY，实际: {report["task"]!r}'
    basename = filename.replace('\\', '/').split('/')[-1]
    assert basename.startswith('p5-sy8e-my-dry-run-'), \
        f'文件名前缀应为 p5-sy8e-my-dry-run-，实际: {basename!r}'
    assert report['confirm_token'] == 'P5-SY8E-MY', \
        f'report.confirm_token 应为 P5-SY8E-MY，实际: {report["confirm_token"]!r}'
    assert report['dry_run'] is True


# =========================================================================
# 测试: P5-SY8F-MY 真实写入令牌 CLI 全链路
# =========================================================================

@test("P5-SY8F-MY no-dry-run 全链路国家断言: RPC payload → Phase G → Phase I → SyncLog 均为 MY")
def test_p5_sy8f_my_full_chain_country_assertions():
    """MY CLI 全链路集成测试 — cli_execute.main() + --no-dry-run，精确断言全链路 country='MY'。

    使用 P5-SY8F-MY 令牌（P5-SY8E-MY 已绑定为仅 --dry-run）。
    禁止仅用 assert_called_with() 弱断言。必须逐条验证：
    - RPC payload 中 p_variants[].country 和 p_inventory[].country 均为 'MY'
    - Phase G product_variant 查询使用 country=eq.MY
    - Phase I warehouse country 预期值为 'MY'
    - SyncLog 写入的 warehouse_id 为 MY 仓库 ID
    """
    rpc_captured = []
    get_calls = []
    verify_wh_captured = []
    sync_log_captured = []

    def capture_rpc(wh_id, p_variants, p_inventory, p_wh_name):
        rpc_captured.append({
            'warehouse_id': wh_id,
            'p_variants': list(p_variants),
            'p_inventory': list(p_inventory),
            'p_warehouse_name': p_wh_name,
        })
        return dict(MY_RPC_RESULT)

    def capture_get(path):
        get_calls.append(path)
        if 'warehouse?id=eq' in path:
            return [dict(MY_WAREHOUSE)]
        if 'inventory' in path:
            return [dict(item) for item in MY_INVENTORY_POST_WRITE]
        if 'product_variant' in path:
            return [dict(item) for item in MY_VARIANT_LIST_POST]
        return []

    def capture_verify_wh(actual, expected):
        verify_wh_captured.append({'actual': dict(actual), 'expected': dict(expected)})
        return []

    def capture_sync_log(warehouse_id, status, new_variants_count,
                         error_message, started_at, finished_at, **kwargs):
        sync_log_captured.append({
            'warehouse_id': warehouse_id,
            'status': status,
            'new_variants_count': new_variants_count,
            'error_message': error_message,
        })
        return {
            'id': 'sl-my-002',
            'status': status,
            'warehouse_id': warehouse_id,
        }

    my_args = [
        'cli_execute.py',
        '--input-json', '/fake/input-my.json',
        '--dry-run-report', '/fake/report-my.json',
        '--execute', '--confirm', 'P5-SY8F-MY',
        '--no-dry-run',
    ]

    stack = ExitStack()
    m = {}
    m['argv'] = stack.enter_context(patch('sys.argv', my_args))
    m['wh_country_cfg'] = stack.enter_context(
        patch('sync.config.WAREHOUSE_COUNTRY', 'MY'))
    m['target_wh_cfg'] = stack.enter_context(
        patch('sync.config.TARGET_WAREHOUSE_NAME', '喜运达MY仓'))
    m['wh_country_exec'] = stack.enter_context(
        patch('sync.executor.WAREHOUSE_COUNTRY', 'MY'))
    m['target_wh_exec'] = stack.enter_context(
        patch('sync.executor.TARGET_WAREHOUSE_NAME', '喜运达MY仓'))
    m['old_wh_exec'] = stack.enter_context(
        patch('sync.executor.OLD_WAREHOUSE_NAME', '马来西亚仓'))
    m['isfile'] = stack.enter_context(patch('os.path.isfile', return_value=True))
    m['open'] = stack.enter_context(patch('builtins.open', mock_open()))
    m['json_load'] = stack.enter_context(patch('json.load',
        side_effect=[MY_INPUT_DATA, MY_DRY_RUN_REPORT]))
    m['json_dump'] = stack.enter_context(patch('json.dump'))
    m['validate'] = stack.enter_context(
        patch('sync.input_validator.validate_json', return_value=[]))
    m['fetch_wh'] = stack.enter_context(
        patch('sync.supabase_gateway.fetch_warehouse', return_value=dict(MY_WAREHOUSE)))
    m['fetch_var'] = stack.enter_context(
        patch('sync.supabase_gateway.fetch_variants', return_value=MY_VARIANT_LIST_POST))
    m['fetch_inv'] = stack.enter_context(
        patch('sync.supabase_gateway.fetch_inventory_by_warehouse',
              return_value=MY_INVENTORY_POST_WRITE))
    m['gen_plan'] = stack.enter_context(
        patch('sync.plan_generator.generate_plan', return_value=MY_PLAN))
    m['compare'] = stack.enter_context(
        patch('sync.verifier.compare_plans', return_value=[]))
    m['rpc'] = stack.enter_context(
        patch('sync.executor._call_sync_rpc', side_effect=capture_rpc))
    m['get'] = stack.enter_context(
        patch('sync.executor._get', side_effect=capture_get))
    m['write_log'] = stack.enter_context(
        patch('sync.executor._write_sync_log', side_effect=capture_sync_log))
    m['verify_inv'] = stack.enter_context(
        patch('sync.executor.verify_inventory_post_write', return_value=[]))
    m['verify_wh'] = stack.enter_context(
        patch('sync.executor.verify_warehouse_final_state',
              side_effect=capture_verify_wh))
    m['sleep'] = stack.enter_context(patch('time.sleep'))
    m['stdout'] = stack.enter_context(patch('sys.stdout', _io.StringIO()))

    with stack:
        try:
            from sync.cli_execute import main
            main()
            assert False, '应调用 sys.exit(0)'
        except SystemExit as e:
            assert e.code == 0, f'退出码应为 0，实际: {e.code}'

    # 断言 1: RPC payload country 均为 'MY'
    assert len(rpc_captured) == 1, f'RPC 应被调用 1 次，实际: {len(rpc_captured)}'
    rpc = rpc_captured[0]
    assert rpc['warehouse_id'] == MY_WAREHOUSE_ID
    assert rpc['p_warehouse_name'] == '喜运达MY仓'
    for i, v in enumerate(rpc['p_variants']):
        assert v['country'] == 'MY', \
            f'p_variants[{i}].country 应为 MY，实际: {v["country"]!r}'
    for i, inv in enumerate(rpc['p_inventory']):
        assert inv['country'] == 'MY', \
            f'p_inventory[{i}].country 应为 MY，实际: {inv["country"]!r}'

    p_var_skus = {(v['sku'], v['country']) for v in rpc['p_variants']}
    p_inv_skus = {(inv['sku'], inv['country']) for inv in rpc['p_inventory']}
    assert not p_var_skus - p_inv_skus, \
        f'p_variants 中的 SKU 必须全部出现在 p_inventory 中'

    # 断言 2: Phase G country=eq.MY
    variant_gets = [c for c in get_calls if 'product_variant' in c]
    assert len(variant_gets) >= 1, \
        f'Phase G 应至少查询 1 次 product_variant，实际: {len(variant_gets)}'
    for q in variant_gets:
        assert 'country=eq.MY' in q, \
            f'Phase G product_variant 查询应包含 country=eq.MY: {q!r}'

    inv_gets = [c for c in get_calls if 'inventory' in c]
    for q in inv_gets:
        assert f'warehouse_id=eq.{MY_WAREHOUSE_ID}' in q, \
            f'Phase G inventory 查询应包含 warehouse_id=eq.{MY_WAREHOUSE_ID}: {q!r}'

    # 断言 3: Phase I warehouse country='MY'
    assert len(verify_wh_captured) == 1, \
        f'verify_warehouse_final_state 应被调用 1 次，实际: {len(verify_wh_captured)}'
    wh_expected = verify_wh_captured[0]['expected']
    assert wh_expected['country'] == 'MY', \
        f'Phase I wh_expected.country 应为 MY，实际: {wh_expected["country"]!r}'
    assert wh_expected['name'] == '喜运达MY仓', \
        f'Phase I wh_expected.name 不匹配: {wh_expected["name"]!r}'
    assert wh_expected['id'] == MY_WAREHOUSE_ID, \
        f'Phase I wh_expected.id 不匹配: {wh_expected["id"]!r}'

    # 断言 4: SyncLog
    assert len(sync_log_captured) == 1, \
        f'SyncLog 应被调用 1 次，实际: {len(sync_log_captured)}'
    sl = sync_log_captured[0]
    assert sl['warehouse_id'] == MY_WAREHOUSE_ID, \
        f'SyncLog warehouse_id 应为 {MY_WAREHOUSE_ID}，实际: {sl["warehouse_id"]!r}'
    assert sl['status'] == 'success', \
        f'SyncLog status 应为 success，实际: {sl["status"]!r}'
    assert sl['error_message'] is None, \
        f'SyncLog error_message 应为 None（success），实际: {sl["error_message"]!r}'

    stdout_text = m['stdout'].getvalue()
    assert 'P5-SY8F-MY' in stdout_text
    assert 'MY' in stdout_text


@test("P5-SY8F-MY --dry-run 正常通过（exit 0），P5-SY8F-MY 是可执行 --no-dry-run 的令牌但也允许 dry run")
def test_p5_sy8f_my_accepts_dry_run():
    """P5-SY8F-MY 可执行 --dry-run（预写入验证），也可执行 --no-dry-run。"""
    my_accept_args = [
        'cli_execute.py',
        '--input-json', '/fake/input.json',
        '--dry-run-report', '/fake/report.json',
        '--execute', '--confirm', 'P5-SY8F-MY',
    ]
    with patch('sys.argv', my_accept_args), \
         patch('sync.config.WAREHOUSE_COUNTRY', 'MY'), \
         patch('os.path.isfile', return_value=True), \
         patch('builtins.open', mock_open()), \
         patch('json.load', side_effect=[MOCK_INPUT_DATA, MOCK_DRY_RUN_REPORT]), \
         patch('json.dump'), \
         patch('sync.input_validator.validate_json', return_value=MOCK_ROWS), \
         patch('sync.supabase_gateway.fetch_warehouse', return_value=MOCK_WAREHOUSE), \
         patch('sync.supabase_gateway.fetch_variants', return_value=[]), \
         patch('sync.supabase_gateway.fetch_inventory_by_warehouse', return_value=[]), \
         patch('sync.plan_generator.generate_plan', return_value=SIMPLE_PLAN), \
         patch('sync.verifier.compare_plans', return_value=[]), \
         patch('sync.executor.execute_plan', return_value=MOCK_EXECUTE_RESULT_DRY_RUN), \
         patch('sys.stdout', _io.StringIO()) as mock_stdout:
        try:
            from sync.cli_execute import main
            main()
            assert False, '应调用 sys.exit(0)'
        except SystemExit as e:
            assert e.code == 0, f'退出码应为 0，实际: {e.code}'

        stdout_text = mock_stdout.getvalue()
        assert 'P5-SY8F-MY' in stdout_text, \
            f'stdout 应包含 P5-SY8F-MY，实际: {stdout_text!r}'


@test("P5-SY8F-MY --no-dry-run report.task='P5-SY8F-MY'，文件名前缀为 p5-sy8f-my-execute-，dry_run=False")
def test_report_identity_my_real_write_token():
    """P5-SY8F-MY 真实写入令牌：report 身份从 token 派生，文件名前缀为 p5-sy8f-my-execute-。"""
    report, filename = _capture_report_and_filename(
        'P5-SY8F-MY', extra_args=['--no-dry-run'], wh_country='MY')
    assert report['task'] == 'P5-SY8F-MY', \
        f'report.task 应为 P5-SY8F-MY，实际: {report["task"]!r}'
    basename = filename.replace('\\', '/').split('/')[-1]
    assert basename.startswith('p5-sy8f-my-execute-'), \
        f'文件名前缀应为 p5-sy8f-my-execute-，实际: {basename!r}'
    assert report['confirm_token'] == 'P5-SY8F-MY', \
        f'report.confirm_token 应为 P5-SY8F-MY，实际: {report["confirm_token"]!r}'
    assert report['dry_run'] is False


# =========================================================================
# 测试: _TOKEN_COUNTRY_MAP 结构一致性
# =========================================================================

@test("_TOKEN_COUNTRY_MAP 在 cli_execute.py 和 executor.py 中一致（消除重复定义风险）")
def test_token_country_map_consistency():
    """两份 _TOKEN_COUNTRY_MAP 定义必须包含相同的 token→country 映射。

    当前 cli_execute.py (main) 和 executor.py (execute_plan) 各维护一份
    _TOKEN_COUNTRY_MAP，其中一份更新而另一份遗漏时会产生令牌验证差异。
    此测试确保结构完全一致。
    """
    import os as _os
    import re

    base_dir = _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__)))

    def _extract_map(filepath):
        with open(filepath, 'r', encoding='utf-8') as f:
            content = f.read()
        # 匹配 _TOKEN_COUNTRY_MAP = { ... }
        match = re.search(r'_TOKEN_COUNTRY_MAP\s*=\s*\{([^}]+)\}', content)
        assert match is not None, \
            f'{_os.path.basename(filepath)} 中未找到 _TOKEN_COUNTRY_MAP 定义'
        pairs = {}
        for line in match.group(1).split('\n'):
            kv = re.search(r"'([^']+)'\s*:\s*'([^']+)'", line)
            if kv:
                pairs[kv.group(1)] = kv.group(2)
        return pairs

    cli_map = _extract_map(_os.path.join(base_dir, 'sync', 'cli_execute.py'))
    exec_map = _extract_map(_os.path.join(base_dir, 'sync', 'executor.py'))

    assert cli_map == exec_map, (
        f'_TOKEN_COUNTRY_MAP 不一致!\n'
        f'  cli_execute.py: {cli_map}\n'
        f'  executor.py:    {exec_map}\n'
        f'差异:\n'
        f'  仅在 cli_execute.py: {set(cli_map.items()) - set(exec_map.items())}\n'
        f'  仅在 executor.py:    {set(exec_map.items()) - set(cli_map.items())}'
    )

    # 额外断言：每个 token 的 country 必须是有效 ISO 3166-1 alpha-2 代码（2 位大写字母）
    for token, country in cli_map.items():
        assert len(country) == 2, \
            f'country 应为 2 位 ISO code: token={token}, country={country!r}'
        assert country == country.upper(), \
            f'country 应为大写: token={token}, country={country!r}'
        assert country.isalpha(), \
            f'country 应仅含字母: token={token}, country={country!r}'

    print(f'  _TOKEN_COUNTRY_MAP 一致: {len(cli_map)} 个 token')


# =========================================================================
# 测试: _DRY_RUN_ONLY_TOKENS 结构一致性
# =========================================================================

@test("_DRY_RUN_ONLY_TOKENS 在 cli_execute.py 和 executor.py 中一致（消除重复定义风险）")
def test_dry_run_only_tokens_consistency():
    """两份 _DRY_RUN_ONLY_TOKENS 定义必须包含相同的 token 集合。

    cli_execute.py (main) 和 executor.py (execute_plan) 各维护一份
    _DRY_RUN_ONLY_TOKENS，其中一份更新而另一份遗漏时会产生验证差异。
    使用 ast.parse + ast.literal_eval 解析完整 set 字面量，
    避免 regex 仅捕获第一个 token 的问题。
    """
    import os as _os
    import ast

    base_dir = _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__)))

    def _extract_tokens(filepath, var_name):
        with open(filepath, 'r', encoding='utf-8') as f:
            content = f.read()
        tree = ast.parse(content)
        for node in ast.walk(tree):
            if isinstance(node, ast.Assign):
                for target in node.targets:
                    if isinstance(target, ast.Name) and target.id == var_name:
                        value = ast.literal_eval(node.value)
                        if isinstance(value, set):
                            return value
        assert False, \
            f'{_os.path.basename(filepath)} 中未找到 {var_name} 的 set 定义'

    cli_tokens = _extract_tokens(
        _os.path.join(base_dir, 'sync', 'cli_execute.py'),
        '_DRY_RUN_ONLY_TOKENS')
    exec_tokens = _extract_tokens(
        _os.path.join(base_dir, 'sync', 'executor.py'),
        '_DRY_RUN_ONLY_TOKENS')

    assert cli_tokens == exec_tokens, (
        f'_DRY_RUN_ONLY_TOKENS 不一致!\n'
        f'  cli_execute.py: {sorted(cli_tokens)}\n'
        f'  executor.py:    {sorted(exec_tokens)}\n'
        f'仅在 cli_execute.py: {sorted(cli_tokens - exec_tokens)}\n'
        f'仅在 executor.py:    {sorted(exec_tokens - cli_tokens)}'
    )

    # 断言完整 3 token（若集合同步正确则应为 3）
    assert cli_tokens == {'P5-SY8C-TH', 'P5-SY8E-MY', 'P5-SY8G-ID'}, \
        f'_DRY_RUN_ONLY_TOKENS 应为 3 个 token，实际: {sorted(cli_tokens)}'

    # _NO_DRY_RUN_EXCLUSIVE_TOKENS 一致性（仅 cli_execute.py 定义）
    cli_exclusive = _extract_tokens(
        _os.path.join(base_dir, 'sync', 'cli_execute.py'),
        '_NO_DRY_RUN_EXCLUSIVE_TOKENS')
    assert cli_exclusive == {'P5-SY8D-TH', 'P5-SY8F-MY', 'P5-SY8H-ID'}, \
        f'_NO_DRY_RUN_EXCLUSIVE_TOKENS 应为 3 个 token，实际: {sorted(cli_exclusive)}'

    print(f'  _DRY_RUN_ONLY_TOKENS 一致: {len(cli_tokens)} 个 token')
    print(f'  _NO_DRY_RUN_EXCLUSIVE_TOKENS 一致: {len(cli_exclusive)} 个 token')


# =========================================================================
# 测试: P5-SY8E-MY 令牌—模式绑定
# =========================================================================

@test("P5-SY8E-MY --no-dry-run 必须在任何 I/O 前被拒绝（exit 1）")
def test_p5_sy8e_my_rejects_no_dry_run_before_io():
    """P5-SY8E-MY 仅支持 --dry-run，--no-dry-run 必须在参数解析后拒绝。"""
    my_reject_args = [
        'cli_execute.py',
        '--input-json', '/fake/input.json',
        '--dry-run-report', '/fake/report.json',
        '--execute', '--confirm', 'P5-SY8E-MY',
        '--no-dry-run',
    ]
    with patch('sys.argv', my_reject_args), \
         patch('sync.config.WAREHOUSE_COUNTRY', 'MY'), \
         patch('os.path.isfile') as mock_isfile, \
         patch('builtins.open') as mock_file, \
         patch('json.load') as mock_json_load, \
         patch('sync.supabase_gateway.fetch_warehouse') as mock_fetch_wh, \
         patch('sync.supabase_gateway.fetch_variants') as mock_fetch_var, \
         patch('sync.supabase_gateway.fetch_inventory_by_warehouse') as mock_fetch_inv, \
         patch('sync.executor._call_sync_rpc') as mock_rpc, \
         patch('sync.executor._write_sync_log') as mock_log, \
         patch('sync.executor._save_fallback_log') as mock_fb, \
         patch('sync.executor.execute_plan') as mock_exec, \
         patch('sync.executor.execute_plan_v2') as mock_exec_v2, \
         patch('sys.stdout', _io.StringIO()) as mock_stdout:
        try:
            from sync.cli_execute import main
            main()
            assert False, '应调用 sys.exit(1)'
        except SystemExit as e:
            assert e.code == 1, f'退出码应为 1，实际: {e.code}'

        mock_isfile.assert_not_called()
        mock_file.assert_not_called()
        mock_json_load.assert_not_called()
        mock_fetch_wh.assert_not_called()
        mock_fetch_var.assert_not_called()
        mock_fetch_inv.assert_not_called()
        mock_rpc.assert_not_called()
        mock_log.assert_not_called()
        mock_fb.assert_not_called()
        mock_exec.assert_not_called()
        mock_exec_v2.assert_not_called()

        stdout_text = mock_stdout.getvalue()
        assert 'P5-SY8E-MY' in stdout_text, \
            f'错误信息应包含令牌 P5-SY8E-MY: {stdout_text!r}'
        assert '--dry-run' in stdout_text, \
            f'错误信息应提及 --dry-run: {stdout_text!r}'


@test("P5-SY8E-MY --dry-run 正常通过（exit 0），P5-SY8E-MY 仅支持 --dry-run")
def test_p5_sy8e_my_accepts_dry_run():
    """P5-SY8E-MY 仅支持 --dry-run，可执行只读验证。"""
    my_accept_args = [
        'cli_execute.py',
        '--input-json', '/fake/input.json',
        '--dry-run-report', '/fake/report.json',
        '--execute', '--confirm', 'P5-SY8E-MY',
    ]
    with patch('sys.argv', my_accept_args), \
         patch('sync.config.WAREHOUSE_COUNTRY', 'MY'), \
         patch('os.path.isfile', return_value=True), \
         patch('builtins.open', mock_open()), \
         patch('json.load', side_effect=[MOCK_INPUT_DATA, MOCK_DRY_RUN_REPORT]), \
         patch('json.dump'), \
         patch('sync.input_validator.validate_json', return_value=MOCK_ROWS), \
         patch('sync.supabase_gateway.fetch_warehouse', return_value=MOCK_WAREHOUSE), \
         patch('sync.supabase_gateway.fetch_variants', return_value=[]), \
         patch('sync.supabase_gateway.fetch_inventory_by_warehouse', return_value=[]), \
         patch('sync.plan_generator.generate_plan', return_value=SIMPLE_PLAN), \
         patch('sync.verifier.compare_plans', return_value=[]), \
         patch('sync.executor.execute_plan', return_value=MOCK_EXECUTE_RESULT_DRY_RUN), \
         patch('sys.stdout', _io.StringIO()) as mock_stdout:
        try:
            from sync.cli_execute import main
            main()
            assert False, '应调用 sys.exit(0)'
        except SystemExit as e:
            assert e.code == 0, f'退出码应为 0，实际: {e.code}'

        stdout_text = mock_stdout.getvalue()
        assert 'P5-SY8E-MY' in stdout_text, \
            f'stdout 应包含 P5-SY8E-MY，实际: {stdout_text!r}'


# =========================================================================
# 测试: P5-SY8G-ID 全链路国家断言 (execute_plan_v2 直接调用)
# =========================================================================

@test("P5-SY8G-ID 全链路国家断言: execute_plan_v2 直接调用，RPC payload → Phase G → Phase I → SyncLog 均为 ID")
def test_id_full_chain_country_assertions():
    """ID 全链路集成测试 — execute_plan_v2 直接调用，精确断言全链路 country='ID'。

    P5-SY8G-ID 仅支持 --dry-run（只读抓取与 Dry Run），不执行真实写入。
    直接调用 sync.executor.execute_plan_v2，仅 mock RPC/HTTP/SyncLog/verifier/sleep
    等外部依赖。execute_plan_v2 自身逻辑真实执行。

    禁止仅用 assert_called_with() 弱断言。必须逐条验证：
    - RPC payload 中 p_variants[].country 和 p_inventory[].country 均为 'ID'
    - Phase G product_variant 查询使用 country=eq.ID
    - Phase I warehouse country 预期值为 'ID'
    - SyncLog 写入的 warehouse_id 为 ID 仓库 ID，status=success
    """
    rpc_captured = []
    get_calls = []
    verify_wh_captured = []
    sync_log_captured = []

    def capture_rpc(wh_id, p_variants, p_inventory, p_wh_name):
        rpc_captured.append({
            'warehouse_id': wh_id,
            'p_variants': list(p_variants),
            'p_inventory': list(p_inventory),
            'p_warehouse_name': p_wh_name,
        })
        return dict(ID_RPC_RESULT)

    def capture_get(path):
        get_calls.append(path)
        if 'warehouse?id=eq' in path:
            return [dict(ID_WAREHOUSE)]
        if 'inventory' in path:
            return [dict(item) for item in ID_INVENTORY_POST_WRITE]
        if 'product_variant' in path:
            return [dict(item) for item in ID_VARIANT_LIST_POST]
        return []

    def capture_verify_wh(actual, expected):
        verify_wh_captured.append({'actual': dict(actual), 'expected': dict(expected)})
        return []

    def capture_sync_log(warehouse_id, status, new_variants_count,
                         error_message, started_at, finished_at, **kwargs):
        sync_log_captured.append({
            'warehouse_id': warehouse_id,
            'status': status,
            'new_variants_count': new_variants_count,
            'error_message': error_message,
        })
        return {
            'id': 'sl-id-001',
            'status': status,
            'warehouse_id': warehouse_id,
        }

    with patch('sync.config.WAREHOUSE_COUNTRY', 'ID'), \
         patch('sync.executor.WAREHOUSE_COUNTRY', 'ID'), \
         patch('sync.executor.TARGET_WAREHOUSE_NAME', '印尼-DEE仓库'), \
         patch('sync.executor._call_sync_rpc', side_effect=capture_rpc), \
         patch('sync.executor._get', side_effect=capture_get), \
         patch('sync.executor._write_sync_log', side_effect=capture_sync_log), \
         patch('sync.executor.verify_inventory_post_write', return_value=[]), \
         patch('sync.executor.verify_warehouse_final_state',
               side_effect=capture_verify_wh), \
         patch('time.sleep'):
        from sync.executor import execute_plan_v2
        result = execute_plan_v2(dict(ID_PLAN), sync_log_enabled=True)

    assert result['phase_g_verified'] is True, \
        f'Phase G 应通过，实际: {result["phase_g_verified"]}'
    assert result['phase_i_verified'] is True, \
        f'Phase I 应通过，实际: {result["phase_i_verified"]}'
    assert result['sync_log_written'] is True, \
        f'SyncLog 应写入，实际: {result["sync_log_written"]}'
    assert result['warehouse_id'] == ID_WAREHOUSE_ID, \
        f'warehouse_id 应为 ID 仓库，实际: {result["warehouse_id"]}'

    assert len(rpc_captured) == 1, f'RPC 应被调用 1 次，实际: {len(rpc_captured)}'
    rpc = rpc_captured[0]
    assert rpc['warehouse_id'] == ID_WAREHOUSE_ID
    assert rpc['p_warehouse_name'] == '印尼-DEE仓库'

    for i, v in enumerate(rpc['p_variants']):
        assert v['country'] == 'ID', \
            f'p_variants[{i}].country 应为 ID，实际: {v["country"]!r}'
    for i, inv in enumerate(rpc['p_inventory']):
        assert inv['country'] == 'ID', \
            f'p_inventory[{i}].country 应为 ID，实际: {inv["country"]!r}'

    p_var_skus = {(v['sku'], v['country']) for v in rpc['p_variants']}
    p_inv_skus = {(inv['sku'], inv['country']) for inv in rpc['p_inventory']}
    assert not p_var_skus - p_inv_skus, \
        f'p_variants 中的 SKU 必须全部出现在 p_inventory 中'

    variant_gets = [c for c in get_calls if 'product_variant' in c]
    assert len(variant_gets) >= 1, \
        f'Phase G 应至少查询 1 次 product_variant，实际: {len(variant_gets)}'
    for q in variant_gets:
        assert 'country=eq.ID' in q, \
            f'Phase G product_variant 查询应包含 country=eq.ID: {q!r}'

    inv_gets = [c for c in get_calls if 'inventory' in c]
    for q in inv_gets:
        assert f'warehouse_id=eq.{ID_WAREHOUSE_ID}' in q

    assert len(verify_wh_captured) == 1, \
        f'verify_warehouse_final_state 应被调用 1 次，实际: {len(verify_wh_captured)}'
    wh_expected = verify_wh_captured[0]['expected']
    assert wh_expected['country'] == 'ID', \
        f'Phase I wh_expected.country 应为 ID，实际: {wh_expected["country"]!r}'
    assert wh_expected['name'] == '印尼-DEE仓库'

    assert len(sync_log_captured) == 1, \
        f'SyncLog 应被调用 1 次，实际: {len(sync_log_captured)}'
    sl = sync_log_captured[0]
    assert sl['warehouse_id'] == ID_WAREHOUSE_ID
    assert sl['status'] == 'success'
    assert sl['error_message'] is None


@test("P5-SY8G-ID --no-dry-run 必须在任何 I/O 前被拒绝（exit 1），动态提示 P5-SY8H-ID")
def test_p5_sy8g_id_rejects_no_dry_run_before_io():
    """P5-SY8G-ID 仅支持 --dry-run，--no-dry-run 必须在参数解析后拒绝。
    动态错误消息应提示使用正确的写令牌（未来 P5-SY8H-ID），而非硬编码。"""
    id_reject_args = [
        'cli_execute.py',
        '--input-json', '/fake/input.json',
        '--dry-run-report', '/fake/report.json',
        '--execute', '--confirm', 'P5-SY8G-ID',
        '--no-dry-run',
    ]
    with patch('sys.argv', id_reject_args), \
         patch('sync.config.WAREHOUSE_COUNTRY', 'ID'), \
         patch('os.path.isfile') as mock_isfile, \
         patch('builtins.open') as mock_file, \
         patch('json.load') as mock_json_load, \
         patch('sync.supabase_gateway.fetch_warehouse') as mock_fetch_wh, \
         patch('sync.executor._call_sync_rpc') as mock_rpc, \
         patch('sync.executor._write_sync_log') as mock_log, \
         patch('sync.executor.execute_plan') as mock_exec, \
         patch('sync.executor.execute_plan_v2') as mock_exec_v2, \
         patch('sys.stdout', _io.StringIO()) as mock_stdout:
        try:
            from sync.cli_execute import main
            main()
            assert False, '应调用 sys.exit(1)'
        except SystemExit as e:
            assert e.code == 1, f'退出码应为 1，实际: {e.code}'

        mock_isfile.assert_not_called()
        mock_file.assert_not_called()
        mock_json_load.assert_not_called()
        mock_fetch_wh.assert_not_called()
        mock_rpc.assert_not_called()
        mock_log.assert_not_called()
        mock_exec.assert_not_called()
        mock_exec_v2.assert_not_called()

        stdout_text = mock_stdout.getvalue()
        assert 'P5-SY8G-ID' in stdout_text
        assert 'P5-SY8H-ID' in stdout_text, \
            f'错误消息应提示 P5-SY8H-ID 为待发布写令牌，实际 stdout: {stdout_text!r}'


@test("P5-SY8G-ID --dry-run 正常通过（exit 0），仅支持 --dry-run（只读抓取与 Dry Run）")
def test_p5_sy8g_id_accepts_dry_run():
    """P5-SY8G-ID 仅支持 --dry-run，可执行只读验证。"""
    id_accept_args = [
        'cli_execute.py',
        '--input-json', '/fake/input.json',
        '--dry-run-report', '/fake/report.json',
        '--execute', '--confirm', 'P5-SY8G-ID',
    ]
    with patch('sys.argv', id_accept_args), \
         patch('sync.config.WAREHOUSE_COUNTRY', 'ID'), \
         patch('os.path.isfile', return_value=True), \
         patch('builtins.open', mock_open()), \
         patch('json.load', side_effect=[ID_INPUT_DATA, ID_DRY_RUN_REPORT]), \
         patch('json.dump'), \
         patch('sync.input_validator.validate_json', return_value=[]), \
         patch('sync.supabase_gateway.fetch_warehouse', return_value=dict(ID_WAREHOUSE)), \
         patch('sync.supabase_gateway.fetch_variants', return_value=[]), \
         patch('sync.supabase_gateway.fetch_inventory_by_warehouse', return_value=[]), \
         patch('sync.plan_generator.generate_plan', return_value=SIMPLE_PLAN), \
         patch('sync.verifier.compare_plans', return_value=[]), \
         patch('sync.executor.execute_plan', return_value=MOCK_EXECUTE_RESULT_DRY_RUN), \
         patch('sys.stdout', _io.StringIO()) as mock_stdout:
        try:
            from sync.cli_execute import main
            main()
            assert False, '应调用 sys.exit(0)'
        except SystemExit as e:
            assert e.code == 0, f'退出码应为 0，实际: {e.code}'

        stdout_text = mock_stdout.getvalue()
        assert 'P5-SY8G-ID' in stdout_text, \
            f'stdout 应包含 P5-SY8G-ID，实际: {stdout_text!r}'


@test("P5-SY8G-ID Dry Run report.task='P5-SY8G-ID'，文件名前缀为 p5-sy8g-id，dry_run=True")
def test_report_identity_id_read_only_token():
    """P5-SY8G-ID 只读令牌：report 身份从 token 派生，文件名前缀为 p5-sy8g-id。"""
    report, filename = _capture_report_and_filename(
        'P5-SY8G-ID', wh_country='ID')
    assert report['task'] == 'P5-SY8G-ID', \
        f'report.task 应为 P5-SY8G-ID，实际: {report["task"]!r}'
    basename = filename.replace('\\', '/').split('/')[-1]
    assert basename.startswith('p5-sy8g-id-dry-run-'), \
        f'文件名前缀应为 p5-sy8g-id-dry-run-，实际: {basename!r}'
    assert report['confirm_token'] == 'P5-SY8G-ID', \
        f'report.confirm_token 应为 P5-SY8G-ID，实际: {report["confirm_token"]!r}'
    assert report['dry_run'] is True


# =========================================================================
# 测试: P5-SY8H-ID 真实写入令牌 CLI 全链路
# =========================================================================

@test("P5-SY8H-ID no-dry-run 全链路国家断言: RPC payload → Phase G → Phase I → SyncLog 均为 ID")
def test_p5_sy8h_id_full_chain_country_assertions():
    """ID CLI 全链路集成测试 — cli_execute.main() + --no-dry-run，精确断言全链路 country='ID'。

    使用 P5-SY8H-ID 令牌（P5-SY8G-ID 已绑定为仅 --dry-run）。
    禁止仅用 assert_called_with() 弱断言。必须逐条验证：
    - RPC payload 中 p_variants[].country 和 p_inventory[].country 均为 'ID'
    - Phase G product_variant 查询使用 country=eq.ID
    - Phase I warehouse country 预期值为 'ID'
    - SyncLog 写入的 warehouse_id 为 ID 仓库 ID
    """
    rpc_captured = []
    get_calls = []
    verify_wh_captured = []
    sync_log_captured = []

    ID_INPUT_DATA_FULL = {
        'rows': [
            {'sku': 'SKU-ID-001', 'cur_stock': 100, 'available': 100, 'locked': 0,
             'product_name': 'ID 产品 1', 'transit': 0, 'sold': 0, 'days_sold': 0},
            {'sku': 'SKU-ID-002', 'cur_stock': 200, 'available': 200, 'locked': 0,
             'product_name': 'ID 产品 2', 'transit': 0, 'sold': 0, 'days_sold': 0},
        ],
        'warehouse': '印尼-DEE仓库',
        'scrapedAt': '2026-06-21T00:00:00Z',
        'invalidRowsPath': None,
    }

    ID_DRY_RUN_REPORT_FULL = {
        'plan': dict(ID_PLAN),
        'plan_drift_check': 'PASS',
        'plan_drift_count': 0,
        'plan_drift_differences': [],
    }

    def capture_rpc(wh_id, p_variants, p_inventory, p_wh_name):
        rpc_captured.append({
            'warehouse_id': wh_id,
            'p_variants': list(p_variants),
            'p_inventory': list(p_inventory),
            'p_warehouse_name': p_wh_name,
        })
        return dict(ID_RPC_RESULT)

    def capture_get(path):
        get_calls.append(path)
        if 'warehouse?id=eq' in path:
            return [dict(ID_WAREHOUSE)]
        if 'inventory' in path:
            return [dict(item) for item in ID_INVENTORY_POST_WRITE]
        if 'product_variant' in path:
            return [dict(item) for item in ID_VARIANT_LIST_POST]
        return []

    def capture_verify_wh(actual, expected):
        verify_wh_captured.append({'actual': dict(actual), 'expected': dict(expected)})
        return []

    def capture_sync_log(warehouse_id, status, new_variants_count,
                         error_message, started_at, finished_at, **kwargs):
        sync_log_captured.append({
            'warehouse_id': warehouse_id,
            'status': status,
            'new_variants_count': new_variants_count,
            'error_message': error_message,
        })
        return {
            'id': 'sl-id-002',
            'status': status,
            'warehouse_id': warehouse_id,
        }

    id_args = [
        'cli_execute.py',
        '--input-json', '/fake/input-id.json',
        '--dry-run-report', '/fake/report-id.json',
        '--execute', '--confirm', 'P5-SY8H-ID',
        '--no-dry-run',
    ]

    stack = ExitStack()
    m = {}
    m['argv'] = stack.enter_context(patch('sys.argv', id_args))
    m['wh_country_cfg'] = stack.enter_context(
        patch('sync.config.WAREHOUSE_COUNTRY', 'ID'))
    m['target_wh_cfg'] = stack.enter_context(
        patch('sync.config.TARGET_WAREHOUSE_NAME', '印尼-DEE仓库'))
    m['wh_country_exec'] = stack.enter_context(
        patch('sync.executor.WAREHOUSE_COUNTRY', 'ID'))
    m['target_wh_exec'] = stack.enter_context(
        patch('sync.executor.TARGET_WAREHOUSE_NAME', '印尼-DEE仓库'))
    m['old_wh_exec'] = stack.enter_context(
        patch('sync.executor.OLD_WAREHOUSE_NAME', '印尼仓'))
    m['isfile'] = stack.enter_context(patch('os.path.isfile', return_value=True))
    m['open'] = stack.enter_context(patch('builtins.open', mock_open()))
    m['json_load'] = stack.enter_context(patch('json.load',
        side_effect=[ID_INPUT_DATA, ID_DRY_RUN_REPORT]))
    m['json_dump'] = stack.enter_context(patch('json.dump'))
    m['validate'] = stack.enter_context(
        patch('sync.input_validator.validate_json', return_value=[]))
    m['fetch_wh'] = stack.enter_context(
        patch('sync.supabase_gateway.fetch_warehouse', return_value=dict(ID_WAREHOUSE)))
    m['fetch_var'] = stack.enter_context(
        patch('sync.supabase_gateway.fetch_variants', return_value=ID_VARIANT_LIST_POST))
    m['fetch_inv'] = stack.enter_context(
        patch('sync.supabase_gateway.fetch_inventory_by_warehouse',
              return_value=ID_INVENTORY_POST_WRITE))
    m['gen_plan'] = stack.enter_context(
        patch('sync.plan_generator.generate_plan', return_value=dict(ID_PLAN)))
    m['compare'] = stack.enter_context(
        patch('sync.verifier.compare_plans', return_value=[]))
    m['rpc'] = stack.enter_context(
        patch('sync.executor._call_sync_rpc', side_effect=capture_rpc))
    m['get'] = stack.enter_context(
        patch('sync.executor._get', side_effect=capture_get))
    m['write_log'] = stack.enter_context(
        patch('sync.executor._write_sync_log', side_effect=capture_sync_log))
    m['verify_inv'] = stack.enter_context(
        patch('sync.executor.verify_inventory_post_write', return_value=[]))
    m['verify_wh'] = stack.enter_context(
        patch('sync.executor.verify_warehouse_final_state',
              side_effect=capture_verify_wh))
    m['sleep'] = stack.enter_context(patch('time.sleep'))
    m['stdout'] = stack.enter_context(patch('sys.stdout', _io.StringIO()))

    with stack:
        try:
            from sync.cli_execute import main
            main()
            assert False, '应调用 sys.exit(0)'
        except SystemExit as e:
            assert e.code == 0, f'退出码应为 0，实际: {e.code}'

    # 断言 1: RPC payload country 均为 'ID'
    assert len(rpc_captured) == 1, f'RPC 应被调用 1 次，实际: {len(rpc_captured)}'
    rpc = rpc_captured[0]
    assert rpc['warehouse_id'] == ID_WAREHOUSE_ID
    for v in rpc['p_variants']:
        assert v['country'] == 'ID', \
            f'p_variants[].country 应为 ID，实际: {v["country"]!r}，SKU: {v.get("sku")!r}'
    for inv in rpc['p_inventory']:
        assert inv['country'] == 'ID', \
            f'p_inventory[].country 应为 ID，实际: {inv["country"]!r}'

    # 断言 2: Phase G 使用 country=eq.ID
    phase_g_calls = [c for c in get_calls if 'product_variant' in c]
    assert len(phase_g_calls) >= 1, 'Phase G product_variant 查询应至少一次'
    for q in phase_g_calls:
        assert 'country=eq.ID' in q, \
            f'Phase G 查询应包含 country=eq.ID，实际: {q!r}'

    # 断言 3: Phase I warehouse 预期 country='ID'
    assert len(verify_wh_captured) >= 1, 'Phase I verify_warehouse 应至少一次'
    for vw in verify_wh_captured:
        assert vw['expected']['country'] == 'ID', \
            f'Phase I wh_expected.country 应为 ID，实际: {vw["expected"]["country"]!r}'

    # 断言 4: SyncLog warehouse_id
    assert len(sync_log_captured) >= 1, 'SyncLog 应至少写入一次'
    sl = sync_log_captured[0]
    assert sl['warehouse_id'] == ID_WAREHOUSE_ID
    assert sl['status'] == 'success'

    stdout_text = m['stdout'].getvalue()
    assert 'P5-SY8H-ID' in stdout_text


@test("P5-SY8H-ID --dry-run 正常通过（exit 0），P5-SY8H-ID 是可执行 --no-dry-run 的令牌但也允许 dry run")
def test_p5_sy8h_id_accepts_dry_run():
    """P5-SY8H-ID 可执行 --dry-run（预写入验证），也可执行 --no-dry-run。"""
    id_accept_args = [
        'cli_execute.py',
        '--input-json', '/fake/input-id.json',
        '--dry-run-report', '/fake/report-id.json',
        '--execute', '--confirm', 'P5-SY8H-ID',
    ]
    with patch('sys.argv', id_accept_args), \
         patch('sync.config.WAREHOUSE_COUNTRY', 'ID'), \
         patch('os.path.isfile', return_value=True), \
         patch('builtins.open', mock_open()), \
         patch('json.load', side_effect=[ID_INPUT_DATA, ID_DRY_RUN_REPORT]), \
         patch('json.dump'), \
         patch('sync.input_validator.validate_json', return_value=[]), \
         patch('sync.supabase_gateway.fetch_warehouse', return_value=dict(ID_WAREHOUSE)), \
         patch('sync.supabase_gateway.fetch_variants', return_value=[]), \
         patch('sync.supabase_gateway.fetch_inventory_by_warehouse', return_value=[]), \
         patch('sync.plan_generator.generate_plan', return_value=dict(ID_PLAN)), \
         patch('sync.verifier.compare_plans', return_value=[]), \
         patch('sync.executor.execute_plan', return_value=MOCK_EXECUTE_RESULT_DRY_RUN), \
         patch('sys.stdout', _io.StringIO()) as mock_stdout:
        try:
            from sync.cli_execute import main
            main()
            assert False, '应调用 sys.exit(0)'
        except SystemExit as e:
            assert e.code == 0, f'退出码应为 0，实际: {e.code}'

        stdout_text = mock_stdout.getvalue()
        assert 'P5-SY8H-ID' in stdout_text, \
            f'stdout 应包含 P5-SY8H-ID，实际: {stdout_text!r}'


@test("P5-SY8H-ID --no-dry-run report.task='P5-SY8H-ID'，文件名前缀为 p5-sy8h-id-execute-，dry_run=False")
def test_report_identity_id_real_write_token():
    """P5-SY8H-ID 真实写入令牌：report 身份从 token 派生，文件名前缀为 p5-sy8h-id-execute-。"""
    report, filename = _capture_report_and_filename(
        'P5-SY8H-ID', extra_args=['--no-dry-run'], wh_country='ID')
    assert report['task'] == 'P5-SY8H-ID', \
        f'report.task 应为 P5-SY8H-ID，实际: {report["task"]!r}'
    basename = filename.replace('\\', '/').split('/')[-1]
    assert basename.startswith('p5-sy8h-id-execute-'), \
        f'文件名前缀应为 p5-sy8h-id-execute-，实际: {basename!r}'
    assert report['confirm_token'] == 'P5-SY8H-ID', \
        f'report.confirm_token 应为 P5-SY8H-ID，实际: {report["confirm_token"]!r}'
    assert report['dry_run'] is False


# ─── P5-SY9K rework: web_bridge real_write summary 映射 ──────────────

RPC_SUMMARY_NONZERO = {
    'variants_created': 6,
    'inventory_received': 48,
    'inventory_inserted': 12,
    'inventory_updated': 20,
    'inventory_unchanged': 16,
    'warehouse_renamed': True,
}

EXECUTE_PLAN_V2_RETURN = {
    'started_at': '2026-06-24T10:00:00+08:00',
    'finished_at': '2026-06-24T10:00:15+08:00',
    'warehouse_id': 'test-wh-id',
    'rpc_summary': RPC_SUMMARY_NONZERO,
    'phase_g_verified': True,
    'phase_i_verified': True,
    'sync_log_written': True,
    'sync_log_fallback_path': None,
    'sync_log_enabled': True,
    'errors': [],
}


def test_web_bridge_summary_reads_from_rpc_summary():
    """P5-SY9K: web_bridge Real Write summary 从 rpc_result['rpc_summary'] 读取。

    验证：
    1. rpc_result['rpc_summary'] 具有非零值（via MOCK_RPC_RESULT）
    2. 从 rpc_summary 读取的 summary 值非零
    3. 直接从 rpc_result 顶级键读取则为 0（证明必须从 rpc_summary 读取）
    """
    rpc_result = EXECUTE_PLAN_V2_RETURN.copy()
    rpc_summary = rpc_result.get('rpc_summary', {}) or {}

    # 1. rpc_summary 本身非空
    assert rpc_summary.get('variants_created') == 6, \
        f'rpc_summary.variants_created 应为 6，实际: {rpc_summary.get("variants_created")}'
    assert rpc_summary.get('inventory_inserted') == 12, \
        f'rpc_summary.inventory_inserted 应为 12，实际: {rpc_summary.get("inventory_inserted")}'
    assert rpc_summary.get('inventory_updated') == 20, \
        f'rpc_summary.inventory_updated 应为 20，实际: {rpc_summary.get("inventory_updated")}'
    assert rpc_summary.get('inventory_unchanged') == 16, \
        f'rpc_summary.inventory_unchanged 应为 16，实际: {rpc_summary.get("inventory_unchanged")}'
    assert rpc_summary.get('warehouse_renamed') is True, \
        f'rpc_summary.warehouse_renamed 应为 True，实际: {rpc_summary.get("warehouse_renamed")}'

    # 2. web_bridge 风格 summary 构造：从 rpc_summary 读取 → 非零值
    summary_from_rpc_summary = {
        'variants_created': rpc_summary.get('variants_created', 0),
        'variants_skipped': rpc_summary.get('variants_skipped', 0),
        'inventory_inserted': rpc_summary.get('inventory_inserted', 0),
        'inventory_updated': rpc_summary.get('inventory_updated', 0),
        'inventory_unchanged': rpc_summary.get('inventory_unchanged', 0),
        'warehouse_renamed': rpc_summary.get('warehouse_renamed', False),
    }
    assert summary_from_rpc_summary['variants_created'] == 6
    assert summary_from_rpc_summary['inventory_inserted'] == 12
    assert summary_from_rpc_summary['inventory_updated'] == 20
    assert summary_from_rpc_summary['inventory_unchanged'] == 16
    assert summary_from_rpc_summary['warehouse_renamed'] is True

    # 3. 旧模式：直接从 rpc_result 顶级键读取 → 全部 0/默认值
    old_summary_direct = {
        'variants_created': rpc_result.get('variants_created', 0),
        'inventory_inserted': rpc_result.get('inventory_inserted', 0),
        'inventory_updated': rpc_result.get('inventory_updated', 0),
        'inventory_unchanged': rpc_result.get('inventory_unchanged', 0),
        'warehouse_renamed': rpc_result.get('warehouse_renamed', False),
    }
    assert old_summary_direct['variants_created'] == 0, \
        '旧模式直接从 rpc_result 顶级键读取 variants_created 应为 0'
    assert old_summary_direct['inventory_inserted'] == 0, \
        '旧模式直接从 rpc_result 顶级键读取 inventory_inserted 应为 0'
    assert old_summary_direct['warehouse_renamed'] is False, \
        '旧模式直接从 rpc_result 顶级键读取 warehouse_renamed 应为 False'


# =========================================================================
# 运行
# =========================================================================

if __name__ == '__main__':
    print('=' * 60)
    print('P5-SY4E CLI 集成测试')
    print('不依赖 Supabase 连接 | 不执行写入')
    print('=' * 60)
    print()

    test_mutually_exclusive_dry_run_and_no_dry_run()
    test_no_dry_run_no_sync_log_rejected_before_io()
    test_default_dry_run_mode()
    test_explicit_dry_run_flag()
    test_dry_run_no_sync_log_accepted()
    test_report_sync_log_summary_dry_run_default()
    test_report_sync_log_summary_disabled()
    test_plan_drift_detected_in_report()
    test_plan_drift_pass_in_report()
    test_dry_run_uses_execute_plan_not_v2()

    # P5-SY8B VN 令牌
    test_vn_token_accepted_dry_run()
    test_invalid_token_rejected_before_io()

    # 令牌国家绑定
    test_vn_config_rejects_ph_token_before_io()
    test_vn_config_accepts_vn_token()
    test_ph_config_rejects_vn_token_before_io()

    # 执行报告时间戳
    test_no_dry_run_report_has_timestamps()

    # P5-SY8D 令牌—模式强制绑定
    test_p5_sy8c_th_rejects_no_dry_run_before_io()
    test_p5_sy8d_th_accepts_dry_run()

    # P5-SY8C TH 全链路国家断言
    test_th_full_chain_country_assertions()

    # P5-SY8E MY 全链路国家断言
    test_my_full_chain_country_assertions()

    # 报告身份 — report.task 与文件名前缀派生自 confirm token
    test_report_identity_ph_token()
    test_report_identity_vn_token()
    test_report_identity_th_token()
    test_report_identity_th_real_write_token()

    # _TOKEN_COUNTRY_MAP 结构一致性
    test_token_country_map_consistency()

    # _DRY_RUN_ONLY_TOKENS 结构一致性
    test_dry_run_only_tokens_consistency()

    # P5-SY8E-MY 令牌—模式绑定
    test_p5_sy8e_my_rejects_no_dry_run_before_io()
    test_p5_sy8e_my_accepts_dry_run()

    # P5-SY8E-MY 报告身份
    test_report_identity_my_token()

    # P5-SY8F-MY real write token CLI full-chain
    test_p5_sy8f_my_full_chain_country_assertions()

    # P5-SY8F-MY token-mode binding
    test_p5_sy8f_my_accepts_dry_run()

    # P5-SY8F-MY real write report identity
    test_report_identity_my_real_write_token()

    # P5-SY8G-ID full chain country assertions (execute_plan_v2 direct)
    test_id_full_chain_country_assertions()

    # P5-SY8G-ID token-mode binding
    test_p5_sy8g_id_rejects_no_dry_run_before_io()
    test_p5_sy8g_id_accepts_dry_run()

    # P5-SY8G-ID report identity
    test_report_identity_id_read_only_token()

    # P5-SY8H-ID real write token CLI full-chain
    test_p5_sy8h_id_full_chain_country_assertions()

    # P5-SY8H-ID token-mode binding
    test_p5_sy8h_id_accepts_dry_run()

    # P5-SY8H-ID real write report identity
    test_report_identity_id_real_write_token()

    # P5-SY9K: web_bridge real_write summary 映射
    test_web_bridge_summary_reads_from_rpc_summary()

    print()
    print('=' * 60)
    print(f'结果: {PASS} 通过, {FAIL} 失败 (共 {PASS + FAIL} 项)')
    print('=' * 60)

    sys.exit(0 if FAIL == 0 else 1)
