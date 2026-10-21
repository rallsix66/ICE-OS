import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { readPostmasterPid, startPostgresServer } from '../p0-02/postgres-process.mjs';
import { openRun, readArgs } from './prepare.mjs';
import { verifyCatalogPostgresOwnership } from './preview-process-ownership.mjs';

function portListening(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port }, () => { socket.end(); resolve(true); });
    socket.on('error', () => resolve(false));
  });
}

export async function startCatalogPostgres(argv = process.argv.slice(2)) {
  const args = readArgs(argv);
  const run = openRun(args);
  const instance = JSON.parse(fs.readFileSync(path.join(run.instanceRoot, 'catalog-instance.json'), 'utf8'));
  if (await portListening(instance.host, instance.port)) {
    const pid = readPostmasterPid(instance.dataDir);
    if (!pid) {
      throw new Error(`CATALOG_POSTGRES_PORT_CONFLICT:127.0.0.1:${instance.port} in use but no postmaster.pid for this run`);
    }
    const owned = verifyCatalogPostgresOwnership(pid, instance);
    if (!owned.ok) {
      throw new Error(`${owned.code}:${owned.message}`);
    }
    fs.writeFileSync(path.join(run.instanceRoot, 'postgres-server.json'), `${JSON.stringify({ pid, port: instance.port, startedAt: new Date().toISOString(), launchMode: 'existing' }, null, 2)}\n`);
    console.log(`catalog postgres already listening: ${instance.host}:${instance.port} (${args.runId}, pid ${pid})`);
    return run;
  }
  const logFile = path.join(run.instanceRoot, 'postgres.log');
  startPostgresServer({
    runRootDir: run.instanceRoot,
    dataDir: instance.dataDir,
    port: instance.port,
    host: instance.host,
    logFile,
    postgresExe: path.join(instance.pgBinDir, 'postgres.exe'),
  });
  for (let i = 0; i < 60; i++) {
    if (await portListening(instance.host, instance.port)) {
      const pid = readPostmasterPid(instance.dataDir);
      fs.writeFileSync(path.join(run.instanceRoot, 'postgres-server.json'), `${JSON.stringify({ pid, port: instance.port, startedAt: new Date().toISOString(), launchMode: 'hidden' }, null, 2)}\n`);
      console.log(`catalog postgres started: ${instance.host}:${instance.port} (${args.runId}, pid ${pid ?? '?'})`);
      return run;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('CATALOG_POSTGRES_START_FAILED');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startCatalogPostgres().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
