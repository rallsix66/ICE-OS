/**
 * 飞书商品来源「只读定时读取」的状态文件（snapshotDir/reader-status.json）。
 *
 * 设计约束：
 * - 只放状态与计数，不放价格、不放行级数据；服务层/页面读这一个文件即可展示
 *   「最近一次真实读取的结果、时间、计数、失败原因、后台进程是否在跑」。
 * - 读在文件缺失/坏 JSON 时返回 null（绝不抛），页面不会因为状态文件坏掉而白屏。
 * - 写是「读-合并-原子替换」：只覆盖 patch 里出现的字段，未出现的保留旧值
 *   （因此一次失败不会抹掉上一份成功快照的 snapshotKey/capturedAt/counts）。
 * - 不引 `server-only`：后台 worker 经 TS loader 直接复用。
 */
import fs from 'node:fs';
import path from 'node:path';

export const READER_STATUS_FILE = 'reader-status.json';

/** 一次真实读取的计数（价格只计数，不保存值）。 */
export interface ProductSourceReaderCounts {
  gridRows: number;
  gridColumns: number;
  businessRows: number;
  emptyRows: number;
  uniqueCodes: number;
  duplicateCodes: string[];
  missingCodeRows: number[];
  imageCells: number;
  priceCells: number;
}

/** 后台只读进程的存活信息（由 worker 写，start/stop 脚本也会写 running=false）。 */
export interface ProductSourceReaderWorker {
  running: boolean;
  pid: number | null;
  startedAt: string | null;
}

export type ProductSourceReaderLastResult = 'captured' | 'unchanged' | 'failed';

export interface ProductSourceReaderStatus {
  method: 'feishu_api';
  updatedAt: string;
  intervalMinutes: number | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastResult: ProductSourceReaderLastResult;
  snapshotKey: string | null;
  capturedAt: string | null;
  counts: ProductSourceReaderCounts | null;
  errorCode: string | null;
  errorMessage: string | null;
  worker: ProductSourceReaderWorker | null;
}

export function readerStatusPath(snapshotDir: string): string {
  return path.join(snapshotDir, READER_STATUS_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function emptyStatus(nowIso: string): ProductSourceReaderStatus {
  return {
    method: 'feishu_api',
    updatedAt: nowIso,
    intervalMinutes: null,
    nextRunAt: null,
    lastRunAt: null,
    lastResult: 'failed',
    snapshotKey: null,
    capturedAt: null,
    counts: null,
    errorCode: null,
    errorMessage: null,
    worker: null,
  };
}

/** 读取状态文件；文件缺失、坏 JSON、形状不对都返回 null（不抛）。 */
export function readReaderStatus(snapshotDir: string): ProductSourceReaderStatus | null {
  if (typeof snapshotDir !== 'string' || snapshotDir.trim() === '') return null;
  let text: string;
  try {
    text = fs.readFileSync(readerStatusPath(snapshotDir), 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  return mergeStatus(emptyStatus(new Date(0).toISOString()), parsed as Partial<ProductSourceReaderStatus>);
}

function mergeStatus(
  base: ProductSourceReaderStatus,
  patch: Partial<ProductSourceReaderStatus>,
): ProductSourceReaderStatus {
  const merged: ProductSourceReaderStatus = { ...base, method: 'feishu_api' };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (!(key in base)) continue;
    (merged as unknown as Record<string, unknown>)[key] = value;
  }
  return merged;
}

/**
 * 合并写状态文件并返回合并结果。
 *
 * 原子替换：先写同目录临时文件再 rename，避免服务层读到半截 JSON。
 * 目录不存在会自动创建（失败场景下 snapshotDir 可能还不存在）。
 * 写盘失败会抛出（不可恢复，调用方/worker 记录日志）。
 */
export function writeReaderStatus(
  snapshotDir: string,
  patch: Partial<ProductSourceReaderStatus>,
): ProductSourceReaderStatus {
  if (typeof snapshotDir !== 'string' || snapshotDir.trim() === '') {
    throw new Error('READER_STATUS_SNAPSHOT_DIR_REQUIRED');
  }
  const existing = readReaderStatus(snapshotDir);
  const base = existing ?? emptyStatus(new Date().toISOString());
  const merged = mergeStatus(base, {
    ...patch,
    updatedAt: patch.updatedAt ?? new Date().toISOString(),
  });
  fs.mkdirSync(snapshotDir, { recursive: true });
  const target = readerStatusPath(snapshotDir);
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, target);
  return merged;
}
