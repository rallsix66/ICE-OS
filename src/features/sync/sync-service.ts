// Sync Feature Module — SyncService (P5-SY5C2 V5.8)
//
// 编排同步执行完整生命周期：claim → artifact store → runner execute → release。
// 返回 SyncServiceResult（非 SyncExecuteResult），区分 completed / failed / indeterminate。

import 'server-only';

import type { SyncRepository } from './repository';
import type { ArtifactProvider } from './artifact-provider';
import type { SyncRunner } from './sync-runner';
import type {
  SyncServiceInput,
  SyncServiceInputDryRun,
  SyncServiceInputRealWrite,
  SyncExecuteParamsDryRun,
  SyncExecuteParamsRealWrite,
  SyncServiceResult,
  JsonValue,
  SyncExecuteResult,
} from './types';
import { validateJsonValue } from './validate-json-value';

/** P5-SY10B: 构建 enriched resultSummary，合并 summary 与 scraperMeta，
 *  使 rawRowCount / validSkuCount / invalidSkuCount 持久化到 sync_run.result_summary，
 *  供 getWarehouseHistory 历史查询使用。 */
function buildResultSummary(result: SyncExecuteResult): Record<string, unknown> {
  const base = result.summary as Record<string, unknown>;
  const enriched: Record<string, unknown> = { ...base };
  if (result.commitOutcome !== undefined) {
    enriched.commitOutcome = result.commitOutcome;
  }
  if (result.publishCommitted !== undefined) {
    enriched.publishCommitted = result.publishCommitted;
  }
  if (result.scraperMeta) {
    enriched.rawRowCount = result.scraperMeta.rawRowCount;
    enriched.validSkuCount = result.scraperMeta.validSkuCount;
    enriched.invalidSkuCount = result.scraperMeta.invalidSkuCount;
  }
  return enriched;
}

export interface SyncServiceDeps {
  repository: SyncRepository;
  artifactProvider: ArtifactProvider;
  runner: SyncRunner;
  /** P5-SY9E rework: 可注入 heartbeat 间隔（毫秒），供测试使用。
   *  生产默认 = LEASE_DURATION * 1000 / 3 ≈ 100s。 */
  heartbeatIntervalMs?: number;
  /** P5-SY10E rework: 系统 claim 配置。enabled 时 SyncService
   *  使用 service_role claim_sync_run_system RPC 而非
   *  auth.uid() 绑定的 claim_sync_run。
   *  仅供 server-side Cron/system wiring 设置，从不通过
   *  createSyncActions 对客户端暴露。 */
  _systemClaimConfig?: {
    enabled: true;
    triggeredBy: string;
  };
}

const LEASE_DURATION = 300; // 5 minutes (seconds)
/** P5-SY9E: 生产默认 heartbeat 间隔 = lease 的 1/3 */
const DEFAULT_HEARTBEAT_INTERVAL_MS = Math.floor((LEASE_DURATION * 1000) / 3);

function makeFailed(
  runId: string,
  error: string,
): SyncServiceResult {
  return { runId, status: 'failed', error };
}

function makeIndeterminate(
  runId: string,
  runnerResult: SyncExecuteResult,
  error: string,
  inputRetained: boolean,
  planRetained: boolean,
  reason: string,
): SyncServiceResult {
  return {
    runId,
    status: 'indeterminate',
    runnerResult,
    error,
    artifactDisposition: { inputRetained, planRetained, reason },
  };
}

function makeCompleted(
  runId: string,
  runnerResult: SyncExecuteResult,
): SyncServiceResult {
  return { runId, status: 'completed', runnerResult };
}

// ─── Factory ──────────────────────────────────────────────────────

export function createSyncService(deps: SyncServiceDeps) {
  // Production guard: reject mock instances
  if (process.env.NODE_ENV === 'production') {
    const ap = deps.artifactProvider as unknown as Record<string, unknown>;
    const rn = deps.runner as unknown as Record<string, unknown>;
    if (ap.__mock__ === true || rn.__mock__ === true) {
      throw new Error('生产环境禁止使用 Mock ArtifactProvider / MockSyncRunner');
    }
  }

  return {
    async executeSync(input: SyncServiceInput): Promise<SyncServiceResult> {
      const { repository, artifactProvider, runner } = deps;
      const runId = crypto.randomUUID();

      // ─── 1. Validate & prepare inputArtifact ───────────────────
      let inputPrepared;
      try {
        validateJsonValue(input.inputArtifact);
        inputPrepared = artifactProvider.prepare(input.inputArtifact);
      } catch (err) {
        return makeFailed(runId, `inputArtifact 验证/准备失败: ${(err as Error).message}`);
      }

      // ─── 2. Dry Run ──────────────────────────────────────────
      if (input.mode === 'dry_run') {
        return executeDryRun(
          runId,
          input,
          inputPrepared.hash,
          inputPrepared.normalizedContent,
          repository,
          artifactProvider,
          runner,
          deps.heartbeatIntervalMs,
          deps._systemClaimConfig,
        );
      }

      // ─── 3. Real Write ───────────────────────────────────────
      if (input.mode === 'real_write') {
        return executeRealWrite(
          runId,
          input,
          inputPrepared.hash,
          inputPrepared.normalizedContent,
          repository,
          artifactProvider,
          runner,
          deps.heartbeatIntervalMs,
          deps._systemClaimConfig,
        );
      }

      return makeFailed(runId, `未知 mode: ${(input as SyncServiceInput).mode}`);
    },
  };
}

export type SyncService = ReturnType<typeof createSyncService>;

// ─── P5-SY9E: heartbeat + timeout orchestration ──────────────────

/** 启动 heartbeat 定时器。失败仅日志，不中断同步主流程。
 *  @param intervalMs heartbeat 间隔（毫秒），默认 DEFAULT_HEARTBEAT_INTERVAL_MS */
function startHeartbeat(
  repo: SyncRepository,
  runId: string,
  intervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
): ReturnType<typeof setInterval> {
  return setInterval(() => {
    repo.heartbeatSyncRun({ runId, leaseDuration: LEASE_DURATION }).catch((err) => {
      console.error(`[heartbeat] sync_run ${runId} 续租失败: ${(err as Error).message}`);
    });
  }, intervalMs);
}

interface RunnerContext {
  signal?: AbortSignal;
  cleanup: () => void;
}

/** 根据 Runner 能力创建 timeout AbortSignal + 合并外部 signal。
 *  返回 signal 和 cleanup 函数。 */
async function prepareRunnerContext(
  runner: SyncRunner,
  externalSignal?: AbortSignal,
): Promise<RunnerContext> {
  const caps = await runner.capabilities();
  const cleanups: Array<() => void> = [];

  let signal: AbortSignal | undefined;

  if (caps.maxTimeoutMs > 0) {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), caps.maxTimeoutMs);
    cleanups.push(() => clearTimeout(tid));
    signal = ctrl.signal;

    // 外部 signal 也转发到同一个 controller
    if (externalSignal) {
      if (externalSignal.aborted) {
        // 已提前 aborted → 立即转发，不等 timeout
        ctrl.abort(externalSignal.reason);
      } else {
        const onAbort = () => ctrl.abort();
        externalSignal.addEventListener('abort', onAbort, { once: true });
        cleanups.push(() => externalSignal.removeEventListener('abort', onAbort));
      }
    }
  } else if (externalSignal) {
    signal = externalSignal;
  }

  return {
    signal,
    cleanup: () => cleanups.forEach((fn) => fn()),
  };
}

// ─── Dry Run lifecycle ────────────────────────────────────────────

async function executeDryRun(
  runId: string,
  input: SyncServiceInputDryRun,
  inputHash: string,
  inputNormalized: JsonValue,
  repo: SyncRepository,
  artifactProvider: ArtifactProvider,
  runner: SyncRunner,
  heartbeatIntervalMs?: number,
  systemClaimConfig?: SyncServiceDeps['_systemClaimConfig'],
): Promise<SyncServiceResult> {
  // a. claim (system or user path)
  const useSystemClaim = systemClaimConfig?.enabled === true;
  const claimed = useSystemClaim
    ? await repo.claimSyncRunSystem({
        runId,
        warehouseId: input.warehouseId,
        leaseDuration: LEASE_DURATION,
        triggeredBy: systemClaimConfig!.triggeredBy,
        triggeredFrom: 'web',
        inputArtifactHash: inputHash,
      })
    : await repo.claimSyncRun({
        runId,
        warehouseId: input.warehouseId,
        mode: 'dry_run',
        leaseDuration: LEASE_DURATION,
        triggeredBy: input.triggeredBy,
        triggeredFrom: 'web',
        inputArtifactHash: inputHash,
      });

  if (!claimed) {
    return makeFailed(runId, '仓库被占用或无可回收槽位');
  }

  // b. store input
  try {
    await artifactProvider.store(runId, 'input', {
      bytes: new TextEncoder().encode(JSON.stringify(inputNormalized)),
      hash: inputHash,
      normalizedContent: inputNormalized,
    });
  } catch (err) {
    // input store 失败 → release failed + delete partial input
    await repo.releaseSyncRun({
      runId,
      status: 'failed',
      exitCode: 1,
      errorMessage: `input artifact 存储失败: ${(err as Error).message}`,
    }).catch(() => {});
    await artifactProvider.delete(runId, 'input').catch(() => {});
    return makeFailed(runId, `input artifact 存储失败: ${(err as Error).message}`);
  }

  // c. execute runner (P5-SY9E rework: heartbeat + timeout + 异常清理)
  const heartbeatId = startHeartbeat(repo, runId, heartbeatIntervalMs);

  // P5-SY9E rework: prepareRunnerContext 异常时清理 heartbeat 并 release failed
  let ctx: Awaited<ReturnType<typeof prepareRunnerContext>>;
  try {
    ctx = await prepareRunnerContext(runner, input.signal);
  } catch (err) {
    clearInterval(heartbeatId);
    const errorMsg = `Runner 能力查询失败: ${(err as Error).message}`;
    try {
      await repo.releaseSyncRun({ runId, status: 'failed', exitCode: 1, errorMessage: errorMsg });
    } catch {
      // release 自身失败 — 已 claim 但无法落库，依赖 lease 过期回收
      return {
        runId,
        status: 'indeterminate',
        error: `已 claim，但 release failed 落库失败: ${errorMsg}。依赖 lease 过期回收`,
        artifactDisposition: {
          inputRetained: true, planRetained: false,
          reason: 'capabilities 查询失败 + release 失败：input retained',
        },
      };
    }
    return makeFailed(runId, errorMsg);
  }

  const dryParams: SyncExecuteParamsDryRun = {
    runId,
    warehouseId: input.warehouseId,
    mode: 'dry_run',
    triggeredBy: input.triggeredBy,
    signal: ctx.signal,
    inputArtifact: inputNormalized,
  };

  let result: SyncExecuteResult;
  try {
    result = await runner.execute(dryParams);
  } catch (err) {
    // Runner 抛错
    clearInterval(heartbeatId);
    ctx.cleanup();
    const errorMsg = `Runner 执行失败: ${(err as Error).message}`;
    try {
      await repo.releaseSyncRun({
        runId,
        status: 'failed',
        exitCode: 1,
        errorMessage: errorMsg,
      });
      // release 成功 — input 保留由 7 天 GC 清理
      return makeFailed(runId, errorMsg);
    } catch {
      // release 自身失败 — 全部 artifact 保留
      return makeIndeterminate(runId, result!, errorMsg, true, false,
        'release failed 自身失败：全部 artifact 保留');
    }
  }

  // P5-SY9E: runner 已完成（成功或抛错），停止 heartbeat + timeout
  clearInterval(heartbeatId);
  ctx.cleanup();

  // d. exitCode === 0
  if (result.exitCode === 0) {
    // planArtifact must exist
    if (!result.planArtifact) {
      try {
        await repo.releaseSyncRun({
          runId,
          status: 'failed',
          exitCode: 1,
          errorMessage: 'Dry Run exitCode=0 但 planArtifact 缺失',
        });
      } catch { /* ignore */ }
      await artifactProvider.delete(runId, 'input').catch(() => {});
      return makeFailed(runId, 'Dry Run exitCode=0 但 planArtifact 缺失');
    }

    // validate and prepare plan
    let planPrepared;
    try {
      validateJsonValue(result.planArtifact);
      planPrepared = artifactProvider.prepare(result.planArtifact);
    } catch (err) {
      try {
        await repo.releaseSyncRun({
          runId,
          status: 'failed',
          exitCode: 1,
          errorMessage: `planArtifact 验证/准备失败: ${(err as Error).message}`,
        });
      } catch { /* ignore */ }
      await artifactProvider.delete(runId, 'input').catch(() => {});
      return makeFailed(runId, `planArtifact 验证/准备失败: ${(err as Error).message}`);
    }

    // store plan
    try {
      await artifactProvider.store(runId, 'plan', planPrepared);
    } catch (err) {
      // plan store 失败 → delete partial plan + delete input
      await repo.releaseSyncRun({
        runId,
        status: 'failed',
        exitCode: 1,
        errorMessage: `plan artifact 存储失败: ${(err as Error).message}`,
      }).catch(() => {});
      await artifactProvider.delete(runId, 'plan').catch(() => {});
      await artifactProvider.delete(runId, 'input').catch(() => {});
      return makeFailed(runId, `plan artifact 存储失败: ${(err as Error).message}`);
    }

    // release completed
    try {
      await repo.releaseSyncRun({
        runId,
        status: 'completed',
        exitCode: 0,
        resultSummary: buildResultSummary(result),
        planDriftCheck: result.planDriftCheck,
        planDriftCount: result.planDriftCount,
        planDriftDifferences: result.planDriftDifferences,
        planArtifactHash: planPrepared.hash,
      });
      return makeCompleted(runId, result);
    } catch (err) {
      // release completed 失败 — delete plan, keep input
      await artifactProvider.delete(runId, 'plan').catch(() => {});
      return makeIndeterminate(
        runId,
        result,
        `运行状态落库失败（release completed 失败）: ${(err as Error).message}`,
        true,
        false,
        'release completed 失败：plan 已删除，input 保留供排查',
      );
    }
  }

  // e. exitCode !== 0
  try {
    await repo.releaseSyncRun({
      runId,
      status: 'failed',
      exitCode: result.exitCode,
      errorMessage: result.errors?.[0] ?? 'Runner 返回非零退出码',
    });
    // release 成功 — input 保留由 7 天 GC 清理
    return { runId, status: 'failed', runnerResult: result, error: result.errors?.[0] };
  } catch (err) {
    // release 自身失败 — 全部 artifact 保留
    return makeIndeterminate(
      runId,
      result,
      `Runner 失败且 release failed 落库失败: ${(err as Error).message}`,
      true,
      false,
      'release failed 自身失败：全部 artifact 保留',
    );
  }
}

// ─── Real Write lifecycle ─────────────────────────────────────────

async function executeRealWrite(
  runId: string,
  input: SyncServiceInputRealWrite,
  inputHash: string,
  inputNormalized: JsonValue,
  repo: SyncRepository,
  artifactProvider: ArtifactProvider,
  runner: SyncRunner,
  heartbeatIntervalMs?: number,
  systemClaimConfig?: SyncServiceDeps['_systemClaimConfig'],
): Promise<SyncServiceResult> {
  // P5-SY10E rework: 系统路径不得执行 real_write
  if (systemClaimConfig?.enabled) {
    return makeFailed(runId, '系统路径禁止执行 Real Write，仅允许 Dry Run');
  }

  // a. Load bound Dry Run artifacts via ArtifactProvider.get()
  let planArtifact_dr: { content: JsonValue; hash: string };
  try {
    await artifactProvider.get(input.dryRunRunId, 'input'); // verify input exists
    const planDr = await artifactProvider.get(input.dryRunRunId, 'plan');
    planArtifact_dr = { content: planDr.content, hash: planDr.hash };
    // Validate bound plan content
    validateJsonValue(planArtifact_dr.content);
  } catch (err) {
    return makeFailed(runId, `绑定 Dry Run artifact 加载失败: ${(err as Error).message}`);
  }

  // b. claim with verified hashes
  const claimed = await repo.claimSyncRun({
    runId,
    warehouseId: input.warehouseId,
    mode: 'real_write',
    leaseDuration: LEASE_DURATION,
    triggeredBy: input.triggeredBy,
    triggeredFrom: 'web',
    dryRunRunId: input.dryRunRunId,
    inputArtifactHash: inputHash,
    planArtifactHash: planArtifact_dr.hash,
  });

  if (!claimed) {
    return makeFailed(runId, '仓库被占用或无可回收槽位');
  }

  // c. store current input
  try {
    await artifactProvider.store(runId, 'input', {
      bytes: new TextEncoder().encode(JSON.stringify(inputNormalized)),
      hash: inputHash,
      normalizedContent: inputNormalized,
    });
  } catch (err) {
    // input store 失败 → release failed + delete partial input
    await repo.releaseSyncRun({
      runId,
      status: 'failed',
      exitCode: 1,
      errorMessage: `input artifact 存储失败: ${(err as Error).message}`,
    }).catch(() => {});
    await artifactProvider.delete(runId, 'input').catch(() => {});
    return makeFailed(runId, `input artifact 存储失败: ${(err as Error).message}`);
  }

  // d. execute runner (P5-SY9E rework: heartbeat + timeout + 异常清理)
  const heartbeatId = startHeartbeat(repo, runId, heartbeatIntervalMs);

  // P5-SY9E rework: prepareRunnerContext 异常时清理 heartbeat 并 release failed
  let ctx: Awaited<ReturnType<typeof prepareRunnerContext>>;
  try {
    ctx = await prepareRunnerContext(runner, input.signal);
  } catch (err) {
    clearInterval(heartbeatId);
    const errorMsg = `Runner 能力查询失败: ${(err as Error).message}`;
    try {
      await repo.releaseSyncRun({ runId, status: 'failed', exitCode: 1, errorMessage: errorMsg });
    } catch {
      // release 自身失败 — 已 claim 但无法落库，依赖 lease 过期回收
      return {
        runId,
        status: 'indeterminate',
        error: `已 claim，但 release failed 落库失败: ${errorMsg}。依赖 lease 过期回收`,
        artifactDisposition: {
          inputRetained: true, planRetained: false,
          reason: 'capabilities 查询失败 + release 失败：input retained',
        },
      };
    }
    return makeFailed(runId, errorMsg);
  }

  const realParams: SyncExecuteParamsRealWrite = {
    runId,
    warehouseId: input.warehouseId,
    mode: 'real_write',
    confirmToken: input.confirmToken,
    triggeredBy: input.triggeredBy,
    dryRunRunId: input.dryRunRunId,
    signal: ctx.signal,
    inputArtifact: inputNormalized,
    boundPlanArtifact: planArtifact_dr.content,
  };

  let result: SyncExecuteResult;
  try {
    result = await runner.execute(realParams);
    // Runner must not output planArtifact in real_write mode
    if (result.planArtifact !== undefined) {
      clearInterval(heartbeatId);
      ctx.cleanup();
      const errorMsg = 'Real Write Runner 不得输出 planArtifact';
      await repo.releaseSyncRun({
        runId,
        status: 'failed',
        exitCode: 1,
        errorMessage: errorMsg,
      }).catch(() => {});
      await artifactProvider.delete(runId, 'input').catch(() => {});
      return makeFailed(runId, errorMsg);
    }
  } catch (err) {
    // Runner 抛错
    clearInterval(heartbeatId);
    ctx.cleanup();
    const errorMsg = `Runner 执行失败: ${(err as Error).message}`;
    try {
      await repo.releaseSyncRun({
        runId,
        status: 'failed',
        exitCode: 1,
        errorMessage: errorMsg,
      });
      return makeFailed(runId, errorMsg);
    } catch {
      return makeIndeterminate(runId, result!, errorMsg, true, false,
        'release failed 自身失败：全部 artifact 保留');
    }
  }

  // P5-SY9E: runner 已完成，停止 heartbeat + timeout
  clearInterval(heartbeatId);
  ctx.cleanup();

  // e. exitCode === 0
  if (result.exitCode === 0) {
    try {
      await repo.releaseSyncRun({
        runId,
        status: 'completed',
        exitCode: 0,
        resultSummary: buildResultSummary(result),
        planDriftCheck: result.planDriftCheck,
        planDriftCount: result.planDriftCount,
        planDriftDifferences: result.planDriftDifferences,
      });
      return makeCompleted(runId, result);
    } catch (err) {
      // Real Write release completed 失败 — 写入可能已生效
      return makeIndeterminate(
        runId,
        result,
        `写入结果可能已生效，但运行状态落库失败（release completed 失败）: ${(err as Error).message}`,
        true,
        false,
        'Real Write release completed 失败：写入可能已生效，input 保留',
      );
    }
  }

  // f. exitCode !== 0
  try {
    await repo.releaseSyncRun({
      runId,
      status: 'failed',
      exitCode: result.exitCode,
      errorMessage: result.errors?.[0] ?? 'Runner 返回非零退出码',
    });
    // release 成功 — input 保留由 7 天 GC 清理
    return { runId, status: 'failed', runnerResult: result, error: result.errors?.[0] };
  } catch (err) {
    return makeIndeterminate(
      runId,
      result,
      `Runner 失败且 release failed 落库失败: ${(err as Error).message}`,
      true,
      false,
      'release failed 自身失败：全部 artifact 保留',
    );
  }
}
