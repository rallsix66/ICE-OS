/**
 * Stop the inventory-sync-v1 background worker owned by this run.
 *
 * Refuses to signal a pid unless the live process proves ownership: exact frozen worker script path,
 * exact instance config path and matching process creation time. A recycled PID or another inventory
 * worker must never be stopped from this instance's marker.
 */
import fs from 'node:fs';
import path from 'node:path';
import { openRun, readArgs } from '../catalog/prepare.mjs';
import { pidAlive, verifyWorkerOwnership } from './worker-process-ownership.mjs';

const args = readArgs(process.argv.slice(2));
const run = openRun(args);
const markerPath = path.join(run.instanceRoot, 'inventory-worker.pid.json');

if (!fs.existsSync(markerPath)) {
  console.log(`no inventory worker marker for ${args.runId}; nothing to stop`);
  process.exit(0);
}
let marker;
try {
  marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
} catch {
  console.error(`inventory worker marker for ${args.runId} is not valid JSON; refusing to stop anything`);
  process.exit(1);
}
if (marker.runId && marker.runId !== args.runId) {
  console.error(`inventory worker marker runId ${marker.runId} does not match ${args.runId}; refusing to stop`);
  process.exit(1);
}
if (!pidAlive(marker.pid)) {
  fs.rmSync(markerPath, { force: true });
  console.log(`inventory worker pid ${marker.pid} already exited; marker removed`);
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
  console.error(`inventory worker pid ${marker.pid} did not exit gracefully within 20s; marker retained`);
  process.exit(1);
}
fs.rmSync(markerPath, { force: true });
console.log(`stopped inventory worker pid ${marker.pid} (workerId=${marker.workerId}, owned=true)`);
