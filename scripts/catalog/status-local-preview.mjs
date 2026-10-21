import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import pg from 'pg';
import { openRun, readArgs } from './prepare.mjs';
import { pidAlive, verifyPreviewServerOwnership } from './preview-process-ownership.mjs';

function portListening(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port }, () => { socket.end(); resolve(true); });
    socket.on('error', () => resolve(false));
  });
}

const args = readArgs(process.argv.slice(2));
const run = openRun(args);
const instance = JSON.parse(fs.readFileSync(path.join(run.instanceRoot, 'catalog-instance.json'), 'utf8'));
const markerPath = path.join(run.instanceRoot, 'preview-server.json');
const marker = fs.existsSync(markerPath) ? JSON.parse(fs.readFileSync(markerPath, 'utf8')) : null;
const previewPort = marker?.port ?? Number(process.env.CATALOG_PREVIEW_PORT ?? 3010);
const pgUp = await portListening(instance.host, instance.port);
const nextUp = await portListening('127.0.0.1', previewPort);
let loginStatus = 0;
let loginOk = false;
if (nextUp) {
  try {
    const res = await fetch(`http://127.0.0.1:${previewPort}/auth/login`, { redirect: 'manual' });
    loginStatus = res.status;
    loginOk = res.status === 200;
  } catch { loginOk = false; }
}
let platformRunId = null;
if (pgUp) {
  const pool = new pg.Pool({ connectionString: `postgres://${instance.bootstrapUser}:${instance.bootstrapPassword}@${instance.host}:${instance.port}/${instance.dbName}`, max: 1 });
  try {
    const row = (await pool.query('SELECT run_id FROM p0_02_meta.platform_instance LIMIT 1')).rows[0];
    platformRunId = row?.run_id ?? null;
  } finally {
    await pool.end();
  }
}
const basisInWorkspace = marker?.workspace
  ? fs.existsSync(path.join(marker.workspace, 'docs/catalog/local-sample-valuation-basis-20261021.json'))
  : false;
const status = {
  runId: args.runId,
  previewReady: Boolean(instance.previewReady),
  platformRunId,
  runIdMatches: platformRunId === args.runId,
  postgres: { listening: pgUp, host: instance.host, port: instance.port },
  next: {
    listening: nextUp,
    port: previewPort,
    pid: marker?.pid ?? null,
    pidAlive: marker?.pid ? pidAlive(marker.pid) : false,
    ownershipVerified: marker?.pid && marker?.workspace
      ? verifyPreviewServerOwnership(marker.pid, marker).ok
      : false,
    url: marker?.url ?? null,
    workspace: marker?.workspace ?? null,
    workspaceBasisPresent: basisInWorkspace,
    loginStatus,
    loginOk,
    markerRunId: marker?.runId ?? null,
    ready: Boolean(marker?.ready),
  },
  manifestExists: fs.existsSync(path.join(run.root, 'local-preview-manifest.json')),
  loginFileExists: fs.existsSync(path.join(run.instanceRoot, 'login.local-preview.txt')),
};
console.log(JSON.stringify(status, null, 2));
process.exitCode = pgUp && nextUp && loginOk && instance.previewReady && status.runIdMatches && basisInWorkspace && marker?.runId === args.runId && status.next.ownershipVerified ? 0 : 1;
