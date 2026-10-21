import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { openRun, readArgs } from './prepare.mjs';
import { pidAlive, verifyPreviewServerOwnership } from './preview-process-ownership.mjs';

function portListening(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port }, () => { socket.end(); resolve(true); });
    socket.on('error', () => resolve(false));
  });
}

async function waitPortClosed(host, port, timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!(await portListening(host, port))) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function waitPidExit(pid, timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!pidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const args = readArgs(process.argv.slice(2));
const run = openRun(args);
const marker = path.join(run.instanceRoot, 'preview-server.json');
if (!fs.existsSync(marker)) {
  console.log(`no preview-server marker for ${args.runId}; nothing to stop`);
  process.exit(0);
}
const meta = JSON.parse(fs.readFileSync(marker, 'utf8'));
const { pid, port, runId: markerRunId } = meta;
if (markerRunId && markerRunId !== args.runId) {
  console.error(`preview-server marker runId ${markerRunId} does not match ${args.runId}`);
  process.exit(1);
}
if (!pid || !Number.isInteger(pid)) {
  console.error(`preview-server marker missing valid pid for ${args.runId}; refusing to stop`);
  process.exit(1);
}

const ownership = verifyPreviewServerOwnership(pid, meta);
if (!ownership.ok) {
  console.error(`refusing to stop preview: ${ownership.code}: ${ownership.message}`);
  process.exit(1);
}

try {
  process.kill(pid);
} catch (error) {
  console.error(`failed to signal preview pid ${pid}: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

const exited = await waitPidExit(pid);
if (!exited) {
  console.error(`preview pid ${pid} did not exit after stop signal; marker retained`);
  process.exit(1);
}

const host = '127.0.0.1';
const closed = port ? await waitPortClosed(host, port) : true;
if (!closed) {
  console.error(`preview port ${port} still listening after pid ${pid} exited; marker retained`);
  process.exit(1);
}

fs.unlinkSync(marker);
console.log(`stopped local preview Next pid ${pid} on ${host}:${port ?? '?'} (${args.runId}); portReleased=${closed}; postgres left running`);
process.exit(0);
