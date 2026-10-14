import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, runRoot, sha256File } from './common.mjs';
import { stopRegisteredProcesses } from './managed-processes.mjs';

const COPY_ENTRIES = [
  'src',
  'public',
  'db',
  'scripts',
  'package.json',
  'package-lock.json',
  'next.config.ts',
  'tsconfig.json',
  'postcss.config.mjs',
  'eslint.config.mjs',
  'vitest.config.p0-01.mts',
  'components.json',
];

const TRACKED_FILE_RE =
  /\.(ts|tsx|js|jsx|mjs|cjs|sql|mts|json|md|css|svg|png|webp|gif|ico|woff2?|ttf|eot)$/i;

export function buildCredentialPath(runId) {
  return path.join(runRoot(runId), 'build-credential.json');
}

export function isolatedWorkspaceRoot(runId) {
  return path.join(runRoot(runId), 'workspace');
}

function unlinkNodeModulesJunction(dest) {
  const nodeModules = path.join(dest, 'node_modules');
  if (!fs.existsSync(nodeModules)) {
    return;
  }
  try {
    const stat = fs.lstatSync(nodeModules);
    if (stat.isSymbolicLink()) {
      fs.unlinkSync(nodeModules);
    }
  } catch {
    // ignore
  }
}

function removeNextBuildOutput(dest) {
  const nextDir = path.join(dest, '.next');
  if (!fs.existsSync(nextDir)) {
    return;
  }
  fs.rmSync(nextDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}

export function collectWorkspaceSourceSnapshot(rootDir = REPO_ROOT) {
  const sourceHashes = {};
  for (const entry of COPY_ENTRIES) {
    const source = path.join(rootDir, entry);
    if (!fs.existsSync(source)) {
      continue;
    }
    if (fs.statSync(source).isFile()) {
      const rel = path.relative(rootDir, source).replace(/\\/g, '/');
      sourceHashes[rel] = sha256File(source);
      continue;
    }
    const stack = [source];
    while (stack.length > 0) {
      const current = stack.pop();
      for (const child of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, child.name);
        if (child.isDirectory()) {
          stack.push(full);
        } else if (TRACKED_FILE_RE.test(child.name)) {
          const rel = path.relative(rootDir, full).replace(/\\/g, '/');
          sourceHashes[rel] = sha256File(full);
        }
      }
    }
  }
  return sourceHashes;
}

function listTrackedWorkspaceFiles(workspaceRoot) {
  const files = [];
  for (const entry of COPY_ENTRIES) {
    const target = path.join(workspaceRoot, entry);
    if (!fs.existsSync(target)) {
      continue;
    }
    if (fs.statSync(target).isFile()) {
      files.push(path.relative(workspaceRoot, target).replace(/\\/g, '/'));
      continue;
    }
    const stack = [target];
    while (stack.length > 0) {
      const current = stack.pop();
      for (const child of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, child.name);
        if (child.isDirectory()) {
          stack.push(full);
        } else if (TRACKED_FILE_RE.test(child.name)) {
          files.push(path.relative(workspaceRoot, full).replace(/\\/g, '/'));
        }
      }
    }
  }
  return files.sort();
}

function pruneStaleWorkspaceFiles(workspaceRoot, expectedRelPaths) {
  const expected = new Set(expectedRelPaths);
  for (const rel of listTrackedWorkspaceFiles(workspaceRoot)) {
    if (!expected.has(rel)) {
      fs.rmSync(path.join(workspaceRoot, rel), { force: true });
    }
  }
}

export function stopIsolatedWorkspaceServers(runId) {
  stopRegisteredProcesses(runId, { kinds: ['next'], strict: true });
}

export function syncIsolatedWorkspace(runId) {
  stopIsolatedWorkspaceServers(runId);
  const dest = isolatedWorkspaceRoot(runId);
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  } else {
    unlinkNodeModulesJunction(dest);
    removeNextBuildOutput(dest);
  }

  const sourceHashes = collectWorkspaceSourceSnapshot(REPO_ROOT);
  for (const entry of COPY_ENTRIES) {
    const source = path.join(REPO_ROOT, entry);
    if (!fs.existsSync(source)) {
      continue;
    }
    fs.cpSync(source, path.join(dest, entry), { recursive: true, force: true });
  }
  pruneStaleWorkspaceFiles(dest, Object.keys(sourceHashes));

  const aggregateHash = crypto.createHash('sha256').update(JSON.stringify(sourceHashes)).digest('hex');
  const manifest = {
    syncedAt: new Date().toISOString(),
    sourceRoot: REPO_ROOT,
    entries: COPY_ENTRIES.filter((entry) => fs.existsSync(path.join(REPO_ROOT, entry))),
    sourceHashes,
    sourceSnapshotHash: aggregateHash,
  };
  fs.writeFileSync(path.join(dest, 'p0-01-workspace-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return dest;
}

export function validateIsolatedWorkspaceSources(runId) {
  const dest = isolatedWorkspaceRoot(runId);
  const manifestPath = path.join(dest, 'p0-01-workspace-manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, reason: 'missing-manifest' };
  }
  const repoSnapshot = collectWorkspaceSourceSnapshot(REPO_ROOT);
  const repoKeys = Object.keys(repoSnapshot).sort();
  const workspaceKeys = listTrackedWorkspaceFiles(dest).sort();
  const mismatches = [];

  if (repoKeys.join('|') !== workspaceKeys.join('|')) {
    const repoSet = new Set(repoKeys);
    const workspaceSet = new Set(workspaceKeys);
    for (const rel of repoKeys) {
      if (!workspaceSet.has(rel)) {
        mismatches.push({ rel, reason: 'missing-in-workspace' });
      }
    }
    for (const rel of workspaceKeys) {
      if (!repoSet.has(rel)) {
        mismatches.push({ rel, reason: 'stale-in-workspace' });
      }
    }
  }

  for (const rel of repoKeys) {
    const repoFile = path.join(REPO_ROOT, rel);
    const workspaceFile = path.join(dest, rel);
    const repoHash = sha256File(repoFile);
    if (repoHash !== repoSnapshot[rel]) {
      mismatches.push({ rel, reason: 'repo-snapshot-internal-mismatch' });
      continue;
    }
    if (!fs.existsSync(workspaceFile)) {
      mismatches.push({ rel, reason: 'missing-in-workspace' });
      continue;
    }
    if (sha256File(workspaceFile) !== repoHash) {
      mismatches.push({ rel, reason: 'workspace-stale-copy' });
    }
  }

  const aggregateHash = crypto.createHash('sha256').update(JSON.stringify(repoSnapshot)).digest('hex');
  if (mismatches.length > 0) {
    return { ok: false, reason: 'hash-mismatch', mismatches: mismatches.slice(0, 20), fileCount: repoKeys.length };
  }
  return { ok: true, fileCount: repoKeys.length, sourceSnapshotHash: aggregateHash };
}

export function writeBuildCredential(runId, workspaceRoot, sourceSnapshotHash) {
  const buildIdPath = path.join(workspaceRoot, '.next', 'BUILD_ID');
  if (!fs.existsSync(buildIdPath)) {
    throw new Error('构建未完成：缺少 .next/BUILD_ID');
  }
  const buildId = fs.readFileSync(buildIdPath, 'utf8').trim();
  if (!buildId) {
    throw new Error('BUILD_ID 为空');
  }
  const credential = {
    runId,
    builtAt: new Date().toISOString(),
    sourceSnapshotHash,
    buildId,
    workspaceRoot: path.resolve(workspaceRoot),
  };
  fs.writeFileSync(buildCredentialPath(runId), `${JSON.stringify(credential, null, 2)}\n`);
  return credential;
}

export function validateBuildCredential(runId) {
  const credPath = buildCredentialPath(runId);
  if (!fs.existsSync(credPath)) {
    return { ok: false, reason: 'missing-build-credential' };
  }
  const cred = JSON.parse(fs.readFileSync(credPath, 'utf8').replace(/^\uFEFF/, ''));
  const workspace = isolatedWorkspaceRoot(runId);
  const validation = validateIsolatedWorkspaceSources(runId);
  if (!validation.ok) {
    return validation;
  }
  const buildIdPath = path.join(workspace, '.next', 'BUILD_ID');
  if (!fs.existsSync(buildIdPath)) {
    return { ok: false, reason: 'missing-next-build' };
  }
  const buildId = fs.readFileSync(buildIdPath, 'utf8').trim();
  if (!buildId) {
    return { ok: false, reason: 'empty-build-id' };
  }
  if (buildId !== cred.buildId) {
    return { ok: false, reason: 'build-id-mismatch' };
  }
  if (cred.sourceSnapshotHash !== validation.sourceSnapshotHash) {
    return { ok: false, reason: 'build-stale-against-sources' };
  }
  if (path.resolve(cred.workspaceRoot) !== path.resolve(workspace)) {
    return { ok: false, reason: 'workspace-mismatch' };
  }
  return { ok: true, sourceSnapshotHash: validation.sourceSnapshotHash, buildId };
}

export function validateBuildMatchesSources(runId) {
  return validateBuildCredential(runId);
}

export function ensureValidatedIsolatedWorkspace(runId, { resync = false, validateOnly = false } = {}) {
  const validation = validateIsolatedWorkspaceSources(runId);
  if (validation.ok && !resync) {
    return { workspace: isolatedWorkspaceRoot(runId), validation };
  }
  if (validateOnly) {
    throw new Error(
      `隔离 workspace 与当前源码不一致（${validation.reason ?? 'unknown'}），请先 npm run p0-01:prepare`,
    );
  }
  const workspace = syncIsolatedWorkspace(runId);
  const after = validateIsolatedWorkspaceSources(runId);
  if (!after.ok) {
    throw new Error(`隔离 workspace 校验失败: ${JSON.stringify(after)}`);
  }
  return { workspace, validation: after };
}
