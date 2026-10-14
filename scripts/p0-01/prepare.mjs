import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  DEFAULT_RUN_ID,
  REPO_ROOT,
  collectP001SourceHashes,
  ensureEnvContract,
  instancePath,
  loadInstance,
  newEvidenceSessionDir,
  runRoot,
  sha256File,
  withHiddenWindowsSpawnOptions,
} from './common.mjs';
import { buildP001ProcessEnv } from './env-whitelist.mjs';
import { guardP001Entry } from './entry-guard.mjs';
import {
  syncIsolatedWorkspace,
  validateIsolatedWorkspaceSources,
  writeBuildCredential,
} from './isolated-workspace.mjs';

const runId = DEFAULT_RUN_ID;
guardP001Entry(runId);

function runNode(script) {
  const result = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'p0-01', script)], {
    stdio: 'inherit',
    cwd: REPO_ROOT,
    env: { ...process.env, P0_01_RUN_ID: runId },
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function main() {
  const root = runRoot(runId);
  fs.mkdirSync(path.join(root, 'baseline'), { recursive: true });

  if (!fs.existsSync(instancePath(runId))) {
    runNode('download-pg.mjs');
    runNode('init-cluster.mjs');
  } else {
    console.log('实例已存在，跳过 download/init');
    runNode('start-postgres.mjs');
  }

  runNode('apply-schema.mjs');
  runNode('seed.mjs');

  const evidenceDir = newEvidenceSessionDir(runId, 'prepare');
  fs.writeFileSync(
    path.join(evidenceDir, 'source-hashes.json'),
    `${JSON.stringify(collectP001SourceHashes(), null, 2)}\n`,
  );

  const workspace = syncIsolatedWorkspace(runId);
  const envPath = path.join(root, 'env.p0-01.json');
  const envJson = ensureEnvContract(loadInstance(runId), envPath);

  const buildEnv = buildP001ProcessEnv(
    {
      NODE_ENV: 'production',
      NEXT_TELEMETRY_DISABLED: '1',
      NODE_PATH: path.join(REPO_ROOT, 'node_modules'),
    },
    envJson,
  );

  const build = spawnSync(
    'npm',
    ['run', 'build', '--', '--webpack'],
    withHiddenWindowsSpawnOptions({
      stdio: 'inherit',
      cwd: workspace,
      env: buildEnv,
      shell: true,
    }),
  );
  if (build.status !== 0) {
    process.exit(build.status ?? 1);
  }

  const workspaceValidationAfterBuild = validateIsolatedWorkspaceSources(runId);
  if (!workspaceValidationAfterBuild.ok) {
    throw new Error(`构建后 workspace 校验失败: ${JSON.stringify(workspaceValidationAfterBuild)}`);
  }
  writeBuildCredential(runId, workspace, workspaceValidationAfterBuild.sourceSnapshotHash);

  const nodeModulesLink = path.join(workspace, 'node_modules');
  if (!fs.existsSync(nodeModulesLink)) {
    fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), nodeModulesLink, 'junction');
  }

  const manifest = {
    runId,
    preparedAt: new Date().toISOString(),
    repoRoot: REPO_ROOT,
    workspaceRoot: workspace,
    packageLockSha256: sha256File(path.join(REPO_ROOT, 'package-lock.json')),
  };
  manifest.evidenceDir = evidenceDir;
  manifest.sourceHashCount = Object.keys(collectP001SourceHashes()).length;
  const workspaceValidation = validateIsolatedWorkspaceSources(runId);
  manifest.sourceSnapshotHash = workspaceValidation.sourceSnapshotHash;
  manifest.workspaceFileCount = workspaceValidation.fileCount;
  fs.writeFileSync(path.join(root, 'prepare-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(evidenceDir, 'prepare-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log('p0-01 prepare 完成');
}

main();
