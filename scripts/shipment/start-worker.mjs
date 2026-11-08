/**
 * 启动货票在途的定时读取后台进程（Node，常驻），并与实例启动方式集成。
 *
 * - 配置写在本实例 `instance/shipment-auto-reader.json`（含受限 sync 数据库连接、飞书 CLI 路径、
 *   日志/临时目录、轮询间隔），实例重启后用同一命令即可继续运行，不依赖 agent 临时启动。
 * - 只认本实例 marker（pid + 脚本/config 路径 + 进程创建时间）判断“是否已在运行”，
 *   已运行则直接复用；PID 存活但归属不成立时拒绝启动第二个进程。
 *
 * 用法：node scripts/shipment/start-worker.mjs --run-id <run-2026...>
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
} from '../catalog/prepare.mjs';
import { pidAlive, readWorkerProcessCreatedAtIso, verifyWorkerOwnership } from './process-ownership.mjs';

const WORKER_SCRIPT = path.join(REPO_ROOT, 'scripts/shipment/worker.mjs');

function resolveLarkCliRunner() {
  const override = process.env.SHIPMENT_LARK_CLI_RUNNER?.trim();
  if (override) {
    if (!fs.existsSync(override)) throw new Error(`SHIPMENT_LARK_CLI_RUNNER_NOT_FOUND:${override}`);
    return override;
  }
  const appData = process.env.APPDATA;
  if (appData) {
    const fallback = path.join(appData, 'npm', 'node_modules', '@larksuite', 'cli', 'scripts', 'run.js');
    if (fs.existsSync(fallback)) return fallback;
  }
  throw new Error('SHIPMENT_LARK_CLI_MISSING: set SHIPMENT_LARK_CLI_RUNNER to lark-cli run.js');
}

const args = readArgs(process.argv.slice(2));
const run = openRun(args);
const inventoryEnvPath = path.join(run.instanceRoot, 'env.inventory.json');
if (!fs.existsSync(inventoryEnvPath)) {
  throw new Error('SHIPMENT_READER_INSTANCE_NOT_PREPARED: run scripts/inventory/prepare-instance.mjs first');
}
const inventoryEnv = JSON.parse(fs.readFileSync(inventoryEnvPath, 'utf8'));
const catalogEnvPath = path.join(run.instanceRoot, 'env.catalog.json');
const catalogEnv = fs.existsSync(catalogEnvPath) ? JSON.parse(fs.readFileSync(catalogEnvPath, 'utf8')) : {};
const syncDbUrl = inventoryEnv.syncDbUrl ?? catalogEnv.P0_02_SYNC_DATABASE_URL;
const ownerDbUrl = inventoryEnv.ownerDbUrl;
if (!syncDbUrl) throw new Error('SHIPMENT_READER_SYNC_DB_URL_MISSING');

const cliRunnerPath = resolveLarkCliRunner();
const readerRoot = path.join(run.instanceRoot, 'shipment-auto-reader');
const logPath = path.join(readerRoot, 'logs');
const tsTempDir = path.join(readerRoot, 'tmp');
fs.mkdirSync(logPath, { recursive: true });
fs.mkdirSync(tsTempDir, { recursive: true });

const configPath = path.join(run.instanceRoot, 'shipment-auto-reader.json');
const config = {
  runId: args.runId,
  workerId: `shipment-auto-reader-${inventoryEnv.port}`,
  sourceKey: 'feishu_logistics_sheet',
  sourceUrl: process.env.SHIPMENT_FEISHU_URL ?? null,
  syncDbUrl,
  webPort: inventoryEnv.webPort,
  cliRunnerPath,
  logPath,
  tsTempDir,
  pollSeconds: Number(process.env.SHIPMENT_READER_POLL_SECONDS ?? 20),
  createdAt: new Date().toISOString(),
  startedBy: 'scripts/shipment/start-worker.mjs',
};
writeJson(configPath, config);

const markerPath = path.join(run.instanceRoot, 'shipment-auto-reader.pid.json');
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
    console.log(`shipment auto reader already running pid ${prior.pid} (workerId=${prior.workerId}, owned=true)`);
    process.exit(0);
  }
  fs.rmSync(markerPath, { force: true });
}

const out = fs.openSync(path.join(logPath, 'reader.stdout.log'), 'a');
const child = spawn(
  process.execPath,
  [WORKER_SCRIPT, '--config', configPath],
  detachedHiddenSpawnOptions({
    cwd: REPO_ROOT,
    env: safeEnv({
      SHIPMENT_LARK_CLI_RUNNER: cliRunnerPath,
      ...(process.env.SHIPMENT_FEISHU_URL ? { SHIPMENT_FEISHU_URL: process.env.SHIPMENT_FEISHU_URL } : {}),
    }),
    stdio: ['ignore', out, out],
  }),
);
child.unref();
await new Promise((resolve) => setTimeout(resolve, 2000));
if (!pidAlive(child.pid)) {
  throw new Error(`SHIPMENT_READER_EXITED_IMMEDIATELY: see ${path.join(logPath, 'reader.stdout.log')}`);
}
let processCreatedAt = null;
for (let attempt = 0; attempt < 20; attempt += 1) {
  processCreatedAt = readWorkerProcessCreatedAtIso(child.pid);
  if (processCreatedAt) break;
  await new Promise((resolve) => setTimeout(resolve, 250));
}
if (!processCreatedAt) {
  try { process.kill(child.pid); } catch { /* ignore */ }
  throw new Error('SHIPMENT_READER_PROCESS_TIME_UNAVAILABLE:cannot bind the reader process identity');
}
const marker = {
  pid: child.pid,
  workerId: config.workerId,
  runId: args.runId,
  startedAt: new Date().toISOString(),
  processCreatedAt,
  configPath,
  workerScript: WORKER_SCRIPT,
  cliRunnerPath,
  logFile: path.join(logPath, `reader-${new Date().toISOString().slice(0, 10)}.jsonl`),
  startedBy: 'scripts/shipment/start-worker.mjs',
};
const ownership = verifyWorkerOwnership(marker);
if (!ownership.ok) {
  try { process.kill(child.pid); } catch { /* ignore */ }
  throw new Error(`${ownership.code}:${ownership.message}`);
}
writeJson(markerPath, marker);

// 打印一次数据库侧状态（定时读取是否启用、间隔、下次计划），便于启动时核对。
let stateLine = 'reader state unavailable';
if (ownerDbUrl) {
  try {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: ownerDbUrl, max: 1 });
    try {
      const row = (await pool.query(
        `SELECT enabled, interval_minutes, next_run_at, last_result, last_error_code
         FROM catalog.shipment_auto_reader WHERE id`)).rows[0];
      if (row) {
        stateLine = `enabled=${row.enabled} interval=${row.interval_minutes}m `
          + `nextRunAt=${row.next_run_at?.toISOString?.() ?? row.next_run_at} `
          + `lastResult=${row.last_result ?? 'none'} lastError=${row.last_error_code ?? 'none'}`;
      }
    } finally {
      await pool.end();
    }
  } catch (error) {
    stateLine = `reader state read failed: ${String(error?.message ?? error).slice(0, 200)}`;
  }
}
console.log(`shipment auto reader started pid ${child.pid} workerId=${config.workerId} `
  + `cli=${cliRunnerPath} log=${marker.logFile}`);
console.log(stateLine);
