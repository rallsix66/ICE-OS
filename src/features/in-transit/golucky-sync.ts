// 喜运达(golucky)物流轨迹同步编排
//
// P0 边界：仅写 tracking_event_external + 更新 sync_status。
// 不回写 shipment.status / tracking_event / inventory / estimated_arrival。
//
// 调用链：
//   cron route (CRON_SECRET 鉴权 + 依赖注入)
//     → syncAllGoluckyRefs(client, concurrency, serviceClient)
//       → externalTrackingRepository (service_role client)
//         → provider_token_cache RPC + tracking_event_external 写入
//
// serviceClient 参数：
//   - 传入 service_role 客户端 → cron 同步（绕过 RLS，直接写库）
//   - 不传 → 使用用户会话客户端（Server Action 调用，经过 RLS）

import { GoluckyClient } from '@/lib/providers/golucky/client';
import { externalTrackingRepository, type ExternalTrackingDbHandle } from './repository';
import type { GoluckySyncResult } from '@/lib/providers/golucky/types';

const DEFAULT_CONCURRENCY = 5;

/** 终态轨迹节点 → 标记 stale，后续 cron 跳过 */
const TERMINAL_CATEGORIES = new Set(['delivered', 'exception']);

/**
 * 同步全部 active 喜运达外部物流记录。
 *
 * @param client — GoluckyClient 实例（已注入 TokenCache）
 * @param concurrency — 并发上限（默认 5）
 * @param db — Supabase service_role；或 P0-02 下 P002_SYNC_RUNNER（sync runner 写库）
 * @returns 逐单同步结果
 */
export async function syncAllGoluckyRefs(
  client: GoluckyClient,
  concurrency: number = DEFAULT_CONCURRENCY,
  db?: ExternalTrackingDbHandle,
): Promise<{
  total: number;
  succeeded: number;
  failed: number;
  results: GoluckySyncResult[];
}> {
  const refs = await externalTrackingRepository.getExternalRefsByProvider('golucky', db);

  if (refs.length === 0) {
    return { total: 0, succeeded: 0, failed: 0, results: [] };
  }

  const results: GoluckySyncResult[] = [];

  // 分批执行，每批 ≤ concurrency
  for (let i = 0; i < refs.length; i += concurrency) {
    const batch = refs.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map((ref) => syncSingleRef(client, ref.id, ref.waybill_no, db)),
    );
    results.push(...batchResults);

    // 批次间短暂延迟（降低限频风险）
    if (i + concurrency < refs.length) {
      await delay(2000);
    }
  }

  const succeeded = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  return { total: refs.length, succeeded, failed, results };
}

/** 同步单条外部物流记录 */
export async function syncSingleRef(
  client: GoluckyClient,
  refId: string,
  waybillNo: string | null,
  db?: ExternalTrackingDbHandle,
): Promise<GoluckySyncResult> {
  if (!waybillNo) {
    await externalTrackingRepository.updateExternalRefSync(refId, 'error', undefined, undefined, db);
    return {
      waybillNo: waybillNo ?? '(无运单号)',
      eventCount: 0,
      success: false,
      error: '运单号为空，无法同步',
    };
  }

  try {
    const { events, rawResponse } = await client.getTracking(waybillNo);

    // Upsert 轨迹事件
    const { inserted, skipped } = await externalTrackingRepository.upsertGoluckyEvents(
      refId,
      'golucky',
      events,
      db,
    );

    // 判断是否终态
    const hasTerminalEvent = events.some((e) => TERMINAL_CATEGORIES.has(e.externalCategory));
    const newSyncStatus = hasTerminalEvent ? 'stale' : 'active';

    await externalTrackingRepository.updateExternalRefSync(
      refId,
      newSyncStatus,
      new Date().toISOString(),
      rawResponse as Record<string, unknown>,
      db,
    );

    return {
      waybillNo,
      eventCount: inserted + skipped,
      success: true,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : '未知错误';

    // 单条失败不中断整批：标记 error，持久化可诊断错误信息
    await externalTrackingRepository.updateExternalRefSync(
      refId,
      'error',
      new Date().toISOString(),
      { _sync_error: errorMessage, _failed_at: new Date().toISOString() },
      db,
    ).catch(() => {
      // 更新同步状态失败不影响错误传播
    });

    return {
      waybillNo,
      eventCount: 0,
      success: false,
      error: errorMessage,
    };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
