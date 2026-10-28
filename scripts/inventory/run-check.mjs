/**
 * Focused self-verification entry for the inventory-sync repair package v2.
 *
 * Stages (each writes its own receipt under .local/catalog/<run>/verify/<stamp>/):
 *   1. python-unit   : worker/parser/publisher/export offline tests (fake DB + fake exporter)
 *   2. ts-unit       : page pure logic + real-shape normalization tests (vitest.inventory)
 *   3. ownership     : R6 process-ownership negative checks (foreign pid / recycled pid refusal)
 *   4. rpc-smoke     : R2/R5/R7 app-RPC behaviour on this instance (queue candidates/paging, empty
 *                      scope round-trip, pending lock + reconcile tri-state, market options)
 *   5. session       : BigSeller read-only session probe (optional with --skip-live)
 *   6. browser       : Playwright closed loop on the running preview (optional with --skip-browser)
 *   7. pg-suite      : real PostgreSQL transaction/recovery suite on a SEPARATE instance
 *                      (--pg-instance-dir or INVENTORY_PG_INSTANCE_DIR; skipped when absent)
 *   8. backup        : database + newest export-file backup/restore drill
 *   9. live-sync     : one real automatic export run + fixed-sample raw-vs-RPC verification
 *                      (only with --with-sync; real BigSeller read-only)
 *  10. recovery      : R4.3 controlled mid-run SIGKILL -> restart takeover drill
 *                      (only with --with-drill)
 *
 * Usage:
 *   node scripts/inventory/run-check.mjs --run-id <run> [--skip-browser] [--skip-live]
 *        [--skip-backup] [--with-sync] [--with-drill] [--pg-instance-dir <dir>]
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT, openRun, readArgs, safeEnv, writeJson } from '../catalog/prepare.mjs';
import { assertConnectedTarget, assertWritableTestTarget } from './test-target-guard.mjs';

const args = readArgs(process.argv.slice(2));
const run = openRun(args);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const evidenceDir = path.join(run.root, 'verify', stamp);
fs.mkdirSync(evidenceDir, { recursive: true });
const inventoryEnv = JSON.parse(fs.readFileSync(path.join(run.instanceRoot, 'env.inventory.json'), 'utf8'));
// run-check triggers writable RPC/drill/backup stages; refuse a protected/delivered target up front.
assertWritableTestTarget({ instanceRoot: run.instanceRoot, runId: args.runId, instance: run.instance, env: inventoryEnv, purpose: 'run-check' });
const skipBrowser = process.argv.includes('--skip-browser');
const skipLive = process.argv.includes('--skip-live');
const skipBackup = process.argv.includes('--skip-backup');
const withSync = process.argv.includes('--with-sync');
const withDrill = process.argv.includes('--with-drill');
const pgDirIndex = process.argv.indexOf('--pg-instance-dir');
const pgInstanceDir = pgDirIndex >= 0
  ? path.resolve(process.argv[pgDirIndex + 1])
  : (process.env.INVENTORY_PG_INSTANCE_DIR ? path.resolve(process.env.INVENTORY_PG_INSTANCE_DIR) : null);

function portListening(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port }, () => { socket.end(); resolve(true); });
    socket.on('error', () => resolve(false));
  });
}

function exec(name, command, commandArgs, { cwd = REPO_ROOT, env = {}, timeout = 900_000, allowFailure = false } = {}) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(command, commandArgs, {
    cwd,
    env: safeEnv(env),
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    timeout,
  });
  const receipt = {
    name, command, args: commandArgs, startedAt, endedAt: new Date().toISOString(),
    status: result.status, signal: result.signal,
    stdout: (result.stdout || '').slice(-30_000), stderr: (result.stderr || '').slice(-30_000),
  };
  writeJson(path.join(evidenceDir, `${name}.json`), receipt);
  const ok = allowFailure ? true : result.status === 0;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} (exit ${result.status})`);
  if (!ok) console.log((receipt.stdout || '').slice(-2000), (receipt.stderr || '').slice(-2000));
  return { name, ok, status: result.status, skipped: false };
}

const results = [];
const node = process.execPath;

results.push(exec('python-unit', 'python', ['-m', 'pytest', 'tests/inventory_py', '-q']));
results.push(exec('ts-unit', node, [
  path.join(REPO_ROOT, 'node_modules/vitest/vitest.mjs'), 'run',
  '--config', 'vitest.config.inventory.mts',
  'tests/inventory/web-model.test.ts', 'tests/inventory/web-real-shape.test.ts',
]));
results.push(exec('ownership', node, [path.join(REPO_ROOT, 'scripts/inventory/check-process-ownership.mjs'), '--run-id', args.runId]));
results.push(exec('rpc-smoke', node, [path.join(REPO_ROOT, 'scripts/inventory/rpc-smoke.mjs'), '--run-id', args.runId]));

if (!skipLive) {
  results.push(exec('bigseller-session', 'python', [path.join(REPO_ROOT, 'tools/inventory-sync/bigseller_session.py'), '--check']));
}

if (!skipBrowser) {
  const webUp = await portListening('127.0.0.1', inventoryEnv.webPort);
  if (!webUp) {
    results.push({ name: 'browser', ok: false, skipped: false, error: `web port ${inventoryEnv.webPort} not listening` });
    console.log(`FAIL browser (port ${inventoryEnv.webPort} not listening)`);
  } else {
    results.push(exec('browser', node, [
      path.join(REPO_ROOT, 'node_modules/@playwright/test/cli.js'), 'test',
      '--config', 'playwright.config.inventory.ts',
    ], {
      env: {
        INVENTORY_BASE_URL: `http://127.0.0.1:${inventoryEnv.webPort}`,
        INVENTORY_BROWSER_EVIDENCE_DIR: path.join(evidenceDir, 'browser'),
      },
    }));
  }
}

if (pgInstanceDir) {
  // The PG suite writes its own isolated instance; it must also be a dedicated writable test target.
  try {
    const pgTargetDir = fs.existsSync(path.join(pgInstanceDir, 'instance', 'catalog-instance.json'))
      ? path.join(pgInstanceDir, 'instance')
      : pgInstanceDir;
    // R4: read the actual env first so the pre-connection guard checks the exact URLs this branch will
    // use (override query parameters must be rejected before any client is created/connected).
    const pgEnvPath = path.join(pgTargetDir, 'env.catalog.json');
    if (!fs.existsSync(pgEnvPath)) {
      throw new Error(`INVENTORY_PG_INSTANCE_ENV_MISSING:${pgEnvPath}`);
    }
    const pgEnv = JSON.parse(fs.readFileSync(pgEnvPath, 'utf8'));
    const pgInstanceMarkerPath = path.join(pgTargetDir, 'catalog-instance.json');
    const pgInstanceMarker = fs.existsSync(pgInstanceMarkerPath)
      ? JSON.parse(fs.readFileSync(pgInstanceMarkerPath, 'utf8'))
      : undefined;
    const pgGuard = assertWritableTestTarget({
      instanceRoot: pgTargetDir,
      instance: pgInstanceMarker,
      env: pgEnv,
      purpose: 'run-check pg-suite',
    });
    // Only after the pre-connection guard passed may this branch create/connect a client.
    const { default: pg } = await import('pg');
    const probe = new pg.Client({ connectionString: pgEnv.P0_02_APP_DATABASE_URL });
    await probe.connect();
    try {
      const verification = await assertConnectedTarget(probe, pgGuard, 'run-check pg-suite');
      writeJson(path.join(evidenceDir, 'pg-suite-target-verification.json'), verification);
      console.log(`pg-suite target verified: ${JSON.stringify(verification.observed)}`);
    } finally {
      await probe.end();
    }
    results.push(exec('pg-suite', node, [
      path.join(REPO_ROOT, 'node_modules/vitest/vitest.mjs'), 'run',
      '--config', 'tests/inventory/vitest.postgres.config.mts',
    ], { env: { INVENTORY_INSTANCE_DIR: pgInstanceDir } }));
  } catch (error) {
    results.push({ name: 'pg-suite', ok: false, skipped: false, error: String(error?.message ?? error) });
    console.log(`FAIL pg-suite (${String(error?.message ?? error).slice(0, 300)})`);
  }
} else {
  results.push({ name: 'pg-suite', ok: true, skipped: true, error: 'no --pg-instance-dir / INVENTORY_PG_INSTANCE_DIR' });
  console.log('SKIP pg-suite (no separate instance directory provided)');
}

if (!skipBackup) {
  results.push(exec('backup-restore', node, [path.join(REPO_ROOT, 'scripts/inventory/backup-restore-verify.mjs'), '--run-id', args.runId]));
}

if (withSync) {
  results.push(exec('live-sync', node, [path.join(REPO_ROOT, 'scripts/inventory/run-manual-sync.mjs'), '--run-id', args.runId, '--wait-seconds', '420'], { timeout: 600_000 }));
  results.push(exec('raw-fixed-samples', 'python', [path.join(REPO_ROOT, 'scripts/inventory/verify-raw-vs-detail.py'), '--run-id', args.runId]));
  results.push(exec('fixed-samples', node, [path.join(REPO_ROOT, 'scripts/inventory/verify-fixed-samples.mjs'), '--run-id', args.runId]));
}

if (withDrill) {
  results.push(exec('recovery-drill', node, [path.join(REPO_ROOT, 'scripts/inventory/recovery-drill.mjs'), '--run-id', args.runId, '--hold-ms', '90000'], { timeout: 900_000 }));
}

const summary = {
  runId: args.runId,
  evidenceDir,
  options: { skipBrowser, skipLive, skipBackup, withSync, withDrill, pgInstanceDir },
  stages: results.map(({ name, ok, status, error, skipped }) => ({ name, ok, status, error, skipped: Boolean(skipped) })),
  allOk: results.every((result) => result.ok),
  finishedAt: new Date().toISOString(),
};
writeJson(path.join(evidenceDir, 'summary.json'), summary);
writeJson(path.join(run.root, 'inventory-verify-latest.json'), { ...summary, evidenceDir });
console.log(JSON.stringify(summary, null, 2));
process.exitCode = summary.allOk ? 0 : 1;
