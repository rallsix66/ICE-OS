import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hashFile, REPO_ROOT } from './prepare.mjs';
import { computePreviewSourceSnapshotHash } from './ensure-preview-workspace.mjs';

const CONTROL_SCRIPT_PATHS = [
  'scripts/catalog/start-local-preview.mjs',
  'scripts/catalog/promote-preview-build.mjs',
  'scripts/catalog/build-preview-workspace.mjs',
  'scripts/catalog/stop-local-preview.mjs',
  'scripts/catalog/merge-preview-node-options.mjs',
];

const REQUIRED_NEXT_ARTIFACTS = [
  '.next/BUILD_ID',
  '.next/required-server-files.json',
  '.next/build-manifest.json',
];

const COMPILE_ARTIFACT_SKIP_DIRS = new Set(['cache', 'trace', 'diagnostics', 'turbopack']);

export function collectCompileArtifactHashes(workspace) {
  const root = path.join(workspace, '.next');
  if (!fs.existsSync(root)) throw new Error('CATALOG_COMPILE_ROOT_MISSING');
  const files = {};
  function walk(dir, relBase) {
    for (const child of fs.readdirSync(dir, { withFileTypes: true })) {
      if (child.isSymbolicLink()) throw new Error('CATALOG_COMPILE_SYMLINK_DENIED');
      const rel = path.posix.join(relBase.replace(/\\/g, '/'), child.name);
      const full = path.join(dir, child.name);
      if (child.isDirectory()) {
        if (relBase === '.next' && COMPILE_ARTIFACT_SKIP_DIRS.has(child.name)) continue;
        walk(full, rel);
      } else {
        files[rel] = hashFile(full);
      }
    }
  }
  walk(root, '.next');
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
}

export function verifyCompileArtifactHashes(workspace, declared) {
  if (!declared || typeof declared !== 'object' || !Object.keys(declared).length) {
    throw new Error('CATALOG_COMPILE_MANIFEST_EMPTY');
  }
  for (const [rel, sha] of Object.entries(declared)) {
    const abs = path.join(workspace, rel);
    if (!fs.existsSync(abs)) throw new Error(`CATALOG_COMPILE_ARTIFACT_MISSING:${rel}`);
    if (hashFile(abs) !== sha) throw new Error(`CATALOG_COMPILE_ARTIFACT_HASH_MISMATCH:${rel}`);
  }
  const onDisk = collectCompileArtifactHashes(workspace);
  for (const rel of Object.keys(onDisk)) {
    if (!(rel in declared)) throw new Error(`CATALOG_COMPILE_ARTIFACT_UNEXPECTED:${rel}`);
  }
  return true;
}

function assertInsideInstance(instanceRoot, targetPath) {
  const resolved = path.resolve(targetPath);
  const root = path.resolve(instanceRoot);
  if (!resolved.startsWith(`${root}${path.sep}`) && resolved !== root) {
    throw new Error(`CATALOG_BUILD_PATH_ESCAPE:${targetPath}`);
  }
  if (fs.existsSync(resolved) && fs.lstatSync(resolved).isSymbolicLink()) {
    throw new Error(`CATALOG_BUILD_SYMLINK_DENIED:${targetPath}`);
  }
}

export function hashControlScripts() {
  const scripts = {};
  for (const rel of CONTROL_SCRIPT_PATHS) {
    const abs = path.join(REPO_ROOT, rel);
    if (fs.existsSync(abs)) scripts[rel] = hashFile(abs);
  }
  return scripts;
}

export function readBuildId(workspace) {
  const p = path.join(workspace, '.next/BUILD_ID');
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8').trim();
}

export function verifyNextArtifacts(workspace) {
  for (const rel of REQUIRED_NEXT_ARTIFACTS) {
    const abs = path.join(workspace, rel);
    if (!fs.existsSync(abs)) throw new Error(`CATALOG_BUILD_ARTIFACT_MISSING:${rel}`);
  }
  const buildId = readBuildId(workspace);
  if (!buildId) throw new Error('CATALOG_BUILD_ID_MISSING');
  return buildId;
}

export function verifyStagingManifest(stagingWorkspace, expectedSourceSnapshotHash) {
  const manifestPath = path.join(stagingWorkspace, '.catalog-build-manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error('CATALOG_STAGING_MANIFEST_MISSING');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.sourceSnapshotHash !== expectedSourceSnapshotHash) {
    throw new Error(`CATALOG_STAGING_SOURCE_MISMATCH:manifest=${manifest.sourceSnapshotHash} expected=${expectedSourceSnapshotHash}`);
  }
  for (const [rel, sha] of Object.entries(manifest.files ?? {})) {
    const abs = path.join(stagingWorkspace, rel);
    if (!fs.existsSync(abs)) throw new Error(`CATALOG_STAGING_FILE_MISSING:${rel}`);
    if (hashFile(abs) !== sha) throw new Error(`CATALOG_STAGING_FILE_HASH_MISMATCH:${rel}`);
  }
  verifyCompileArtifactHashes(stagingWorkspace, manifest.compileArtifactHashes);
  return manifest;
}

export function validatePendingBuild(instanceRoot, pending) {
  assertInsideInstance(instanceRoot, pending.stagingWorkspace);
  const pendingSource = pending.sourceSnapshotHash ?? pending.compileSourceSnapshotHash;
  if (!pendingSource) throw new Error('CATALOG_PENDING_SOURCE_MISSING');
  const manifest = verifyStagingManifest(pending.stagingWorkspace, pendingSource);
  const buildId = verifyNextArtifacts(pending.stagingWorkspace);
  if (pending.buildId && pending.buildId !== buildId) {
    throw new Error(`CATALOG_PENDING_BUILD_ID_MISMATCH:pending=${pending.buildId} disk=${buildId}`);
  }
  const currentSource = computePreviewSourceSnapshotHash();
  return {
    buildId,
    manifest,
    sourceSnapshotHash: pendingSource,
    currentSourceSnapshotHash: currentSource,
    sourceMatchesWorkspace: pendingSource === currentSource,
    controlScriptHashes: hashControlScripts(),
  };
}

export function validateReadyRecord(instanceRoot, ready) {
  const currentSource = computePreviewSourceSnapshotHash();
  const compileSource = ready.compileSourceSnapshotHash ?? ready.sourceSnapshotHash;
  if (!compileSource || !ready.buildId) return { ok: false, code: 'READY_INCOMPLETE' };
  const active = path.join(instanceRoot, 'next-workspace');
  assertInsideInstance(instanceRoot, active);
  const activeBuildId = readBuildId(active);
  if (ready.buildId !== activeBuildId) {
    return { ok: false, code: 'BUILD_ID_MISMATCH', activeBuildId, readyBuildId: ready.buildId };
  }
  try {
    verifyNextArtifacts(active);
  } catch (error) {
    return { ok: false, code: 'ARTIFACT_INVALID', message: error instanceof Error ? error.message : String(error) };
  }
  const manifestPath = path.join(instanceRoot, 'next-workspace-manifest.json');
  if (!fs.existsSync(manifestPath)) return { ok: false, code: 'ACTIVE_MANIFEST_MISSING' };
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const manifestCompile = manifest.compileSourceSnapshotHash ?? manifest.sourceSnapshotHash;
  if (manifestCompile !== compileSource) {
    return { ok: false, code: 'ACTIVE_MANIFEST_COMPILE_MISMATCH' };
  }
  if (manifest.buildId && manifest.buildId !== ready.buildId) {
    return { ok: false, code: 'ACTIVE_MANIFEST_BUILD_MISMATCH' };
  }
  const declared = ready.stagingManifestFileHashes ?? manifest.files ?? {};
  for (const [rel, sha] of Object.entries(declared)) {
    const abs = path.join(active, rel);
    if (!fs.existsSync(abs)) {
      return { ok: false, code: 'ACTIVE_FILE_MISSING', file: rel };
    }
    if (hashFile(abs) !== sha) {
      return { ok: false, code: 'ACTIVE_FILE_HASH_MISMATCH', file: rel };
    }
  }
  const compileDeclared = ready.compileArtifactHashes ?? manifest.compileArtifactHashes;
  try {
    verifyCompileArtifactHashes(active, compileDeclared);
  } catch (error) {
    return {
      ok: false,
      code: 'COMPILE_ARTIFACT_INVALID',
      message: error instanceof Error ? error.message : String(error),
    };
  }
  return {
    ok: true,
    buildId: ready.buildId,
    compileSourceSnapshotHash: compileSource,
    currentSourceSnapshotHash: currentSource,
    repoSourceDrift: compileSource !== currentSource,
  };
}

export function buildReadyRecord({ buildId, stagingWorkspace, sourceSnapshotHash, stagingManifest }) {
  return {
    at: new Date().toISOString(),
    buildId,
    sourceSnapshotHash,
    compileSourceSnapshotHash: sourceSnapshotHash,
    stagingWorkspace,
    stagingManifestFileHashes: stagingManifest.files ?? {},
    compileArtifactHashes: stagingManifest.compileArtifactHashes ?? {},
    controlScriptHashes: hashControlScripts(),
    credentialVersion: 3,
  };
}

export function sha256Json(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
