"""P5-SY3B/P5-SY4C 执行器 — 幂等 Variant 创建 + Inventory UPSERT + Warehouse 改名 + SyncLog。

P5-SY3B (execute_plan):
  使用 Supabase REST API + service_role key。
  所有写入操作设计为可安全重跑（幂等）：
  - ProductVariant: 按 (sku, country) 唯一约束，已存在则跳过，禁止覆盖 product_id/match_status
  - Inventory: 按 (variant_id, warehouse_id) 唯一约束 UPSERT，更新 quantity/last_sync_at
  - Warehouse: 仅按名称/id 精确 UPDATE

P5-SY4C (execute_plan_v2):
  使用 sync_warehouse_inventory RPC 单次事务写入替代分批 REST 请求。
  RPC 成功后执行 Phase G/I 只读二次审计，审计通过后记录 sync_log。
  失败时分类记录 sync_log（failed/network_timeout_unknown）及 fallback 日志。

禁止：
  - 覆盖已匹配 Variant 的 product_id / match_status
  - 创建新 Warehouse
  - P5-SY3B 写 sync_log（仅 P5-SY4C 写入）
"""
import json
import math
import os
import urllib.request
import urllib.error
import ssl
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Optional

from .config import (
    TARGET_WAREHOUSE_NAME,
    OLD_WAREHOUSE_NAME,
    WAREHOUSE_COUNTRY,
)
from .verifier import verify_inventory_post_write, verify_warehouse_final_state


# =========================================================================
# 环境加载
# =========================================================================

def _load_env() -> dict:
    project_root = Path(__file__).resolve().parents[3]
    env_path = project_root / '.env.local'
    if not env_path.exists():
        raise RuntimeError(f'未找到 .env.local: {env_path}')

    env = {}
    with open(env_path, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            if '=' in line:
                key, _, value = line.partition('=')
                env[key.strip()] = value.strip().strip('"').strip("'")
    return env


_SUPABASE_URL: str | None = None
_SERVICE_KEY: str | None = None
_BASE: str | None = None


def _audit_fetch_inventory(warehouse_id: str) -> list:
    from .p0_02_connection_boundary import independent_p0_02_enabled

    if independent_p0_02_enabled():
        from .postgres_gateway import fetch_inventory_by_warehouse

        return fetch_inventory_by_warehouse(warehouse_id)
    return _get(
        'inventory'
        '?select=id,variant_id,warehouse_id,quantity'
        f'&warehouse_id=eq.{warehouse_id}'
    )


def _audit_fetch_variants_by_country(country: str) -> list:
    from .p0_02_connection_boundary import independent_p0_02_enabled

    if independent_p0_02_enabled():
        from .postgres_gateway import fetch_variants

        return fetch_variants()

    return _get(
        'product_variant'
        '?select=id,sku,country'
        f'&country=eq.{country}'
    )


def _audit_fetch_warehouse(warehouse_id: str) -> list:
    from .p0_02_connection_boundary import independent_p0_02_enabled

    if independent_p0_02_enabled():
        from .postgres_gateway import fetch_warehouse_by_id

        return [fetch_warehouse_by_id(warehouse_id)]
    return _get(f'warehouse?id=eq.{warehouse_id}')


def _ensure_supabase_rest() -> tuple[str, str, str]:
    """Legacy Supabase REST：仅在非 P0-02 独立运行时加载 .env.local。"""
    from .p0_02_connection_boundary import independent_p0_02_enabled

    if independent_p0_02_enabled():
        raise RuntimeError(
            'P0-02 独立平台已禁用 Supabase REST；请使用 postgres_gateway / execute_plan_v2',
        )
    global _SUPABASE_URL, _SERVICE_KEY, _BASE
    if _BASE is not None and _SUPABASE_URL and _SERVICE_KEY:
        return _SUPABASE_URL, _SERVICE_KEY, _BASE
    env = _load_env()
    url = env.get('NEXT_PUBLIC_SUPABASE_URL', '')
    key = env.get('SUPABASE_SERVICE_ROLE_KEY', '')
    if not url:
        raise RuntimeError('NEXT_PUBLIC_SUPABASE_URL 未在 .env.local 中配置')
    if not key:
        raise RuntimeError('SUPABASE_SERVICE_ROLE_KEY 未在 .env.local 中配置')
    _SUPABASE_URL = url
    _SERVICE_KEY = key
    _BASE = f'{url}/rest/v1'
    return _SUPABASE_URL, _SERVICE_KEY, _BASE


# =========================================================================
# HTTP 工具
# =========================================================================

def _get(path: str, _retry: int = 2) -> list:
    """GET 请求 Supabase REST API，返回 list[dict]."""
    supabase_url, service_key, base = _ensure_supabase_rest()
    url = f'{base}/{path}'
    last_error = None

    for attempt in range(_retry + 1):
        req = urllib.request.Request(url)
        req.add_header('apikey', service_key)
        req.add_header('Authorization', f'Bearer {service_key}')
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


def _post(path: str, body: list, upsert: bool = False, _retry: int = 2) -> list:
    """POST 请求 Supabase REST API，返回创建的记录列表."""
    _, service_key, base = _ensure_supabase_rest()
    url = f'{base}/{path}'
    data = json.dumps(body).encode('utf-8')
    last_error = None

    for attempt in range(_retry + 1):
        req = urllib.request.Request(url, data=data, method='POST')
        req.add_header('apikey', service_key)
        req.add_header('Authorization', f'Bearer {service_key}')
        req.add_header('Content-Type', 'application/json')
        if upsert:
            req.add_header('Prefer', 'resolution=merge-duplicates,return=representation')
        else:
            req.add_header('Prefer', 'return=representation')

        ctx = ssl.create_default_context()

        try:
            with urllib.request.urlopen(req, context=ctx, timeout=60) as resp:
                body_text = resp.read().decode('utf-8')
                if body_text.strip():
                    data = json.loads(body_text)
                    if isinstance(data, list):
                        return data
                    if isinstance(data, dict):
                        return [data]
                return []
        except urllib.error.HTTPError as e:
            body_text = e.read().decode('utf-8', errors='replace')
            raise RuntimeError(
                f'Supabase POST 错误 ({e.code}): {e.url}\n{body_text[:500]}'
            ) from None
        except (urllib.error.URLError, OSError, ConnectionResetError) as e:
            last_error = e
            if attempt < _retry:
                time.sleep(1.0 * (attempt + 1))
                continue

    raise RuntimeError(f'Supabase POST 连接失败（重试 {_retry} 次后）: {last_error}') from None


def _patch(path: str, body: dict, _retry: int = 2) -> list:
    """PATCH 请求 Supabase REST API，返回更新的记录列表."""
    _, service_key, base = _ensure_supabase_rest()
    url = f'{base}/{path}'
    data = json.dumps(body).encode('utf-8')
    last_error = None

    for attempt in range(_retry + 1):
        req = urllib.request.Request(url, data=data, method='PATCH')
        req.add_header('apikey', service_key)
        req.add_header('Authorization', f'Bearer {service_key}')
        req.add_header('Content-Type', 'application/json')
        req.add_header('Prefer', 'return=representation')

        ctx = ssl.create_default_context()

        try:
            with urllib.request.urlopen(req, context=ctx, timeout=60) as resp:
                body_text = resp.read().decode('utf-8')
                if body_text.strip():
                    data = json.loads(body_text)
                    if isinstance(data, list):
                        return data
                    if isinstance(data, dict):
                        return [data]
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


# =========================================================================
# 执行核心
# =========================================================================

def execute_plan(
    dry_run_report_path: str,
    *,
    confirm: str,
    dry_run: bool = False,
) -> dict:
    """执行 Dry Run 报告中的写入计划。

    Args:
        dry_run_report_path: P5-SY3A dry run 报告 JSON 路径
        confirm: 确认令牌，必须等于 P5-SY3B-PH 或 P5-SY8B-VN
        dry_run: True 时仅执行只读查询和分类，不写入

    Returns:
        执行报告 dict（不含密钥）

    Raises:
        RuntimeError: confirm 令牌不匹配或查询/写入失败
    """
    from .config import WAREHOUSE_COUNTRY

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

    _DRY_RUN_ONLY_TOKENS = {'P5-SY8C-TH', 'P5-SY8E-MY', 'P5-SY8G-ID'}
    _PENDING_WRITE_TOKENS = {}

    # 0. 安全门
    token_country = _TOKEN_COUNTRY_MAP.get(confirm)
    if token_country is None:
        expected = [t for t, c in _TOKEN_COUNTRY_MAP.items() if c == WAREHOUSE_COUNTRY]
        raise RuntimeError(
            f'确认令牌未知: 收到 "{confirm}"。'
            f'当前 WAREHOUSE_COUNTRY={WAREHOUSE_COUNTRY}，期望令牌: {expected}。'
            f'必须显式传入 --confirm <TOKEN> 才能执行写入。'
        )

    if token_country != WAREHOUSE_COUNTRY:
        expected = [t for t, c in _TOKEN_COUNTRY_MAP.items() if c == WAREHOUSE_COUNTRY]
        raise RuntimeError(
            f'令牌国家与当前 WAREHOUSE_COUNTRY 不一致: '
            f'收到 "{confirm}" (绑定国家: {token_country})，'
            f'当前 WAREHOUSE_COUNTRY={WAREHOUSE_COUNTRY}，期望令牌: {expected}。'
            f'必须显式传入 --confirm <TOKEN> 才能执行写入。'
        )

    if confirm in _DRY_RUN_ONLY_TOKENS and not dry_run:
        write_tokens = [t for t, c in _TOKEN_COUNTRY_MAP.items() if c == WAREHOUSE_COUNTRY and t not in _DRY_RUN_ONLY_TOKENS]
        if not write_tokens:
            write_tokens = _PENDING_WRITE_TOKENS.get(WAREHOUSE_COUNTRY, [])
        write_hint = ' 或 '.join(write_tokens) if write_tokens else 'N/A'
        raise RuntimeError(
            f'令牌 {confirm} 仅支持 dry_run=True（只读抓取与 Dry Run）。'
            f'该令牌绑定为只读方案专用，不得执行真实写入。'
            f'如需真实写入，请使用 {write_hint} 令牌。'
        )

    from .p0_02_connection_boundary import independent_p0_02_enabled

    if independent_p0_02_enabled() and not dry_run:
        raise RuntimeError(
            'P0-02 独立平台 legacy execute_plan 真实写入已封存；请使用 execute_plan_v2',
        )

    # 1. 加载 Dry Run 报告
    report_path = Path(dry_run_report_path)
    if not report_path.exists():
        raise RuntimeError(f'Dry Run 报告不存在: {dry_run_report_path}')

    with open(report_path, 'r', encoding='utf-8') as f:
        plan = json.load(f)

    new_variants_plan = plan.get('new_variants', [])
    inventory_after = plan.get('inventory_after_variant_create', [])
    inventory_updates_plan = plan.get('inventory_updates', [])
    inventory_inserts_plan = plan.get('inventory_inserts', [])
    inventory_unchanged_plan = plan.get('inventory_unchanged', [])
    rename_plan = plan.get('warehouse_rename_required')

    warehouse_id = rename_plan.get('warehouse_id') if rename_plan else None
    if not warehouse_id:
        raise RuntimeError('Dry Run 报告中缺少 warehouse_id')

    # 构建完整库存预期计划（用于写入和验证）
    def _normalize_inventory_item(item: dict, wh_id: str) -> dict:
        """将不同格式的库存计划项标准化为 {sku, new_quantity, warehouse_id}"""
        return {
            'sku': item['sku'],
            'new_quantity': int(item.get('new_quantity', item.get('quantity', 0))),
            'warehouse_id': item.get('warehouse_id', wh_id),
        }

    # 完整库存预期（供 Phase G 验证使用，包含全部 98 条）
    full_inventory_plan = []
    for item in inventory_updates_plan:
        full_inventory_plan.append(_normalize_inventory_item(item, warehouse_id))
    for item in inventory_inserts_plan:
        full_inventory_plan.append(_normalize_inventory_item(item, warehouse_id))
    for item in inventory_unchanged_plan:
        full_inventory_plan.append(_normalize_inventory_item(item, warehouse_id))
    for item in inventory_after:
        full_inventory_plan.append(_normalize_inventory_item(item, warehouse_id))

    # 写入计划（供 Phase E/F 使用，排除 unchanged，只写需要变更的）
    inventory_write_plan = []
    for item in inventory_updates_plan:
        inventory_write_plan.append(_normalize_inventory_item(item, warehouse_id))
    for item in inventory_inserts_plan:
        inventory_write_plan.append(_normalize_inventory_item(item, warehouse_id))
    for item in inventory_after:
        inventory_write_plan.append(_normalize_inventory_item(item, warehouse_id))

    if not new_variants_plan and not inventory_write_plan:
        raise RuntimeError(
            'Dry Run 报告中 new_variants 和需要写入的 inventory '
            '(updates/inserts/after_variant_create) 均为空，无需执行'
        )

    result = {
        'started_at': datetime.now().astimezone().isoformat(timespec='seconds'),
        'dry_run': dry_run,
        'confirm_token': confirm,
        'warehouse_id': warehouse_id,
        'warehouse_name_before': None,
        'variants_before': 0,
        'variants_created': 0,
        'variants_skipped': 0,
        'variants_total': 0,
        'inventory_before': 0,
        'inventory_inserted': 0,
        'inventory_updated': 0,
        'inventory_total': 0,
        'warehouse_renamed': False,
        'warehouse_name_after': None,
        'errors': [],
        'finished_at': None,
    }

    # =====================================================================
    # Phase A: 查询现状
    # =====================================================================

    # A1. 查询 Warehouse
    wh_rows = _audit_fetch_warehouse(warehouse_id)
    if not wh_rows:
        raise RuntimeError(f'未找到 warehouse id={warehouse_id}')
    wh_current = wh_rows[0]
    result['warehouse_name_before'] = wh_current.get('name')
    print(f'[A1] Warehouse: id={warehouse_id}, name="{wh_current.get("name")}"')

    # A2. 查询现有 overseas variants
    existing_variants = _audit_fetch_variants_by_country(WAREHOUSE_COUNTRY)
    result['variants_before'] = len(existing_variants)
    existing_sku_map = {v['sku']: v for v in existing_variants}
    print(f'[A2] 现有 {WAREHOUSE_COUNTRY} variants: {len(existing_variants)} 条')

    time.sleep(0.3)

    # A3. 查询现有 Inventory
    existing_inventory = _audit_fetch_inventory(warehouse_id)
    result['inventory_before'] = len(existing_inventory)
    existing_inv_set = {inv['variant_id'] for inv in existing_inventory}
    print(f'[A3] 现有 Inventory (wh={warehouse_id[:8]}...): {len(existing_inventory)} 条')

    # =====================================================================
    # Phase B: 分类 — 哪些 Variant 需要创建 / 跳过
    # =====================================================================
    to_create = []
    skipped_variants = []
    for nv in new_variants_plan:
        sku = nv['sku']
        if sku in existing_sku_map:
            ex = existing_sku_map[sku]
            skipped_variants.append({
                'sku': sku,
                'existing_id': ex['id'],
                'match_status': ex.get('match_status'),
                'product_id': ex.get('product_id'),
                'reason': '已存在，跳过（禁止覆盖 product_id / match_status）',
            })
        else:
            to_create.append({
                'sku': sku,
                'country': nv.get('country', WAREHOUSE_COUNTRY),
                'name': nv['name'],
                'product_id': None,
                'match_status': 'unmatched',
            })

    result['variants_created'] = 0  # 将在写入后更新
    result['variants_skipped'] = len(skipped_variants)
    print(f'[Phase B] 待创建 Variant: {len(to_create)}, 跳过(已存在): {len(skipped_variants)}')

    # =====================================================================
    # Phase C: 写入 Variant（仅当非 dry_run）
    # =====================================================================
    created_variant_map = {}  # sku → variant_id

    if dry_run:
        print('[Phase C] DRY RUN — 跳过 Variant 写入')
    elif to_create:
        BATCH_SIZE = 50
        for batch_start in range(0, len(to_create), BATCH_SIZE):
            batch = to_create[batch_start:batch_start + BATCH_SIZE]
            created = _post('product_variant', batch, upsert=False)
            for c in created:
                created_variant_map[c['sku']] = c['id']
            print(
                f'[Phase C] 批次 {batch_start // BATCH_SIZE + 1}: '
                f'创建 {len(created)}/{len(batch)} 条 Variant'
            )
            if batch_start + BATCH_SIZE < len(to_create):
                time.sleep(0.3)

        result['variants_created'] = len(created_variant_map)
        print(f'[Phase C] 共创建 Variant: {len(created_variant_map)} 条')
    else:
        print('[Phase C] 无需创建新 Variant（全部已存在）')

    # =====================================================================
    # Phase D: 构建完整 variant_id 映射
    # =====================================================================
    # 已有 variant → 直接复用 ID
    variant_id_by_sku = {}
    for sku, v in existing_sku_map.items():
        variant_id_by_sku[sku] = v['id']
    # 新建 variant → 使用创建返回的 ID
    variant_id_by_sku.update(created_variant_map)

    result['variants_total'] = len(variant_id_by_sku)
    print(f'[Phase D] variant_id 映射: {len(variant_id_by_sku)} 条 (已有 {len(existing_sku_map)} + 新建 {len(created_variant_map)})')

    # =====================================================================
    # Phase E: 构建 Inventory UPSERT 数据（含更新、新增、新变体库存）
    # =====================================================================
    now_iso = datetime.now().astimezone().isoformat(timespec='seconds')
    inventory_rows = []
    missing_variant_errors = []

    for item in inventory_write_plan:
        sku = item['sku']
        variant_id = variant_id_by_sku.get(sku)
        if not variant_id:
            if dry_run:
                # Dry Run 模式：DB 无 variant 时使用占位 UUID，
                # 新 Variant 在非 Dry Run 中才会创建，Dry Run 仅验证计划结构
                inventory_rows.append({
                    'variant_id': '00000000-0000-0000-0000-000000000000',
                    'warehouse_id': warehouse_id,
                    'quantity': int(item['new_quantity']),
                    'last_sync_at': now_iso,
                })
            else:
                missing_variant_errors.append(
                    f'SKU "{sku}": 找不到 variant_id，无法创建 Inventory'
                )
                continue
        else:
            inventory_rows.append({
                'variant_id': variant_id,
                'warehouse_id': warehouse_id,
                'quantity': int(item['new_quantity']),
                'last_sync_at': now_iso,
            })

    # Phase E fail-fast: 非 Dry Run 下任一 SKU 找不到 variant_id 立即终止
    if missing_variant_errors:
        error_detail = '\n'.join(f'  - {e}' for e in missing_variant_errors)
        raise RuntimeError(
            f'Phase E 失败: {len(missing_variant_errors)} 个 SKU 找不到 variant_id，'
            f'无法构建完整 Inventory 数据。终止以避免部分写入。\n{error_detail}'
        )

    print(f'[Phase E] 待 UPSERT Inventory: {len(inventory_rows)} 条')

    # 区分 INSERT vs UPDATE（用于计数）
    new_inv_count = sum(
        1 for r in inventory_rows
        if r['variant_id'] not in existing_inv_set
    )
    update_inv_count = len(inventory_rows) - new_inv_count
    print(f'[Phase E]   其中新增: {new_inv_count}, 更新: {update_inv_count}')

    # =====================================================================
    # Phase F: Inventory 写入 — 分 INSERT 和 UPDATE（仅当非 dry_run）
    # =====================================================================
    if dry_run:
        print('[Phase F] DRY RUN — 跳过 Inventory 写入')
        result['inventory_inserted'] = new_inv_count
        result['inventory_updated'] = update_inv_count
    elif inventory_rows:
        # 分离新增和更新
        to_insert_inv = [r for r in inventory_rows if r['variant_id'] not in existing_inv_set]
        to_update_inv = [r for r in inventory_rows if r['variant_id'] in existing_inv_set]

        BATCH_SIZE = 50
        inserted_count = 0
        updated_count = 0

        # INSERT 新记录
        for batch_start in range(0, len(to_insert_inv), BATCH_SIZE):
            batch = to_insert_inv[batch_start:batch_start + BATCH_SIZE]
            created = _post('inventory', batch, upsert=False)
            inserted_count += len(created)
            print(
                f'[Phase F] INSERT 批次 {batch_start // BATCH_SIZE + 1}: '
                f'{len(created)}/{len(batch)} 条'
            )
            if batch_start + BATCH_SIZE < len(to_insert_inv):
                time.sleep(0.3)

        # UPDATE 已有记录
        for batch_start in range(0, len(to_update_inv), BATCH_SIZE):
            batch = to_update_inv[batch_start:batch_start + BATCH_SIZE]
            for row in batch:
                _patch(
                    f'inventory?variant_id=eq.{row["variant_id"]}'
                    f'&warehouse_id=eq.{row["warehouse_id"]}',
                    {'quantity': row['quantity'], 'last_sync_at': row['last_sync_at']}
                )
                updated_count += 1
                time.sleep(0.1)
            print(
                f'[Phase F] UPDATE 批次 {batch_start // BATCH_SIZE + 1}: '
                f'{len(batch)} 条'
            )
            if batch_start + BATCH_SIZE < len(to_update_inv):
                time.sleep(0.3)

        result['inventory_inserted'] = inserted_count
        result['inventory_updated'] = updated_count
        total_written = inserted_count + updated_count
        print(f'[Phase F] 共写入 Inventory: INSERT {inserted_count} + UPDATE {updated_count} = {total_written}')
    else:
        print('[Phase F] Inventory 数据为空，跳过')
        result['inventory_inserted'] = 0
        result['inventory_updated'] = 0

    # =====================================================================
    # Phase G: 写后逐项验证 — 任一差异 fail-fast，禁止进入 Phase H
    # =====================================================================
    time.sleep(0.5)
    verify_inventory = _audit_fetch_inventory(warehouse_id)
    result['inventory_total'] = len(verify_inventory)
    print(f'[Phase G] 写后验证: Inventory 共 {len(verify_inventory)} 条')

    if not dry_run:
        # 重新查询 variant 映射以获取最新 ID（确保 verify 时映射完整）
        time.sleep(0.3)
        current_variants = _audit_fetch_variants_by_country(WAREHOUSE_COUNTRY)
        current_variant_map = {v['sku']: v['id'] for v in current_variants}

        inv_diffs = verify_inventory_post_write(
            inventory_plan=full_inventory_plan,
            actual_inventory=verify_inventory,
            variant_id_by_sku=current_variant_map,
            warehouse_id=warehouse_id,
        )

        if inv_diffs:
            diff_text = '\n'.join(f'  - {d}' for d in inv_diffs)
            raise RuntimeError(
                f'Phase G 写后验证失败 — Inventory 数据不一致 '
                f'({len(inv_diffs)} 项差异):\n{diff_text}\n\n'
                f'已阻止 Warehouse 改名。数据库可能处于不一致状态，'
                f'请检查后重新运行。'
            )

        print(f'[Phase G] 逐项验证通过: '
              f'{len(full_inventory_plan)} 条 SKU quantity 全部一致，无计划外记录')

    # =====================================================================
    # Phase H: Warehouse 改名（仅当非 dry_run 且验证通过）
    # =====================================================================
    if rename_plan and rename_plan.get('action') == 'rename':
        current_name = wh_current.get('name', '')
        if current_name == OLD_WAREHOUSE_NAME:
            if dry_run:
                print(f'[Phase H] DRY RUN — 跳过 Warehouse 改名')
                result['warehouse_renamed'] = False
            else:
                _patch(
                    f'warehouse?id=eq.{warehouse_id}',
                    {'name': TARGET_WAREHOUSE_NAME}
                )
                result['warehouse_renamed'] = True
                print(
                    f'[Phase H] Warehouse 已改名: '
                    f'"{OLD_WAREHOUSE_NAME}" → "{TARGET_WAREHOUSE_NAME}"'
                )
        elif current_name == TARGET_WAREHOUSE_NAME:
            print(f'[Phase H] Warehouse 名称已是 "{TARGET_WAREHOUSE_NAME}"，无需改名')
            result['warehouse_renamed'] = False
        else:
            result['errors'].append(
                f'Warehouse 名称为未知值 "{current_name}"，跳过改名'
            )
            print(f'[Phase H] 错误: 未知 Warehouse 名称 "{current_name}"，跳过改名')
    else:
        print('[Phase H] 无需改名')

    # =====================================================================
    # Phase I: Warehouse 最终状态验证
    # =====================================================================
    wh_final_rows = _audit_fetch_warehouse(warehouse_id)
    if not wh_final_rows:
        raise RuntimeError(
            f'Phase I 失败: 无法查询 Warehouse id={warehouse_id}（可能已被删除）'
        )

    wh_final = wh_final_rows[0]
    result['warehouse_name_after'] = wh_final.get('name')

    if not dry_run:
        wh_expected = {
            'id': warehouse_id,
            'name': TARGET_WAREHOUSE_NAME,
            'country': WAREHOUSE_COUNTRY,
            'type': 'overseas',
            'is_active': True,
        }
        wh_diffs = verify_warehouse_final_state(wh_final, wh_expected)

        if wh_diffs:
            diff_text = '\n'.join(f'  - {d}' for d in wh_diffs)
            raise RuntimeError(
                f'Phase I 失败: Warehouse 最终状态不符合预期 '
                f'({len(wh_diffs)} 项差异):\n{diff_text}\n\n'
                f'PATCH 可能未生效或数据库状态异常，请检查后重新运行。'
            )

        print(f'[Phase I] Warehouse 最终状态验证通过: '
              f'id={wh_final["id"][:8]}..., '
              f'name="{wh_final["name"]}", '
              f'country={wh_final["country"]}, '
              f'type={wh_final["type"]}, '
              f'is_active={wh_final["is_active"]}')

    result['finished_at'] = datetime.now().astimezone().isoformat(timespec='seconds')

    # 计算汇总字段
    total_writes = result['inventory_inserted'] + result['inventory_updated']
    result['inventory_write_actions'] = total_writes

    return result


# =========================================================================
# 公开工具函数（供测试使用）
# =========================================================================

def classify_variants(
    new_variants_plan: list,
    existing_sku_map: dict,
) -> tuple:
    """纯函数：分类哪些 variant 需要创建/跳过。

    Args:
        new_variants_plan: Dry Run 中的 new_variants 列表
        existing_sku_map: {sku: variant_dict} 已有 variant 映射

    Returns:
        (to_create: list, skipped: list)
    """
    to_create = []
    skipped = []
    for nv in new_variants_plan:
        sku = nv['sku']
        if sku in existing_sku_map:
            ex = existing_sku_map[sku]
            skipped.append({
                'sku': sku,
                'existing_id': ex.get('id'),
                'match_status': ex.get('match_status'),
                'product_id': ex.get('product_id'),
                'reason': '已存在，跳过（禁止覆盖 product_id / match_status）',
            })
        else:
            to_create.append({
                'sku': sku,
                'country': nv.get('country', WAREHOUSE_COUNTRY),
                'name': nv.get('name', ''),
                'product_id': None,
                'match_status': 'unmatched',
            })
    return to_create, skipped


# =========================================================================
# P5-SY4C: RPC 适配与 SyncLog 写入
# =========================================================================

def _build_rpc_payload(plan: dict, last_sync_at: str) -> tuple:
    """纯函数：从 generated_plan 构建 sync_warehouse_inventory RPC 参数。

    p_variants 仅含 new_variants 的 sku、country、name。
    p_inventory 合并 inventory_updates、inventory_inserts、
    inventory_after_variant_create、inventory_unchanged（完整库存快照）。
    所有条目使用同一个 last_sync_at。

    严格 quantity 校验：仅接受 type is int 且 >= 0；
    拒绝 bool（int 子类）、float、字符串、None。
    校验在所有数据转换前完成，禁止先 int() 再校验。

    Args:
        plan: generate_plan() 返回的写入计划 dict
        last_sync_at: 统一快照时间（ISO 8601 timestamptz 格式）

    Returns:
        (warehouse_id: str, p_variants: list, p_inventory: list, p_warehouse_name: str)

    Raises:
        RuntimeError: 空快照、重复业务键、无效 quantity、空 SKU/country/name、
                      新 Variant 缺少对应 Inventory、缺少 warehouse_id
    """
    from .config import WAREHOUSE_COUNTRY

    rename = plan.get('warehouse_rename_required') or {}
    warehouse_id = rename.get('warehouse_id')
    if not warehouse_id:
        raise RuntimeError(
            'plan 缺少 warehouse_id（warehouse_rename_required.warehouse_id）'
        )

    p_warehouse_name = rename.get('target_name') or TARGET_WAREHOUSE_NAME
    if not p_warehouse_name:
        raise RuntimeError('plan 缺少目标 Warehouse 名称')

    new_variants = plan.get('new_variants', [])
    p_variants = []
    seen_variant_keys = set()

    for nv in new_variants:
        sku = nv.get('sku')
        country = nv.get('country', WAREHOUSE_COUNTRY)
        name = (nv.get('name') or '').strip()

        if not sku or not sku.strip():
            raise RuntimeError('新 Variant 的 SKU 不能为空')
        if not country or not country.strip():
            raise RuntimeError(
                f'新 Variant 的 country 不能为空: sku={sku}'
            )
        if not name:
            raise RuntimeError(
                f'新 Variant 的 name 不能为空: sku={sku}'
            )

        sku = sku.strip()
        country = country.strip()

        key = (sku, country)
        if key in seen_variant_keys:
            raise RuntimeError(
                f'p_variants 含重复 (sku,country) 业务键: '
                f'sku={sku}, country={country}'
            )
        seen_variant_keys.add(key)

        p_variants.append({
            'sku': sku,
            'country': country,
            'name': name,
        })

    updates = plan.get('inventory_updates', [])
    inserts = plan.get('inventory_inserts', [])
    after_create = plan.get('inventory_after_variant_create', [])
    unchanged = plan.get('inventory_unchanged', [])

    p_inventory = []
    seen_inv_keys = set()

    def _validate_quantity(raw_qty, sku: str, category: str):
        """严格校验 quantity：仅接受 type is int 且 >= 0。
        拒绝 bool（int 子类）、float、字符串、None。
        必须在任何数据转换前调用。
        """
        if raw_qty is None:
            raise RuntimeError(
                f'quantity 不能为 None: sku={sku}, category={category}'
            )
        if type(raw_qty) is bool:
            raise RuntimeError(
                f'quantity 不能为布尔值: sku={sku}, category={category}, 值={raw_qty}'
            )
        if type(raw_qty) is not int:
            raise RuntimeError(
                f'quantity 必须为 int 类型（拒绝 {type(raw_qty).__name__}）: '
                f'sku={sku}, category={category}, 值={raw_qty!r}'
            )
        if raw_qty < 0:
            raise RuntimeError(
                f'quantity 不能为负数: sku={sku}, category={category}, quantity={raw_qty}'
            )
        return raw_qty

    def _validate_alert_field(raw_value, field_name: str, sku: str, category: str):
        """校验 daily_sales / estimated_days 字段。

        P5-SY12C 规则：
        - None / '' / '-' / '—' → 返回 None（写入 NULL）
        - NaN / Infinity / -Infinity → 抛错（禁止非有限值）
        - 有效有限 float 或 int → 返回 float 或 int 值

        注意：bool 是 int 子类，True/False 会被 type is int 捕获，
        但 here raw_value 来自 scraper 的 float_or_none，不会是 bool。
        """
        if raw_value is None:
            return None
        if isinstance(raw_value, str):
            stripped = raw_value.strip()
            if stripped in ('', '-', '—'):
                return None
            raise RuntimeError(
                f'{field_name} 不能为字符串: sku={sku}, category={category}, 值={raw_value!r}'
            )
        if isinstance(raw_value, float):
            if math.isnan(raw_value):
                raise RuntimeError(
                    f'{field_name} 不能为 NaN: sku={sku}, category={category}'
                )
            if math.isinf(raw_value):
                raise RuntimeError(
                    f'{field_name} 不能为 Infinity: sku={sku}, category={category}, 值={raw_value}'
                )
            return raw_value
        if isinstance(raw_value, int):
            return float(raw_value)
        raise RuntimeError(
            f'{field_name} 类型非法（期望 float/int/None/str）: '
            f'sku={sku}, category={category}, type={type(raw_value).__name__}, 值={raw_value!r}'
        )

    def _add_inventory_item(sku: str, country: str, qty: int,
                            daily_sales=None, estimated_days=None):
        """添加一条 Inventory 条目，含重复业务键检测。
        daily_sales/estimated_days 可选：有效有限值或 None（不发送或 JSON null）。
        """
        nonlocal p_inventory, seen_inv_keys
        key = (sku, country)
        if key in seen_inv_keys:
            raise RuntimeError(
                f'p_inventory 含重复 (sku,country) 业务键: '
                f'sku={sku}, country={country}'
            )
        seen_inv_keys.add(key)
        entry = {
            'sku': sku,
            'country': country,
            'quantity': qty,
            'last_sync_at': last_sync_at,
        }
        if daily_sales is not None:
            entry['daily_sales'] = daily_sales
        if estimated_days is not None:
            entry['estimated_days'] = estimated_days
        p_inventory.append(entry)

    # 处理 updates / inserts / after_create（使用 new_quantity 字段）
    for cat_name, cat_items in [
        ('inventory_updates', updates),
        ('inventory_inserts', inserts),
        ('inventory_after_variant_create', after_create),
    ]:
        for item in cat_items:
            sku = item.get('sku', '')
            country = item.get('country', WAREHOUSE_COUNTRY)

            if not sku or not sku.strip():
                raise RuntimeError(
                    f'Inventory SKU 不能为空: category={cat_name}'
                )
            if not country or not country.strip():
                raise RuntimeError(
                    f'Inventory country 不能为空: sku={sku}, category={cat_name}'
                )

            sku = sku.strip()
            country = country.strip()
            raw_qty = item.get('new_quantity')
            qty = _validate_quantity(raw_qty, sku, cat_name)

            # P5-SY12C: 校验并透传 daily_sales / estimated_days
            ds = _validate_alert_field(
                item.get('daily_sales'), 'daily_sales', sku, cat_name
            )
            ed = _validate_alert_field(
                item.get('estimated_days'), 'estimated_days', sku, cat_name
            )

            _add_inventory_item(sku, country, qty, ds, ed)

    # 处理 unchanged（使用 quantity 字段）
    for item in unchanged:
        sku = item.get('sku', '')
        country = item.get('country', WAREHOUSE_COUNTRY)

        if not sku or not sku.strip():
            raise RuntimeError('Inventory SKU 不能为空: category=inventory_unchanged')
        if not country or not country.strip():
            raise RuntimeError(
                f'Inventory country 不能为空: sku={sku}, category=inventory_unchanged'
            )

        sku = sku.strip()
        country = country.strip()
        raw_qty = item.get('quantity')
        qty = _validate_quantity(raw_qty, sku, 'inventory_unchanged')

        # P5-SY12C: 校验并透传 daily_sales / estimated_days
        ds = _validate_alert_field(
            item.get('daily_sales'), 'daily_sales', sku, 'inventory_unchanged'
        )
        ed = _validate_alert_field(
            item.get('estimated_days'), 'estimated_days', sku, 'inventory_unchanged'
        )

        _add_inventory_item(sku, country, qty, ds, ed)

    if not p_inventory:
        raise RuntimeError(
            'p_inventory 不能为空快照（无 updates/inserts/after_variant_create/unchanged）'
        )

    # 新 Variant-Inventory 关联完整性校验：
    # 每个 p_variants 的 (sku,country) 必须存在于 p_inventory
    for nv in p_variants:
        key = (nv['sku'], nv['country'])
        if key not in seen_inv_keys:
            raise RuntimeError(
                f'新 Variant 缺少对应 Inventory: '
                f'sku={nv["sku"]}, country={nv["country"]}'
            )

    return warehouse_id, p_variants, p_inventory, p_warehouse_name


def _call_sync_rpc(
    warehouse_id: str,
    p_variants: list,
    p_inventory: list,
    p_warehouse_name: str,
) -> dict:
    """调用 sync_warehouse_inventory RPC。

    通过 Supabase REST API POST /rpc/sync_warehouse_inventory。
    仅发送一次请求，不自动重试。
    网络超时分类为 network_timeout_unknown。

    Args:
        warehouse_id: 目标 Warehouse UUID
        p_variants: [{sku, country, name}] 新 Variant 列表
        p_inventory: [{sku, country, quantity, last_sync_at}] 完整库存快照
        p_warehouse_name: 目标 Warehouse 名称

    Returns:
        RPC 返回的摘要 dict，含 variants_created / inventory_received /
        inventory_inserted / inventory_updated / inventory_unchanged /
        warehouse_renamed

    Raises:
        RuntimeError: RPC 业务错误（含 PostgreSQL 错误信息）
        RuntimeError: 网络超时（错误消息包含 network_timeout_unknown）
    """
    from .p0_02_connection_boundary import independent_p0_02_enabled

    if independent_p0_02_enabled():
        from .postgres_rpc import call_sync_warehouse_inventory_rpc

        return call_sync_warehouse_inventory_rpc(
            warehouse_id,
            p_variants,
            p_inventory,
            p_warehouse_name,
        )

    supabase_url, service_key, _base = _ensure_supabase_rest()
    url = f'{supabase_url}/rest/v1/rpc/sync_warehouse_inventory'
    body = json.dumps({
        'p_warehouse_id': warehouse_id,
        'p_variants': p_variants,
        'p_inventory': p_inventory,
        'p_warehouse_name': p_warehouse_name,
    }).encode('utf-8')

    req = urllib.request.Request(url, data=body, method='POST')
    req.add_header('apikey', service_key)
    req.add_header('Authorization', f'Bearer {service_key}')
    req.add_header('Content-Type', 'application/json')
    req.add_header('Accept', 'application/json')

    ctx = ssl.create_default_context()

    try:
        with urllib.request.urlopen(req, context=ctx, timeout=120) as resp:
            resp_body = resp.read().decode('utf-8')
            if resp_body.strip():
                data = json.loads(resp_body)
                if isinstance(data, dict):
                    return data
                if isinstance(data, list) and len(data) > 0:
                    return data[0]
            return {}
    except urllib.error.HTTPError as e:
        body_text = e.read().decode('utf-8', errors='replace')
        raise RuntimeError(
            f'Supabase RPC 错误 ({e.code}): {e.url}\n{body_text[:1000]}'
        ) from None
    except json.JSONDecodeError as e:
        raise RuntimeError(
            f'Supabase RPC 返回非法 JSON（RPC 已执行，提交状态未知）: {e}\n'
            f'必须只读查询核对数据库状态后再决定是否重试'
        ) from None
    except UnicodeDecodeError as e:
        raise RuntimeError(
            f'Supabase RPC 返回非法 UTF-8（RPC 已执行，提交状态未知）: {e}\n'
            f'必须只读查询核对数据库状态后再决定是否重试\n'
            f'禁止自动重试 RPC 写请求'
        ) from None
    except (urllib.error.URLError, OSError, ConnectionResetError) as e:
        raise RuntimeError(
            f'network_timeout_unknown: RPC 网络错误（未重试，仅发送一次请求）\n'
            f'原始错误: {e}\n'
            f'结果未知: 网络在 RPC 响应前断开，数据库侧事务状态不确定\n'
            f'（可能已提交、可能已回滚、可能仍在执行）。\n'
            f'恢复指引:\n'
            f'  1. 检查网络连接和 Supabase 服务状态\n'
            f'  2. 确认 .env.local 中 NEXT_PUBLIC_SUPABASE_URL 正确\n'
            f'  3. 必须先只读查询核对当前 Variant、Inventory、Warehouse 状态\n'
            f'  4. 确认数据库无残留写入或部分变更后再决定是否重试\n'
            f'分类: network_timeout_unknown'
        ) from None


def _write_sync_log(
    warehouse_id: str,
    status: str,
    new_variants_count: int,
    error_message: str | None,
    started_at: str,
    finished_at: str,
    *,
    sync_run_id: str | None = None,
    triggered_by: str | None = None,
    conn=None,
) -> dict:
    """写入 sync_log 记录。

    使用 service_role key，不经过 RLS。

    Args:
        warehouse_id: 仓库 UUID
        status: 'success' 或 'failed'
        new_variants_count: 新建 Variant 数量
        error_message: 错误信息（success 时为 None）
        started_at: 同步开始时间（ISO 8601）
        finished_at: 同步结束时间（ISO 8601）

    Returns:
        创建的 sync_log 记录 dict

    Raises:
        RuntimeError: sync_log 写入失败
    """
    if status not in ('success', 'failed'):
        raise RuntimeError(
            f'sync_log status 必须为 success 或 failed，实际: {status}'
        )

    if new_variants_count < 0:
        raise RuntimeError(
            f'new_variants_count 不能为负数: {new_variants_count}'
        )

    from .p0_02_connection_boundary import independent_p0_02_enabled

    if independent_p0_02_enabled():
        from .postgres_rpc import write_sync_log_postgres, write_sync_log_postgres_conn

        if conn is not None:
            return write_sync_log_postgres_conn(
                conn,
                warehouse_id,
                status,
                new_variants_count,
                error_message,
                started_at,
                finished_at,
                sync_run_id=sync_run_id,
                triggered_by=triggered_by,
            )
        return write_sync_log_postgres(
            warehouse_id,
            status,
            new_variants_count,
            error_message,
            started_at,
            finished_at,
            sync_run_id=sync_run_id,
            triggered_by=triggered_by,
        )

    _, service_key, base = _ensure_supabase_rest()
    url = f'{base}/sync_log'
    body_data = {
        'warehouse_id': warehouse_id,
        'status': status,
        'new_variants_count': new_variants_count,
        'error_message': error_message,
        'started_at': started_at,
        'finished_at': finished_at,
    }
    data_bytes = json.dumps(body_data).encode('utf-8')

    def _attempt_write():
        req = urllib.request.Request(url, data=data_bytes, method='POST')
        req.add_header('apikey', service_key)
        req.add_header('Authorization', f'Bearer {service_key}')
        req.add_header('Content-Type', 'application/json')
        req.add_header('Prefer', 'return=representation')
        ctx = ssl.create_default_context()
        with urllib.request.urlopen(req, context=ctx, timeout=30) as resp:
            resp_body = resp.read().decode('utf-8')
            if not resp_body.strip():
                raise RuntimeError('sync_log 返回空响应')
            resp_data = json.loads(resp_body)
            if isinstance(resp_data, list):
                if len(resp_data) == 0:
                    raise RuntimeError('sync_log 返回空列表 []')
                if len(resp_data) != 1:
                    raise RuntimeError(
                        f'sync_log list 响应必须恰好包含 1 条记录，'
                        f'实际: {len(resp_data)} 条'
                    )
                record = resp_data[0]
            elif isinstance(resp_data, dict):
                record = resp_data
            else:
                raise RuntimeError(
                    f'sync_log 返回非预期 JSON 结构（期望 list 或 dict，'
                    f'实际: {type(resp_data).__name__}）'
                )

            if not isinstance(record, dict):
                raise RuntimeError(
                    f'sync_log 返回非预期结构: 记录必须为 dict，'
                    f'实际: {type(record).__name__}（值={record!r}）'
                )

            # 拒绝空 dict {}
            if not record:
                raise RuntimeError('sync_log 返回空对象 {}')

            # 必需字段为非空字符串（拒绝数字、布尔、空字符串等）
            for field in ('id', 'status', 'warehouse_id'):
                val = record.get(field)
                if type(val) is not str or not val:
                    raise RuntimeError(
                        f'sync_log 记录字段 {field} 必须为非空字符串，'
                        f'实际类型: {type(val).__name__}, 值: {val!r}'
                    )

            # status 必须与请求一致
            if record.get('status') != status:
                raise RuntimeError(
                    f'sync_log 记录 status 不匹配: '
                    f'期望 {status!r}, 实际 {record.get("status")!r}'
                )

            # warehouse_id 必须与请求一致
            if record.get('warehouse_id') != warehouse_id:
                raise RuntimeError(
                    f'sync_log 记录 warehouse_id 不匹配: '
                    f'期望 {warehouse_id!r}, 实际 {record.get("warehouse_id")!r}'
                )

            return record

    first_error = None
    for attempt in range(2):
        try:
            return _attempt_write()
        except (urllib.error.HTTPError, urllib.error.URLError, OSError,
                json.JSONDecodeError, UnicodeDecodeError, RuntimeError) as e:
            first_error = e
            if attempt == 0:
                time.sleep(1.0)
                continue

    # 两次均失败 → 抛出异常，由调用方保存 fallback
    if isinstance(first_error, urllib.error.HTTPError):
        body_text = first_error.read().decode('utf-8', errors='replace')
        raise RuntimeError(
            f'sync_log 写入失败（重试 1 次后仍失败，HTTP {first_error.code}）: '
            f'{first_error.url}\n{body_text[:500]}'
        ) from None
    if isinstance(first_error, (json.JSONDecodeError, UnicodeDecodeError)):
        raise RuntimeError(
            f'sync_log 写入失败（重试 1 次后仍失败，响应解析错误）: '
            f'{type(first_error).__name__}: {first_error}'
        ) from None
    if isinstance(first_error, RuntimeError):
        raise first_error
    raise RuntimeError(
        f'sync_log 写入网络错误（重试 1 次后仍失败）: {first_error}'
    ) from None


def _save_fallback_log(sync_log_data: dict, output_dir: str) -> str:
    """sync_log 写入失败时保存本地 fallback JSON。

    Args:
        sync_log_data: sync_log 记录 dict（含 warehouse_id/status/error_message 等）
        output_dir: 输出目录路径

    Returns:
        保存的 fallback 文件路径
    """
    os.makedirs(output_dir, exist_ok=True)
    timestamp = datetime.now().strftime('%Y%m%d-%H%M%S')
    filename = f'fallback-sync-log-{timestamp}.json'
    filepath = os.path.join(output_dir, filename)

    fallback = {
        'type': 'fallback_sync_log',
        'generated_at': datetime.now().astimezone().isoformat(timespec='seconds'),
        'sync_log_data': sync_log_data,
    }

    with open(filepath, 'w', encoding='utf-8') as f:
        json.dump(fallback, f, ensure_ascii=False, indent=2)

    return filepath


def execute_plan_v2(
    plan: dict,
    *,
    sync_log_enabled: bool = True,
    last_sync_at: str | None = None,
    fallback_dir: str | None = None,
    sync_run_id: str | None = None,
    triggered_by: str | None = None,
) -> dict:
    """使用 sync_warehouse_inventory RPC 执行写入计划。

    一次 RPC 调用完成 Variant 创建、Inventory 三向写入与 Warehouse 改名。
    RPC 成功后执行 Phase G/I 只读二次审计，审计通过后记录 sync_log。

    Args:
        plan: generate_plan() 返回的写入计划
        sync_log_enabled: 是否写入 sync_log（非 Dry Run 必须为 True）
        last_sync_at: 统一快照时间，默认使用当前时间
        fallback_dir: fallback log 输出目录，默认使用 runtime 目录

    Returns:
        执行报告 dict:
        {
            'started_at': str,
            'finished_at': str,
            'warehouse_id': str,
            'rpc_summary': dict,
            'phase_g_verified': bool,
            'phase_i_verified': bool,
            'sync_log_written': bool,
            'sync_log_fallback_path': str | None,
            'errors': list,
        }

    Raises:
        RuntimeError: RPC 业务错误或网络超时
    """
    if last_sync_at is None:
        last_sync_at = datetime.now().astimezone().isoformat(timespec='seconds')

    if fallback_dir is None:
        project_root = Path(__file__).resolve().parents[3]
        fallback_dir = os.path.join(
            project_root, 'tools', 'bigseller-scraper', 'runtime'
        )

    # 提取 warehouse_id
    rename = plan.get('warehouse_rename_required') or {}
    warehouse_id = rename.get('warehouse_id')
    if not warehouse_id:
        raise RuntimeError('plan 缺少 warehouse_id（warehouse_rename_required.warehouse_id）')

    new_variants_plan = plan.get('new_variants', [])
    new_variants_count = len(new_variants_plan)

    import os as _os

    bound_sync_run_id = sync_run_id or _os.environ.get('P0_02_SYNC_RUN_ID')
    bound_triggered_by = triggered_by or _os.environ.get('P0_02_SYNC_TRIGGERED_BY')

    result = {
        'started_at': datetime.now().astimezone().isoformat(timespec='seconds'),
        'finished_at': None,
        'warehouse_id': warehouse_id,
        'rpc_summary': None,
        'phase_g_verified': False,
        'phase_i_verified': False,
        'sync_log_written': False,
        'sync_log_fallback_path': None,
        'sync_log_enabled': sync_log_enabled,
        'publish_committed': False,
        'errors': [],
    }

    # =====================================================================
    # 1. 构建 RPC 参数
    # =====================================================================
    wh_id, p_variants, p_inventory, p_wh_name = _build_rpc_payload(
        plan, last_sync_at
    )
    print(f'[execute_plan_v2] RPC 参数已构建: '
          f'variants={len(p_variants)}, inventory={len(p_inventory)}, '
          f'warehouse_name="{p_wh_name}"')

    # =====================================================================
    # 2. 调用 RPC
    # =====================================================================
    started_at = result['started_at']
    rpc_error = None
    publish_conn = None

    def _finalize_publish_conn(*, commit: bool) -> None:
        nonlocal publish_conn
        if publish_conn is None:
            return
        try:
            if commit:
                publish_conn.commit()
            else:
                publish_conn.rollback()
        finally:
            publish_conn.close()
            publish_conn = None

    try:
        from .p0_02_connection_boundary import independent_p0_02_enabled

        if independent_p0_02_enabled():
            from .postgres_rpc import (
                call_sync_warehouse_inventory_rpc,
                open_sync_publish_connection,
            )

            publish_conn = open_sync_publish_connection()
            rpc_result = call_sync_warehouse_inventory_rpc(
                wh_id,
                p_variants,
                p_inventory,
                p_wh_name,
                conn=publish_conn,
                auto_commit=False,
            )
        else:
            rpc_result = _call_sync_rpc(wh_id, p_variants, p_inventory, p_wh_name)
    except Exception as e:
        _finalize_publish_conn(commit=False)
        rpc_error = e
        finished_at = datetime.now().astimezone().isoformat(timespec='seconds')
        result['finished_at'] = finished_at

        error_str = str(e)
        is_network_timeout = 'network_timeout_unknown' in error_str.lower()

        # 记录 sync_log failed
        if sync_log_enabled:
            try:
                _write_sync_log(
                    warehouse_id=warehouse_id,
                    status='failed',
                    new_variants_count=new_variants_count,
                    error_message=error_str[:2000],
                    started_at=started_at,
                    finished_at=finished_at,
                    sync_run_id=bound_sync_run_id,
                    triggered_by=bound_triggered_by,
                )
                result['sync_log_written'] = True
            except Exception as sl_err:
                try:
                    fb_path = _save_fallback_log(
                        {
                            'warehouse_id': warehouse_id,
                            'status': 'failed',
                            'new_variants_count': new_variants_count,
                            'error_message': error_str[:2000],
                            'started_at': started_at,
                            'finished_at': finished_at,
                        },
                        fallback_dir,
                    )
                    result['sync_log_fallback_path'] = fb_path
                    result['errors'].append(
                        f'sync_log 写入失败: {sl_err}（已保存 fallback: {fb_path}）'
                    )
                except Exception as fb_err:
                    msg = (f'sync_log 写入失败且 fallback 保存失败 — '
                           f'sync_log 错误: {sl_err}；fallback 错误: {fb_err}')
                    result['errors'].append(msg)
                    print(msg, file=sys.stderr)

        raise  # 重新抛出原始错误

    # =====================================================================
    # 2b. RPC 返回摘要严格校验
    # =====================================================================
    _VALIDATE_RPC_FIELDS = [
        'variants_created', 'inventory_received', 'inventory_inserted',
        'inventory_updated', 'inventory_unchanged', 'warehouse_renamed',
    ]

    def _rpc_validation_failed(reason: str):
        """RPC 摘要校验失败：记录 sync_log.failed + 抛出 RuntimeError。
        RPC 已执行但返回不可信，数据库状态未知，必须只读核对。
        """
        _finalize_publish_conn(commit=False)
        full_msg = (
            f'RPC 返回摘要校验失败（RPC 已执行，提交状态未知）: {reason}'
        )
        result['errors'].append(full_msg)
        result['rpc_summary'] = rpc_result

        finished_at = datetime.now().astimezone().isoformat(timespec='seconds')
        result['finished_at'] = finished_at

        if sync_log_enabled:
            try:
                _write_sync_log(
                    warehouse_id=warehouse_id,
                    status='failed',
                    new_variants_count=new_variants_count,
                    error_message=full_msg[:2000],
                    started_at=started_at,
                    finished_at=finished_at,
                    sync_run_id=bound_sync_run_id,
                    triggered_by=bound_triggered_by,
                )
                result['sync_log_written'] = True
            except Exception as sl_err:
                try:
                    fb_path = _save_fallback_log(
                        {
                            'warehouse_id': warehouse_id,
                            'status': 'failed',
                            'new_variants_count': new_variants_count,
                            'error_message': full_msg[:2000],
                            'started_at': started_at,
                            'finished_at': finished_at,
                        },
                        fallback_dir,
                    )
                    result['sync_log_fallback_path'] = fb_path
                    result['errors'].append(
                        f'sync_log 写入失败: {sl_err}（已保存 fallback: {fb_path}）'
                    )
                except Exception as fb_err:
                    msg = (f'sync_log 写入失败且 fallback 保存失败 — '
                           f'sync_log 错误: {sl_err}；fallback 错误: {fb_err}')
                    result['errors'].append(msg)
                    print(msg, file=sys.stderr)

        raise RuntimeError(full_msg)

    if not isinstance(rpc_result, dict):
        _rpc_validation_failed(
            f'期望 dict，实际类型: {type(rpc_result).__name__}'
        )

    for field in _VALIDATE_RPC_FIELDS:
        if field not in rpc_result:
            _rpc_validation_failed(
                f'缺少必需字段: {field}，实际字段: {sorted(rpc_result.keys())}'
            )

    int_fields = [
        'variants_created', 'inventory_received', 'inventory_inserted',
        'inventory_updated', 'inventory_unchanged',
    ]
    for field in int_fields:
        val = rpc_result[field]
        if type(val) is bool or type(val) is not int:
            _rpc_validation_failed(
                f'{field} 必须为 int（拒绝 {type(val).__name__}），值={val!r}'
            )
        if val < 0:
            _rpc_validation_failed(
                f'{field} 不能为负数，值={val}'
            )

    wh_renamed = rpc_result['warehouse_renamed']
    if type(wh_renamed) is not bool:
        _rpc_validation_failed(
            f'warehouse_renamed 必须为 bool，实际类型: {type(wh_renamed).__name__}'
        )

    received = rpc_result['inventory_received']
    inserted = rpc_result['inventory_inserted']
    updated = rpc_result['inventory_updated']
    unchanged = rpc_result['inventory_unchanged']
    if received != inserted + updated + unchanged:
        _rpc_validation_failed(
            f'inventory_received ({received}) != inserted ({inserted}) '
            f'+ updated ({updated}) + unchanged ({unchanged}) = '
            f'{inserted + updated + unchanged}'
        )

    result['rpc_summary'] = rpc_result
    print(f'[execute_plan_v2] RPC 返回: {json.dumps(rpc_result)}')
    print(f'[execute_plan_v2] RPC 摘要校验通过')

    # finished_at 将在 Phase G/I 审计全部通过后设置（成功路径），
    # 或在审计失败时由 _record_audit_failure 设置为失败时间。

    # =====================================================================
    # 3. Phase G: 写后 Inventory 只读审计
    # =====================================================================

    def _record_audit_failure(error_msg: str, phase_label: str) -> str:
        """post-commit 审计失败：写入 sync_log.failed + 必要时保存 fallback。

        所有审计失败（查询异常、验证差异）均通过此函数记录。
        error_message 必须包含 'post-commit audit failed'。
        设置 result.finished_at 为失败发生时间。

        Returns:
            full_msg — 调用方必须用此返回值构造 RuntimeError，
            确保主错误始终为审计失败信息，sync_log fallback 仅为附加信息。
        """
        _finalize_publish_conn(commit=False)
        full_msg = f'post-commit audit failed ({phase_label}): {error_msg}'
        result['errors'].append(full_msg)

        now_iso = datetime.now().astimezone().isoformat(timespec='seconds')
        result['finished_at'] = now_iso

        if not sync_log_enabled:
            return full_msg
        try:
            _write_sync_log(
                warehouse_id=warehouse_id,
                status='failed',
                new_variants_count=new_variants_count,
                error_message=full_msg[:2000],
                started_at=started_at,
                finished_at=now_iso,
                sync_run_id=bound_sync_run_id,
                triggered_by=bound_triggered_by,
            )
            result['sync_log_written'] = True
        except RuntimeError as sl_err:
            try:
                fb_path = _save_fallback_log(
                    {
                        'warehouse_id': warehouse_id,
                        'status': 'failed',
                        'new_variants_count': new_variants_count,
                        'error_message': full_msg[:2000],
                        'started_at': started_at,
                        'finished_at': now_iso,
                    },
                    fallback_dir,
                )
                result['sync_log_fallback_path'] = fb_path
                result['errors'].append(
                    f'sync_log 写入失败（审计失败后）: {sl_err}'
                    f'（已保存 fallback: {fb_path}）'
                )
            except Exception as fb_err:
                msg = (f'sync_log 写入失败且 fallback 保存失败（审计失败后） — '
                       f'sync_log 错误: {sl_err}；fallback 错误: {fb_err}')
                result['errors'].append(msg)
                print(msg, file=sys.stderr)

        return full_msg

    try:
        time.sleep(0.5)

        full_inventory_plan = []
        for cat in ('inventory_updates', 'inventory_inserts',
                    'inventory_after_variant_create', 'inventory_unchanged'):
            for item in plan.get(cat, []):
                full_inventory_plan.append({
                    'sku': item['sku'],
                    'new_quantity': int(item.get('new_quantity', item.get('quantity', 0))),
                    'warehouse_id': item.get('warehouse_id', warehouse_id),
                })

        if publish_conn is not None:
            from .postgres_gateway import (
                fetch_inventory_by_warehouse_conn,
                fetch_variants_conn,
            )

            verify_inventory = fetch_inventory_by_warehouse_conn(
                publish_conn, warehouse_id
            )
        else:
            verify_inventory = _audit_fetch_inventory(warehouse_id)
        print(f'[execute_plan_v2] Phase G: Inventory 写后查询 {len(verify_inventory)} 条')

        time.sleep(0.3)
        if publish_conn is not None:
            from .postgres_gateway import fetch_variants_conn

            current_variants = fetch_variants_conn(
                publish_conn, warehouse_id=warehouse_id
            )
        else:
            current_variants = _audit_fetch_variants_by_country(WAREHOUSE_COUNTRY)
        current_variant_map = {v['sku']: v['id'] for v in current_variants}

        inv_diffs = verify_inventory_post_write(
            inventory_plan=full_inventory_plan,
            actual_inventory=verify_inventory,
            variant_id_by_sku=current_variant_map,
            warehouse_id=warehouse_id,
        )

        if inv_diffs:
            diff_text = '\n'.join(f'  - {d}' for d in inv_diffs)
            raise RuntimeError(_record_audit_failure(
                f'Phase G Inventory 数据不一致 ({len(inv_diffs)} 项差异):\n{diff_text}',
                'Phase G',
            ))

        result['phase_g_verified'] = True
        print(f'[execute_plan_v2] Phase G 审计通过: '
              f'{len(full_inventory_plan)} 条 SKU quantity 全部一致')

        # ==================================================================
        # 4. Phase I: Warehouse 最终状态审计
        # ==================================================================
        if publish_conn is not None:
            from .postgres_gateway import fetch_warehouse_by_id_conn

            wh_final = fetch_warehouse_by_id_conn(publish_conn, warehouse_id)
        else:
            wh_final_rows = _audit_fetch_warehouse(warehouse_id)
            if not wh_final_rows:
                raise RuntimeError(_record_audit_failure(
                    f'无法查询 Warehouse id={warehouse_id}',
                    'Phase I',
                ))
            wh_final = wh_final_rows[0]

        wh_expected = {
            'id': warehouse_id,
            'name': TARGET_WAREHOUSE_NAME,
            'country': WAREHOUSE_COUNTRY,
            'type': 'overseas',
            'is_active': True,
        }
        wh_diffs = verify_warehouse_final_state(wh_final, wh_expected)

        if wh_diffs:
            diff_text = '\n'.join(f'  - {d}' for d in wh_diffs)
            raise RuntimeError(_record_audit_failure(
                f'Phase I Warehouse 最终状态不符合预期 ({len(wh_diffs)} 项差异):\n{diff_text}',
                'Phase I',
            ))

        result['phase_i_verified'] = True
        print(f'[execute_plan_v2] Phase I 审计通过: '
              f'id={wh_final["id"][:8]}..., '
              f'name="{wh_final["name"]}", '
              f'country={wh_final["country"]}, '
              f'type={wh_final["type"]}, '
              f'is_active={wh_final["is_active"]}')

    except RuntimeError as e:
        # 仅 _record_audit_failure 自身抛出的 RuntimeError 直接传播
        if not any('post-commit audit failed' in err for err in result['errors']):
            raise RuntimeError(_record_audit_failure(
                f'查询或验证异常: {type(e).__name__}: {e}',
                'post-commit audit',
            )) from e
        raise
    except Exception as e:
        raise RuntimeError(_record_audit_failure(
            f'查询或验证异常: {type(e).__name__}: {e}',
            'post-commit audit',
        )) from e

    # Phase G/I 通过后：必要 success sync_log 与库存发布同一事务提交（P0-02）
    finished_at = datetime.now().astimezone().isoformat(timespec='seconds')
    result['finished_at'] = finished_at

    if publish_conn is not None:
        try:
            if sync_log_enabled:
                _write_sync_log(
                    warehouse_id=warehouse_id,
                    status='success',
                    new_variants_count=rpc_result.get('variants_created', 0),
                    error_message=None,
                    started_at=started_at,
                    finished_at=finished_at,
                    sync_run_id=bound_sync_run_id,
                    triggered_by=bound_triggered_by,
                    conn=publish_conn,
                )
            _finalize_publish_conn(commit=True)
            result['publish_committed'] = True
            if sync_log_enabled:
                result['sync_log_written'] = True
                print('[execute_plan_v2] sync_log success 已与发布同事务提交')
        except Exception as sl_err:
            _finalize_publish_conn(commit=False)
            result['publish_committed'] = False
            result['sync_log_written'] = False
            fail_msg = f'发布事务提交失败（库存与 success sync_log 已回滚）: {sl_err}'
            result['errors'].append(fail_msg)
            print(fail_msg, file=sys.stderr)
            if sync_log_enabled:
                try:
                    _write_sync_log(
                        warehouse_id=warehouse_id,
                        status='failed',
                        new_variants_count=new_variants_count,
                        error_message=fail_msg[:2000],
                        started_at=started_at,
                        finished_at=finished_at,
                        sync_run_id=bound_sync_run_id,
                        triggered_by=bound_triggered_by,
                    )
                except Exception as log_err:
                    result['errors'].append(
                        f'回滚后 failed sync_log 写入失败: {log_err}',
                    )
            raise RuntimeError(fail_msg) from sl_err
    else:
        _finalize_publish_conn(commit=True)
        result['publish_committed'] = True
        if sync_log_enabled:
            try:
                _write_sync_log(
                    warehouse_id=warehouse_id,
                    status='success',
                    new_variants_count=rpc_result.get('variants_created', 0),
                    error_message=None,
                    started_at=started_at,
                    finished_at=finished_at,
                    sync_run_id=bound_sync_run_id,
                    triggered_by=bound_triggered_by,
                )
                result['sync_log_written'] = True
                print('[execute_plan_v2] sync_log success 已写入')
            except Exception as sl_err:
                try:
                    fb_path = _save_fallback_log(
                        {
                            'warehouse_id': warehouse_id,
                            'status': 'success',
                            'new_variants_count': rpc_result.get('variants_created', 0),
                            'error_message': None,
                            'started_at': started_at,
                            'finished_at': finished_at,
                        },
                        fallback_dir,
                    )
                    result['sync_log_fallback_path'] = fb_path
                    result['errors'].append(
                        f'sync_log 写入失败（RPC 已成功）: {sl_err}（已保存 fallback: {fb_path}）'
                    )
                    print(f'[execute_plan_v2] sync_log 写入失败，已保存 fallback: {fb_path}')
                except Exception as fb_err:
                    msg = (f'sync_log 写入失败且 fallback 保存失败（RPC 已成功） — '
                           f'sync_log 错误: {sl_err}；fallback 错误: {fb_err}')
                    result['errors'].append(msg)
                    print(msg, file=sys.stderr)

    print('[execute_plan_v2] 完成')
    return result


def build_inventory_upsert_rows(
    inventory_after: list,
    variant_id_by_sku: dict,
    warehouse_id: str,
) -> tuple:
    """纯函数：构建 Inventory UPSERT 数据。

    Args:
        inventory_after: Dry Run 中的 inventory_after_variant_create 列表
        variant_id_by_sku: {sku: variant_id} 映射
        warehouse_id: 目标仓库 UUID

    Returns:
        (inventory_rows: list, errors: list)
    """
    now_iso = datetime.now().astimezone().isoformat(timespec='seconds')
    inventory_rows = []
    errors = []

    for item in inventory_after:
        sku = item['sku']
        variant_id = variant_id_by_sku.get(sku)
        if not variant_id:
            errors.append(
                f'SKU "{sku}": 找不到 variant_id，无法创建 Inventory'
            )
            continue
        inventory_rows.append({
            'variant_id': variant_id,
            'warehouse_id': warehouse_id,
            'quantity': int(item['new_quantity']),
            'last_sync_at': now_iso,
        })

    return inventory_rows, errors
