/** Stop this run's worker, preview web and isolated postgres. Refuses to touch any other instance. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT, openRun, readArgs, safeEnv } from '../catalog/prepare.mjs';

const args = readArgs(process.argv.slice(2));
const run = openRun(args);
const results = [];

function runScript(script) {
  const result = spawnSync(process.execPath, [path.join(REPO_ROOT, script), '--run-id', args.runId], {
    cwd: REPO_ROOT,
    env: safeEnv(),
    encoding: 'utf8',
    windowsHide: true,
  });
  results.push({ script, status: result.status, stdout: (result.stdout || '').trim(), stderr: (result.stderr || '').trim() });
  return result.status === 0;
}

const workerStopped = fs.existsSync(path.join(run.instanceRoot, 'inventory-worker.pid.json'))
  ? runScript('scripts/inventory/stop-worker.mjs')
  : true;
const webStopped = runScript('scripts/catalog/stop-local-preview.mjs');
const pgStopped = runScript('scripts/catalog/stop-catalog-postgres.mjs');
console.log(JSON.stringify({ runId: args.runId, workerStopped, webStopped, pgStopped, results }, null, 2));
process.exitCode = workerStopped && webStopped && pgStopped ? 0 : 1;
