import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readPostmasterPid } from '../p0-02/postgres-process.mjs';
import { openRun, readArgs } from './prepare.mjs';
import { pidAlive, verifyCatalogPostgresOwnership } from './preview-process-ownership.mjs';

const args = readArgs(process.argv.slice(2));
const run = openRun(args);
const instance = JSON.parse(fs.readFileSync(path.join(run.instanceRoot, 'catalog-instance.json'), 'utf8'));
const marker = path.join(run.instanceRoot, 'postgres-server.json');
const dataDir = instance.dataDir;
let pid;
try {
  pid = readPostmasterPid(dataDir);
} catch (error) {
  console.error(`cannot read postmaster.pid: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
if (!pid) {
  if (fs.existsSync(marker)) fs.unlinkSync(marker);
  console.log(`catalog postgres not running for ${args.runId} (no postmaster.pid)`);
  process.exit(0);
}

const ownership = verifyCatalogPostgresOwnership(pid, instance);
if (!ownership.ok) {
  console.error(`refusing to stop postgres: ${ownership.code}: ${ownership.message}`);
  process.exit(1);
}

const pgCtl = path.join(instance.pgBinDir, 'pg_ctl.exe');
const stopped = spawnSync(pgCtl, ['stop', '-D', dataDir, '-m', 'fast', '-w'], { encoding: 'utf8' });
if (stopped.status !== 0) {
  console.error(`pg_ctl stop failed for ${args.runId}: ${stopped.stderr || stopped.stdout || stopped.status}`);
  process.exit(1);
}

if (pidAlive(pid)) {
  console.error(`postgres pid ${pid} still alive after pg_ctl stop; marker retained`);
  process.exit(1);
}

if (fs.existsSync(marker)) fs.unlinkSync(marker);
console.log(`stopped catalog postgres pid ${pid} on 127.0.0.1:${instance.port} (${args.runId})`);
process.exit(0);
