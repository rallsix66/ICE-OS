import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, writeJson } from './prepare.mjs';
import { previewOperatingEnv, readPreviewOperatingConfig } from './preview-operating-config.mjs';
import { pidAlive } from './preview-process-ownership.mjs';

async function loginReachable(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/auth/login`, { redirect: 'manual' });
    return res.status === 200;
  } catch {
    return false;
  }
}

/**
 * Two consecutive starts with unchanged source must keep the same pid and marker.
 */
export async function runPreviewDoubleStart(evidenceDir) {
  const runId = process.env.CATALOG_DOUBLE_START_RUN_ID;
  if (!runId) {
    throw new Error('CATALOG_DOUBLE_START_RUN_ID required (prepared local-preview run with active preview)');
  }
  const markerPath = path.join(REPO_ROOT, '.local/catalog', runId, 'instance', 'preview-server.json');
  if (!fs.existsSync(markerPath)) {
    throw new Error(`CATALOG_DOUBLE_START_NO_MARKER:${markerPath}`);
  }
  const before = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  const beforeRaw = fs.readFileSync(markerPath, 'utf8');
  if (!before.pid || !pidAlive(before.pid)) {
    throw new Error(`CATALOG_DOUBLE_START_PREVIEW_NOT_HEALTHY:pid ${before.pid} not alive; start preview once before this probe`);
  }
  const startScript = path.join(REPO_ROOT, 'scripts/catalog/start-local-preview.mjs');
  const childEnv = previewOperatingEnv(readPreviewOperatingConfig());

  const first = spawnSync(process.execPath, [startScript, '--run-id', runId], {
    encoding: 'utf8',
    env: childEnv,
    windowsHide: true,
  });
  const afterFirst = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  const afterFirstRaw = fs.readFileSync(markerPath, 'utf8');

  const second = spawnSync(process.execPath, [startScript, '--run-id', runId], {
    encoding: 'utf8',
    env: childEnv,
    windowsHide: true,
  });
  const afterSecond = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  const afterSecondRaw = fs.readFileSync(markerPath, 'utf8');

  const baseUrl = `http://127.0.0.1:${afterSecond.port ?? 3010}`;
  const loginOk = await loginReachable(baseUrl);

  const result = {
    runId,
    beforePid: before.pid,
    afterFirstPid: afterFirst.pid,
    afterSecondPid: afterSecond.pid,
    firstExitCode: first.status,
    secondExitCode: second.status,
    markerUnchangedFirst: beforeRaw === afterFirstRaw,
    markerUnchangedSecond: afterFirstRaw === afterSecondRaw,
    pidStable: before.pid === afterFirst.pid && afterFirst.pid === afterSecond.pid,
    pidAlive: pidAlive(afterSecond.pid),
    loginOk,
    pass:
      first.status === 0
      && second.status === 0
      && before.pid === afterFirst.pid
      && afterFirst.pid === afterSecond.pid
      && beforeRaw === afterFirstRaw
      && afterFirstRaw === afterSecondRaw
      && pidAlive(afterSecond.pid)
      && loginOk,
  };

  if (evidenceDir) writeJson(path.join(evidenceDir, 'preview-double-start.json'), result);
  if (!result.pass) {
    throw new Error(`CATALOG_DOUBLE_START_FAILED:${JSON.stringify(result)}`);
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const evidence = process.argv.includes('--evidence-dir') ? process.argv[process.argv.indexOf('--evidence-dir') + 1] : null;
  runPreviewDoubleStart(evidence)
    .then((out) => console.log(JSON.stringify(out, null, 2)))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
