/** Start the inventory-sync-v1 preview web app on the isolated instance (default port 3031). */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT, openRun, readArgs, safeEnv } from '../catalog/prepare.mjs';

const args = readArgs(process.argv.slice(2));
const run = openRun(args);
const envPath = path.join(run.instanceRoot, 'env.inventory.json');
if (!fs.existsSync(envPath)) throw new Error('INVENTORY_INSTANCE_NOT_PREPARED: run scripts/inventory/prepare-instance.mjs first');
const inventoryEnv = JSON.parse(fs.readFileSync(envPath, 'utf8'));
const mode = (process.env.INVENTORY_PREVIEW_NEXT_MODE ?? 'start').toLowerCase() === 'dev' ? 'dev' : 'start';
const port = String(inventoryEnv.webPort ?? 3031);

const result = spawnSync(
  process.execPath,
  [path.join(REPO_ROOT, 'scripts/catalog/start-local-preview.mjs'), '--run-id', args.runId],
  {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: safeEnv({
      CATALOG_PREVIEW_PORT: port,
      CATALOG_PREVIEW_NEXT_MODE: mode,
      INVENTORY_PREVIEW_PORT: port,
    }),
    windowsHide: true,
  },
);
if (result.status !== 0) throw new Error(`INVENTORY_WEB_START_FAILED:${result.status}`);
console.log(`inventory web ready: http://127.0.0.1:${port}/dashboard/sync (mode=${mode})`);

