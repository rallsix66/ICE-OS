/**
 * 启动「飞书商品来源」只读定时读取后台进程（Node，常驻）。
 *
 * 按 shipment 定时读取同一套归属模式：
 * - 配置写本实例 `instance/product-source-reader.json`（snapshotDir、logPath、intervalMinutes、workerId、
 *   lark-cli run.js 路径），实例重启后用同一命令即可继续运行；
 * - 只认本实例 marker（pid + 脚本/config 路径 + 进程创建时间）判断「是否已在运行」，
 *   已运行则复用；PID 存活但归属不成立时拒绝启动第二个进程；
 * - 只读：不连数据库、不应用批次、不写飞书原表；快照只写 snapshotDir。
 *
 * 用法：node scripts/catalog/feishu-source/start-worker.mjs --run-id <run-2026...>
 *      [--snapshot-dir <dir>] [--interval-minutes <n>]
 *
 * 默认 snapshotDir：<CATALOG_RUN_ROOT>/source-snapshots（与 service.ts 的 sourceRoot() 一致）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  REPO_ROOT,
  detachedHiddenSpawnOptions,
  openRun,
  readArgs,
  safeEnv,
  writeJson,
} from '../../catalog/prepare.mjs';
import { resolveLarkCliRunner } from '../../runtime/platform.mjs';
import {
  pidAlive,
  readWorkerProcessCreatedAtIso,
  verifyWorkerOwnership,
} from '../../shipment/process-ownership.mjs';

const WORKER_SCRIPT = path.join(REPO_ROOT, 'scripts/catalog/feishu-source/worker.mjs');
const MIN_INTERVAL_MINUTES = 5;
const DEFAULT_INTERVAL_MINUTES = 60;

const args = readArgs(process.argv.slice(2));
// readArgs 只认 --run-id/--host；本脚本自己的参数单独从 argv 取。
const argv = process.argv.slice(2);
function argValue(name) {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const next = argv[index + 1];
  return next === undefined || next.startsWith('--') ? undefined : next;
}
const run = openRun(args);
const instanceRoot = run.instanceRoot;
if (!fs.existsSync(instanceRoot)) throw new Error('PRODUCT_SOURCE_READER_INSTANCE_MISSING');

function positiveNumber(raw) {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

const intervalMinutes = Math.max(
  MIN_INTERVAL_MINUTES,
  Math.round(positiveNumber(argValue('interval-minutes') ?? process.env.PRODUCT_SOURCE_READER_INTERVAL_MINUTES) ?? DEFAULT_INTERVAL_MINUTES),
);
// 默认快照目录必须与 service.ts 的 sourceRoot() 一致：<CATALOG_RUN_ROOT>/source-snapshots
// （CATALOG_RUN_ROOT = .local/catalog/<runId>，即 run.root）。这样服务层/页面不用额外配置就能读到。
const snapshotDir = path.resolve(
  argValue('snapshot-dir')
    ?? process.env.PRODUCT_SOURCE_SNAPSHOT_DIR
    ?? path.join(run.root, 'source-snapshots'),
);

// lark-cli 入口：PRODUCT_SOURCE_LARK_CLI_RUNNER > SHIPMENT_LARK_CLI_RUNNER > 默认候选（与读取层一致）。
const explicitRunner = process.env.PRODUCT_SOURCE_LARK_CLI_RUNNER?.trim();
let cliRunnerPath = null;
if (explicitRunner) {
  if (!fs.existsSync(explicitRunner)) throw new Error(`PRODUCT_SOURCE_LARK_CLI_RUNNER_NOT_FOUND:${explicitRunner}`);
  cliRunnerPath = explicitRunner;
} else {
  cliRunnerPath = resolveLarkCliRunner();
}
if (!cliRunnerPath) {
  throw new Error('PRODUCT_SOURCE_LARK_CLI_MISSING: set PRODUCT_SOURCE_LARK_CLI_RUNNER (or SHIPMENT_LARK_CLI_RUNNER) to lark-cli run.js');
}

const readerRoot = path.join(instanceRoot, 'product-source-reader');
const logPath = path.join(readerRoot, 'logs');
const tsTempDir = path.join(readerRoot, 'tmp');
fs.mkdirSync(logPath, { recursive: true });
fs.mkdirSync(tsTempDir, { recursive: true });
fs.mkdirSync(snapshotDir, { recursive: true });

const configPath = path.join(instanceRoot, 'product-source-reader.json');
const workerId = `product-source-reader-${run.instance.webPort ?? run.instance.port}`;
const config = {
  runId: args.runId,
  workerId,
  sourceUrl: 'https://ygr1tb7cyf.feishu.cn/wiki/TC2AwLgRniqWKhkg9D2cEx79n0b',
  snapshotDir,
  logPath,
  tsTempDir,
  intervalMinutes,
  cliRunnerPath,
  createdAt: new Date().toISOString(),
  startedBy: 'scripts/catalog/feishu-source/start-worker.mjs',
};
writeJson(configPath, config);

const markerPath = path.join(instanceRoot, 'product-source-reader.pid.json');
if (fs.existsSync(markerPath)) {
  let prior = null;
  try {
    prior = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch {
    prior = null;
  }
  if (prior && pidAlive(prior.pid)) {
    const ownership = verifyWorkerOwnership(prior);
    if (!ownership.ok) {
      throw new Error(`${ownership.code}:${ownership.message}; refusing to start a second reader`);
    }
    console.log(`product source reader already running pid ${prior.pid} (workerId=${prior.workerId}, owned=true)`);
    process.exit(0);
  }
  fs.rmSync(markerPath, { force: true });
}

const out = fs.openSync(path.join(logPath, 'reader.stdout.log'), 'a');
const startedAt = new Date().toISOString();
const child = spawn(
  process.execPath,
  [WORKER_SCRIPT, '--config', configPath],
  detachedHiddenSpawnOptions({
    cwd: REPO_ROOT,
    env: safeEnv({
      PRODUCT_SOURCE_READER_INTERVAL_MINUTES: String(intervalMinutes),
      ...(explicitRunner ? { PRODUCT_SOURCE_LARK_CLI_RUNNER: explicitRunner } : {}),
    }),
    stdio: ['ignore', out, out],
  }),
);
child.unref();
await new Promise((resolve) => setTimeout(resolve, 2000));
if (!pidAlive(child.pid)) {
  throw new Error(`PRODUCT_SOURCE_READER_EXITED_IMMEDIATELY: see ${path.join(logPath, 'reader.stdout.log')}`);
}
let processCreatedAt = null;
for (let attempt = 0; attempt < 20; attempt += 1) {
  processCreatedAt = readWorkerProcessCreatedAtIso(child.pid);
  if (processCreatedAt) break;
  await new Promise((resolve) => setTimeout(resolve, 250));
}
if (!processCreatedAt) {
  try { process.kill(child.pid); } catch { /* ignore */ }
  throw new Error('PRODUCT_SOURCE_READER_PROCESS_TIME_UNAVAILABLE:cannot bind the reader process identity');
}
const marker = {
  pid: child.pid,
  workerId,
  runId: args.runId,
  startedAt,
  processCreatedAt,
  configPath,
  workerScript: WORKER_SCRIPT,
  cliRunnerPath,
  snapshotDir,
  logFile: path.join(logPath, `reader-${new Date().toISOString().slice(0, 10)}.jsonl`),
  startedBy: 'scripts/catalog/feishu-source/start-worker.mjs',
};
const ownership = verifyWorkerOwnership(marker);
if (!ownership.ok) {
  try { process.kill(child.pid); } catch { /* ignore */ }
  throw new Error(`${ownership.code}:${ownership.message}`);
}
writeJson(markerPath, marker);

// 等启动后的第一轮读取落状态（最多 60s），便于启动时直接看到结果；失败不阻止启动。
const statusFile = path.join(snapshotDir, 'reader-status.json');
const deadline = Date.now() + 60_000;
let first = null;
while (Date.now() < deadline) {
  if (fs.existsSync(statusFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
      if (parsed.updatedAt && Date.parse(parsed.updatedAt) >= Date.parse(startedAt)) {
        first = parsed;
        break;
      }
    } catch {
      // 半截/坏文件：继续等
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}
console.log(`product source reader started pid ${child.pid} workerId=${workerId} `
  + `interval=${intervalMinutes}m snapshotDir=${snapshotDir} log=${marker.logFile}`);
if (first) {
  console.log(`first read: lastResult=${first.lastResult} `
    + `businessRows=${first.counts?.businessRows ?? 'n/a'} uniqueCodes=${first.counts?.uniqueCodes ?? 'n/a'} `
    + `imageCells=${first.counts?.imageCells ?? 'n/a'} nextRunAt=${first.nextRunAt ?? 'n/a'} `
    + `error=${first.errorCode ?? 'none'}`);
} else {
  console.log('first read result not observed within 60s; check the reader log');
}
