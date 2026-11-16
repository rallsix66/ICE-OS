/**
 * 停止本实例的「飞书商品来源」只读定时读取后台进程。
 *
 * 只按本实例 marker 停机，并且必须先证明进程归属（脚本/config 路径 + 进程创建时间），
 * 不误杀复用 PID 或别的实例的进程。停机后把 reader-status.worker.running 置 false。
 *
 * 用法：node scripts/catalog/feishu-source/stop-worker.mjs --run-id <run-2026...>
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO_ROOT, openRun, readArgs } from '../../catalog/prepare.mjs';
import { pidAlive, verifyWorkerOwnership } from '../../shipment/process-ownership.mjs';

const args = readArgs(process.argv.slice(2));
const run = openRun(args);
const instanceRoot = run.instanceRoot;
const markerPath = path.join(instanceRoot, 'product-source-reader.pid.json');
const configPath = path.join(instanceRoot, 'product-source-reader.json');

function resolveSnapshotDir() {
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (typeof config.snapshotDir === 'string' && config.snapshotDir) return config.snapshotDir;
    } catch {
      // 配置坏了就用默认目录；只影响状态提示。
    }
  }
  return path.join(run.root, 'source-snapshots');
}

async function markStatusStopped() {
  try {
    const { createTsLoader } = await import('./ts-loader.mjs');
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iceos-product-source-stop-'));
    try {
      const loader = createTsLoader({ tempDir });
      const status = await loader.load(path.join(REPO_ROOT, 'src/features/catalog/product-source/reader-status.ts'));
      status.writeReaderStatus(resolveSnapshotDir(), {
        worker: { running: false, pid: null, startedAt: null },
        nextRunAt: null,
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  } catch (error) {
    console.error(`product source reader status update failed: ${String(error?.message ?? error).slice(0, 300)}`);
  }
}

if (!fs.existsSync(markerPath)) {
  console.log(`no product source reader marker for ${args.runId}; nothing to stop`);
  process.exit(0);
}
let marker;
try {
  marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
} catch {
  console.error('product source reader marker is not valid JSON; refusing to stop anything');
  process.exit(1);
}
if (marker.runId && marker.runId !== args.runId) {
  console.error(`marker runId ${marker.runId} does not match ${args.runId}; refusing to stop`);
  process.exit(1);
}
if (!pidAlive(marker.pid)) {
  fs.rmSync(markerPath, { force: true });
  await markStatusStopped();
  console.log(`product source reader pid ${marker.pid} already exited; marker removed`);
  process.exit(0);
}
const ownership = verifyWorkerOwnership(marker);
if (!ownership.ok) {
  console.error(`refusing to stop pid ${marker.pid}: ${ownership.code}: ${ownership.message}`);
  process.exit(1);
}
process.kill(marker.pid, 'SIGTERM');
const deadline = Date.now() + 20_000;
let exited = false;
while (Date.now() < deadline) {
  if (!pidAlive(marker.pid)) { exited = true; break; }
  await new Promise((resolve) => setTimeout(resolve, 250));
}
if (!exited) {
  console.error(`product source reader pid ${marker.pid} did not exit gracefully within 20s; marker retained`);
  process.exit(1);
}
fs.rmSync(markerPath, { force: true });
await markStatusStopped();
console.log(`stopped product source reader pid ${marker.pid} (workerId=${marker.workerId}, owned=true)`);
