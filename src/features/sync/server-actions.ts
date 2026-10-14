'use server';

// Sync Feature Module — 顶层 Server Actions (P5-SY5D)
//
// 通过 createSyncActions 工厂组合 mock 依赖，导出页面可调用的 Server Actions。
// 页面通过此边界调用同步能力，不直接实例化 Repository / Provider / Runner。
// 真实 Provider / Runner / Repository 就绪后替换 mock 依赖即可。

import { createSyncActions } from './actions';
import { createSyncService } from './sync-service';
import { SupabaseSyncRepository } from './supabase-repository';
import { FileSystemArtifactProvider } from './file-system-artifact-provider';
import { RealSyncRunner, type WarehouseBridgeInfo } from './real-sync-runner';
import { WebInputArtifactSource, isWebsyncRealWriteEnabled } from './web-input-artifact-source';
import { evaluateRules } from './rules-engine';
import { getSyncRunsSchema, getSyncRunsPaginatedSchema, getSyncRunDetailSchema, getSyncLogDetailSchema } from './schema';
import { revalidatePath } from 'next/cache';
import { requireActiveAdmin, requireActiveAuth } from '@/lib/auth';
import { callAppRpc, queryAppRows } from '@/lib/database/app-db';
import { requireAppDbIdentity } from '@/lib/database/app-identity';
import { isIndependentPlatformRuntime } from '@/lib/database/runtime';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { PostgresSyncRepository } from './postgres-sync-repository';
import { mapSyncWarehouseOverviewRows } from './map-sync-warehouse-overview';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import type { SyncRunsResponse, SyncRunsPaginatedResponse, SyncRunDetailResponse, SessionHealthResult, TriggerDryRunResult, ConfirmRealWriteResult, BatchDryRunResult, BatchRealWriteResult, BatchRealWriteItem, SyncLogRecord, WarehouseSyncStatus, AutoPreReviewResult, AutoPreReviewItem, WarehouseHistory, RuleVerdict, SyncWarehouseOverviewItem } from './types';

// ─── Per-request dependency wiring ───────────────────────────────

async function createSyncRepository() {
  if (isIndependentPlatformRuntime()) {
    const identity = await requireAppDbIdentity();
    return new PostgresSyncRepository(identity);
  }
  return new SupabaseSyncRepository(
    await createClient(),
    await createServiceClient(),
  );
}

/** 真实同步管线：RealSyncRunner + FileSystemArtifactProvider + WebInputArtifactSource
 *  调用 Python 桥接执行 BigSeller 抓取 + Supabase RPC 写入。
 *
 *  P5-SY9C: 生产路径已移除 MockArtifactProvider 和 mockInputArtifactSource。
 *  通过 WEBSYNC_REAL_WRITE_ENABLED feature gate 控制真实写入入口。
 *  P5-SY9E heartbeat/timeout 完成且 P5-SY9I 独立验收通过后才允许启用。 */
async function wireRealActions(warehouses: WarehouseBridgeInfo[]) {
  const repository = await createSyncRepository();
  const artifactProvider = new FileSystemArtifactProvider();
  const runner = new RealSyncRunner(warehouses);
  const inputArtifactSource = new WebInputArtifactSource(warehouses);
  const syncService = createSyncService({
    repository,
    artifactProvider,
    runner,
  });

  return createSyncActions({
    repository,
    syncService,
    inputArtifactSource,
    artifactProvider, // P5-SY9D rework: confirmRealWrite 加载绑定 artifact 使用
  });
}

// ─── Exported Server Actions ─────────────────────────────────────

export async function getSyncRuns(
  warehouseId?: string,
  limit?: number,
): Promise<SyncRunsResponse> {
  await requireActiveAuth();
  const repository = await createSyncRepository();
  const parsed = getSyncRunsSchema.parse({ warehouseId, limit });
  return repository.getSyncRuns({
    warehouseId: parsed.warehouseId,
    limit: parsed.limit,
  });
}

/** Phase D: 服务端分页查询同步运行列表。
 *  返回 { rows, total, page, pageSize }，替换客户端分页。
 *  Admin 和 Operator 均可调用，角色感知脱敏由 RPC 处理。 */
export async function getSyncRunsPaginated(
  warehouseId?: string,
  page?: number,
  pageSize?: number,
): Promise<SyncRunsPaginatedResponse> {
  await requireActiveAuth();
  const repository = await createSyncRepository();
  const parsed = getSyncRunsPaginatedSchema.parse({ warehouseId, page, pageSize });
  return repository.getSyncRunsPaginated({
    warehouseId: parsed.warehouseId,
    page: parsed.page,
    pageSize: parsed.pageSize,
  });
}

export async function getSyncRunDetail(
  runId: string,
): Promise<SyncRunDetailResponse> {
  await requireActiveAuth();
  const repository = await createSyncRepository();
  const parsed = getSyncRunDetailSchema.parse({ runId });
  return repository.getSyncRunDetail(parsed.runId);
}

// CLEANUP-CANDIDATE: triggerSync uses PH-only FormData schema.
// This is a legacy path disabled since P5-SY9C. Remove after P5-SY9I passes review.
export async function triggerSync(
  _formData: FormData,
): Promise<{ success: boolean; runId: string; status: string; error?: string }> {
  void _formData;
  await requireActiveAdmin();
  // P5-SY9C: 旧版 FormData 同步路径已禁用。
  // 在构造 SyncService 之前直接返回中文错误，
  // 不通过 MockSyncRunner 间接触发生产 guard。
  return {
    success: false,
    runId: '',
    status: 'failed',
    error: '旧版 FormData 同步路径已禁用，请使用一键同步功能。',
  };
}

const COUNTRY_TOKEN_MAP: Record<string, string> = {
  PH: 'P5-SY3B-PH',
  VN: 'P5-SY8B-VN',
  TH: 'P5-SY8D-TH',
  MY: 'P5-SY8F-MY',
  ID: 'P5-SY8H-ID',
};

// P5-SY9 batch write 2026-06-24: PH/VN/TH names changed in BigSeller.
// DB names already match BigSeller UI names; oldName passed as current name.
const COUNTRY_OLDNAME_MAP: Record<string, string> = {
  PH: '菲律宾-新创启辰自建仓',
  VN: '越南青林湾仓库',
  TH: 'DEE-龙仔厝（ICE专属）',
  MY: '喜运达MY仓',
  ID: '印尼-DEE仓库',
};

async function getOverseasWarehouses(): Promise<
  Array<{ id: string; name: string; country: string; token: string }>
> {
  let rows: Array<{ id: string; name: string; country: string }>;
  if (isIndependentPlatformRuntime()) {
    const identity = await requireAppDbIdentity();
    rows = await queryAppRows<{ id: string; name: string; country: string }>(
      identity,
      `SELECT id::text AS id, name, country
       FROM public.warehouse
       WHERE type = 'overseas' AND is_active = true
       ORDER BY country`,
    );
  } else {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from('warehouse')
      .select('id, name, country')
      .eq('type', 'overseas')
      .eq('is_active', true)
      .order('country');

    if (error) throw new Error(`获取海外仓列表失败: ${error.message}`);
    rows = data ?? [];
  }

  if (rows.length === 0) throw new Error('未找到活跃海外仓');

  return rows.map((w) => ({
    id: w.id,
    name: w.name,
    country: w.country,
    token: COUNTRY_TOKEN_MAP[w.country] ?? '',
  }));
}

/** 获取海外仓选项列表（供前端筛选和触发同步使用） */
export async function getOverseasWarehouseOptions(): Promise<
  Array<{ id: string; name: string; country: string }>
> {
  await requireActiveAuth();
  const warehouses = await getOverseasWarehouses();
  return warehouses.map(({ id, name, country }) => ({ id, name, country }));
}

/** PERF-D-OVERVIEW: 获取全量仓库同步概览（服务端聚合）。
 *  Admin 返回全部活跃海外仓，Operator 仅返回已分配仓库。
 *  无外部输入，内部调用 get_sync_warehouse_overview RPC。 */
export async function getSyncWarehouseOverview(): Promise<SyncWarehouseOverviewItem[]> {
  const user = await requireActiveAuth();
  if (isIndependentPlatformRuntime()) {
    const raw = await callAppRpc<unknown>(
      { profileUserId: user.id },
      'public.get_sync_warehouse_overview',
      [],
    );
    return mapSyncWarehouseOverviewRows(raw);
  }
  const repository = await createSyncRepository();
  return repository.getSyncWarehouseOverview();
}

// ─── 一键同步（自动 dry_run → real_write 链式调用）────────────────

function toWarehouseBridgeInfo(
  warehouses: Awaited<ReturnType<typeof getOverseasWarehouses>>,
): WarehouseBridgeInfo[] {
  return warehouses.map((w) => ({
    id: w.id,
    name: w.name,
    oldName: COUNTRY_OLDNAME_MAP[w.country] ?? w.name,
    country: w.country,
    token: w.token,
  }));
}

// P5-SY9K rework: 旧快速同步入口已永久禁用。
// syncWarehouse 原先自动串联 dry_run → real_write，
// 违反"Dry Run → 审核 → 确认写入"安全流程。
// 请使用 triggerDryRun → 审核 → confirmRealWrite 代替。
export async function syncWarehouse(warehouseId: string): Promise<{
  warehouseId: string;
  warehouseName: string;
  success: boolean;
  runId: string;
  status: string;
  error?: string;
  dryRunRunId?: string;
}> {
  await requireActiveAdmin();
  return {
    warehouseId,
    warehouseName: '旧快速同步入口已禁用',
    success: false,
    runId: '',
    status: 'failed',
    error: '旧快速同步入口已禁用，请使用 Dry Run → 审核 → 确认写入流程。',
  };
}

// ─── P5-SY9D: 单仓 Dry Run（仅审核，不自动链 Real Write）──────────

export async function triggerDryRun(warehouseId: string): Promise<TriggerDryRunResult> {
  await requireActiveAdmin();

  // ── Session health guard (P5-SY9B) ──────────────────────────
  const health = await verifyBigSellerSession();
  if (health.status !== 'healthy') {
    return {
      warehouseId,
      warehouseName: '会话异常',
      success: false,
      runId: '',
      status: 'failed',
      error: `BigSeller 登录会话不可用：${health.message}`,
    };
  }

  const warehouses = await getOverseasWarehouses();
  const wh = warehouses.find((w) => w.id === warehouseId);
  if (!wh) {
    return { warehouseId, warehouseName: '未知仓库', success: false, runId: '', status: 'failed', error: '未知仓库 ID' };
  }
  const actions = await wireRealActions(toWarehouseBridgeInfo(warehouses));
  const result = await actions.triggerDryRun(warehouseId, wh.name);
  if (result.success) {
    revalidatePath('/dashboard/inventory/overseas');
  }
  return result;
}

// ─── P5-SY9D: 确认 Real Write（绑定已完成 Dry Run） ──────────────

export async function confirmRealWrite(
  warehouseId: string,
  dryRunRunId: string,
): Promise<ConfirmRealWriteResult> {
  await requireActiveAdmin();

  // ── Session health guard (P5-SY9B) ──────────────────────────
  const health = await verifyBigSellerSession();
  if (health.status !== 'healthy') {
    return {
      warehouseId,
      warehouseName: '会话异常',
      success: false,
      runId: '',
      status: 'failed',
      error: `BigSeller 登录会话不可用：${health.message}`,
      dryRunRunId,
    };
  }

  // ── Feature gate (P5-SY9C) ──────────────────────────────────
  if (!isWebsyncRealWriteEnabled()) {
    return {
      warehouseId,
      warehouseName: '功能未开放',
      success: false,
      runId: '',
      status: 'failed',
      error: 'Web 同步真实写入功能尚未启用。请等待 P5-SY9E heartbeat/timeout 完成并通过 P5-SY9I 独立验收。',
      dryRunRunId,
    };
  }

  const warehouses = await getOverseasWarehouses();
  const wh = warehouses.find((w) => w.id === warehouseId);
  if (!wh) {
    return { warehouseId, warehouseName: '未知仓库', success: false, runId: '', status: 'failed', error: '未知仓库 ID', dryRunRunId };
  }
  const actions = await wireRealActions(toWarehouseBridgeInfo(warehouses));
  const result = await actions.confirmRealWrite(warehouseId, wh.name, wh.country, dryRunRunId, wh.token);
  if (result.success) {
    revalidatePath('/dashboard/inventory/overseas');
  }
  return result;
}

// ─── P5-SY9F: 批量全部海外仓 Dry Run ────────────────────────────

export async function triggerBatchDryRun(): Promise<BatchDryRunResult> {
  await requireActiveAdmin();

  // ── Session health guard (P5-SY9B) ──────────────────────────
  const health = await verifyBigSellerSession();
  if (health.status !== 'healthy') {
    return {
      results: [],
      allSucceeded: false,
      successCount: 0,
      failedCount: 0,
      blockedCount: 0,
      blockReason: `BigSeller 登录会话不可用：${health.message}`,
    };
  }

  const warehouses = await getOverseasWarehouses();
  const actions = await wireRealActions(toWarehouseBridgeInfo(warehouses));
  const result = await actions.triggerBatchDryRun(
    warehouses.map((w) => ({ id: w.id, name: w.name, country: w.country })),
  );

  if (result.results.some((r) => r.status === 'ready')) {
    revalidatePath('/dashboard/inventory/overseas');
  }

  return result;
}

// ─── P5-SY10C: 自动预审编排 ───────────────────────────────────

/** 自动预审编排：串联 session health → 批量 Dry Run → 逐仓历史 + 规则评估。
 *  仅 Admin 可调用。PASS 仍需走人工审核 + confirmRealWrite，不自动写库。
 *  返回各仓预审结果（含 Dry Run 状态、历史上下文、规则决策），
 *  BLOCK 仓库不能进入后续批量真实写入候选。 */
export async function runAutoPreReview(): Promise<AutoPreReviewResult> {
  await requireActiveAdmin();

  // ── Session health guard ─────────────────────────────────────
  const health = await verifyBigSellerSession();
  if (health.status !== 'healthy') {
    return {
      items: [],
      summary: { total: 0, pass: 0, warn: 0, block: 0, failed: 0 },
      sessionHealth: health,
      blockReason: `BigSeller 登录会话不可用：${health.message}`,
    };
  }

  const warehouses = await getOverseasWarehouses();
  const actions = await wireRealActions(toWarehouseBridgeInfo(warehouses));
  const result = await actions.runAutoPreReview(
    warehouses.map((w) => ({ id: w.id, name: w.name, country: w.country })),
    health,
  );

  if (result.items.some((i) => i.dryRun.status === 'ready')) {
    revalidatePath('/dashboard/inventory/overseas');
  }

  return result;
}

// ─── P5-SY10E rework: 定时自动预审（Cron Route Handler 调用）─────────

/** 定时任务触发的自动预审编排。
 *  使用 CRON_API_KEY 鉴权（不依赖用户 session）。
 *  仅触发 Dry Run + 规则评估，不调用 Real Write。
 *
 *  P5-SY10E rework: 不再通过 createSyncActions 工厂（该工厂强制 requireActiveAdmin）。
 *  直接构造带 _systemClaimConfig 的 SyncService，使用 service_role
 *  claim_sync_run_system RPC 替代 auth.uid() 绑定的 claim_sync_run。
 *
 *  system path 能力仅在此函数内存在，不暴露给普通 Web/Admin 调用路径。
 *
 *  由 Vercel Cron GET /api/cron/dry-run 调用。
 *  Admin 手动触发请使用 runAutoPreReview()。 */
export async function runScheduledAutoPreReview(
  apiKey: string,
): Promise<AutoPreReviewResult> {
  // ── API key 鉴权 ────────────────────────────────────────────
  const configuredKey = process.env.CRON_API_KEY;
  if (!configuredKey) {
    throw new Error('CRON_API_KEY 环境变量未配置');
  }
  if (apiKey !== configuredKey) {
    throw new Error('CRON_API_KEY 无效');
  }

  // ── 系统触发者 ID ──────────────────────────────────────────
  const triggeredBy = process.env.CRON_SYSTEM_USER_ID;
  if (!triggeredBy) {
    throw new Error('CRON_SYSTEM_USER_ID 环境变量未配置');
  }

  // ── Session health guard（core 版本，无 requireActiveAdmin）─
  const health = await _verifyBigSellerSessionCore();
  if (health.status !== 'healthy') {
    return {
      items: [],
      summary: { total: 0, pass: 0, warn: 0, block: 0, failed: 0 },
      sessionHealth: health,
      blockReason: `BigSeller 登录会话不可用：${health.message}`,
    };
  }

  // ── 仓库列表 ───────────────────────────────────────────────
  const warehouses = await getOverseasWarehouses();
  const bridgeInfo = toWarehouseBridgeInfo(warehouses);

  // ── 系统 claim wiring（不经过 createSyncActions）─────────
  const repository = await createSyncRepository();
  const artifactProvider = new FileSystemArtifactProvider();
  const runner = new RealSyncRunner(bridgeInfo);
  const inputArtifactSource = new WebInputArtifactSource(bridgeInfo);
  const systemSyncService = createSyncService({
    repository,
    artifactProvider,
    runner,
    _systemClaimConfig: { enabled: true, triggeredBy },
  });

  // ── 逐仓预取历史上下文（在 Dry Run 之前）────────────────
  const preRunHistory = new Map<string, { history: WarehouseHistory | null; error?: string }>();
  for (const wh of warehouses) {
    try {
      const history = await repository.getWarehouseHistory(wh.id);
      preRunHistory.set(wh.id, { history });
    } catch (err) {
      preRunHistory.set(wh.id, { history: null, error: (err as Error).message });
    }
  }

  // ── 执行批量 Dry Run（逐仓，system claim）───────────────
  const dryRunResults: Array<{
    whId: string;
    whName: string;
    whCountry: string;
    runId: string;
    status: 'ready' | 'failed' | 'blocked';
    failureReason?: string;
    rawRowCount: number;
    validSkuCount: number;
    invalidSkuCount: number;
    variantsCreated: number;
    inventoryInserted: number;
    inventoryUpdated: number;
    inventoryUnchanged: number;
    planDriftCheck: 'PASS' | 'DRIFT_DETECTED' | null;
    planDriftCount: number;
    warehouseRenamePlan: AutoPreReviewItem['dryRun']['warehouseRenamePlan'];
  }> = [];

  for (const wh of warehouses) {
    try {
      const inputArtifact = await inputArtifactSource.getInputArtifact(wh.id, 'dry_run');
      const dryRunResult = await systemSyncService.executeSync({
        warehouseId: wh.id,
        mode: 'dry_run',
        inputArtifact,
        triggeredBy,
      });

      if (dryRunResult.status !== 'completed') {
        dryRunResults.push({
          whId: wh.id,
          whName: wh.name,
          whCountry: wh.country,
          runId: dryRunResult.runId,
          status: 'failed',
          failureReason: dryRunResult.error || 'Dry Run 失败',
          rawRowCount: 0,
          validSkuCount: 0,
          invalidSkuCount: 0,
          variantsCreated: 0,
          inventoryInserted: 0,
          inventoryUpdated: 0,
          inventoryUnchanged: 0,
          planDriftCheck: null,
          planDriftCount: 0,
          warehouseRenamePlan: null,
        });
        continue;
      }

      const summary = dryRunResult.runnerResult?.summary;
      const planContent = dryRunResult.runnerResult?.planArtifact as Record<string, unknown> | undefined;
      const scraperMeta = dryRunResult.runnerResult?.scraperMeta;
      const planDriftCheck = dryRunResult.runnerResult?.planDriftCheck ?? 'PASS';
      const renameRequired = planContent?.warehouse_rename_required as Record<string, unknown> | undefined;

      let warehouseRenamePlan: AutoPreReviewItem['dryRun']['warehouseRenamePlan'] = null;
      if (renameRequired) {
        warehouseRenamePlan = {
          action: (renameRequired.action === 'rename' ? 'rename' : 'none') as 'rename' | 'none',
          currentName: renameRequired.current_name as string | undefined,
          targetName: renameRequired.target_name as string | undefined,
          message: renameRequired.message as string | undefined,
        };
      }

      const isBlocked = planDriftCheck !== 'PASS';

      dryRunResults.push({
        whId: wh.id,
        whName: wh.name,
        whCountry: (planContent?.country as string) || wh.country,
        runId: dryRunResult.runId,
        status: isBlocked ? 'blocked' : 'ready',
        failureReason: isBlocked ? `计划漂移未通过（plan_drift_check=${planDriftCheck}，${dryRunResult.runnerResult?.planDriftCount ?? 0} 项差异）` : undefined,
        rawRowCount: scraperMeta?.rawRowCount ?? 0,
        validSkuCount: scraperMeta?.validSkuCount ?? 0,
        invalidSkuCount: scraperMeta?.invalidSkuCount ?? 0,
        variantsCreated: summary?.variantsCreated ?? 0,
        inventoryInserted: summary?.inventoryInserted ?? 0,
        inventoryUpdated: summary?.inventoryUpdated ?? 0,
        inventoryUnchanged: summary?.inventoryUnchanged ?? 0,
        planDriftCheck,
        planDriftCount: dryRunResult.runnerResult?.planDriftCount ?? 0,
        warehouseRenamePlan,
      });
    } catch (err) {
      dryRunResults.push({
        whId: wh.id,
        whName: wh.name,
        whCountry: wh.country,
        runId: '',
        status: 'failed',
        failureReason: `Dry Run 异常: ${(err as Error).message}`,
        rawRowCount: 0,
        validSkuCount: 0,
        invalidSkuCount: 0,
        variantsCreated: 0,
        inventoryInserted: 0,
        inventoryUpdated: 0,
        inventoryUnchanged: 0,
        planDriftCheck: null,
        planDriftCount: 0,
        warehouseRenamePlan: null,
      });
    }
  }

  // ── 逐仓规则评估 ─────────────────────────────────────────
  const items: AutoPreReviewItem[] = [];
  for (const dr of dryRunResults) {
    const cached = preRunHistory.get(dr.whId);

    let history: WarehouseHistory;
    let ruleVerdict: RuleVerdict;

    if (cached?.history) {
      history = cached.history;
      ruleVerdict = evaluateRules({
        sessionHealth: health,
        dryRun: {
          status: dr.status,
          planDriftCheck: dr.planDriftCheck,
          rawRowCount: dr.rawRowCount,
          validSkuCount: dr.validSkuCount,
          invalidSkuCount: dr.invalidSkuCount,
          variantsCreated: dr.variantsCreated,
          inventoryInserted: dr.inventoryInserted,
          inventoryUpdated: dr.inventoryUpdated,
          inventoryUnchanged: dr.inventoryUnchanged,
          warehouseRenamePlan: dr.warehouseRenamePlan ?? null,
          failureReason: dr.failureReason,
        },
        history,
      });
    } else {
      history = {
        hasBaseline: false,
        consecutiveFailures: 0,
        lastSuccess: null,
        stats: null,
      };
      ruleVerdict = {
        decision: 'BLOCK',
        evaluations: [
          {
            rule: 'history_unavailable',
            level: 'BLOCK',
            message: `历史上下文读取失败，无法安全预审${cached?.error ? `：${cached.error}` : ''}`,
          },
        ],
        summary: '1 项阻断',
      };
    }

    items.push({
      warehouseId: dr.whId,
      warehouseName: dr.whName,
      country: dr.whCountry,
      dryRun: {
        status: dr.status,
        runId: dr.runId,
        failureReason: dr.failureReason,
        rawRowCount: dr.rawRowCount,
        validSkuCount: dr.validSkuCount,
        invalidSkuCount: dr.invalidSkuCount,
        variantsCreated: dr.variantsCreated,
        inventoryInserted: dr.inventoryInserted,
        inventoryUpdated: dr.inventoryUpdated,
        inventoryUnchanged: dr.inventoryUnchanged,
        planDriftCheck: dr.planDriftCheck,
        planDriftCount: dr.planDriftCount,
        warehouseRenamePlan: dr.warehouseRenamePlan,
      },
      history,
      ruleVerdict,
    });
  }

  // ── 汇总统计 ─────────────────────────────────────────────
  if (items.some((i) => i.dryRun.status === 'ready')) {
    revalidatePath('/dashboard/inventory/overseas');
  }

  return {
    items,
    summary: {
      total: items.length,
      pass: items.filter((i) => i.ruleVerdict.decision === 'PASS').length,
      warn: items.filter((i) => i.ruleVerdict.decision === 'WARN').length,
      block: items.filter((i) => i.ruleVerdict.decision === 'BLOCK').length,
      failed: items.filter((i) => i.dryRun.status === 'failed').length,
    },
    sessionHealth: health,
  };
}

// ─── P5-SY9G: 批量审核后真实写入 ────────────────────────────

export async function triggerBatchRealWrite(
  items: BatchRealWriteItem[],
  confirmationPhrase: string,
): Promise<BatchRealWriteResult> {
  await requireActiveAdmin();

  // ── Session health guard (P5-SY9B) ──────────────────────────
  const health = await verifyBigSellerSession();
  if (health.status !== 'healthy') {
    return {
      results: [],
      allSucceeded: false,
      successCount: 0,
      failedCount: 0,
      skippedCount: 0,
      blockReason: `BigSeller 登录会话不可用：${health.message}`,
    };
  }

  // ── Feature gate (P5-SY9C) ──────────────────────────────────
  // Web 真实写入入口保持 server-side disabled，直到 P5-SY9E
  // heartbeat/timeout 完成且 P5-SY9I 独立验收通过后才允许启用。
  if (!isWebsyncRealWriteEnabled()) {
    return {
      results: [],
      allSucceeded: false,
      successCount: 0,
      failedCount: 0,
      skippedCount: 0,
      blockReason: 'Web 同步真实写入功能尚未启用。请等待 P5-SY9E heartbeat/timeout 完成并通过 P5-SY9I 独立验收。',
    };
  }

  const warehouses = await getOverseasWarehouses();
  const actions = await wireRealActions(toWarehouseBridgeInfo(warehouses));

  // Populate confirmToken server-side from COUNTRY_TOKEN_MAP.
  // Client must not send tokens — they are derived from warehouse country.
  const populatedItems = items.map((item) => ({
    ...item,
    confirmToken: COUNTRY_TOKEN_MAP[item.country] ?? '',
  }));

  const result = await actions.triggerBatchRealWrite(populatedItems, confirmationPhrase);

  if (result.results.some((r) => r.status === 'success')) {
    revalidatePath('/dashboard/inventory/overseas');
  }

  return result;
}

// P5-SY9K rework: 旧批量同步入口已永久禁用。
// syncAllWarehouses 原先逐个调用 syncWarehouse（自动串联 dry_run → real_write），
// 违反"Dry Run → 审核 → 确认写入"安全流程。
// 请使用 triggerBatchDryRun → 审核 → triggerBatchRealWrite 代替。
export async function syncAllWarehouses(): Promise<{
  results: Array<{
    warehouseId: string;
    warehouseName: string;
    success: boolean;
    runId: string;
    status: string;
    error?: string;
    dryRunRunId?: string;
  }>;
  allSuccess: boolean;
}> {
  await requireActiveAdmin();
  return {
    results: [{
      warehouseId: 'all',
      warehouseName: '全部海外仓',
      success: false,
      runId: '',
      status: 'failed',
      error: '旧批量同步入口已禁用，请使用批量 Dry Run → 审核 → 批量确认写入流程。',
    }],
    allSuccess: false,
  };
}

// ─── 重新建立 BigSeller 登录会话 ────────────────────────────────

/** 在服务器上打开 headed Chrome，让管理员手动完成 BigSeller 登录和验证码。
 *  登录成功后 session cookie 会被持久化，后续网页端 headless 同步即可正常使用。
 *  仅在服务器有桌面环境时可用。 */
export async function establishBigSellerSession(): Promise<{
  success: boolean;
  message: string;
}> {
  await requireActiveAdmin();

  // Vercel Functions 没有可交互桌面，也不提供本项目所需的 Python/Chromium
  // 运行时。此操作只能在安装了同步运行时的桌面主机上执行。
  if (process.env.VERCEL) {
    return {
      success: false,
      message:
        '当前页面运行在 Vercel 云端，无法启动本机 Python 或弹出桌面 Chrome。' +
        '请在安装了 Python、Playwright 和 Chrome 的同步主机上建立 BigSeller 登录会话。',
    };
  }

  const projectRoot = path.resolve(process.cwd());
  const logDir = path.join(projectRoot, 'tools', 'bigseller-scraper', 'runtime');
  const logFile = path.join(logDir, 'session-establish.log');
  const lockFile = path.join(logDir, 'session-establish.lock');
  const pythonExecutable = process.env.PYTHON_EXECUTABLE?.trim() || 'python';
  let ownsLock = false;
  let logFd: number | null = null;

  const cleanupLock = () => {
    if (!ownsLock) return;
    try { fs.unlinkSync(lockFile); } catch { /* ignore */ }
    ownsLock = false;
  };

  const closeLogFd = () => {
    if (logFd === null) return;
    try { fs.closeSync(logFd); } catch { /* ignore */ }
    logFd = null;
  };

  try {
    fs.mkdirSync(logDir, { recursive: true });

    // 防重复：如果已有会话建立进程在运行，拒绝再次启动
    if (fs.existsSync(lockFile)) {
      const lockAge = Date.now() - fs.statSync(lockFile).mtimeMs;
      // 超过 10 分钟的锁文件视为过期（进程可能已异常退出）
      if (lockAge < 10 * 60 * 1000) {
        return {
          success: false,
          message:
            '登录会话建立进程已在运行中，请在已打开的 Chrome 窗口中完成登录。' +
            '如果确认没有 Chrome 窗口打开，请等待 10 分钟后重试。',
        };
      }
      // 清理过期锁
      fs.unlinkSync(lockFile);
    }

    fs.writeFileSync(lockFile, '', 'utf-8');
    ownsLock = true;

    // 将之前日志截断，保留最近一次
    logFd = fs.openSync(logFile, 'w');

    // detached spawn — 只等待操作系统确认子进程成功启动，不等待登录完成。
    // stdout/stderr 写入日志文件，便于排查 session 持久化是否成功。
    const proc = spawn(pythonExecutable, [
      '-m', 'tools.bigseller-scraper.bigseller_scraper',
    ], {
      cwd: projectRoot,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: {
        ...process.env,
        BS_HEADLESS: '0',
        BS_SESSION_ONLY: '1',
        PYTHONIOENCODING: 'utf-8',
      },
    });

    // Python 进程退出或后续异常时清理锁文件。
    proc.once('close', cleanupLock);

    const launchResult = await new Promise<
      { success: true } | { success: false; error: Error }
    >((resolve) => {
      proc.once('spawn', () => resolve({ success: true }));
      proc.once('error', (error: Error) => {
        cleanupLock();
        resolve({ success: false, error });
      });
    });

    // spawn 成功后子进程已继承日志句柄；父进程可以安全关闭自己的句柄。
    closeLogFd();

    if (!launchResult.success) {
      return {
        success: false,
        message:
          `无法启动登录会话进程：${launchResult.error.message}。` +
          '请确认 PYTHON_EXECUTABLE 指向可用的 Python，并在支持桌面 Chrome 的同步主机上重试。',
      };
    }

    proc.unref();

    return {
      success: true,
      message:
        '已在服务器上打开 Chrome 浏览器，请在浏览器中完成 BigSeller 登录和验证码。' +
        '登录完成后浏览器会自动关闭，session cookie 将被持久化，之后网页端同步即可正常使用。' +
        `（日志: ${logFile}）`,
    };
  } catch (error) {
    closeLogFd();
    cleanupLock();
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: `无法建立 BigSeller 登录会话：${message}`,
    };
  }
}

// ─── P5-SY9H: 海外仓同步状态（供海外库存页使用）───────────────

/** 获取每个海外仓的最新同步状态摘要。
 *  调用 getSyncRuns 获取全部运行记录，按 warehouse_id 分组取最新状态。
 *  Admin 和 Operator 均可查看。 */
export async function getOverseasWarehouseSyncStatus(): Promise<
  Record<string, WarehouseSyncStatus>
> {
  const user = await requireActiveAuth();
  const repository = await createSyncRepository();
  const runs = await repository.getSyncRuns({ limit: 100 });

  // P5-SY13A: 获取已分配仓库 ID，operator 仅看到已分配仓库的同步状态
  const { warehouseAccessRepository } = await import('@/features/warehouse-access/repository');
  const accessibleWhIds = await warehouseAccessRepository.getAccessibleWarehouseIds(user.id);

  const statusMap: Record<string, WarehouseSyncStatus> = {};

  for (const run of runs) {
    // P5-SY13A: 跳过不可访问仓库的运行（空分配→无结果）
    if (!accessibleWhIds.has(run.warehouse_id)) continue;

    const existing = statusMap[run.warehouse_id];
    const runTime = run.finished_at ?? run.started_at ?? run.created_at;
    const existingTime = existing?.lastSyncAt;

    // Keep the most recent run per warehouse
    if (!existing || (runTime && existingTime && runTime > existingTime)) {
      const syncStatus: WarehouseSyncStatus['lastSyncStatus'] =
        run.status === 'completed'
          ? 'success'
          : run.status === 'in_progress'
            ? 'in_progress'
            : 'failed';

      const failureReason =
        run.status === 'failed'
          ? 'error_message' in run
            ? (run as import('./types').SyncRunAdminRow).error_message
            : (run as import('./types').SyncRunOperatorRow).failure_summary
          : null;

      statusMap[run.warehouse_id] = {
        lastSyncStatus: syncStatus,
        lastSyncAt: runTime ?? null,
        lastFailureReason: failureReason ?? null,
      };
    }
  }

  return statusMap;
}

// ─── P5-SY9H: sync_log 详情（供详情 Sheet 展示）─────────────────

/** 获取 sync_log 记录（通过 sync_run_id 关联）。
 *  使用 serviceClient 直接查询 public.sync_log，仅供详情 Sheet 展示。
 *  P5-SY13A: 应用层补强仓库权限校验 — operator 仅可查看已分配仓库的 sync_log。
 *  serviceClient 绕过 RLS，必须在返回前通过 warehouseAccessRepository 校验权限。 */
export async function getSyncLogDetail(
  runId: string,
): Promise<SyncLogRecord | null> {
  const user = await requireActiveAuth();
  const repository = await createSyncRepository();
  const parsed = getSyncLogDetailSchema.parse({ runId });
  const log = await repository.getSyncLog(parsed.runId);
  if (!log) return null;

  // P5-SY13A: 校验 operator 是否可访问该仓库的 sync_log
  const { warehouseAccessRepository } = await import('@/features/warehouse-access/repository');
  const canAccess = await warehouseAccessRepository.canAccessWarehouse(user.id, log.warehouseId);
  if (!canAccess) return null;

  return log;
}

// ─── BigSeller 会话健康检查 (P5-SY9B) ──────────────────────────

const HEALTH_CHECK_TIMEOUT_MS = 60_000;

/** 核心会话健康检查实现（不含权限校验）。
 *  供 verifyBigSellerSession() 和定时任务 Route Handler 共用。
 *  不执行任何写入、抓取或同步操作。 */
async function _verifyBigSellerSessionCore(): Promise<SessionHealthResult> {
  const projectRoot = path.resolve(process.cwd());

  return new Promise<SessionHealthResult>((resolve) => {
    const proc = spawn('python', [
      '-m', 'tools.bigseller-scraper.sync.health_check',
    ], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });

    let stdout = '';
    let stderr = '';

    const timeoutId = setTimeout(() => {
      proc.kill('SIGTERM');
    }, HEALTH_CHECK_TIMEOUT_MS);

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });

    proc.on('close', (code: number | null) => {
      clearTimeout(timeoutId);

      const lines = stdout
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

      const lastJsonLine = lines.at(-1);
      if (!lastJsonLine) {
        if (stderr) {
          console.error('[verifyBigSellerSession] stderr:', stderr);
        }
        resolve({
          status: 'unknown_error',
          message: '会话健康检查无输出，Python 子进程可能启动失败。请检查服务器环境和 Playwright/Chrome 安装。',
          checkedAt: new Date().toISOString(),
        });
        return;
      }

      try {
        const raw = JSON.parse(lastJsonLine) as Record<string, unknown>;
        // Python 输出 checked_at (snake_case)，统一转换为 TypeScript 契约的 checkedAt (camelCase)
        const result: SessionHealthResult = {
          status: (raw.status as SessionHealthResult['status']) ?? 'unknown_error',
          message: (raw.message as string) ?? '',
          checkedAt: (raw.checked_at as string) ?? (raw.checkedAt as string) ?? new Date().toISOString(),
          details: (raw.details as Record<string, unknown>) ?? {},
        };
        if (stderr) {
          console.log('[verifyBigSellerSession]', stderr.split('\n').slice(-3).join('\n'));
        }
        resolve(result);
      } catch {
        resolve({
          status: 'unknown_error',
          message: `会话健康检查输出解析失败（exit=${code}）。请检查 Python 环境和依赖。`,
          checkedAt: new Date().toISOString(),
        });
      }
    });

    proc.on('error', (err: Error) => {
      clearTimeout(timeoutId);
      resolve({
        status: 'unknown_error',
        message: `无法启动会话健康检查进程: ${err.message}`,
        checkedAt: new Date().toISOString(),
      });
    });
  });
}

/** 验证 BigSeller 登录会话是否可用于 Web headless 同步。
 *  使用与 Web 同步相同的 profile 和 headless 模式，只读检查库存页是否可访问。
 *  仅 Admin 可调用；不执行任何写入、抓取或同步操作。 */
export async function verifyBigSellerSession(): Promise<SessionHealthResult> {
  await requireActiveAdmin();
  return _verifyBigSellerSessionCore();
}
