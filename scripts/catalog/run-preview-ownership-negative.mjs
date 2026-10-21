import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, writeJson } from './prepare.mjs';

/**
 * Security negative: stop-local-preview must refuse a foreign pid even when marker runId matches.
 * Uses a self-spawned harmless HTTP listener only; does not touch historical catalog runs.
 */
export async function runPreviewOwnershipNegative(evidenceDir) {
  const runId = `run-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z-${Math.random().toString(16).slice(2, 10)}`;
  const root = path.join(REPO_ROOT, '.local/catalog', runId);
  const instanceRoot = path.join(root, 'instance');
  fs.mkdirSync(path.join(instanceRoot, 'pgdata'), { recursive: true });

  const port = 50550 + Math.floor(Math.random() * 400);
  const dbName = `iceos_catalog_${runId.replace(/[^a-z0-9]+/gi, '_')}`;
  const templateRun = process.env.CATALOG_OWNERSHIP_TEMPLATE_RUN;
  let templateInstance;
  if (templateRun) {
    templateInstance = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, '.local/catalog', templateRun, 'instance/catalog-instance.json'), 'utf8'));
  } else {
    throw new Error('CATALOG_OWNERSHIP_TEMPLATE_RUN required (use a prepared local-preview run id)');
  }

  const instance = {
    ...templateInstance,
    runId,
    label: 'catalog-local-preview-v1',
    port,
    dbName,
    dataDir: path.join(instanceRoot, 'pgdata'),
    previewReady: true,
  };
  fs.writeFileSync(path.join(instanceRoot, 'catalog-instance.json'), `${JSON.stringify(instance, null, 2)}\n`);

  const envTemplate = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, '.local/catalog', templateRun, 'instance/env.catalog.json'), 'utf8'));
  const envJson = { ...envTemplate, P0_02_RUN_ID: runId };
  for (const key of ['P0_02_APP_DATABASE_URL', 'P0_02_AUTH_DATABASE_URL', 'P0_02_SYNC_DATABASE_URL']) {
    const url = new URL(envJson[key]);
    url.port = String(port);
    url.pathname = `/${dbName}`;
    envJson[key] = url.toString();
  }
  fs.writeFileSync(path.join(instanceRoot, 'env.catalog.json'), `${JSON.stringify(envJson, null, 2)}\n`);

  const workspace = path.join(instanceRoot, 'next-workspace-probe');
  fs.mkdirSync(workspace, { recursive: true });

  const listenPort = 38000 + Math.floor(Math.random() * 2000);
  const decoy = spawn(
    process.execPath,
    ['-e', `require('http').createServer((q,r)=>{r.statusCode=200;r.end('probe')}).listen(${listenPort},'127.0.0.1')`],
    { stdio: 'ignore', detached: true, windowsHide: true },
  );
  decoy.unref();
  const decoyPid = decoy.pid;
  if (!decoyPid) throw new Error('CATALOG_OWNERSHIP_DECOY_SPAWN_FAILED');
  await new Promise((r) => setTimeout(r, 300));

  const marker = {
    pid: decoyPid,
    port: listenPort,
    runId,
    workspace,
    url: `http://127.0.0.1:${listenPort}/`,
    startedAt: new Date().toISOString(),
    ready: true,
  };
  fs.writeFileSync(path.join(instanceRoot, 'preview-server.json'), `${JSON.stringify(marker, null, 2)}\n`);

  const stop = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts/catalog/stop-local-preview.mjs'), '--run-id', runId], {
    encoding: 'utf8',
    env: { ...process.env, Path: process.env.Path },
  });

  const decoyAlive = (() => {
    try { process.kill(decoyPid, 0); return true; } catch { return false; }
  })();
  try { process.kill(decoyPid); } catch { /* cleanup probe */ }

  const result = {
    runId,
    decoyPid,
    decoyAlive,
    stopExitCode: stop.status,
    stopStdout: stop.stdout,
    stopStderr: stop.stderr,
    markerRetained: fs.existsSync(path.join(instanceRoot, 'preview-server.json')),
    pass: stop.status !== 0 && decoyAlive && fs.existsSync(path.join(instanceRoot, 'preview-server.json')),
  };

  if (evidenceDir) writeJson(path.join(evidenceDir, 'preview-ownership-negative.json'), result);

  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }

  if (!result.pass) {
    throw new Error(`CATALOG_OWNERSHIP_NEGATIVE_FAILED:${JSON.stringify(result)}`);
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const evidence = process.argv.includes('--evidence-dir') ? process.argv[process.argv.indexOf('--evidence-dir') + 1] : null;
  runPreviewOwnershipNegative(evidence)
    .then((out) => console.log(JSON.stringify(out, null, 2)))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
