import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { collectWorkspaceSourceHashes, snapshotWorkspace } from './prepare.mjs';

export function computePreviewSourceSnapshotHash() {
  return crypto.createHash('sha256').update(JSON.stringify(collectWorkspaceSourceHashes())).digest('hex');
}

export function previewWorkspaceRefreshNeeded(instanceRoot) {
  const workspace = path.join(instanceRoot, 'next-workspace');
  const manifestPath = path.join(instanceRoot, 'next-workspace-manifest.json');
  const sourceSnapshotHash = computePreviewSourceSnapshotHash();
  let manifest = null;
  if (fs.existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch {
      manifest = null;
    }
  }
  const needed = !(manifest?.sourceSnapshotHash === sourceSnapshotHash && fs.existsSync(path.join(workspace, 'package.json')));
  return { workspace, manifestPath, manifest, sourceSnapshotHash, needed };
}

export function ensurePreviewWorkspace(instanceRoot) {
  const workspace = path.join(instanceRoot, 'next-workspace');
  const manifestPath = path.join(instanceRoot, 'next-workspace-manifest.json');
  const sourceSnapshotHash = computePreviewSourceSnapshotHash();
  let manifest = null;
  if (fs.existsSync(manifestPath)) {
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { manifest = null; }
  }
  if (manifest?.sourceSnapshotHash === sourceSnapshotHash && fs.existsSync(path.join(workspace, 'package.json'))) {
    return { workspace, manifest, refreshed: false };
  }
  fs.rmSync(workspace, { recursive: true, force: true });
  const snap = snapshotWorkspace(workspace);
  manifest = { ...snap, sourceSnapshotHash };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { workspace, manifest, refreshed: true };
}
