"""Supabase 只读网关 — 封装 Supabase REST API 查询。

仅用于 P5-SY3A dry-run：读取 Warehouse / ProductVariant / Inventory。
禁止 INSERT / UPDATE / UPSERT / DELETE / RPC 写操作。
使用 service_role key（仅 CLI 同步脚本场景，不经由 RLS）。
"""
import json
import os
import urllib.request
import urllib.error
import ssl
from pathlib import Path

from .config import WAREHOUSE_COUNTRY, WAREHOUSE_TYPE


def _legacy_test_isolated_env() -> dict | None:
    if os.environ.get('SYNC_LEGACY_TEST_ISOLATED') == '1':
        return {
            'NEXT_PUBLIC_SUPABASE_URL': 'https://legacy-test.invalid',
            'SUPABASE_SERVICE_ROLE_KEY': 'legacy-test-fictional-key-not-real',
        }
    return None


def _load_env() -> dict:
    """从项目根 .env.local 读取 Supabase 连接信息（legacy 隔离测试使用虚构配置）。"""
    isolated = _legacy_test_isolated_env()
    if isolated is not None:
        return isolated

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


_ENV = _load_env()
_SUPABASE_URL = _ENV.get('NEXT_PUBLIC_SUPABASE_URL', '')
_SERVICE_KEY = _ENV.get('SUPABASE_SERVICE_ROLE_KEY', '')

if not _SUPABASE_URL:
    raise RuntimeError('NEXT_PUBLIC_SUPABASE_URL 未在 .env.local 中配置')
if not _SERVICE_KEY:
    raise RuntimeError('SUPABASE_SERVICE_ROLE_KEY 未在 .env.local 中配置')

_BASE = f'{_SUPABASE_URL}/rest/v1'


import time  # noqa: E402

def _req(path: str, _retry: int = 2) -> list:
    """GET 请求 Supabase REST API，返回 JSON 数组。
    遇 SSL 或连接错误时自动重试（最多 _retry 次）。
    """
    url = f'{_BASE}/{path}'
    last_error = None

    for attempt in range(_retry + 1):
        req = urllib.request.Request(url)
        req.add_header('apikey', _SERVICE_KEY)
        req.add_header('Authorization', f'Bearer {_SERVICE_KEY}')
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
                f'Supabase API 错误 ({e.code}): {e.url}\n{body[:500]}'
            ) from None
        except (urllib.error.URLError, OSError, ConnectionResetError) as e:
            last_error = e
            if attempt < _retry:
                time.sleep(1.0 * (attempt + 1))
                continue

    raise RuntimeError(f'Supabase 连接失败（重试 {_retry} 次后）: {last_error}') from None


# =========================================================================
# 公开查询接口 — 全部只读
# =========================================================================


def fetch_warehouse():
    """查询目标国家 overseas 类型且 is_active=true 的仓库。

    返回单条 dict（id, name, country, type, is_active）。
    无结果、多条结果或 is_active=false 均抛出 RuntimeError。
    """
    rows = _req(
        'warehouse'
        '?select=id,name,country,type,is_active'
        f'&country=eq.{WAREHOUSE_COUNTRY}'
        f'&type=eq.{WAREHOUSE_TYPE}'
    )

    active = [r for r in rows if r.get('is_active') is True]

    if len(active) == 0:
        total = len(rows)
        if total == 0:
            raise RuntimeError(
                f'未找到 country={WAREHOUSE_COUNTRY} type={WAREHOUSE_TYPE} 的仓库'
            )
        raise RuntimeError(
            f'已找到 {total} 个 {WAREHOUSE_COUNTRY} overseas 仓库，但全部 is_active=false'
        )

    if len(active) > 1:
        names = [r.get('name', '?') for r in active]
        raise RuntimeError(
            f'预期 1 个活跃 {WAREHOUSE_COUNTRY} overseas 仓库，实际 {len(active)} 个: {names}'
        )

    return active[0]


def fetch_variants():
    """查询所有目标国家的 ProductVariant 记录。

    返回 list[dict]，字段含 id, sku, country, name, product_id, match_status。
    """
    return _req(
        'product_variant'
        '?select=id,sku,country,name,product_id,match_status'
        f'&country=eq.{WAREHOUSE_COUNTRY}'
    )


def fetch_inventory_by_warehouse(warehouse_id: str):
    """查询指定仓库的全部 Inventory 记录。

    返回 list[dict]，字段含 id, variant_id, warehouse_id, quantity。
    """
    return _req(
        'inventory'
        '?select=id,variant_id,warehouse_id,quantity'
        f'&warehouse_id=eq.{warehouse_id}'
    )
