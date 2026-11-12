/**
 * 飞书商品来源「只读定时读取」后台进程（Node，常驻）。
 *
 * 职责单一：按间隔真实读取飞书 ICE产品库工作表，把快照与状态写进本实例的
 * product-source 目录。**不连数据库、不应用批次、不写飞书原表、不启停网页**。
 *
 * 配置（start-worker.mjs 写 <instance>/product-source-reader.json）：
 *   { workerId, snapshotDir, logPath, tsTempDir, intervalMinutes, cliRunnerPath }
 *
 * 用法：
 *   node scripts/catalog/feishu-source/worker.mjs --config <instance/product-source-reader.json>
 *   node scripts/catalog/feishu-source/worker.mjs --config <...> --once   # 只跑一轮（测试/验收）
 * 间隔：环境变量 PRODUCT_SOURCE_READER_INTERVAL_MINUTES 覆盖配置，默认 60，最小 5。
 * 退出码：--once 时 0=读取成功（captured/unchanged），1=failed。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function readArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else { args[key] = next; index += 1; }
  }
  return args;
}

const args = readArgs(process.argv.slice(2));
const runOnce = args['once'] === true;
if (!args.config || typeof args.config !== 'string') {
  console.error('PRODUCT_SOURCE_READER_CONFIG_REQUIRED: use --config <instance/product-source-reader.json>');
  process.exit(1);
}
const configPath = path.resolve(args.config);
if (!fs.existsSync(configPath)) {
  console.error(`PRODUCT_SOURCE_READER_CONFIG_NOT_FOUND:${configPath}`);
  process.exit(1);
}
const rawConfigText = fs.readFileSync(configPath, 'utf8');
// 兼容被记事本/Windows PowerShell 5.1 写成带 BOM 的配置文件。
const config = JSON.parse(rawConfigText.charCodeAt(0) === 0xfeff ? rawConfigText.slice(1) : rawConfigText);
const snapshotDir = typeof config.snapshotDir === 'string' ? config.snapshotDir.trim() : '';
if (!snapshotDir) {
  console.error('PRODUCT_SOURCE_READER_SNAPSHOT_DIR_REQUIRED');
  process.exit(1);
}

function resolveIntervalMinutes() {
  const raw = process.env.PRODUCT_SOURCE_READER_INTERVAL_MINUTES ?? config.intervalMinutes;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 60;
  return Math.max(5, Math.round(parsed));
}
const intervalMinutes = resolveIntervalMinutes();
const intervalMs = intervalMinutes * 60_000;

const logDir = typeof config.logPath === 'string' && config.logPath
  ? config.logPath
  : path.join(snapshotDir, 'logs');
fs.mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, `reader-${new Date().toISOString().slice(0, 10)}.jsonl`);
function log(event, detail = {}) {
  const line = JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event, ...detail });
  try {
    fs.appendFileSync(logFile, `${line}\n`);
  } catch {
    // 日志写不进去不能影响读取。
  }
  if (!runOnce) console.log(line);
}

let stopping = false;
let sleepTimer = null;
let sleepResolve = null;
let captureModule = null;
let statusModule = null;

function sleep(ms) {
  return new Promise((resolve) => {
    sleepResolve = resolve;
    sleepTimer = setTimeout(() => {
      sleepTimer = null;
      sleepResolve = null;
      resolve();
    }, ms);
  });
}

function wake() {
  if (sleepTimer) clearTimeout(sleepTimer);
  sleepTimer = null;
  if (sleepResolve) {
    const resolve = sleepResolve;
    sleepResolve = null;
    resolve();
  }
}

async function loadModules() {
  const { createTsLoader } = await import('./ts-loader.mjs');
  const tempDir = typeof config.tsTempDir === 'string' && config.tsTempDir
    ? config.tsTempDir
    : path.join(os.tmpdir(), 'iceos-product-source-reader-ts');
  fs.mkdirSync(tempDir, { recursive: true });
  const loader = createTsLoader({ tempDir });
  const sourceDir = path.join(REPO_ROOT, 'src/features/catalog/product-source');
  captureModule = await loader.load(path.join(sourceDir, 'feishu-capture.ts'));
  statusModule = await loader.load(path.join(sourceDir, 'reader-status.ts'));
}

/** 跑一轮真实读取；返回 capture 结果并补齐 interval/nextRunAt/worker 状态。 */
async function runOneCycle() {
  const startedAt = new Date().toISOString();
  const result = await captureModule.captureFeishuProductSource({
    snapshotDir,
    ...(typeof config.cliRunnerPath === 'string' && config.cliRunnerPath ? { cliRunnerPath: config.cliRunnerPath } : {}),
  });
  const nextRunAt = new Date(Date.now() + intervalMs).toISOString();
  // 手动的 --once 只更新“最近一次读取结果/计数”，不改定时计划与 worker 归属（避免挤动下一次自动读取）。
  const base = runOnce
    ? { intervalMinutes }
    : { intervalMinutes, nextRunAt, worker: { running: true, pid: process.pid, startedAt } };
  if (result.status === 'failed') {
    statusModule.writeReaderStatus(snapshotDir, { ...base, lastRunAt: startedAt, lastResult: 'failed', errorCode: result.errorCode, errorMessage: result.errorMessage });
  } else {
    statusModule.writeReaderStatus(snapshotDir, {
      ...base,
      lastRunAt: result.capturedAt,
      lastResult: result.status,
      snapshotKey: result.snapshotKey,
      capturedAt: result.capturedAt,
      counts: result.counts,
      errorCode: null,
      errorMessage: null,
    });
  }
  log('cycle-finish', {
    status: result.status,
    snapshotKey: result.snapshotKey,
    snapshotFile: result.snapshotFile,
    counts: result.counts,
    errorCode: result.errorCode,
    errorMessage: result.errorMessage,
    nextRunAt,
  });
  return result;
}

function markStopped() {
  try {
    statusModule?.writeReaderStatus(snapshotDir, {
      worker: { running: false, pid: null, startedAt: null },
      nextRunAt: null,
    });
  } catch (error) {
    log('status-write-failed', { message: String(error?.message ?? error).slice(0, 300) });
  }
}

async function main() {
  await loadModules();
  log('start', {
    workerId: config.workerId ?? null,
    runId: config.runId ?? null,
    snapshotDir,
    intervalMinutes,
    runOnce,
  });
  const first = await runOneCycle();
  if (runOnce) {
    log('run-once-finished', { status: first.status });
    process.exitCode = first.status === 'failed' ? 1 : 0;
    return;
  }
  while (!stopping) {
    await sleep(Math.min(intervalMs, 15_000));
    if (stopping) break;
    const status = statusModule.readReaderStatus(snapshotDir);
    const nextRunAt = status?.nextRunAt ? Date.parse(status.nextRunAt) : Number.NaN;
    if (Number.isFinite(nextRunAt) && Date.now() < nextRunAt) continue;
    try {
      await runOneCycle();
    } catch (error) {
      log('cycle-error', { message: String(error?.message ?? error).slice(0, 500) });
      statusModule.writeReaderStatus(snapshotDir, {
        intervalMinutes,
        lastRunAt: new Date().toISOString(),
        lastResult: 'failed',
        errorCode: 'FEISHU_CAPTURE_FAILED',
        errorMessage: String(error?.message ?? error).slice(0, 500),
        nextRunAt: new Date(Date.now() + intervalMs).toISOString(),
        worker: { running: true, pid: process.pid, startedAt: new Date().toISOString() },
      });
    }
  }
  log('stop', { stopping });
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log('signal', { signal });
  wake();
  markStopped();
  // 让 while 循环尽快结束；最多 2s 兜底。
  setTimeout(() => process.exit(0), 200).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch((error) => {
  log('fatal', { message: String(error?.stack ?? error?.message ?? error).slice(0, 2000) });
  markStopped();
  process.exitCode = 1;
});
