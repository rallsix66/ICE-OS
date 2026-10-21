import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, newEvidence, runCommand, safeEnv, writeJson } from './prepare.mjs';
import { prepareLocalPreview } from './prepare-local-preview.mjs';
import { ensurePreviewWorkspace } from './ensure-preview-workspace.mjs';
import { runPreviewOwnershipNegative } from './run-preview-ownership-negative.mjs';
import { runPreviewOwnershipProbes } from './run-preview-ownership-probes.mjs';
import { runPreviewStartWorkspaceGuard } from './run-preview-start-workspace-guard.mjs';
import { runPreviewStartControlFlowProbe } from './run-preview-start-control-flow-probe.mjs';
import { runPreviewDoubleStart } from './run-preview-double-start.mjs';
import { collectWorkspaceSourceHashes } from './prepare.mjs';

function sourceSnapshotHash() {
  const sorted = collectWorkspaceSourceHashes();
  return crypto.createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

function captureDisplaySnapshot(label, env, outPath) {
  runCommand(process.execPath, [
    path.join(REPO_ROOT, 'node_modules/vitest/vitest.mjs'),
    'run',
    '--config',
    'vitest.config.catalog.mts',
    'tests/catalog/local-preview-snapshot.postgres.test.ts',
  ], {
    env: safeEnv({ ...env, CATALOG_SNAPSHOT_OUT: outPath, CATALOG_SNAPSHOT_LABEL: label }),
    evidenceDir,
    name: `snapshot-${label}`,
  });
  return JSON.parse(fs.readFileSync(outPath, 'utf8'));
}

const runId = `run-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z-${crypto.randomBytes(4).toString('hex')}`;
const root = path.join(REPO_ROOT, '.local/catalog', runId);
const evidenceDir = newEvidence(root, 'self-verify');
const log = [];
let failed = false;

function evidenceJsonPath(name) {
  return path.join(evidenceDir, `${name}.json`);
}

function persistLog(extra = {}) {
  writeJson(path.join(evidenceDir, 'self-verify-log.json'), {
    runId,
    root,
    steps: log,
    failed,
    finishedAt: new Date().toISOString(),
    ...extra,
  });
}

function step(name, fn) {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  let exitCode = 0;
  let errorMessage;
  try {
    const out = fn();
    exitCode = typeof out === 'number' ? out : out?.status ?? 0;
  } catch (error) {
    failed = true;
    exitCode = typeof error?.message === 'string' && error.message.startsWith('CATALOG_COMMAND_FAILED:')
      ? Number(error.message.split(':').pop()) || 1
      : 1;
    errorMessage = error instanceof Error ? error.message : String(error);
    process.exitCode = exitCode || 1;
  }
  const entry = {
    name,
    commandEvidence: evidenceJsonPath(name),
    startedAt,
    endedAt: new Date().toISOString(),
    exitCode,
    ms: Date.now() - t0,
    ...(errorMessage ? { error: errorMessage } : {}),
  };
  log.push(entry);
  persistLog({ lastStep: name, previewLeftRunning: null });
  return exitCode;
}

function loadRunEnv() {
  const instanceRoot = path.join(root, 'instance');
  const envJson = JSON.parse(fs.readFileSync(path.join(instanceRoot, 'env.catalog.json'), 'utf8'));
  return safeEnv({ ...envJson, CATALOG_RUN_ROOT: root, CATALOG_SOURCE_ROOT: REPO_ROOT });
}

function releasePreviewPortForRun(port, exceptRunId) {
  const catalogRoot = path.join(REPO_ROOT, '.local', 'catalog');
  if (!fs.existsSync(catalogRoot)) return;
  for (const otherRunId of fs.readdirSync(catalogRoot)) {
    if (otherRunId === exceptRunId || !/^run-\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(otherRunId)) continue;
    const markerPath = path.join(catalogRoot, otherRunId, 'instance', 'preview-server.json');
    if (!fs.existsSync(markerPath)) continue;
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    if (Number(marker.port) !== port) continue;
    runCommand(process.execPath, [path.join(REPO_ROOT, 'scripts/catalog/stop-local-preview.mjs'), '--run-id', otherRunId], {
      env: safeEnv(),
      evidenceDir,
      name: `release-port-${otherRunId}`,
    });
  }
}

function previewLeftRunningNow() {
  try {
    const code = runCommand(process.execPath, [path.join(REPO_ROOT, 'scripts/catalog/status-local-preview.mjs'), '--run-id', runId], {
      env: safeEnv(),
      evidenceDir,
      name: 'preview-left-running-check',
    });
    return (code?.status ?? 0) === 0;
  } catch {
    return false;
  }
}

// --- prepare (recorded separately; throws on failure) ---
{
  const name = 'prepare-local-preview';
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  let exitCode = 0;
  let errorMessage;
  try {
    await prepareLocalPreview(['--run-id', runId]);
  } catch (error) {
    failed = true;
    exitCode = 1;
    errorMessage = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
  }
  log.push({
    name,
    startedAt,
    endedAt: new Date().toISOString(),
    exitCode,
    ms: Date.now() - t0,
    ...(errorMessage ? { error: errorMessage } : {}),
  });
  persistLog({ lastStep: name, previewLeftRunning: false });
  if (failed) {
    console.error(`self-verify aborted at prepare: ${root}`);
    process.exit(process.exitCode ?? 1);
  }
}

{
  const name = 'preview-ownership-negative';
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  let exitCode = 0;
  let errorMessage;
  try {
    process.env.CATALOG_OWNERSHIP_TEMPLATE_RUN = runId;
    await runPreviewOwnershipNegative(evidenceDir);
  } catch (error) {
    failed = true;
    exitCode = 1;
    errorMessage = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
  }
  log.push({ name, startedAt, endedAt: new Date().toISOString(), exitCode, ms: Date.now() - t0, ...(errorMessage ? { error: errorMessage } : {}) });
  persistLog({ lastStep: name, previewLeftRunning: false });
  if (failed) process.exit(process.exitCode ?? 1);
}

{
  const name = 'preview-start-control-flow-probe';
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  let exitCode = 0;
  let errorMessage;
  try {
    await runPreviewStartControlFlowProbe(evidenceDir);
  } catch (error) {
    failed = true;
    exitCode = 1;
    errorMessage = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
  }
  log.push({ name, startedAt, endedAt: new Date().toISOString(), exitCode, ms: Date.now() - t0, ...(errorMessage ? { error: errorMessage } : {}) });
  persistLog({ lastStep: name, previewLeftRunning: false });
  if (failed) process.exit(process.exitCode ?? 1);
}

{
  const name = 'preview-ownership-probes';
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  let exitCode = 0;
  let errorMessage;
  try {
    await runPreviewOwnershipProbes(evidenceDir);
  } catch (error) {
    failed = true;
    exitCode = 1;
    errorMessage = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
  }
  log.push({ name, startedAt, endedAt: new Date().toISOString(), exitCode, ms: Date.now() - t0, ...(errorMessage ? { error: errorMessage } : {}) });
  persistLog({ lastStep: name, previewLeftRunning: false });
  if (failed) process.exit(process.exitCode ?? 1);
}

let env = loadRunEnv();
const frozenSourceSnapshotHash = sourceSnapshotHash();
const instanceRoot = path.join(root, 'instance');
const { workspace } = ensurePreviewWorkspace(instanceRoot);

const script = (rel) => path.join(REPO_ROOT, rel);

releasePreviewPortForRun(Number(process.env.CATALOG_PREVIEW_PORT ?? 3010), runId);

if (step('start-local-preview', () =>
  runCommand(process.execPath, [script('scripts/catalog/start-local-preview.mjs'), '--run-id', runId], {
    env: safeEnv(),
    evidenceDir,
    name: 'start-local-preview',
  }))) {
  persistLog({ previewLeftRunning: false });
  console.error(`self-verify failed: ${root}`);
  process.exit(process.exitCode ?? 1);
}

env = loadRunEnv();

{
  const name = 'preview-double-start';
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  let exitCode = 0;
  let errorMessage;
  try {
    process.env.CATALOG_DOUBLE_START_RUN_ID = runId;
    await runPreviewDoubleStart(evidenceDir);
  } catch (error) {
    failed = true;
    exitCode = 1;
    errorMessage = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
  }
  log.push({ name, startedAt, endedAt: new Date().toISOString(), exitCode, ms: Date.now() - t0, ...(errorMessage ? { error: errorMessage } : {}) });
  persistLog({ lastStep: name, previewLeftRunning: previewLeftRunningNow() });
  if (failed) process.exit(process.exitCode ?? 1);
}

if (step('status-local-preview', () =>
  runCommand(process.execPath, [script('scripts/catalog/status-local-preview.mjs'), '--run-id', runId], {
    env: safeEnv(),
    evidenceDir,
    name: 'status-local-preview',
  }))) {
  persistLog({ previewLeftRunning: previewLeftRunningNow() });
  console.error(`self-verify failed: ${root}`);
  process.exit(process.exitCode ?? 1);
}

{
  const name = 'preview-start-workspace-guard';
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  let exitCode = 0;
  let errorMessage;
  try {
    process.env.CATALOG_GUARD_RUN_ID = runId;
    await runPreviewStartWorkspaceGuard(evidenceDir);
  } catch (error) {
    failed = true;
    exitCode = 1;
    errorMessage = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
  }
  log.push({ name, startedAt, endedAt: new Date().toISOString(), exitCode, ms: Date.now() - t0, ...(errorMessage ? { error: errorMessage } : {}) });
  persistLog({ lastStep: name, previewLeftRunning: previewLeftRunningNow() });
  if (failed) process.exit(process.exitCode ?? 1);
}

if (step('isolated-next-build', () =>
  runCommand(process.execPath, [script('node_modules/next/dist/bin/next'), 'build', '--webpack'], {
    cwd: workspace,
    env,
    evidenceDir,
    name: 'isolated-next-build',
  }))) {
  persistLog({ previewLeftRunning: previewLeftRunningNow() });
  console.error(`self-verify failed: ${root}`);
  process.exit(process.exitCode ?? 1);
}

if (step('vitest-display', () =>
  runCommand(process.execPath, [script('node_modules/vitest/vitest.mjs'), 'run', '--config', 'vitest.config.catalog.mts', 'tests/catalog/local-preview-display.postgres.test.ts', 'tests/catalog/local-preview-workspace.test.ts', 'tests/catalog/warehouse-valuation.test.ts', 'tests/catalog/client-scope-warehouse.postgres.test.ts'], {
    env,
    evidenceDir,
    name: 'vitest-display',
  }))) {
  persistLog({ previewLeftRunning: previewLeftRunningNow() });
  console.error(`self-verify failed: ${root}`);
  process.exit(process.exitCode ?? 1);
}

const browserEvidence = path.join(evidenceDir, 'browser');
fs.mkdirSync(browserEvidence, { recursive: true });
const browserEnv = safeEnv({
  ...env,
  CATALOG_BASE_URL: 'http://127.0.0.1:3010',
  CATALOG_TEST_EVIDENCE_DIR: browserEvidence,
  CATALOG_BROWSER_OUTPUT: path.join(browserEvidence, 'output'),
  CATALOG_BROWSER_REPORT: path.join(browserEvidence, 'report.json'),
});

if (step('playwright-local-preview', () =>
  runCommand(process.execPath, [script('node_modules/@playwright/test/cli.js'), 'test', '-c', 'playwright.config.catalog.ts', 'tests/catalog/local-preview.browser.pw.ts'], {
    env: browserEnv,
    evidenceDir,
    name: 'playwright-local-preview',
  }))) {
  persistLog({ previewLeftRunning: previewLeftRunningNow() });
  console.error(`self-verify failed: ${root}`);
  process.exit(process.exitCode ?? 1);
}

writeJson(path.join(evidenceDir, 'prior-invalid-restart-evidence-note.json'), {
  note: 'run-20261021T063949Z-7eee8e4e uuid before/after files shared capturedAt 06:43:26Z (post-restart re-read); retained as historical invalid comparison only — not valid restart proof',
  paths: [
    '.local/catalog/run-20261021T063949Z-7eee8e4e/evidence/self-verify-2026-10-21T06-39-49-841Z-f1badc/uuid-data-before-stop.json',
    '.local/catalog/run-20261021T063949Z-7eee8e4e/evidence/self-verify-2026-10-21T06-39-49-841Z-f1badc/uuid-data-after-restart.json',
  ],
});

const beforeStopPath = path.join(evidenceDir, 'display-projection-before-stop.json');
const afterRestartPath = path.join(evidenceDir, 'display-projection-after-restart.json');
let snapshotBefore;
let snapshotAfter;
try {
  snapshotBefore = captureDisplaySnapshot('before-stop', env, beforeStopPath);
  snapshotBefore.frozenSourceSnapshotHash = frozenSourceSnapshotHash;
  fs.writeFileSync(beforeStopPath, `${JSON.stringify(snapshotBefore, null, 2)}\n`);
  if (snapshotBefore.itemCount !== 126) {
    failed = true;
    process.exitCode = 1;
  }
} catch (error) {
  failed = true;
  writeJson(beforeStopPath, { error: String(error) });
  process.exitCode = 1;
}

if (step('stop-local-preview', () =>
  runCommand(process.execPath, [script('scripts/catalog/stop-local-preview.mjs'), '--run-id', runId], {
    env: safeEnv(),
    evidenceDir,
    name: 'stop-local-preview',
  }))) {
  persistLog({ previewLeftRunning: false });
  console.error(`self-verify failed: ${root}`);
  process.exit(process.exitCode ?? 1);
}

if (step('restart-local-preview', () =>
  runCommand(process.execPath, [script('scripts/catalog/start-local-preview.mjs'), '--run-id', runId], {
    env: safeEnv(),
    evidenceDir,
    name: 'restart-local-preview',
  }))) {
  persistLog({ previewLeftRunning: false });
  console.error(`self-verify failed: ${root}`);
  process.exit(process.exitCode ?? 1);
}

env = loadRunEnv();

if (step('status-after-restart', () =>
  runCommand(process.execPath, [script('scripts/catalog/status-local-preview.mjs'), '--run-id', runId], {
    env: safeEnv(),
    evidenceDir,
    name: 'status-after-restart',
  }))) {
  persistLog({ previewLeftRunning: previewLeftRunningNow() });
  console.error(`self-verify failed: ${root}`);
  process.exit(process.exitCode ?? 1);
}

try {
  snapshotAfter = captureDisplaySnapshot('after-restart', env, afterRestartPath);
  snapshotAfter.frozenSourceSnapshotHash = frozenSourceSnapshotHash;
  const comparison = {
    matchesProjection: snapshotBefore?.projectionSha256 === snapshotAfter.projectionSha256,
    beforeCapturedAt: snapshotBefore?.capturedAt,
    afterCapturedAt: snapshotAfter.capturedAt,
    beforeProjectionSha256: snapshotBefore?.projectionSha256,
    afterProjectionSha256: snapshotAfter.projectionSha256,
    frozenSourceSnapshotHash,
    chronologyValid: Boolean(snapshotBefore?.capturedAt && snapshotAfter.capturedAt && snapshotBefore.capturedAt < snapshotAfter.capturedAt),
  };
  writeJson(path.join(evidenceDir, 'display-projection-restart-comparison.json'), comparison);
  fs.writeFileSync(afterRestartPath, `${JSON.stringify({ ...snapshotAfter, comparison }, null, 2)}\n`);
  if (!comparison.matchesProjection || !comparison.chronologyValid || snapshotAfter.itemCount !== 126) {
    failed = true;
    process.exitCode = 1;
  }
} catch (error) {
  failed = true;
  writeJson(afterRestartPath, { error: String(error) });
  process.exitCode = 1;
}

const leftRunning = previewLeftRunningNow();
const rootBuildNote = {
  executed: false,
  reason: 'Self-verify uses isolated instance/next-workspace build only; root npm run build not required for catalog preview acceptance.',
};

persistLog({
  failed,
  previewLeftRunning: leftRunning,
  rootNpmBuild: rootBuildNote,
  frozenSourceSnapshotHash,
  evidenceIndex: {
    selfVerifyLog: path.join(evidenceDir, 'self-verify-log.json'),
    displayBeforeStop: beforeStopPath,
    displayAfterRestart: afterRestartPath,
    displayComparison: path.join(evidenceDir, 'display-projection-restart-comparison.json'),
    priorInvalidRestartNote: path.join(evidenceDir, 'prior-invalid-restart-evidence-note.json'),
    previewOwnershipNegative: path.join(evidenceDir, 'preview-ownership-negative.json'),
    previewOwnershipProbes: path.join(evidenceDir, 'preview-ownership-probes.json'),
    previewStartWorkspaceGuard: path.join(evidenceDir, 'preview-start-workspace-guard.json'),
    previewStartControlFlowProbe: path.join(evidenceDir, 'preview-start-control-flow-probe.json'),
    previewDoubleStart: path.join(evidenceDir, 'preview-double-start.json'),
    browserReport: path.join(browserEvidence, 'report.json'),
  },
  previewUrl: leftRunning ? 'http://127.0.0.1:3010/dashboard/catalog' : null,
  commands: {
    start: `node scripts/catalog/start-local-preview.mjs --run-id ${runId}`,
    status: `node scripts/catalog/status-local-preview.mjs --run-id ${runId}`,
    stop: `node scripts/catalog/stop-local-preview.mjs --run-id ${runId}`,
  },
});

console.log(`self-verify complete: ${root} (exit ${process.exitCode ?? 0}, previewLeftRunning=${leftRunning})`);

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (failed || process.exitCode) process.exit(process.exitCode ?? 1);
}
