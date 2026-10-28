/**
 * Bring an existing (fully stopped) inventory-sync instance back in the documented order:
 *   database -> preview web -> background worker -> status check.
 *
 * Every step delegates to the single-purpose script that verifies instance/process ownership; this
 * command never starts a second copy and never touches 3011/3021/3022/3031 instances.
 *
 * Usage: node scripts/inventory/start-instance.mjs --run-id <run>
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT, openRun, readArgs, safeEnv } from '../catalog/prepare.mjs';

const args = readArgs(process.argv.slice(2));
const run = openRun(args);
const envPath = path.join(run.instanceRoot, 'env.inventory.json');
if (!fs.existsSync(envPath)) throw new Error('INVENTORY_INSTANCE_NOT_PREPARED: run prepare-instance.mjs first');
const inventoryEnv = JSON.parse(fs.readFileSync(envPath, 'utf8'));

function step(name, script, extraEnv = {}) {
  console.log(`--- ${name}: ${script}`);
  const result = spawnSync(process.execPath, [path.join(REPO_ROOT, script), '--run-id', args.runId], {
    cwd: REPO_ROOT,
    env: safeEnv(extraEnv),
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) throw new Error(`INVENTORY_START_STEP_FAILED:${name}:${result.status}`);
  return result.status;
}

const steps = [];
steps.push(step('postgres', 'scripts/catalog/start-catalog-postgres.mjs'));
steps.push(step('web', 'scripts/inventory/start-web.mjs', {
  INVENTORY_PREVIEW_PORT: String(inventoryEnv.webPort),
  CATALOG_PREVIEW_PORT: String(inventoryEnv.webPort),
  CATALOG_PREVIEW_NEXT_MODE: process.env.CATALOG_PREVIEW_NEXT_MODE ?? 'start',
}));
steps.push(step('worker', 'scripts/inventory/start-worker.mjs'));
console.log(`--- status: scripts/inventory/status.mjs (exit code is informational; see summary)`);
const status = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts/inventory/status.mjs'), '--run-id', args.runId], {
  cwd: REPO_ROOT,
  env: safeEnv(),
  encoding: 'utf8',
  windowsHide: true,
  maxBuffer: 64 * 1024 * 1024,
});
if (status.stdout) process.stdout.write(status.stdout);
if (status.stderr) process.stderr.write(status.stderr);
console.log(`started order: postgres -> web(${inventoryEnv.webPort}) -> worker -> status; status exit=${status.status}`);
process.exitCode = status.status === 0 ? 0 : 1;
