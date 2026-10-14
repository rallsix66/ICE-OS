// P0: 喜运达物流轨迹定时同步 Cron Route
//
// GET /api/cron/golucky
// Authorization: Bearer <CRON_SECRET>
//
// Vercel Cron 定时调用此端点（schedule: 0 2 * * *，UTC 02:00 / 北京时间 10:00，兼容 Hobby），拉取全部 active 喜运达外部物流记录的轨迹。
//
// 本 route 仅负责 CRON_SECRET 鉴权 + 服务端依赖注入。
// 实际同步逻辑收拢于 src/features/in-transit/golucky-sync.ts。
//
// 调用链：
//   route (auth + DI) → syncAllGoluckyRefs → externalTrackingRepository (service_role) → DB
//
// 安全边界：
// - CRON_SECRET 缺失 → 500（fail-closed），不读 Authorization、不访问 DB
// - CRON_SECRET 已配置但鉴权失败 → 401，不访问 DB
// - 仅 service_role 写库，绝不对 anon/authenticated 暴露
// - P0 不回写 shipment.status / tracking_event / inventory / estimated_arrival
// - 生产使用 SupabaseTokenCache（数据库租约），不使用 InMemoryTokenCache
// - golucky 同步仅此一条调度路径；dry-run Cron 独立共存

import { NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { isIndependentPlatformRuntime } from '@/lib/database/runtime';
import { GoluckyClient, PostgresTokenCache, SupabaseTokenCache } from '@/lib/providers/golucky';
import { P002_SYNC_RUNNER } from '@/features/in-transit/repository';
import { syncAllGoluckyRefs } from '@/features/in-transit/golucky-sync';

const DEFAULT_CONCURRENCY = 5;

export async function GET(request: NextRequest) {
  // ── 第一步：配置检查（优先于鉴权，fail-closed） ──────────
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || cronSecret === '') {
    return Response.json(
      { error: 'CRON_SECRET 未配置，喜运达同步不可用' },
      { status: 500 },
    );
  }

  // ── 第二步：请求鉴权 ──────────────────────────────────
  const authHeader = request.headers.get('authorization');
  if (!authHeader) {
    return Response.json(
      { error: '缺少 Authorization header' },
      { status: 401 },
    );
  }

  if (!authHeader.startsWith('Bearer ')) {
    return Response.json(
      { error: 'Authorization 格式错误，期望 Bearer <token>' },
      { status: 401 },
    );
  }

  const token = authHeader.slice(7);
  if (token !== cronSecret) {
    return Response.json(
      { error: 'CRON_SECRET 错误' },
      { status: 401 },
    );
  }

  // ── 第三步：检查喜运达 API 凭证 ────────────────────────
  const baseUrl = process.env.GOLUCKY_BASE_URL;
  const appKey = process.env.GOLUCKY_APP_KEY;
  const appSecret = process.env.GOLUCKY_APP_SECRET;

  if (!baseUrl || !appKey || !appSecret) {
    return Response.json(
      { error: '喜运达 API 凭证未配置（GOLUCKY_BASE_URL / GOLUCKY_APP_KEY / GOLUCKY_APP_SECRET）' },
      { status: 500 },
    );
  }

  // ── 第四步：依赖注入 + 委托同步 ────────────────────────
  const tokenCache = isIndependentPlatformRuntime()
    ? new PostgresTokenCache()
    : new SupabaseTokenCache(await createServiceClient());

  const client = new GoluckyClient({
    baseUrl: baseUrl!,
    appKey: appKey!,
    appSecret: appSecret!,
    tokenCache,
  });

  try {
    const dbHandle = isIndependentPlatformRuntime()
      ? P002_SYNC_RUNNER
      : await createServiceClient();
    const result = await syncAllGoluckyRefs(client, DEFAULT_CONCURRENCY, dbHandle);

    return Response.json({
      total: result.total,
      succeeded: result.succeeded,
      failed: result.failed,
      errors: result.results.filter((r) => !r.success).map((r) => ({
        waybill_no: r.waybillNo,
        error: r.error ?? '未知错误',
      })),
      message: `同步完成：${result.succeeded} 成功 / ${result.failed} 失败`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : '未知错误';
    return Response.json(
      { error: `喜运达同步执行失败: ${message}` },
      { status: 500 },
    );
  }
}
