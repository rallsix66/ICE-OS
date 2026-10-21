import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { REPO_ROOT, readArgs, openRun, assertLiveInstance, newEvidence, writeJson, safeEnv, runCommand, snapshotWorkspace, hashFile, collectWorkspaceSourceHashes } from './prepare.mjs';

async function pickPort() {
  return new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const address = server.address(); server.close(() => resolve(address.port)); }); });
}

export async function runBrowserTests(argv = process.argv.slice(2)) {
  const run = openRun(readArgs(argv));
  await assertLiveInstance(run);
  const evidenceDir = newEvidence(run.root, 'browser');
  const rootDebugLog = path.join(REPO_ROOT, 'debug.log');
  const debugFingerprint = () => fs.existsSync(rootDebugLog) ? { size: fs.statSync(rootDebugLog).size, sha256: hashFile(rootDebugLog) } : null;
  const debugBefore = debugFingerprint();
  const chromiumLog = path.join(evidenceDir, 'chromium-debug.log');
  const workspace = path.join(evidenceDir, 'workspace');
  fs.mkdirSync(workspace);
  const manifest = snapshotWorkspace(workspace);
  writeJson(path.join(evidenceDir, 'source-manifest.json'), manifest);
  const webPort = await pickPort();
  const baseURL = `http://127.0.0.1:${webPort}`;
  const env = safeEnv({ ...run.env, NODE_ENV: 'production', CATALOG_RUN_ROOT: run.root, CATALOG_SOURCE_ROOT: REPO_ROOT, CATALOG_EVIDENCE_ROOT: path.join(run.root, 'private-evidence'), P0_02_BETTER_AUTH_URL: baseURL, NODE_PATH: path.join(REPO_ROOT, 'node_modules') });
  runCommand(process.execPath, [path.join(REPO_ROOT, 'node_modules/next/dist/bin/next'), 'build', '--webpack'], { cwd: workspace, env, evidenceDir, name: 'build' });
  if (JSON.stringify(collectWorkspaceSourceHashes()) !== JSON.stringify(manifest.files)) throw new Error('CATALOG_CURRENT_SOURCE_MANIFEST_DRIFT');
  for (const [relative, sha] of Object.entries(manifest.files)) {
    if (hashFile(path.join(workspace, relative)) !== sha) throw new Error(`CATALOG_BUILD_SOURCE_DRIFT:${relative}`);
    if (hashFile(path.join(REPO_ROOT, relative)) !== sha) throw new Error(`CATALOG_CURRENT_SOURCE_DRIFT:${relative}`);
  }
  writeJson(path.join(evidenceDir, 'build-credential.json'), { runId: run.runId, workspace, sourceSnapshotHash: manifest.sourceSnapshotHash, buildId: fs.readFileSync(path.join(workspace, '.next/BUILD_ID'), 'utf8').trim(), completedAt: new Date().toISOString() });
  const preload = path.join(REPO_ROOT, 'scripts/p0-02/loopback-network-preload.cjs');
  const serverEnv = { ...env, PORT: String(webPort), NODE_OPTIONS: `--require="${preload.replace(/\\/g, '/')}"`, P0_02_ALLOWED_PORTS: `${run.instance.port},${webPort}` };
  const stdout = fs.openSync(path.join(evidenceDir, 'next.stdout.log'), 'a');
  const stderr = fs.openSync(path.join(evidenceDir, 'next.stderr.log'), 'a');
  const child = spawn(process.execPath, [path.join(REPO_ROOT, 'node_modules/next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', String(webPort)], { cwd: workspace, env: serverEnv, windowsHide: true, stdio: ['ignore', stdout, stderr] });
  fs.closeSync(stdout); fs.closeSync(stderr);
  writeJson(path.join(evidenceDir, 'server.json'), { pid: child.pid, baseURL, runId: run.runId, startedAt: new Date().toISOString(), workspace });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 180; attempt++) {
      if (child.exitCode !== null) throw new Error(`CATALOG_NEXT_EXITED:${child.exitCode}`);
      try { const response = await fetch(`${baseURL}/auth/login`); if (response.status < 500) { ready = true; break; } } catch { /* readiness retry */ }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!ready) throw new Error('CATALOG_NEXT_READY_TIMEOUT');
    const testEnv = safeEnv({ ...run.env, CATALOG_BASE_URL: baseURL, CATALOG_RUN_ROOT: run.root, CATALOG_SOURCE_ROOT: REPO_ROOT, CATALOG_BROWSER_OUTPUT: path.join(evidenceDir, 'playwright-output'), CATALOG_BROWSER_REPORT: path.join(evidenceDir, 'playwright-report.json'), CATALOG_TEST_ENV_PATH: path.join(run.instanceRoot, 'env.catalog.json'), CATALOG_TEST_EVIDENCE_DIR: evidenceDir, P0_02_BETTER_AUTH_URL: baseURL, CHROME_LOG_FILE: chromiumLog });
    // Early Chromium/GPU diagnostics can ignore log-file flags. Its inherited
    // working directory must also be the new isolated workspace, never the repo.
    runCommand(process.execPath, [path.join(REPO_ROOT, 'node_modules/@playwright/test/cli.js'), 'test', '--config', 'playwright.config.catalog.ts'], { cwd: workspace, env: testEnv, evidenceDir, name: 'playwright' });
    if (JSON.stringify(collectWorkspaceSourceHashes()) !== JSON.stringify(manifest.files)) throw new Error('CATALOG_CURRENT_SOURCE_MANIFEST_DRIFT');
    for (const [relative, sha] of Object.entries(manifest.files)) if (hashFile(path.join(REPO_ROOT, relative)) !== sha) throw new Error(`CATALOG_CURRENT_SOURCE_DRIFT:${relative}`);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => { if (child.exitCode !== null) resolve(); else { child.once('exit', resolve); setTimeout(resolve, 5_000); } });
    writeJson(path.join(evidenceDir, 'server-stopped.json'), { pid: child.pid, stoppedAt: new Date().toISOString(), exitCode: child.exitCode, signalCode: child.signalCode });
    const debugAfter = debugFingerprint();
    const unchanged = JSON.stringify(debugBefore) === JSON.stringify(debugAfter);
    writeJson(path.join(evidenceDir, 'root-debug-log-integrity.json'), { file: rootDebugLog, before: debugBefore, after: debugAfter, unchanged, chromiumLog,
      chromiumLogFingerprint: fs.existsSync(chromiumLog) ? { size: fs.statSync(chromiumLog).size, sha256: hashFile(chromiumLog) } : null,
      isolatedWorkingDirectory: workspace,
      earlyDefaultLog: fs.existsSync(path.join(workspace, 'debug.log')) ? { path: path.join(workspace, 'debug.log'), size: fs.statSync(path.join(workspace, 'debug.log')).size, sha256: hashFile(path.join(workspace, 'debug.log')) } : null });
    if (!unchanged) throw new Error('CATALOG_ROOT_DEBUG_LOG_CHANGED');
  }
  writeJson(path.join(evidenceDir, 'result.json'), { pass: true, runId: run.runId, baseURL, sourceSnapshotHash: manifest.sourceSnapshotHash });
  console.log(`catalog browser evidence: ${evidenceDir}`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.join(REPO_ROOT, 'scripts/catalog/run-browser-tests.mjs')) runBrowserTests().catch((error) => { console.error(error.message); process.exitCode = 1; });
