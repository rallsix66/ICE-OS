/**
 * Short R5 closeout verification on an existing prepared run (no prepare, no full business gates).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, collectWorkspaceSourceHashes, newEvidence, runCommand, safeEnv, writeJson } from './prepare.mjs';
import { previewOperatingEnv, readPreviewOperatingConfig } from './preview-operating-config.mjs';
import { runPreviewOwnershipNegative } from './run-preview-ownership-negative.mjs';
import { runPreviewOwnershipProbes } from './run-preview-ownership-probes.mjs';
import { runPreviewStartControlFlowProbe } from './run-preview-start-control-flow-probe.mjs';
import { runPreviewDoubleStart } from './run-preview-double-start.mjs';

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
    name: `snapshot-${label}`,
  });
  return JSON.parse(fs.readFileSync(outPath, 'utf8'));
}

function loadRunEnv(runId) {
  const root = path.join(REPO_ROOT, '.local/catalog', runId);
  const envJson = JSON.parse(fs.readFileSync(path.join(root, 'instance', 'env.catalog.json'), 'utf8'));
  return { root, env: safeEnv({ ...envJson, CATALOG_RUN_ROOT: root, CATALOG_SOURCE_ROOT: REPO_ROOT }) };
}

const previewConfig = readPreviewOperatingConfig();
const previewEnv = () => previewOperatingEnv(previewConfig);

const runId = process.env.CATALOG_SHORT_VERIFY_RUN_ID ?? 'run-20261021T100700Z-b3c4d5e6';
const { root, env: initialEnv } = loadRunEnv(runId);
const evidenceDir = process.env.CATALOG_SHORT_VERIFY_EVIDENCE_DIR
  ?? newEvidence(root, 'r5-short-verify');
const log = [];
let failed = false;

function record(name, fn) {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  let exitCode = 0;
  let error;
  try {
    fn();
  } catch (e) {
    failed = true;
    exitCode = 1;
    error = e instanceof Error ? e.message : String(e);
    process.exitCode = 1;
  }
  log.push({ name, startedAt, endedAt: new Date().toISOString(), ms: Date.now() - t0, exitCode, ...(error ? { error } : {}) });
}

const frozenSourceSnapshotHash = sourceSnapshotHash();
writeJson(path.join(evidenceDir, 'frozen-source-snapshot.json'), {
  capturedAt: new Date().toISOString(),
  frozenSourceSnapshotHash,
  runId,
});

await runPreviewOwnershipProbes(evidenceDir);
log.push({ name: 'preview-ownership-probes', exitCode: 0 });

process.env.CATALOG_OWNERSHIP_TEMPLATE_RUN = runId;
await runPreviewOwnershipNegative(evidenceDir);
log.push({ name: 'preview-ownership-negative', exitCode: 0 });

await runPreviewStartControlFlowProbe(evidenceDir);
log.push({ name: 'preview-start-control-flow-probe', exitCode: 0 });

runCommand(process.execPath, [path.join(REPO_ROOT, 'scripts/catalog/start-local-preview.mjs'), '--run-id', runId], {
  env: previewEnv(),
  evidenceDir,
  name: 'ensure-preview-before-double-start',
});
log.push({ name: 'ensure-preview-before-double-start', exitCode: 0 });

process.env.CATALOG_DOUBLE_START_RUN_ID = runId;
process.env.CATALOG_PREVIEW_PORT = String(previewConfig.port);
process.env.CATALOG_PREVIEW_NEXT_MODE = previewConfig.mode;
await runPreviewDoubleStart(evidenceDir);
log.push({ name: 'preview-double-start', exitCode: 0 });

let env = initialEnv;
const beforePath = path.join(evidenceDir, 'display-projection-before-stop.json');
const afterPath = path.join(evidenceDir, 'display-projection-after-restart.json');

record('snapshot-before-stop', () => {
  const snap = captureDisplaySnapshot('before-stop', env, beforePath);
  snap.frozenSourceSnapshotHash = frozenSourceSnapshotHash;
  fs.writeFileSync(beforePath, `${JSON.stringify(snap, null, 2)}\n`);
  if (snap.itemCount !== 126) throw new Error(`expected 126 items, got ${snap.itemCount}`);
});

record('stop-local-preview', () => {
  runCommand(process.execPath, [path.join(REPO_ROOT, 'scripts/catalog/stop-local-preview.mjs'), '--run-id', runId], {
    env: previewEnv(),
    evidenceDir,
    name: 'stop-local-preview',
  });
});

record('restart-local-preview', () => {
  runCommand(process.execPath, [path.join(REPO_ROOT, 'scripts/catalog/start-local-preview.mjs'), '--run-id', runId], {
    env: previewEnv(),
    evidenceDir,
    name: 'restart-local-preview',
  });
});

record('status-after-restart', () => {
  runCommand(process.execPath, [path.join(REPO_ROOT, 'scripts/catalog/status-local-preview.mjs'), '--run-id', runId], {
    env: previewEnv(),
    evidenceDir,
    name: 'status-after-restart',
  });
});

env = loadRunEnv(runId).env;

record('snapshot-after-restart', () => {
  const after = captureDisplaySnapshot('after-restart', env, afterPath);
  const before = JSON.parse(fs.readFileSync(beforePath, 'utf8'));
  after.frozenSourceSnapshotHash = frozenSourceSnapshotHash;
  const comparison = {
    matchesProjection: before.projectionSha256 === after.projectionSha256,
    beforeCapturedAt: before.capturedAt,
    afterCapturedAt: after.capturedAt,
    beforeProjectionSha256: before.projectionSha256,
    afterProjectionSha256: after.projectionSha256,
    frozenSourceSnapshotHash,
    chronologyValid: Boolean(before.capturedAt && after.capturedAt && before.capturedAt < after.capturedAt),
  };
  writeJson(path.join(evidenceDir, 'display-projection-restart-comparison.json'), comparison);
  fs.writeFileSync(afterPath, `${JSON.stringify({ ...after, comparison }, null, 2)}\n`);
  if (!comparison.matchesProjection || !comparison.chronologyValid || after.itemCount !== 126) {
    throw new Error(`projection restart check failed: ${JSON.stringify(comparison)}`);
  }
});

const index = {
  runId,
  evidenceDir,
  frozenSourceSnapshotHash,
  failed,
  finishedAt: new Date().toISOString(),
  previewConfig,
  previewUrl: previewConfig.catalogUrl,
  steps: log,
  artifacts: {
    frozenSource: path.join(evidenceDir, 'frozen-source-snapshot.json'),
    ownershipProbes: path.join(evidenceDir, 'preview-ownership-probes.json'),
    ownershipNegative: path.join(evidenceDir, 'preview-ownership-negative.json'),
    controlFlowVm: path.join(evidenceDir, 'preview-control-flow-vm-probes.json'),
    controlFlowGate: path.join(evidenceDir, 'preview-start-control-flow-probe.json'),
    doubleStart: path.join(evidenceDir, 'preview-double-start.json'),
    displayBefore: beforePath,
    displayAfter: afterPath,
    displayComparison: path.join(evidenceDir, 'display-projection-restart-comparison.json'),
    shortVerifyLog: path.join(evidenceDir, 'r5-short-verify-log.json'),
  },
};

writeJson(path.join(evidenceDir, 'r5-short-verify-log.json'), index);
writeJson(path.join(root, 'r5-short-verify-index.json'), {
  latestEvidenceDir: evidenceDir,
  ...index,
});

console.log(JSON.stringify(index, null, 2));
if (failed) process.exit(1);

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(failed ? 1 : 0);
}
