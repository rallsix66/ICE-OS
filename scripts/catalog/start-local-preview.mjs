import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { REPO_ROOT, detachedHiddenSpawnOptions, openRun, readArgs, safeEnv, writeJson } from './prepare.mjs';
import { startCatalogPostgres } from './start-catalog-postgres.mjs';
import { computePreviewSourceSnapshotHash, ensurePreviewWorkspace, previewWorkspaceRefreshNeeded } from './ensure-preview-workspace.mjs';
import {
  pidAlive,
  readPreviewProcessCreatedAtIso,
  verifyPreviewServerOwnership,
} from './preview-process-ownership.mjs';
import { priorPreviewAction } from './preview-start-prior-action.mjs';
import { applyCatalogIncrements } from './apply-catalog-increments.mjs';
import { mergePreviewNodeOptions } from './merge-preview-node-options.mjs';
import {
  readBuildId,
  validateReadyRecord,
  verifyNextArtifacts,
} from './preview-build-credential.mjs';
function portListening(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port }, () => { socket.end(); resolve(true); });
    socket.on('error', () => resolve(false));
  });
}

async function waitForPreviewReady(baseUrl, timeoutMs = 240_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/auth/login`, { redirect: 'manual' });
      if (res.status === 200) return true;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function stopVerifiedPreview(runId) {
  const stop = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts/catalog/stop-local-preview.mjs'), '--run-id', runId], {
    encoding: 'utf8',
    env: safeEnv(),
    windowsHide: true,
  });
  if (stop.status !== 0) {
    throw new Error(`CATALOG_PREVIEW_CONTROLLED_STOP_FAILED:${stop.stderr || stop.stdout || stop.status}`);
  }
}

const args = readArgs(process.argv.slice(2));
const run = openRun(args);
const instance = JSON.parse(fs.readFileSync(path.join(run.instanceRoot, 'catalog-instance.json'), 'utf8'));
if (!instance.previewReady) throw new Error('CATALOG_LOCAL_PREVIEW_NOT_SEEDED');
const port = Number(process.env.CATALOG_PREVIEW_PORT ?? 3010);
const baseUrl = `http://127.0.0.1:${port}`;
const markerPath = path.join(run.instanceRoot, 'preview-server.json');
const previewMode = (process.env.CATALOG_PREVIEW_NEXT_MODE ?? 'start').toLowerCase() === 'dev' ? 'dev' : 'start';
let alreadyRunning = false;

if (fs.existsSync(markerPath)) {
  const prior = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  if (prior.pid && pidAlive(prior.pid)) {
    const owned = verifyPreviewServerOwnership(prior.pid, prior);
    if (!owned.ok) {
      throw new Error(`${owned.code}:${owned.message}`);
    }
    if (prior.runId !== args.runId) {
      throw new Error(`CATALOG_PREVIEW_MARKER_STALE:marker runId ${prior.runId} does not match ${args.runId}`);
    }
    const refresh = previewWorkspaceRefreshNeeded(run.instanceRoot);
    const strictLauncherMarker = Boolean(prior.processCreatedAt);
    const modeMatches = !prior.previewMode || prior.previewMode === previewMode;
    if (strictLauncherMarker && modeMatches && !refresh.needed && prior.port === port && await portListening('127.0.0.1', port)) {
      const ready = await waitForPreviewReady(baseUrl, 5_000);
      if (ready) {
        alreadyRunning = true;
      }
    }
    const action = priorPreviewAction({ alreadyRunning });
    if (action === 'controlled-stop') {
      await stopVerifiedPreview(args.runId);
    }
  } else {
    fs.rmSync(markerPath, { force: true });
  }
}

await startCatalogPostgres(['--run-id', args.runId]);
await applyCatalogIncrements(args);
if (alreadyRunning) {
  console.log(`local preview already running: ${baseUrl}/dashboard/catalog (run ${args.runId})`);
  process.exit(0);
}

const activeWorkspace = path.join(run.instanceRoot, 'next-workspace');
const manifestPath = path.join(run.instanceRoot, 'next-workspace-manifest.json');
const readyPath = path.join(run.instanceRoot, 'preview-build-ready.json');
const readyRecord = fs.existsSync(readyPath) ? JSON.parse(fs.readFileSync(readyPath, 'utf8')) : null;
const readyValid = readyRecord
  ? validateReadyRecord(run.instanceRoot, readyRecord)
  : { ok: false, code: 'READY_MISSING' };
if (previewMode === 'start' && !readyValid.ok) {
  throw new Error(`CATALOG_PREVIEW_BUILD_NOT_PROMOTED:${readyValid.code ?? 'READY_MISSING'}:use build-preview-workspace.mjs then promote-preview-build.mjs`);
}
let workspaceResult;
if (readyValid.ok) {
  verifyNextArtifacts(activeWorkspace);
  workspaceResult = {
    workspace: activeWorkspace,
    manifest: fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null,
    refreshed: false,
  };
  if (readyValid.repoSourceDrift) {
    console.warn(`preview compile source drift: promoted ${readyValid.compileSourceSnapshotHash} vs repo ${computePreviewSourceSnapshotHash()}; keeping promoted .next`);
  }
} else {
  if (readyRecord) console.warn(`preview-build-ready rejected (${readyValid.code}); syncing workspace source snapshot (dev mode)`);
  workspaceResult = ensurePreviewWorkspace(run.instanceRoot);
}
const { workspace, manifest } = workspaceResult;
const envFile = path.join(run.instanceRoot, 'env.catalog.json');
const envJson = JSON.parse(fs.readFileSync(envFile, 'utf8'));
envJson.P0_02_BETTER_AUTH_URL = baseUrl;
fs.writeFileSync(envFile, `${JSON.stringify(envJson, null, 2)}\n`);
const basisPath = path.join(workspace, 'docs/catalog/local-sample-valuation-basis-20261021.json');
if (!fs.existsSync(basisPath)) throw new Error(`CATALOG_WORKSPACE_BASIS_MISSING:${basisPath}`);
const preload = path.join(REPO_ROOT, 'scripts/p0-02/loopback-network-preload.cjs');
const launcher = path.join(REPO_ROOT, 'scripts/catalog/catalog-next-preview-dev.mjs');
const env = safeEnv({
  ...envJson,
  PORT: String(port),
  HOSTNAME: '127.0.0.1',
  NODE_ENV: previewMode === 'dev' ? 'development' : 'production',
  NODE_OPTIONS: mergePreviewNodeOptions(preload),
  P0_02_ALLOWED_PORTS: `${instance.port},${port}`,
  CATALOG_PREVIEW_RUN_ID: args.runId,
  CATALOG_HIDE_DEV_INDICATORS: previewMode === 'dev' ? 'true' : undefined,
  NEXT_PUBLIC_ICE_POST_LOGIN_PATH: '/dashboard/catalog',
});
if (previewMode === 'start') {
  verifyNextArtifacts(workspace);
  if (readBuildId(workspace) !== readyValid.buildId) {
    throw new Error('CATALOG_PREVIEW_BUILD_ID_MISMATCH:active workspace does not match preview-build-ready.json');
  }
}
const log = fs.openSync(path.join(run.instanceRoot, 'next-preview.log'), 'a');
const nextArgs = previewMode === 'dev'
  ? ['dev', '--webpack', '-p', String(port), '-H', '127.0.0.1']
  : ['start', '-p', String(port), '-H', '127.0.0.1'];
const child = spawn(
  process.execPath,
  [
    launcher,
    '--catalog-workspace', workspace,
    '--catalog-run-id', args.runId,
    ...nextArgs,
  ],
  detachedHiddenSpawnOptions({ cwd: REPO_ROOT, env, stdio: ['ignore', log, log] }),
);
child.unref();
let processCreatedAt = null;
for (let attempt = 0; attempt < 20; attempt += 1) {
  await new Promise((r) => setTimeout(r, 250));
  if (!pidAlive(child.pid)) break;
  processCreatedAt = readPreviewProcessCreatedAtIso(child.pid);
  if (processCreatedAt) break;
}
if (!processCreatedAt) {
  try { process.kill(child.pid); } catch { /* ignore */ }
  if (!pidAlive(child.pid)) {
    throw new Error(`CATALOG_PREVIEW_LAUNCHER_EXITED:preview launcher exited before ready (see ${path.join(run.instanceRoot, 'next-preview.log')})`);
  }
  throw new Error('CATALOG_PREVIEW_PROCESS_TIME_UNAVAILABLE:cannot read launcher creation time');
}
const ready = await waitForPreviewReady(baseUrl);
if (!ready) {
  try { process.kill(child.pid); } catch { /* ignore */ }
  throw new Error('CATALOG_PREVIEW_START_TIMEOUT');
}
const startedAt = new Date().toISOString();
const serverMeta = {
  pid: child.pid,
  url: `${baseUrl}/dashboard/catalog`,
  port,
  workspace,
  launcher,
  previewMode,
  startedAt,
  processCreatedAt,
  runId: args.runId,
  workspaceSourceSnapshotHash: manifest.sourceSnapshotHash,
  basisDocumentPath: basisPath,
  ready: true,
};
fs.writeFileSync(markerPath, `${JSON.stringify(serverMeta, null, 2)}\n`);
writeJson(path.join(run.root, 'local-preview-manifest.json'), {
  runId: args.runId,
  host: instance.host,
  port: instance.port,
  database: instance.dbName,
  previewUrl: serverMeta.url,
  authOrigin: baseUrl,
  workspaceSourceSnapshotHash: manifest.sourceSnapshotHash,
  login: { email: 'admin@catalog.test', note: '密码见 instance/login.local-preview.txt（不入库）' },
});
console.log(`local preview ready: ${serverMeta.url} (run ${args.runId}, pid ${child.pid}, isolated cwd ${workspace})`);
