/**
 * 停止本实例的货票在途定时读取后台进程。
 *
 * 只按本实例 marker 停机，并且必须先证明进程归属（脚本/config 路径 + 进程创建时间），
 * 不误杀复用 PID 或别的实例的进程。
 *
 * 用法：node scripts/shipment/stop-worker.mjs --run-id <run-2026...>
 */
import fs from 'node:fs';
import path from 'node:path';
import { openRun, readArgs } from '../catalog/prepare.mjs';
import { pidAlive, verifyWorkerOwnership } from './process-ownership.mjs';

const args = readArgs(process.argv.slice(2));
const run = openRun(args);
const markerPath = path.join(run.instanceRoot, 'shipment-auto-reader.pid.json');

if (!fs.existsSync(markerPath)) {
  console.log(`no shipment auto reader marker for ${args.runId}; nothing to stop`);
  process.exit(0);
}
let marker;
try {
  marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
} catch {
  console.error('shipment auto reader marker is not valid JSON; refusing to stop anything');
  process.exit(1);
}
if (marker.runId && marker.runId !== args.runId) {
  console.error(`marker runId ${marker.runId} does not match ${args.runId}; refusing to stop`);
  process.exit(1);
}
if (!pidAlive(marker.pid)) {
  fs.rmSync(markerPath, { force: true });
  console.log(`shipment auto reader pid ${marker.pid} already exited; marker removed`);
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
  console.error(`shipment auto reader pid ${marker.pid} did not exit gracefully within 20s; marker retained`);
  process.exit(1);
}
fs.rmSync(markerPath, { force: true });
console.log(`stopped shipment auto reader pid ${marker.pid} (workerId=${marker.workerId}, owned=true)`);
