#!/usr/bin/env node
/**
 * Catalog local preview Next dev launcher.
 * Keeps --catalog-workspace and --catalog-run-id on the process command line for ownership verification.
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function readArg(flag) {
  const index = process.argv.indexOf(flag);
  if (index < 0 || index + 1 >= process.argv.length) return null;
  return process.argv[index + 1];
}

const catalogWorkspace = readArg('--catalog-workspace');
const catalogRunId = readArg('--catalog-run-id');
if (!catalogWorkspace || !catalogRunId) {
  console.error('catalog-next-preview-dev: --catalog-workspace and --catalog-run-id are required');
  process.exit(1);
}

const workspace = path.resolve(catalogWorkspace);
const nextBin = path.join(REPO_ROOT, 'node_modules/next/dist/bin/next');
const passthrough = [];
for (let i = 2; i < process.argv.length; i += 1) {
  const token = process.argv[i];
  if (token === '--catalog-workspace' || token === '--catalog-run-id') {
    i += 1;
    continue;
  }
  passthrough.push(token);
}

const child = spawn(process.execPath, [nextBin, ...passthrough], {
  cwd: workspace,
  env: process.env,
  stdio: 'inherit',
  windowsHide: true,
});

function forwardSignal(signal) {
  try {
    child.kill(signal);
  } catch {
    /* ignore */
  }
}

process.on('SIGTERM', () => forwardSignal('SIGTERM'));
process.on('SIGINT', () => forwardSignal('SIGINT'));

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on('error', (error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
