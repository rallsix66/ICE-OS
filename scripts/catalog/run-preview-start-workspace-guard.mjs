import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, writeJson } from './prepare.mjs';
import { previewOperatingEnv, readPreviewOperatingConfig } from './preview-operating-config.mjs';
import { verifyPreviewServerOwnership } from './preview-process-ownership.mjs';

function portListening(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port }, () => { socket.end(); resolve(true); });
    socket.on('error', () => resolve(false));
  });
}

export async function runPreviewStartWorkspaceGuard(evidenceDir) {
  const runId = process.env.CATALOG_GUARD_RUN_ID;
  if (!runId) throw new Error('CATALOG_GUARD_RUN_ID required (prepared local-preview run id)');

  const instanceRoot = path.join(REPO_ROOT, '.local/catalog', runId, 'instance');
  const markerPath = path.join(instanceRoot, 'preview-server.json');
  if (!fs.existsSync(markerPath)) throw new Error('CATALOG_GUARD_RUN_ID missing preview-server marker');

  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  const workspace = path.resolve(marker.workspace);
  const sentinel = path.join(workspace, '.workspace-guard-sentinel');
  fs.writeFileSync(sentinel, `guard-${new Date().toISOString()}\n`);

  const wrongWorkspace = path.join(instanceRoot, 'next-workspace-wrong');
  fs.mkdirSync(wrongWorkspace, { recursive: true });
  fs.writeFileSync(markerPath, `${JSON.stringify({ ...marker, workspace: wrongWorkspace }, null, 2)}\n`);

  const guardPreviewConfig = {
    port: marker.port ?? readPreviewOperatingConfig().port,
    mode: marker.previewMode ?? readPreviewOperatingConfig().mode,
  };
  const rejectStart = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts/catalog/start-local-preview.mjs'), '--run-id', runId], {
    encoding: 'utf8',
    env: previewOperatingEnv(guardPreviewConfig),
    windowsHide: true,
  });

  const markerRestored = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  const ownershipReject = {
    exitCode: rejectStart.status,
    sentinelStillPresent: fs.existsSync(sentinel),
    workspaceStillPresent: fs.existsSync(workspace),
    markerWorkspaceRestored: path.resolve(markerRestored.workspace) === workspace,
    pass: rejectStart.status !== 0 && fs.existsSync(sentinel) && fs.existsSync(workspace),
  };

  fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
  const manifestPath = path.join(instanceRoot, 'next-workspace-manifest.json');
  const manifestJson = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifestJson.sourceSnapshotHash = '0'.repeat(64);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifestJson, null, 2)}\n`);

  const refreshStart = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts/catalog/start-local-preview.mjs'), '--run-id', runId], {
    encoding: 'utf8',
    env: previewOperatingEnv(guardPreviewConfig),
    windowsHide: true,
    timeout: 300_000,
  });

  const listeningAfter = await portListening('127.0.0.1', guardPreviewConfig.port);
  const markerAfter = fs.existsSync(markerPath) ? JSON.parse(fs.readFileSync(markerPath, 'utf8')) : null;
  const controlledRefresh = {
    exitCode: refreshStart.status,
    sentinelRemoved: !fs.existsSync(sentinel),
    listeningAfter,
    ownershipOk: markerAfter?.pid ? verifyPreviewServerOwnership(markerAfter.pid, markerAfter).ok : false,
    pass: refreshStart.status === 0 && !fs.existsSync(sentinel) && listeningAfter && Boolean(markerAfter?.pid && verifyPreviewServerOwnership(markerAfter.pid, markerAfter).ok),
  };

  const result = { runId, ownershipReject, controlledRefresh, pass: ownershipReject.pass && controlledRefresh.pass };
  if (evidenceDir) writeJson(path.join(evidenceDir, 'preview-start-workspace-guard.json'), result);

  if (!result.pass) {
    throw new Error(`CATALOG_START_WORKSPACE_GUARD_FAILED:${JSON.stringify(result)}`);
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const evidence = process.argv.includes('--evidence-dir') ? process.argv[process.argv.indexOf('--evidence-dir') + 1] : null;
  runPreviewStartWorkspaceGuard(evidence)
    .then((out) => console.log(JSON.stringify(out, null, 2)))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
