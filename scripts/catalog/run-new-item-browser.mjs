import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { NEW_ITEM_REPO_ROOT, openNewItemRun, assertNewItemLive, snapshotNewItemWorkspace, collectNewItemHashes, fileHash, stopExactNewItemInstance } from './prepare-new-item.mjs';

const pickPort = () => new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const address = server.address(); server.close(() => resolve(address.port)); }); });
const portListening = (port) => new Promise((resolve) => {
  const socket = net.connect({ host: '127.0.0.1', port });
  const finish = (listening) => { socket.destroy(); resolve(listening); };
  socket.once('connect', () => finish(true)); socket.once('error', () => finish(false)); socket.setTimeout(500, () => finish(true));
});
const childExited = (child) => child.exitCode !== null || child.signalCode !== null;
const waitForChild = (child, milliseconds) => new Promise((resolve) => {
  if (childExited(child)) return resolve();
  const finish = () => { clearTimeout(timer); child.off('exit', finish); resolve(); };
  const timer = setTimeout(finish, milliseconds); child.once('exit', finish);
});
async function stopOwnWebChild(child, webPort) {
  child.kill('SIGTERM'); await waitForChild(child, 5_000);
  const forced = !childExited(child);
  if (forced) { child.kill('SIGKILL'); await waitForChild(child, 5_000); }
  let pidPresent;
  try { process.kill(child.pid, 0); pidPresent = true; } catch (error) { if (error.code !== 'ESRCH') throw error; pidPresent = false; }
  let listening = true;
  for (let attempt = 0; attempt < 20; attempt++) {
    listening = await portListening(webPort); if (!listening) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { pid: child.pid, webPort, exitCode: child.exitCode, signalCode: child.signalCode, forced, pidPresent, portListening: listening, stopped: childExited(child) && !pidPresent && !listening, stoppedAt: new Date().toISOString() };
}
export async function runNewItemBrowser(argv = process.argv.slice(2)) {
  const run = await openNewItemRun(argv), h = run.helper;
  if (['new-item-postgres-started.json', 'new-item-check-started.json', 'new-item-browser-started.json'].some((name) => fs.existsSync(path.join(run.root, name)))) throw new Error('N1C_BROWSER_REQUIRES_SEPARATE_FRESH_INSTANCE');
  fs.writeFileSync(path.join(run.root, 'new-item-browser-started.json'), JSON.stringify({ runId: run.runId, processId: process.pid, parentProcessId: process.ppid, startedAt: new Date().toISOString() }), { flag: 'wx' });
  const evidenceDirectory = h.newEvidence(run.root, 'new-item-browser');
  const workspace = path.join(evidenceDirectory, 'workspace');
  const rootDebug = path.join(NEW_ITEM_REPO_ROOT, 'debug.log');
  const fingerprint = (file) => fs.existsSync(file) ? { size: fs.statSync(file).size, sha256: fileHash(file) } : null;
  const debugBefore = fingerprint(rootDebug);
  let child, source, webPort;
  try {
  h.writeJson(path.join(evidenceDirectory, 'target.json'), await assertNewItemLive(run));
  const { default: pg } = await import('pg'), i = run.instance;
  const owner = new pg.Client({ connectionString: `postgres://${i.bootstrapUser}:${i.bootstrapPassword}@${i.host}:${i.port}/${i.dbName}` });
  await owner.connect();
  try {
    const state = (await owner.query(`SELECT (SELECT count(*)::int FROM catalog.baseline_release) AS releases,(SELECT count(*)::int FROM catalog.product_capture) AS captures,(SELECT count(*)::int FROM catalog.new_item_request) AS requests`)).rows[0];
    if (Object.values(state).some((value) => value !== 0)) throw new Error('N1C_BROWSER_REQUIRES_UNTOUCHED_C_DATA');
  } finally { await owner.end(); }
  fs.mkdirSync(workspace);
  source = await snapshotNewItemWorkspace(workspace); h.writeJson(path.join(evidenceDirectory, 'source-manifest.json'), source);
  webPort = await pickPort(); const baseURL = `http://127.0.0.1:${webPort}`;
  const env = h.safeEnv({ ...run.env, NODE_ENV: 'production', NODE_PATH: path.join(NEW_ITEM_REPO_ROOT, 'node_modules'), P0_02_BETTER_AUTH_URL: baseURL });
  h.runCommand(process.execPath, [path.join(NEW_ITEM_REPO_ROOT, 'node_modules/next/dist/bin/next'), 'build', '--webpack'], { cwd: workspace, env, evidenceDir: evidenceDirectory, name: 'new-item-build' });
  const assertSources = async () => {
    if (JSON.stringify(await collectNewItemHashes()) !== JSON.stringify(source.files)) throw new Error('N1C_CURRENT_SOURCE_DRIFT');
    for (const [relative, sha] of Object.entries(source.files)) if (fileHash(path.join(workspace, relative)) !== sha) throw new Error('N1C_WORKSPACE_SOURCE_DRIFT');
  };
  await assertSources();
  h.writeJson(path.join(evidenceDirectory, 'build-credential.json'), { runId: run.runId, workspace, sourceSnapshotHash: source.sourceSnapshotHash, buildId: fs.readFileSync(path.join(workspace, '.next/BUILD_ID'), 'utf8').trim() });
  const out = fs.openSync(path.join(evidenceDirectory, 'next.stdout.log'), 'a'), err = fs.openSync(path.join(evidenceDirectory, 'next.stderr.log'), 'a');
  const preload = path.join(NEW_ITEM_REPO_ROOT, 'scripts/p0-02/loopback-network-preload.cjs').replace(/\\/g, '/');
  child = spawn(process.execPath, [path.join(NEW_ITEM_REPO_ROOT, 'node_modules/next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', String(webPort)], { cwd: workspace, env: { ...env, PORT: String(webPort), P0_02_ALLOWED_PORTS: `${run.instance.port},${webPort}`, NODE_OPTIONS: `--require="${preload}"` }, windowsHide: true, stdio: ['ignore', out, err] });
  fs.closeSync(out); fs.closeSync(err);
  h.writeJson(path.join(evidenceDirectory, 'server.json'), { runId: run.runId, pid: child.pid, baseURL, workspace, startedAt: new Date().toISOString() });
    let ready = false;
    for (let attempt = 0; attempt < 180; attempt++) {
      if (child.exitCode !== null) throw new Error('N1C_NEXT_EXITED');
      try { if ((await fetch(`${baseURL}/auth/login`)).status < 500) { ready = true; break; } } catch { /* readiness */ }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!ready) throw new Error('N1C_NEXT_READY_TIMEOUT');
    const testEnv = h.safeEnv({ ...run.env, CATALOG_BASE_URL: baseURL, CATALOG_TEST_ENV_PATH: run.envFile, CATALOG_TEST_EVIDENCE_DIR: evidenceDirectory, CATALOG_NEW_ITEM_TEST_EVIDENCE_DIR: evidenceDirectory, CATALOG_BROWSER_OUTPUT: path.join(evidenceDirectory, 'playwright-output'), CATALOG_BROWSER_REPORT: path.join(evidenceDirectory, 'playwright-report.json'), P0_02_BETTER_AUTH_URL: baseURL, CHROME_LOG_FILE: path.join(evidenceDirectory, 'chromium-debug.log') });
    h.runCommand(process.execPath, [path.join(NEW_ITEM_REPO_ROOT, 'node_modules/@playwright/test/cli.js'), 'test', '--config', 'playwright.config.catalog-new-item.ts'], { cwd: workspace, env: testEnv, evidenceDir: evidenceDirectory, name: 'new-item-playwright' });
    await assertSources();
  } finally {
    let webStopFailure;
    if (child) {
      try {
        const stopped = await stopOwnWebChild(child, webPort);
        h.writeJson(path.join(evidenceDirectory, 'server-stopped.json'), { runId: run.runId, ...stopped });
        if (!stopped.stopped) webStopFailure = new Error('N1C_OWN_WEB_CHILD_NOT_STOPPED');
      } catch (error) { webStopFailure = error; h.writeJson(path.join(evidenceDirectory, 'server-stop-failure.json'), { runId: run.runId, pid: child.pid, webPort, error: error.message }); }
    }
    const debugAfter = fingerprint(rootDebug), unchanged = JSON.stringify(debugBefore) === JSON.stringify(debugAfter);
    h.writeJson(path.join(evidenceDirectory, 'root-debug-log-integrity.json'), { file: rootDebug, before: debugBefore, after: debugAfter, unchanged, isolatedWorkingDirectory: workspace, earlyDefaultLog: fingerprint(path.join(workspace, 'debug.log')) });
    await stopExactNewItemInstance(run.runId, evidenceDirectory);
    if (!unchanged) throw new Error('N1C_ROOT_DEBUG_LOG_CHANGED');
    if (webStopFailure) throw webStopFailure;
  }
  h.writeJson(path.join(evidenceDirectory, 'result.json'), { pass: true, runId: run.runId, sourceSnapshotHash: source.sourceSnapshotHash });
  console.log(`new item browser evidence: ${evidenceDirectory}`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runNewItemBrowser().catch((error) => { console.error(error.message); process.exitCode = 1; });
