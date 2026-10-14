// Sync Feature Module — PostgresSyncRepository (P0-02)
//
// 独立 PostgreSQL：authenticated 路径走 app pool + GUC；sync runner 路径走 sync pool。

import type { DbIdentity } from '@/lib/database/app-db';
import { callAppRpc, callSyncRpc, queryAppRows } from '@/lib/database/app-db';
import type { SyncRepository } from './repository';
import type {
  SyncRunsResponse,
  SyncRunsPaginatedResponse,
  SyncRunDetailResponse,
  DryRunBindingMetadata,
  SyncLogRecord,
  WarehouseHistory,
  SyncWarehouseOverviewItem,
} from './types';
import { mapSyncWarehouseOverviewRows } from './map-sync-warehouse-overview';

function parseRpcPayload<T>(data: unknown): T {
  if (data === null || data === 'null') {
    return null as T;
  }
  if (typeof data === 'string') {
    return JSON.parse(data) as T;
  }
  return data as T;
}

export class PostgresSyncRepository implements SyncRepository {
  constructor(private identity: DbIdentity) {}

  private async isActiveAdmin(): Promise<boolean> {
    const rows = await queryAppRows<{ role: string | null }>(
      this.identity,
      `SELECT public.get_user_role() AS role`,
    );
    return rows[0]?.role === 'admin';
  }

  async claimSyncRun(params: {
    warehouseId: string;
    mode: 'dry_run' | 'real_write';
    runId: string;
    leaseDuration: number;
    triggeredBy: string;
    triggeredFrom: 'web';
    dryRunRunId?: string;
    inputArtifactHash?: string;
    planArtifactHash?: string;
  }): Promise<string | null> {
    const data = await callAppRpc<string | null>(
      this.identity,
      'public.claim_sync_run',
      [
        params.warehouseId,
        params.mode,
        params.runId,
        params.leaseDuration,
        params.triggeredBy,
        params.triggeredFrom,
        params.dryRunRunId ?? null,
        params.inputArtifactHash ?? null,
        params.planArtifactHash ?? null,
      ],
    );
    return data ?? null;
  }

  async releaseSyncRun(params: {
    runId: string;
    status: 'completed' | 'failed';
    exitCode: 0 | 1 | 2;
    errorMessage?: string;
    resultSummary?: Record<string, unknown>;
    planDriftCheck?: 'PASS' | 'DRIFT_DETECTED';
    planDriftCount?: number;
    planDriftDifferences?: string[];
    planArtifactHash?: string;
  }): Promise<void> {
    const driftDiff =
      params.planDriftDifferences === undefined
        ? null
        : JSON.stringify(params.planDriftDifferences);
    await callSyncRpc('public.release_sync_run', [
      params.runId,
      params.status,
      params.exitCode,
      params.errorMessage ?? null,
      params.resultSummary ?? null,
      params.planDriftCheck ?? null,
      params.planDriftCount ?? null,
      driftDiff,
      params.planArtifactHash ?? null,
    ]);
  }

  async heartbeatSyncRun(params: {
    runId: string;
    leaseDuration: number;
  }): Promise<void> {
    await callSyncRpc('public.heartbeat_sync_run', [
      params.runId,
      params.leaseDuration,
    ]);
  }

  async claimSyncRunSystem(params: {
    warehouseId: string;
    runId: string;
    leaseDuration: number;
    triggeredBy: string;
    triggeredFrom: 'web';
    inputArtifactHash?: string;
  }): Promise<string | null> {
    const data = await callSyncRpc<string | null>('public.claim_sync_run_system', [
      params.warehouseId,
      'dry_run',
      params.runId,
      params.leaseDuration,
      params.triggeredBy,
      params.triggeredFrom,
      params.inputArtifactHash ?? null,
    ]);
    return data ?? null;
  }

  async getSyncRuns(params: {
    warehouseId?: string;
    limit: number;
  }): Promise<SyncRunsResponse> {
    const data = await callAppRpc<unknown>(
      this.identity,
      'public.get_sync_runs',
      [params.warehouseId ?? null, params.limit],
    );
    const parsed = parseRpcPayload<unknown>(data);
    return (Array.isArray(parsed) ? parsed : []) as SyncRunsResponse;
  }

  async getSyncRunsPaginated(params: {
    warehouseId?: string;
    page: number;
    pageSize: number;
  }): Promise<SyncRunsPaginatedResponse> {
    const data = await callAppRpc<unknown>(
      this.identity,
      'public.get_sync_runs_paginated',
      [params.warehouseId ?? null, params.page, params.pageSize],
    );
    const parsed = parseRpcPayload<Record<string, unknown>>(data);
    return {
      rows: (Array.isArray(parsed.rows) ? parsed.rows : []) as SyncRunsPaginatedResponse['rows'],
      total: (parsed.total as number) ?? 0,
      page: (parsed.page as number) ?? params.page,
      pageSize: (parsed.pageSize as number) ?? params.pageSize,
    };
  }

  async getSyncRunDetail(runId: string): Promise<SyncRunDetailResponse> {
    const data = await callAppRpc<unknown>(
      this.identity,
      'public.get_sync_run_detail',
      [runId],
    );
    if (data === null || data === 'null') return null;
    return parseRpcPayload<SyncRunDetailResponse>(data);
  }

  async cleanupExpiredSyncRuns(): Promise<number> {
    const count = await callSyncRpc<number>('public.cleanup_expired_sync_runs', []);
    return count ?? 0;
  }

  async getActiveRunIds(): Promise<Set<string>> {
    if (!(await this.isActiveAdmin())) {
      return new Set();
    }
    const rows = await queryAppRows<{ id: string }>(
      this.identity,
      `SELECT id::text AS id FROM public.sync_run WHERE status = 'in_progress'`,
    );
    return new Set(rows.map((r) => r.id));
  }

  async getRecentlyCompletedRunIds(since: Date): Promise<Set<string>> {
    if (!(await this.isActiveAdmin())) {
      return new Set();
    }
    const rows = await queryAppRows<{ id: string }>(
      this.identity,
      `SELECT id::text AS id FROM public.sync_run
       WHERE status = 'completed' AND finished_at >= $1::timestamptz`,
      [since.toISOString()],
    );
    return new Set(rows.map((r) => r.id));
  }

  async getReferencedDryRunIds(): Promise<Set<string>> {
    if (!(await this.isActiveAdmin())) {
      return new Set();
    }
    const rows = await queryAppRows<{ dry_run_run_id: string | null }>(
      this.identity,
      `SELECT dry_run_run_id::text AS dry_run_run_id FROM public.sync_run
       WHERE dry_run_run_id IS NOT NULL`,
    );
    return new Set(
      rows.map((r) => r.dry_run_run_id).filter((id): id is string => Boolean(id)),
    );
  }

  async getDryRunBindingMetadata(runId: string): Promise<DryRunBindingMetadata | null> {
    if (!(await this.isActiveAdmin())) {
      return null;
    }
    const rows = await queryAppRows<DryRunBindingMetadata>(
      this.identity,
      `SELECT id::text AS id, warehouse_id::text AS warehouse_id, mode, status,
              finished_at, plan_drift_check, input_artifact_hash, plan_artifact_hash
       FROM public.sync_run WHERE id = $1::uuid LIMIT 1`,
      [runId],
    );
    return rows[0] ?? null;
  }

  async getSyncLog(runId: string): Promise<SyncLogRecord | null> {
    const rows = await queryAppRows<{
      id: string;
      sync_run_id: string;
      warehouse_id: string;
      status: string;
      new_variants_count: number | null;
      error_message: string | null;
      started_at: string;
      finished_at: string | null;
    }>(
      this.identity,
      `SELECT id::text AS id, sync_run_id::text AS sync_run_id, warehouse_id::text AS warehouse_id,
              status, new_variants_count, error_message, started_at, finished_at
       FROM public.sync_log WHERE sync_run_id = $1::uuid LIMIT 1`,
      [runId],
    );
    const data = rows[0];
    if (!data) return null;
    return {
      id: data.id,
      syncRunId: data.sync_run_id,
      warehouseId: data.warehouse_id,
      status: data.status as 'success' | 'failed',
      newVariantsCount: data.new_variants_count ?? 0,
      errorMessage: data.error_message,
      startedAt: data.started_at,
      finishedAt: data.finished_at,
    };
  }

  async getWarehouseHistory(warehouseId: string): Promise<WarehouseHistory> {
    const runs = await queryAppRows<{
      id: string;
      mode: string;
      status: string;
      finished_at: string | null;
      result_summary: Record<string, unknown> | null;
    }>(
      this.identity,
      `SELECT id::text AS id, mode, status, finished_at, result_summary
       FROM public.sync_run
       WHERE warehouse_id = $1::uuid
       ORDER BY started_at DESC
       LIMIT 20`,
      [warehouseId],
    );
    const hasBaseline = runs.some((r) => r.status === 'completed');

    let consecutiveFailures = 0;
    for (const r of runs) {
      if (r.mode === 'dry_run' && r.status === 'failed') {
        consecutiveFailures++;
      } else {
        break;
      }
    }

    const lastSuccessRun = runs.find((r) => r.status === 'completed');
    const lastSuccess = lastSuccessRun
      ? {
          finishedAt: lastSuccessRun.finished_at ?? '',
          newVariantsCount:
            ((lastSuccessRun.result_summary as Record<string, unknown> | null)
              ?.variantsCreated as number) ?? 0,
        }
      : null;

    const completedRuns = runs.filter((r) => r.status === 'completed').slice(0, 5);

    let stats: WarehouseHistory['stats'] = null;
    if (completedRuns.length > 0 && hasBaseline) {
      let sumRaw = 0;
      let sumValid = 0;
      let sumInvalid = 0;
      let sumVariants = 0;
      for (const r of completedRuns) {
        const rs = r.result_summary ?? {};
        sumRaw += (rs.rawRowCount as number) ?? 0;
        sumValid += (rs.validSkuCount as number) ?? 0;
        sumInvalid += (rs.invalidSkuCount as number) ?? 0;
        sumVariants += (rs.variantsCreated as number) ?? 0;
      }
      const n = completedRuns.length;
      stats = {
        avgRawRowCount: sumRaw / n,
        avgValidSkuCount: sumValid / n,
        avgInvalidSkuCount: sumInvalid / n,
        avgVariantsCreated: sumVariants / n,
      };
    }

    return { hasBaseline, consecutiveFailures, lastSuccess, stats };
  }

  async getSyncWarehouseOverview(): Promise<SyncWarehouseOverviewItem[]> {
    const raw = await callAppRpc<unknown>(
      this.identity,
      'public.get_sync_warehouse_overview',
      [],
    );
    return mapSyncWarehouseOverviewRows(raw);
  }
}
