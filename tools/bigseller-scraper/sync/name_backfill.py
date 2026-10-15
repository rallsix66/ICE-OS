"""P6-UX-V2-E: 受控 product_variant.name 回填

从 BigSeller JSON 的 rows[].raw.sku_info 重新调用修复后的
_extract_product_name()，按 (sku, country) 匹配已有 product_variant，
生成 dry-run 差异报告。

默认只 dry-run 不写库。写入需显式 --confirm 令牌。

禁止：
- 全局只按 sku 匹配（必须 (sku, country)）
- 更新 inventory / product / migration
- 无 --confirm 令牌写入
- import 时读取 .env.local（DB 访问在函数内 lazy load）
"""
import json
import os
import sys
import ssl
import time
import urllib.request
import urllib.error
from pathlib import Path
from datetime import datetime

# 确保能 import bigseller_scraper 中的 _extract_product_name
_SCRAPER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _SCRAPER_DIR not in sys.path:
    sys.path.insert(0, _SCRAPER_DIR)
from bigseller_scraper import _extract_product_name  # noqa: E402

# ── 国家 → BigSeller 仓库名映射（用于从 JSON warehouse 字段推导 country）──
WAREHOUSE_TO_COUNTRY: dict[str, str] = {
    '菲律宾-新创启辰自建仓': 'PH',
    '菲律宾仓': 'PH',
    '泰国-DEE仓库': 'TH',
    'DEE-龙仔厝（ICE专属）': 'TH',
    '印尼-DEE仓库': 'ID',
    '马来西亚-DEE仓库': 'MY',
    '喜运达MY仓': 'MY',
    '越南-DEE仓库': 'VN',
    '越南青林湾仓库': 'VN',
}

# ── 写入确认令牌 ──
_BACKFILL_CONFIRM_TOKEN = 'P6-UX-V2-E-NAME-BACKFILL'

# ── 模块级缓存：lazy-load 仅首次调用时读取 .env.local ──
_env_cache: dict | None = None


def _get_env() -> dict:
    """Lazy-load .env.local。首次调用时读取并缓存，后续复用缓存。"""
    global _env_cache
    if _env_cache is not None:
        return _env_cache

    if os.environ.get('P0_02_ENABLED', '').strip().lower() == 'true':
        raise RuntimeError(
            'P0-02 独立平台已封存 name_backfill（禁止读取 .env.local / Supabase REST）',
        )

    project_root = Path(__file__).resolve().parents[3]
    env_path = project_root / '.env.local'
    if not env_path.exists():
        raise RuntimeError(f'未找到 .env.local: {env_path}')

    env: dict = {}
    with open(env_path, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            if '=' in line:
                key, _, value = line.partition('=')
                env[key.strip()] = value.strip().strip('"').strip("'")

    _env_cache = env
    return env


def _get_supabase_base() -> str:
    """Lazy-load Supabase URL 并返回 REST base URL。"""
    env = _get_env()
    url = env.get('NEXT_PUBLIC_SUPABASE_URL', '')
    if not url:
        raise RuntimeError('NEXT_PUBLIC_SUPABASE_URL 未在 .env.local 中配置')
    return f'{url}/rest/v1'


def _get_service_key() -> str:
    """Lazy-load service_role key。"""
    env = _get_env()
    key = env.get('SUPABASE_SERVICE_ROLE_KEY', '')
    if not key:
        raise RuntimeError('SUPABASE_SERVICE_ROLE_KEY 未在 .env.local 中配置')
    return key


# =========================================================================
# 纯函数 — 不依赖 DB / 网络 / 文件系统
# =========================================================================


def build_backfill_plan(
    input_rows: list[dict],
    variant_map: dict[tuple[str, str], dict],
    *,
    country: str,
) -> dict:
    """纯函数：从 BigSeller 行数据生成回填差异计划。

    Args:
        input_rows: BigSeller JSON rows，每条含 sku 和 raw.sku_info
        variant_map: {(sku, country): variant_dict} 已有 Variant 查找表
        country: 目标国家代码（如 'PH'），用于 (sku, country) 匹配

    Returns:
        {
            'country': str,
            'total_input_rows': int,
            'diffs': [
                {
                    'sku': str, 'country': str, 'variant_id': str,
                    'old_name': str, 'new_name': str,
                }
            ],
            'skipped': {
                'duplicate_input': [{'sku': str, 'country': str, 'reason': str}],
                'no_variant': [{'sku': str, 'country': str, 'reason': str}],
                'empty_new_name': [{'sku': str, 'raw_sku_info': str, 'reason': str}],
                'same_name': [{'sku': str, 'country': str, 'variant_id': str, 'name': str}],
            },
        }
    """
    diffs: list[dict] = []
    skipped_duplicate: list[dict] = []
    skipped_no_variant: list[dict] = []
    skipped_empty: list[dict] = []
    skipped_same: list[dict] = []

    seen_input_keys: set[tuple[str, str]] = set()

    for row in input_rows:
        sku = (row.get('sku') or '').strip()
        raw_info = (row.get('raw', {}).get('sku_info') or '').strip()

        if not sku:
            continue

        # 重复输入保护：按 (sku, country) 检测，拒绝重复以避免同一 variant 多次写
        input_key = (sku, country)
        if input_key in seen_input_keys:
            skipped_duplicate.append({
                'sku': sku,
                'country': country,
                'reason': f'输入 rows 中 (sku={sku}, country={country}) 重复出现，'
                          f'跳过后续出现以避免同一 variant 多次写入',
            })
            continue
        seen_input_keys.add(input_key)

        # 从 raw.sku_info 重新提取产品名（修复后逻辑）
        new_name = _extract_product_name(raw_info).strip()

        # 空 new_name 跳过
        if not new_name:
            skipped_empty.append({
                'sku': sku,
                'raw_sku_info': raw_info,
                'reason': '修复后 _extract_product_name() 返回空字符串',
            })
            continue

        # 按 (sku, country) 查找已有 variant
        variant = variant_map.get(input_key)

        if variant is None:
            skipped_no_variant.append({
                'sku': sku,
                'country': country,
                'reason': f'未找到 (sku={sku}, country={country}) 的 product_variant',
            })
            continue

        old_name = (variant.get('name') or '').strip()

        # 相同名称跳过
        if old_name == new_name:
            skipped_same.append({
                'sku': sku,
                'country': country,
                'variant_id': variant['id'],
                'name': old_name,
            })
            continue

        diffs.append({
            'sku': sku,
            'country': country,
            'variant_id': variant['id'],
            'old_name': old_name,
            'new_name': new_name,
        })

    return {
        'country': country,
        'total_input_rows': len(input_rows),
        'diffs': diffs,
        'skipped': {
            'duplicate_input': skipped_duplicate,
            'no_variant': skipped_no_variant,
            'empty_new_name': skipped_empty,
            'same_name': skipped_same,
        },
    }


def _validate_patch_response(
    result_list: list,
    variant_id: str,
    expected_name: str,
) -> str | None:
    """纯函数：校验 PATCH product_variant 返回值。

    Supabase PATCH with Prefer: return=representation 应返回更新后的行。

    Args:
        result_list: _patch() 返回的 list
        variant_id: 期望的 variant UUID
        expected_name: 期望更新后的 name

    Returns:
        None 表示校验通过。
        非空 str 表示校验失败原因。
    """
    if not result_list:
        return f'PATCH 返回空数组，未确认写入: variant_id={variant_id}'

    if len(result_list) > 1:
        return (
            f'PATCH 返回 {len(result_list)} 行（期望恰好 1 行）: '
            f'variant_id={variant_id}'
        )

    row = result_list[0]
    if not isinstance(row, dict):
        return (
            f'PATCH 返回非 dict 类型: {type(row).__name__}, '
            f'variant_id={variant_id}'
        )

    returned_id = row.get('id')
    if returned_id != variant_id:
        return (
            f'PATCH 返回 id 不匹配: 期望 {variant_id}, 实际 {returned_id}'
        )

    returned_name = row.get('name')
    if returned_name != expected_name:
        return (
            f'PATCH 返回 name 不匹配: 期望 {expected_name!r}, '
            f'实际 {returned_name!r}'
        )

    return None


def format_backfill_report(plan: dict) -> str:
    """纯函数：将回填计划格式化为可读文本报告。"""
    lines: list[str] = []
    diffs = plan['diffs']
    skipped = plan['skipped']
    total_skipped = (
        len(skipped.get('duplicate_input', []))
        + len(skipped.get('no_variant', []))
        + len(skipped.get('empty_new_name', []))
        + len(skipped.get('same_name', []))
    )

    lines.append('=' * 70)
    lines.append('product_variant.name 回填 Dry-Run 报告')
    lines.append(f'生成时间: {datetime.now().astimezone().isoformat(timespec="seconds")}')
    lines.append(f'目标国家: {plan["country"]}')
    lines.append(f'输入行数: {plan["total_input_rows"]}')
    lines.append('=' * 70)
    lines.append('')
    lines.append(f'待更新: {len(diffs)} 条')
    lines.append(f'跳过:   {total_skipped} 条')
    lines.append(f'  - 输入重复 (sku,country): {len(skipped.get("duplicate_input", []))}')
    lines.append(f'  - 无匹配 Variant:         {len(skipped.get("no_variant", []))}')
    lines.append(f'  - 提取后名称为空:         {len(skipped.get("empty_new_name", []))}')
    lines.append(f'  - 新旧名称相同:           {len(skipped.get("same_name", []))}')
    lines.append('')

    if diffs:
        lines.append('─' * 70)
        lines.append(f'差异明细 ({len(diffs)} 条)')
        lines.append('─' * 70)
        for i, d in enumerate(diffs, 1):
            lines.append(f'{i:4d}. SKU: {d["sku"]}')
            lines.append(f'       Variant ID: {d["variant_id"]}')
            lines.append(f'       旧名: {d["old_name"]}')
            lines.append(f'       新名: {d["new_name"]}')
            lines.append('')
    else:
        lines.append('没有需要更新的记录。')

    if skipped.get('duplicate_input'):
        lines.append('─' * 70)
        lines.append(f'输入重复 ({len(skipped["duplicate_input"])} 条)')
        lines.append('─' * 70)
        for s in skipped['duplicate_input'][:10]:
            lines.append(f'  SKU: {s["sku"]}  country: {s["country"]}')
        if len(skipped['duplicate_input']) > 10:
            lines.append(f'  ... 及其他 {len(skipped["duplicate_input"]) - 10} 条')

    if skipped.get('empty_new_name'):
        lines.append('─' * 70)
        lines.append(f'提取后名称为空 ({len(skipped["empty_new_name"])} 条)')
        lines.append('─' * 70)
        for s in skipped['empty_new_name'][:10]:
            lines.append(f'  SKU: {s["sku"]}')
            lines.append(f'  raw.sku_info: {s["raw_sku_info"][:120]}')
        if len(skipped['empty_new_name']) > 10:
            lines.append(f'  ... 及其他 {len(skipped["empty_new_name"]) - 10} 条')

    lines.append('')
    lines.append('=' * 70)
    if diffs:
        lines.append('如需执行写入，请运行:')
        lines.append(f'  python tools/bigseller-scraper/sync/name_backfill.py '
                     f'--confirm {_BACKFILL_CONFIRM_TOKEN} --json <PATH> --country {plan["country"]}')
    lines.append('=' * 70)

    return '\n'.join(lines)


# =========================================================================
# Supabase 只读查询
# =========================================================================


def _get(path: str, _retry: int = 2) -> list:
    """GET 请求 Supabase REST API（每次调用 lazy-load env）。"""
    base = _get_supabase_base()
    key = _get_service_key()
    url = f'{base}/{path}'
    last_error = None

    for attempt in range(_retry + 1):
        req = urllib.request.Request(url)
        req.add_header('apikey', key)
        req.add_header('Authorization', f'Bearer {key}')
        req.add_header('Accept', 'application/json')
        ctx = ssl.create_default_context()

        try:
            with urllib.request.urlopen(req, context=ctx, timeout=30) as resp:
                body = resp.read().decode('utf-8')
                data = json.loads(body)
                if isinstance(data, list):
                    return data
                if isinstance(data, dict):
                    return [data]
                return []
        except urllib.error.HTTPError as e:
            body = e.read().decode('utf-8', errors='replace')
            raise RuntimeError(
                f'Supabase GET 错误 ({e.code}): {e.url}\n{body[:500]}'
            ) from None
        except (urllib.error.URLError, OSError, ConnectionResetError) as e:
            last_error = e
            if attempt < _retry:
                time.sleep(1.0 * (attempt + 1))
                continue

    raise RuntimeError(f'Supabase 连接失败（重试 {_retry} 次后）: {last_error}') from None


def fetch_variants_by_country(country: str) -> list[dict]:
    """查询指定国家的全部 product_variant。

    Returns:
        list[dict]，字段含 id, sku, country, name
    """
    if not country or len(country) != 2:
        raise RuntimeError(f'country 必须为 2 位 ISO 代码，实际: {country!r}')

    return _get(
        'product_variant'
        '?select=id,sku,country,name'
        f'&country=eq.{country}'
    )


# =========================================================================
# 写入执行
# =========================================================================


def _patch(path: str, body: dict, _retry: int = 2) -> list:
    """PATCH 请求 Supabase REST API（每次调用 lazy-load env）。"""
    base = _get_supabase_base()
    key = _get_service_key()
    url = f'{base}/{path}'
    data = json.dumps(body).encode('utf-8')
    last_error = None

    for attempt in range(_retry + 1):
        req = urllib.request.Request(url, data=data, method='PATCH')
        req.add_header('apikey', key)
        req.add_header('Authorization', f'Bearer {key}')
        req.add_header('Content-Type', 'application/json')
        req.add_header('Prefer', 'return=representation')
        ctx = ssl.create_default_context()

        try:
            with urllib.request.urlopen(req, context=ctx, timeout=60) as resp:
                body_text = resp.read().decode('utf-8')
                if body_text.strip():
                    resp_data = json.loads(body_text)
                    if isinstance(resp_data, list):
                        return resp_data
                    if isinstance(resp_data, dict):
                        return [resp_data]
                return []
        except urllib.error.HTTPError as e:
            body_text = e.read().decode('utf-8', errors='replace')
            raise RuntimeError(
                f'Supabase PATCH 错误 ({e.code}): {e.url}\n{body_text[:500]}'
            ) from None
        except (urllib.error.URLError, OSError, ConnectionResetError) as e:
            last_error = e
            if attempt < _retry:
                time.sleep(1.0 * (attempt + 1))
                continue

    raise RuntimeError(f'Supabase PATCH 连接失败（重试 {_retry} 次后）: {last_error}') from None


def execute_backfill_writes(diffs: list[dict]) -> dict:
    """执行回填写入：逐条 PATCH product_variant.name，并严格校验返回值。

    每条写入后校验：
    - PATCH 返回恰好 1 行
    - 返回行 id == variant_id
    - 返回行 name == new_name
    任一失败即记录 failed，不计入 updated。

    Args:
        diffs: build_backfill_plan() 返回的 diffs 列表

    Returns:
        {'updated': int, 'failed': [{'sku': str, 'variant_id': str, 'error': str}]}
    """
    updated = 0
    failed: list[dict] = []

    for i, d in enumerate(diffs):
        variant_id = d['variant_id']
        new_name = d['new_name']
        sku = d['sku']

        try:
            result = _patch(
                f'product_variant?id=eq.{variant_id}',
                {'name': new_name},
            )

            # 严格校验 PATCH 返回值
            validation_error = _validate_patch_response(
                result, variant_id, new_name
            )
            if validation_error is not None:
                failed.append({
                    'sku': sku,
                    'variant_id': variant_id,
                    'error': validation_error,
                })
                print(f'  校验失败 [{sku}]: {validation_error}')
            else:
                updated += 1
                if (i + 1) % 10 == 0 or (i + 1) == len(diffs):
                    print(f'  已更新 {updated}/{len(diffs)} ...')
        except RuntimeError as e:
            failed.append({
                'sku': sku,
                'variant_id': variant_id,
                'error': str(e)[:500],
            })
            print(f'  失败 [{sku}]: {e}')
        time.sleep(0.15)

    return {'updated': updated, 'failed': failed}


# =========================================================================
# CLI
# =========================================================================


def _derive_country_from_json(json_data: dict) -> str | None:
    """从 JSON 的 warehouse 字段推导国家代码。"""
    wh = (json_data.get('warehouse') or '').strip()
    if wh in WAREHOUSE_TO_COUNTRY:
        return WAREHOUSE_TO_COUNTRY[wh]

    # 尝试从首行 warehouse 推导
    rows = json_data.get('rows', [])
    if rows:
        first_wh = (rows[0].get('warehouse') or '').strip()
        if first_wh in WAREHOUSE_TO_COUNTRY:
            return WAREHOUSE_TO_COUNTRY[first_wh]

    return None


def run_backfill(
    json_path: str,
    *,
    country: str | None = None,
    confirm: str | None = None,
) -> dict:
    """运行 name backfill：加载 JSON → 查询 DB → 生成计划 → (可选)写入。

    Args:
        json_path: BigSeller JSON 文件路径
        country: 2 位 ISO 国家代码。None 时从 JSON warehouse 字段自动推导
        confirm: 写入确认令牌。None 时仅 dry-run

    Returns:
        执行报告 dict
    """
    # 1. 加载 JSON
    json_path_abs = os.path.abspath(json_path)
    if not os.path.exists(json_path_abs):
        raise RuntimeError(f'JSON 文件不存在: {json_path_abs}')

    with open(json_path_abs, 'r', encoding='utf-8') as f:
        json_data = json.load(f)

    # 2. 确定 country
    if not country:
        country = _derive_country_from_json(json_data)
        if not country:
            raise RuntimeError(
                '无法从 JSON warehouse 字段自动推导国家代码。'
                '请使用 --country 显式指定（如 PH, TH, ID, MY, VN）。'
            )
        print(f'自动推导国家: {country}')

    # 3. 提取输入行
    input_rows = json_data.get('rows', [])
    if not input_rows:
        raise RuntimeError('JSON 中 rows 为空数组，无数据可回填')

    print(f'JSON 行数: {len(input_rows)}')
    print(f'目标国家: {country}')

    # 4. 查询已有 variants
    print(f'查询 {country} 的 product_variant ...')
    variants = fetch_variants_by_country(country)
    print(f'  已有 {len(variants)} 条 variant')

    # 构建 (sku, country) → variant 映射
    variant_map: dict[tuple[str, str], dict] = {}
    for v in variants:
        sku = (v.get('sku') or '').strip()
        v_country = (v.get('country') or '').strip()
        if sku and v_country:
            variant_map[(sku, v_country)] = v

    # 5. 生成回填计划（纯函数）
    plan = build_backfill_plan(input_rows, variant_map, country=country)
    plan['source_json'] = json_path_abs

    # 6. 打印报告
    report = format_backfill_report(plan)
    print(report)

    # 7. 写入（如确认）
    result = {
        'dry_run': True,
        'plan': plan,
        'writes_executed': False,
        'updated': 0,
        'failed': [],
    }

    if confirm == _BACKFILL_CONFIRM_TOKEN:
        diffs = plan['diffs']
        if not diffs:
            print('没有需要更新的记录，跳过写入。')
            return result

        print('=' * 70)
        print(f'确认令牌已通过。即将更新 {len(diffs)} 条 product_variant.name ...')
        print('=' * 70)
        write_result = execute_backfill_writes(diffs)
        result['dry_run'] = False
        result['writes_executed'] = True
        result['updated'] = write_result['updated']
        result['failed'] = write_result['failed']

        print()
        print(f'写入完成: 成功 {write_result["updated"]}, 失败 {len(write_result["failed"])}')
        if write_result['failed']:
            print('失败明细:')
            for f_item in write_result['failed']:
                print(f'  SKU={f_item["sku"]}  variant_id={f_item["variant_id"]}')
                print(f'  {f_item["error"]}')
    elif confirm is not None:
        raise RuntimeError(
            f'无效的确认令牌: "{confirm}"。'
            f'正确令牌: {_BACKFILL_CONFIRM_TOKEN}'
        )

    return result


# =========================================================================
# 入口
# =========================================================================

if __name__ == '__main__':
    import argparse

    parser = argparse.ArgumentParser(
        description='P6-UX-V2-E: product_variant.name 受控回填',
    )
    parser.add_argument(
        '--json', required=True,
        help='BigSeller 抓取 JSON 文件路径',
    )
    parser.add_argument(
        '--country', default=None,
        help='2 位 ISO 国家代码（如 PH, TH）。不指定时从 JSON warehouse 字段自动推导',
    )
    parser.add_argument(
        '--confirm', default=None,
        help=f'写入确认令牌（"{_BACKFILL_CONFIRM_TOKEN}"）。不指定时仅 dry-run',
    )
    args = parser.parse_args()

    try:
        result = run_backfill(
            args.json,
            country=args.country,
            confirm=args.confirm,
        )
        if result['writes_executed']:
            sys.exit(0 if len(result['failed']) == 0 else 1)
        else:
            print('\n[Dry-Run 完成 — 未执行任何写入]')
    except RuntimeError as e:
        print(f'\n错误: {e}', file=sys.stderr)
        sys.exit(1)
