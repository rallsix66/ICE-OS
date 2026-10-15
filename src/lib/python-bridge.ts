// Python Bridge — 从 Next.js Server Action 调用 Python 同步脚本
//
// 通过 child_process.spawn 执行 web_bridge.py，
// 传递仓库参数，捕获 stdout JSON 并解析返回。
// 仅限服务端使用。

import { spawn } from 'node:child_process';
import path from 'node:path';

const PROJECT_ROOT = path.resolve(process.cwd());
const PYTHON_MODULE = 'tools.bigseller-scraper.sync.web_bridge';

export interface PythonBridgeParams {
  warehouseId: string;
  warehouseName: string;
  oldName: string;
  country: string;
  token: string;
  mode: 'dry_run' | 'real_write';
  /** P5-SY9D: real_write 模式下的前一次 Dry Run 基线 JSON 文件路径（用于计划漂移比较） */
  priorDryRunPath?: string;
  /** P0-02: Node claim 的运行 ID，写入 Python sync_log 关联 */
  syncRunId?: string;
  /** P0-02: 发起 sync 的 profile UUID */
  triggeredByProfileId?: string;
}

export interface PythonBridgeResult {
  success: boolean;
  exit_code: number;
  warehouse_id: string;
  warehouse_name: string;
  country: string;
  mode: string;
  started_at: string;
  finished_at: string | null;
  errors: string[];
  summary: {
    variants_created: number;
    variants_skipped: number;
    inventory_inserted: number;
    inventory_updated: number;
    inventory_unchanged: number;
    warehouse_renamed: boolean;
  };
  plan_drift_check: 'PASS' | 'DRIFT_DETECTED' | null;
  plan_drift_count: number;
  plan_drift_differences: string[];
  /** P5-SY9D rework: 完整 Dry Run plan artifact（含元数据）。
   *  dry_run 完成时 web_bridge.py 输出 plan_summary；
   *  real_write 时为 null（无需 plan，使用绑定的 Dry Run plan）。 */
  plan: Record<string, unknown> | null;
  /** 抓取元数据（BigSeller scraper 输出） */
  raw_row_count: number;
  valid_sku_count: number;
  invalid_sku_count: number;
  /** P0-02: 发布事务 commit 结果（real_write） */
  publish_committed?: boolean;
  sync_log_written?: boolean;
  commit_outcome?: 'committed' | 'committed_ack_lost' | 'rolled_back' | 'unknown' | null;
}

/** SIGKILL 前等待 SIGTERM 优雅退出的宽限期（毫秒） */
const SIGKILL_GRACE_MS = 5_000;

/** 终止原因类型 */
type TerminateReason = 'timeout' | 'abort' | 'error';

/**
 * 调用 Python web_bridge.py 执行完整同步流程。
 * 返回解析后的 JSON 结果。
 *
 * @param timeoutMs 可选超时（毫秒）。超时后 SIGTERM → 5s grace → SIGKILL。
 *                  超时时 reject，调用方应在 sync-service 层 release 为 failed。
 * @param signal    可选 AbortSignal。abort 时与 timeout 走同一终止管线。
 */
export async function callPythonBridge(
  params: PythonBridgeParams,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<PythonBridgeResult> {
  const args = [
    '-m', PYTHON_MODULE,
    '--warehouse-id', params.warehouseId,
    '--warehouse-name', params.warehouseName,
    '--old-name', params.oldName,
    '--country', params.country,
    '--token', params.token,
    '--mode', params.mode,
  ];
  if (params.priorDryRunPath) {
    args.push('--prior-dry-run-path', params.priorDryRunPath);
  }

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
  };
  if (params.syncRunId) {
    childEnv.P0_02_SYNC_RUN_ID = params.syncRunId;
  }
  if (params.triggeredByProfileId) {
    childEnv.P0_02_SYNC_TRIGGERED_BY = params.triggeredByProfileId;
  }
  childEnv.P0_02_TARGET_WAREHOUSE_ID = params.warehouseId;

  return new Promise<PythonBridgeResult>((resolve, reject) => {
    const proc = spawn('python', args, {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });

    // ── P5-SY9E rework: 统一终止管线 ──────────────────────────
    let settled = false;
    let terminateReason: TerminateReason = 'error';
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let sigkillId: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;

    const clearTimers = () => {
      if (timeoutId) { clearTimeout(timeoutId); timeoutId = undefined; }
      if (sigkillId) { clearTimeout(sigkillId); sigkillId = undefined; }
    };

    /** 统一终止：SIGTERM → 5s grace → SIGKILL（若进程仍存活）。
     *  timeout 和 AbortSignal 均走此管线。已 settled 时幂等。 */
    function terminate(reason: TerminateReason): void {
      if (settled) return;
      settled = true;
      terminateReason = reason;
      proc.kill('SIGTERM');
      sigkillId = setTimeout(() => {
        if (proc.exitCode === null) {
          proc.kill('SIGKILL');
        }
      }, SIGKILL_GRACE_MS);
    }

    // timeout
    if (timeoutMs && timeoutMs > 0) {
      timeoutId = setTimeout(() => terminate('timeout'), timeoutMs);
    }

    // external AbortSignal
    if (signal) {
      if (signal.aborted) {
        terminate('abort');
      } else {
        const onAbort = () => terminate('abort');
        abortListener = onAbort;
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    // ── close / error 处理 ──────────────────────────────────
    proc.on('close', (code: number | null) => {
      clearTimers();
      if (abortListener && signal) {
        signal.removeEventListener('abort', abortListener);
      }

      // 被终止 — 返回中文错误
      if (settled) {
        const reasonLabel = terminateReason === 'timeout'
          ? `超时（timeout=${timeoutMs}ms）`
          : terminateReason === 'abort'
            ? '外部取消（AbortSignal）'
            : `进程错误（exit=${code}）`;
        reject(new Error(`Python bridge 被终止：${reasonLabel}`));
        return;
      }

      // 正常退出 — 解析 JSON
      const lines = stdout
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

      const lastJsonLine = lines.at(-1);
      if (!lastJsonLine) {
        if (stderr) {
          console.error('[python-bridge] stderr:', stderr);
        }
        reject(new Error(`Python bridge 无输出（exit=${code}）`));
        return;
      }

      try {
        const result = JSON.parse(lastJsonLine) as PythonBridgeResult;
        if (stderr) {
          console.log('[python-bridge]', stderr.split('\n').slice(-5).join('\n'));
        }
        resolve(result);
      } catch {
        reject(new Error(
          `Python bridge JSON 解析失败（exit=${code}）: ${lastJsonLine.slice(0, 500)}`,
        ));
      }
    });

    proc.on('error', (err: Error) => {
      clearTimers();
      if (abortListener && signal) {
        signal.removeEventListener('abort', abortListener);
      }
      reject(new Error(`Python bridge 启动失败: ${err.message}`));
    });
  });
}
