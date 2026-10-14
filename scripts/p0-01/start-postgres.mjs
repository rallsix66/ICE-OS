import { spawnSync } from 'node:child_process';

import {
  DEFAULT_RUN_ID,
  pgExe,
  runRoot,
  saveInstance,
  withHiddenWindowsSpawnOptions,
} from './common.mjs';
import { loadAndGuardInstance, probePidAlive } from './instance-guard.mjs';
import { readPostmasterPid, startPostgresServer } from './postgres-process.mjs';
import { postgresCommandMatchesInstance, resolveProcessCommandLine } from './process-identity.mjs';

const runId = DEFAULT_RUN_ID;

function waitForPostgres(instance, attempts = 60) {
  const env = { ...process.env, PGPASSWORD: instance.bootstrapPassword };
  for (let i = 0; i < attempts; i += 1) {
    const probe = spawnSync(
      pgExe('psql', runId),
      [
        '-h',
        instance.host,
        '-p',
        String(instance.port),
        '-U',
        instance.bootstrapUser,
        '-d',
        'postgres',
        '-c',
        'SELECT 1',
      ],
      withHiddenWindowsSpawnOptions({ encoding: 'utf8', env }),
    );
    if (probe.status === 0) {
      return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  throw new Error('PostgreSQL 启动超时');
}

function main() {
  let instance;
  try {
    instance = loadAndGuardInstance(runId);
  } catch (error) {
    console.error(JSON.stringify({ status: 'start-refused', phase: 'guard', error: String(error) }));
    process.exit(2);
  }

  let existing;
  try {
    existing = readPostmasterPid(instance.dataDir);
  } catch (error) {
    console.error(JSON.stringify({ status: 'start-refused', reason: 'malformed-pid-file', error: String(error) }));
    process.exit(3);
  }
  if (existing !== null) {
    const alive = probePidAlive(existing);
    if (alive.alive === null) {
      console.error(JSON.stringify({ status: 'start-refused', reason: 'pid-probe-uncertain', pid: existing }));
      process.exit(4);
    }
    if (alive.alive === true) {
      const cmd = resolveProcessCommandLine(existing);
      if (!postgresCommandMatchesInstance(cmd, instance, runId)) {
        console.error(JSON.stringify({ status: 'start-refused', reason: 'pid-identity-mismatch', pid: existing }));
        process.exit(5);
      }
      console.log(JSON.stringify({ status: 'already-running', pid: existing }));
      return;
    }
  }

  try {
    startPostgresServer({
      runRootDir: runRoot(runId),
      dataDir: instance.dataDir,
      port: instance.port,
      host: instance.host,
      logFile: instance.logFile,
      runId,
    });
  } catch (error) {
    console.error(JSON.stringify({ status: 'start-failed', error: String(error) }));
    process.exit(4);
  }

  try {
    waitForPostgres(instance);
  } catch (error) {
    console.error(JSON.stringify({ status: 'start-failed', phase: 'ready-wait', error: String(error) }));
    process.exit(5);
  }

  const pid = readPostmasterPid(instance.dataDir);
  if (pid !== null) {
    saveInstance(runId, { ...instance, pid });
  }

  console.log(JSON.stringify({ status: 'started', pid }));
}

main();
