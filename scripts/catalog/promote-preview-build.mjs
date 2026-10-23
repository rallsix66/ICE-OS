import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT, openRun, readArgs, writeJson } from './prepare.mjs';
import {
  buildReadyRecord,
  validatePendingBuild,
  verifyNextArtifacts,
} from './preview-build-credential.mjs';

const args = readArgs(process.argv.slice(2));
const run = openRun(args);
const pendingPath = path.join(run.instanceRoot, 'pending-preview-build.json');
if (!fs.existsSync(pendingPath)) throw new Error('CATALOG_NO_PENDING_BUILD');
const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
const staging = pending.stagingWorkspace;
const active = path.join(run.instanceRoot, 'next-workspace');
const backup = path.join(run.instanceRoot, 'next-workspace-backup');
const validated = validatePendingBuild(run.instanceRoot, pending);
const buildId = validated.buildId;

const stop = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts/catalog/stop-local-preview.mjs'), '--run-id', args.runId], {
  encoding: 'utf8',
  windowsHide: true,
});
if (stop.status !== 0) throw new Error(`CATALOG_PREVIEW_STOP_FAILED:${stop.stderr || stop.stdout}`);

if (fs.existsSync(backup)) fs.rmSync(backup, { recursive: true, force: true });
if (fs.existsSync(active)) {
  try {
    fs.renameSync(active, backup);
  } catch {
    fs.cpSync(active, backup, { recursive: true, force: true });
    fs.rmSync(active, { recursive: true, force: true });
  }
}
try {
  fs.cpSync(staging, active, { recursive: true, force: true });
  const promotedBuildId = verifyNextArtifacts(active);
  if (buildId !== promotedBuildId) {
    throw new Error('CATALOG_PROMOTE_BUILD_ID_DRIFT');
  }
} catch (error) {
  if (fs.existsSync(active)) fs.rmSync(active, { recursive: true, force: true });
  if (fs.existsSync(backup)) {
    fs.cpSync(backup, active, { recursive: true, force: true });
  }
  throw error;
}
const manifestPath = path.join(run.instanceRoot, 'next-workspace-manifest.json');
const readyPath = path.join(run.instanceRoot, 'preview-build-ready.json');
const stagingManifest = JSON.parse(fs.readFileSync(path.join(staging, '.catalog-build-manifest.json'), 'utf8'));
let priorManifest = null;
let priorReady = null;
if (fs.existsSync(manifestPath)) priorManifest = fs.readFileSync(manifestPath, 'utf8');
if (fs.existsSync(readyPath)) priorReady = fs.readFileSync(readyPath, 'utf8');
try {
  writeJson(manifestPath, {
    ...stagingManifest,
    compileSourceSnapshotHash: validated.sourceSnapshotHash,
    promotedAt: new Date().toISOString(),
    buildId,
    controlScriptHashes: validated.controlScriptHashes,
  });
  writeJson(readyPath, buildReadyRecord({
    buildId,
    stagingWorkspace: staging,
    sourceSnapshotHash: validated.sourceSnapshotHash,
    stagingManifest,
  }));
} catch (error) {
  if (priorManifest == null) fs.rmSync(manifestPath, { force: true });
  else fs.writeFileSync(manifestPath, priorManifest);
  if (priorReady == null) fs.rmSync(readyPath, { force: true });
  else fs.writeFileSync(readyPath, priorReady);
  if (fs.existsSync(active)) fs.rmSync(active, { recursive: true, force: true });
  if (fs.existsSync(backup)) fs.cpSync(backup, active, { recursive: true, force: true });
  throw error;
}
fs.rmSync(pendingPath, { force: true });
if (fs.existsSync(backup)) fs.rmSync(backup, { recursive: true, force: true });
console.log(JSON.stringify({ ok: true, buildId, activeWorkspace: active }, null, 2));
