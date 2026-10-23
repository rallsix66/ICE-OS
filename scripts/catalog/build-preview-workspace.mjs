import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT, openRun, readArgs, safeEnv, writeJson } from './prepare.mjs';
import { computePreviewSourceSnapshotHash, previewWorkspaceRefreshNeeded } from './ensure-preview-workspace.mjs';
import { snapshotWorkspace } from './prepare.mjs';
import { mergePreviewNodeOptions } from './merge-preview-node-options.mjs';
import { collectCompileArtifactHashes } from './preview-build-credential.mjs';

const args = readArgs(process.argv.slice(2));
const run = openRun(args);
const sourceSnapshotHash = computePreviewSourceSnapshotHash();
const staging = path.join(run.instanceRoot, `next-build-${sourceSnapshotHash.slice(0, 16)}`);
const active = path.join(run.instanceRoot, 'next-workspace');
const refresh = previewWorkspaceRefreshNeeded(run.instanceRoot);

function ensureStagingWorkspace() {
  const pkg = path.join(staging, 'package.json');
  const manifestPath = path.join(staging, '.catalog-build-manifest.json');
  if (fs.existsSync(pkg) && fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.sourceSnapshotHash === sourceSnapshotHash) return { workspace: staging, manifest, refreshed: false };
  }
  if (fs.existsSync(staging)) {
    try {
      fs.rmSync(staging, { recursive: true, force: true });
    } catch (error) {
      throw new Error(`CATALOG_BUILD_STAGING_LOCKED:${staging}:${error instanceof Error ? error.message : error}`);
    }
  }
  const snap = snapshotWorkspace(staging);
  const manifest = { ...snap, sourceSnapshotHash, role: 'build-staging' };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { workspace: staging, manifest, refreshed: true };
}

const { workspace } = ensureStagingWorkspace();
const preload = path.join(REPO_ROOT, 'scripts/p0-02/loopback-network-preload.cjs');
const envFile = path.join(run.instanceRoot, 'env.catalog.json');
const envJson = fs.existsSync(envFile) ? JSON.parse(fs.readFileSync(envFile, 'utf8')) : {};
const env = safeEnv({
  ...envJson,
  NODE_ENV: 'production',
  NODE_OPTIONS: mergePreviewNodeOptions(preload),
});
const nextBin = path.join(workspace, 'node_modules/next/dist/bin/next');
const logPath = path.join(run.instanceRoot, 'build-webpack.log');
const meta = {
  at: new Date().toISOString(),
  cwd: workspace,
  activeWorkspace: active,
  activeWorkspaceRefreshNeeded: refresh.needed,
  repoRoot: REPO_ROOT,
  nodeVersion: process.version,
  nodeOptions: env.NODE_OPTIONS,
  nextVersion: JSON.parse(fs.readFileSync(path.join(workspace, 'node_modules/next/package.json'), 'utf8')).version,
  workspaceDotEnvLocal: fs.existsSync(path.join(workspace, '.env.local')),
  repoDotEnvLocal: fs.existsSync(path.join(REPO_ROOT, '.env.local')),
  workspaceSourceSnapshotHash: sourceSnapshotHash,
  staging,
};
fs.appendFileSync(logPath, `\n--- staging workspace build ${meta.at} ---\n${JSON.stringify(meta, null, 2)}\n`);
const build = spawnSync(process.execPath, [nextBin, 'build', '--webpack'], {
  cwd: workspace,
  env,
  encoding: 'utf8',
  windowsHide: true,
  maxBuffer: 32 * 1024 * 1024,
});
fs.appendFileSync(logPath, build.stdout ?? '');
fs.appendFileSync(logPath, build.stderr ?? '');
fs.appendFileSync(logPath, `\nexitCode=${build.status}\n`);
if (build.status !== 0) {
  console.error(build.stderr || build.stdout);
  process.exit(build.status ?? 1);
}
const buildIdPath = path.join(workspace, '.next/BUILD_ID');
const buildId = fs.existsSync(buildIdPath) ? fs.readFileSync(buildIdPath, 'utf8').trim() : null;
const stagingManifestPath = path.join(workspace, '.catalog-build-manifest.json');
const stagingManifest = JSON.parse(fs.readFileSync(stagingManifestPath, 'utf8'));
stagingManifest.buildId = buildId;
stagingManifest.compileArtifactHashes = collectCompileArtifactHashes(workspace);
fs.writeFileSync(stagingManifestPath, `${JSON.stringify(stagingManifest, null, 2)}\n`);
writeJson(path.join(run.instanceRoot, 'pending-preview-build.json'), {
  at: new Date().toISOString(),
  buildId,
  stagingWorkspace: workspace,
  sourceSnapshotHash,
  compileSourceSnapshotHash: sourceSnapshotHash,
  activeWorkspace: active,
  note: 'Build succeeded in staging; promote via promote-preview-build.mjs after validatePendingBuild.',
});
console.log(JSON.stringify({ ok: true, workspace, buildId, logPath, staging }, null, 2));
