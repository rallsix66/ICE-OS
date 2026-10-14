import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { REPO_ROOT, runRoot } from './common.mjs';
import { guardP001Entry } from './entry-guard.mjs';

const runId =
  process.env.P0_02_FRESH_INIT_RUN_ID ??
  `run-fresh-r4-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
guardP001Entry(runId);
const root = runRoot(runId);
const reusedPg = path.join(REPO_ROOT, '.local', 'p0-02', 'run-20261013-r1', 'pg', 'pgsql');
const targetPg = path.join(root, 'pg', 'pgsql');

function runStep(script) {
  const result = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'p0-02', script)], {
    cwd: REPO_ROOT,
    env: { ...process.env, P0_02_RUN_ID: runId, P0_02_FRESH_INIT: 'true' },
    encoding: 'utf8',
    stdio: 'inherit',
  });
  return result.status ?? 1;
}

if (!fs.existsSync(reusedPg)) {
  console.error(JSON.stringify({ status: 'failed', reason: 'missing-reused-pg-binaries' }));
  process.exit(2);
}

fs.mkdirSync(path.dirname(targetPg), { recursive: true });
if (!fs.existsSync(targetPg)) {
  fs.cpSync(reusedPg, targetPg, { recursive: true });
}

const initExit = runStep('init-cluster.mjs');
const applyExit = initExit === 0 ? runStep('apply-schema.mjs') : 1;

const summary = {
  runId,
  root,
  init: { exit: initExit },
  apply: { exit: applyExit },
};
fs.mkdirSync(path.join(root, 'evidence'), { recursive: true });
fs.writeFileSync(path.join(root, 'evidence', 'fresh-init-r4.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));

if (initExit !== 0 || applyExit !== 0) {
  process.exit(applyExit !== 0 ? applyExit : initExit);
}
