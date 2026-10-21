import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, detachedHiddenSpawnOptions, safeEnv, writeJson } from './prepare.mjs';
import {
  readPreviewProcessCreatedAtIso,
  verifyPreviewServerOwnership,
} from './preview-process-ownership.mjs';
import { ensurePreviewWorkspace } from './ensure-preview-workspace.mjs';

function portListening(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port }, () => { socket.end(); resolve(true); });
    socket.on('error', () => resolve(false));
  });
}

async function waitPort(port, timeoutMs = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await portListening('127.0.0.1', port)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function probeCase(name, pid, marker, expectOk) {
  const result = verifyPreviewServerOwnership(pid, marker);
  const pass = result.ok === expectOk;
  return { name, expectOk, ok: result.ok, code: result.code ?? null, pass };
}

export async function runPreviewOwnershipProbes(evidenceDir) {
  const runId = `run-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z-${Math.random().toString(16).slice(2, 10)}`;
  const root = path.join(REPO_ROOT, '.local/catalog', runId);
  const instanceRoot = path.join(root, 'instance');
  fs.mkdirSync(instanceRoot, { recursive: true });
  fs.writeFileSync(path.join(instanceRoot, 'catalog-instance.json'), `${JSON.stringify({
    runId,
    label: 'catalog-local-preview-v1',
    host: '127.0.0.1',
    port: 54399,
    dbName: 'probe',
    dataDir: path.join(instanceRoot, 'pgdata'),
    previewReady: true,
  }, null, 2)}\n`);

  const { workspace } = ensurePreviewWorkspace(instanceRoot);
  const altWorkspace = path.join(instanceRoot, 'next-workspace-alt');
  fs.mkdirSync(altWorkspace, { recursive: true });

  const listenPort = 38100 + Math.floor(Math.random() * 1500);
  const launcher = path.join(REPO_ROOT, 'scripts/catalog/catalog-next-preview-dev.mjs');
  const log = fs.openSync(path.join(instanceRoot, 'probe-next.log'), 'a');
  const child = spawn(
    process.execPath,
    [launcher, '--catalog-workspace', workspace, '--catalog-run-id', runId, 'dev', '--webpack', '-p', String(listenPort), '-H', '127.0.0.1'],
    detachedHiddenSpawnOptions({
      cwd: REPO_ROOT,
      env: safeEnv({ NODE_ENV: 'development' }),
      stdio: ['ignore', log, log],
    }),
  );
  child.unref();
  await new Promise((r) => setTimeout(r, 800));
  const processCreatedAt = readPreviewProcessCreatedAtIso(child.pid);
  const startedAt = new Date().toISOString();
  const baseMarker = {
    pid: child.pid,
    port: listenPort,
    runId,
    workspace,
    startedAt,
    processCreatedAt,
    url: `http://127.0.0.1:${listenPort}/`,
    ready: true,
  };

  const portReady = await waitPort(listenPort, 120_000);
  const cases = [];
  if (portReady && processCreatedAt) {
    cases.push(probeCase('correct-instance', child.pid, baseMarker, true));
    cases.push(probeCase('wrong-workspace', child.pid, { ...baseMarker, workspace: altWorkspace }, false));
    cases.push(probeCase('wrong-started-at', child.pid, { ...baseMarker, startedAt: '1999-01-01T00:00:00.000Z' }, false));
    cases.push(probeCase('wrong-run-id', child.pid, { ...baseMarker, runId: `${runId}-other` }, false));
    cases.push(probeCase('stale-process-created-at', child.pid, { ...baseMarker, processCreatedAt: '1999-01-01T00:00:00.000Z' }, false));
    const incomplete = { ...baseMarker };
    delete incomplete.processCreatedAt;
    cases.push(probeCase('missing-process-created-at', child.pid, incomplete, false));
    cases.push(probeCase('wrong-workspace-and-time-incomplete-marker', child.pid, {
      ...incomplete,
      workspace: altWorkspace,
      startedAt: '1999-01-01T00:00:00.000Z',
    }, false));
  }

  try { process.kill(child.pid); } catch { /* cleanup */ }
  await new Promise((r) => setTimeout(r, 500));

  const result = {
    runId,
    pid: child.pid,
    portReady,
    processCreatedAt,
    cases,
    pass: portReady && Boolean(processCreatedAt) && cases.length > 0 && cases.every((item) => item.pass),
  };

  if (evidenceDir) writeJson(path.join(evidenceDir, 'preview-ownership-probes.json'), result);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }

  if (!result.pass) {
    throw new Error(`CATALOG_OWNERSHIP_PROBES_FAILED:${JSON.stringify(result)}`);
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const evidence = process.argv.includes('--evidence-dir') ? process.argv[process.argv.indexOf('--evidence-dir') + 1] : null;
  runPreviewOwnershipProbes(evidence)
    .then((out) => console.log(JSON.stringify(out, null, 2)))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
