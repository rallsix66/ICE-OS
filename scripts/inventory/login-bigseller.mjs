/**
 * Open a headed Chrome window on BigSeller so the operator can log in personally, then persist the
 * session into the shared Playwright profile. Never asks for or stores a password.
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT, openRun, readArgs } from '../catalog/prepare.mjs';

const args = readArgs(process.argv.slice(2));
const run = openRun(args);
const sessionScript = path.join(REPO_ROOT, 'tools/inventory-sync/bigseller_session.py');
const result = spawnSync('python', [sessionScript, '--login', '--wait-seconds', '1800'], {
  cwd: REPO_ROOT,
  stdio: 'inherit',
  windowsHide: false,
});
if (result.status !== 0) throw new Error(`INVENTORY_BIGSELLER_LOGIN_FAILED:${result.status}`);
console.log(`BigSeller session refreshed for run ${run.runId}`);
