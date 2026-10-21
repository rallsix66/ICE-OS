import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, WIN_CREATE_NO_WINDOW } from './prepare.mjs';

function tryScript(script, runId) {
  const args = [path.join(REPO_ROOT, 'scripts/catalog', script), '--run-id', runId];
  const opts = { encoding: 'utf8', windowsHide: true };
  if (process.platform === 'win32') opts.creationFlags = WIN_CREATE_NO_WINDOW;
  return spawnSync(process.execPath, args, opts);
}

const catalogRoot = path.join(REPO_ROOT, '.local', 'catalog');
if (!fs.existsSync(catalogRoot)) {
  console.log('no .local/catalog runs');
  process.exit(0);
}
const runs = fs.readdirSync(catalogRoot).filter((n) => /^run-\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(n)).sort();
for (const runId of runs) {
  const inst = path.join(catalogRoot, runId, 'instance', 'catalog-instance.json');
  if (!fs.existsSync(inst)) continue;
  for (const script of ['stop-local-preview.mjs', 'stop-catalog-postgres.mjs']) {
    const result = tryScript(script, runId);
    console.log(`${runId} ${script} exit ${result.status ?? '?'}`);
  }
}
console.log(`catalog stop-all finished (${runs.length} run dir(s) scanned). 若仍有黑窗口，直接点 X 关掉即可（旧进程）。`);

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // cli
}
