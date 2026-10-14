import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { instancePath, loadInstance, pgExe, runRoot, withHiddenWindowsSpawnOptions } from './common.mjs';
import { assertInstanceConnectionUrls, assertInstanceMetadataContract } from './connection-target.mjs';

const RUN_ID_PATTERN = /^run-[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function assertRunId(runId) {
  if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) {
    throw new Error(`?? run ID: ${runId}`);
  }
  if (runId.includes('..') || runId.includes('/') || runId.includes('\\')) {
    throw new Error(`run ID ??????: ${runId}`);
  }
}

function normalize(p) {
  return path.resolve(p).replace(/\\/g, '/').toLowerCase();
}

function resolveRealPath(targetPath) {
  try {
    if (typeof fs.realpathSync.native === 'function') {
      return fs.realpathSync.native(targetPath);
    }
    return fs.realpathSync(targetPath);
  } catch (error) {
    throw new Error(`????????: ${targetPath} (${String(error)})`);
  }
}

function assertRealPathWithinRun(runId, targetPath, label) {
  const root = path.resolve(runRoot(runId));
  const real = resolveRealPath(targetPath);
  if (!real.startsWith(root + path.sep) && real !== root) {
    throw new Error(`${label} realpath ??: ${real}`);
  }
  return real;
}

export function assertInstancePaths(runId, instance) {
  assertRunId(runId);
  if (instance.runId !== runId) {
    throw new Error(`instance.json runId=${instance.runId} ? P0_02_RUN_ID=${runId} ???`);
  }

  const root = path.resolve(runRoot(runId));
  const p0Root = path.resolve(path.join(runRoot(runId), '..'));
  const expectedSuffix = normalize(path.join('.local', 'p0-02', runId));
  if (!normalize(root).endsWith(expectedSuffix)) {
    throw new Error('run ??????????');
  }

  const siblingRuns = fs
    .readdirSync(p0Root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('run-') && entry.name !== runId)
    .map((entry) => path.resolve(p0Root, entry.name));

  const dataDir = path.resolve(instance.dataDir);
  const recordPath = path.resolve(instancePath(runId));
  assertRealPathWithinRun(runId, dataDir, 'dataDir');
  assertRealPathWithinRun(runId, recordPath, 'instance.json');

  for (const sibling of siblingRuns) {
    if (dataDir === sibling || dataDir.startsWith(`${sibling}${path.sep}`)) {
      throw new Error('dataDir ??? run ????');
    }
    if (normalize(dataDir).startsWith(`${normalize(sibling)}/`)) {
      throw new Error('dataDir ??????? run');
    }
  }

  if (!dataDir.startsWith(root + path.sep) && dataDir !== root) {
    throw new Error('dataDir ?????? run ???');
  }

  if (!recordPath.startsWith(root + path.sep)) {
    throw new Error('instance.json ?????? run ???');
  }
}

export function probePidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return { alive: false, reason: 'invalid-pid' };
  }
  try {
    process.kill(pid, 0);
    return { alive: true };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) {
      if (error.code === 'ESRCH') {
        return { alive: false, reason: 'not-found' };
      }
      if (error.code === 'EPERM') {
        return { alive: null, reason: 'eperm' };
      }
    }
    return { alive: null, reason: 'unknown' };
  }
}

function psqlQuery(instance, sql, { bootstrap = true } = {}) {
  const user = bootstrap ? instance.bootstrapUser : instance.appRunnerUser;
  const password = bootstrap ? instance.bootstrapPassword : instance.appRunnerPassword;
  const result = spawnSync(
    pgExe('psql', instance.runId),
    [
      '-h',
      instance.host,
      '-p',
      String(instance.port),
      '-U',
      user,
      '-d',
      instance.dbName,
      '-tA',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      sql,
    ],
    withHiddenWindowsSpawnOptions({
      encoding: 'utf8',
      env: { PGPASSWORD: password },
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
  return {
    status: result.status,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
  };
}

function verifyLiveConnectionTargets(instance) {
  assertInstanceMetadataContract(instance);
  const dbProbe = psqlQuery(instance, 'SELECT current_database()');
  if (dbProbe.status !== 0) {
    throw new Error(`???????????????${dbProbe.stderr || dbProbe.stdout}?`);
  }
  if (dbProbe.stdout.toLowerCase() !== instance.dbName.toLowerCase()) {
    throw new Error(`???????current_database=${dbProbe.stdout} ? instance.dbName ???`);
  }

  const portProbe = psqlQuery(instance, 'SELECT inet_server_port()::text');
  if (portProbe.status !== 0) {
    throw new Error(`??????????? inet_server_port?${portProbe.stderr}?`);
  }
  if (Number.parseInt(portProbe.stdout, 10) !== instance.port) {
    throw new Error(`????????? ${portProbe.stdout} ? instance.port ???`);
  }

  const dataDirProbe = psqlQuery(instance, `SHOW data_directory`);
  if (dataDirProbe.status !== 0) {
    throw new Error(`??????????? data_directory?${dataDirProbe.stderr}?`);
  }
  const serverDataDir = resolveRealPath(dataDirProbe.stdout);
  const expectedDataDir = resolveRealPath(instance.dataDir);
  if (normalize(serverDataDir) !== normalize(expectedDataDir)) {
    throw new Error(
      `???????data_directory=${serverDataDir} ? instance.dataDir=${expectedDataDir} ???`,
    );
  }
}

export function verifyConnectionAndInstancePaths(runId, instance) {
  assertInstancePaths(runId, instance);
  if (!fs.existsSync(instance.dataDir)) {
    throw new Error('dataDir ??????????');
  }
  verifyLiveConnectionTargets(instance);
}

export function verifyReadOnlyInstanceState(runId, instance) {
  assertInstancePaths(runId, instance);

  if (!fs.existsSync(instance.dataDir)) {
    throw new Error('dataDir ??????????');
  }

  verifyLiveConnectionTargets(instance);

  const metaExists = psqlQuery(
    instance,
    `SELECT to_regclass('p0_02_meta.platform_instance') IS NOT NULL`,
  );
  if (metaExists.status !== 0) {
    throw new Error(`??????????? platform_instance?${metaExists.stderr}?`);
  }

  if (metaExists.stdout === 't') {
    const markerCount = psqlQuery(instance, `SELECT COUNT(*)::text FROM p0_02_meta.platform_instance`);
    if (markerCount.status !== 0) {
      throw new Error(`??????????? platform_instance?${markerCount.stderr}?`);
    }
    if (markerCount.stdout !== '1') {
      throw new Error(
        `???????platform_instance ??=${markerCount.stdout ?? '(?)'}?????????`,
      );
    }
    const marker = psqlQuery(instance, `SELECT run_id FROM p0_02_meta.platform_instance LIMIT 1`);
    if (marker.status !== 0) {
      throw new Error(`??????????? platform_instance ???${marker.stderr}?`);
    }
    if (!marker.stdout || marker.stdout.trim() === '') {
      throw new Error('???????platform_instance ????');
    }
    if (marker.stdout !== runId) {
      throw new Error(`platform_instance ??? ${marker.stdout}?? ${runId} ???`);
    }
  }

  const bizSchema = psqlQuery(instance, `SELECT to_regclass('public.role') IS NOT NULL`);
  if (bizSchema.status !== 0) {
    throw new Error(`??????????? public.role?${bizSchema.stderr}?`);
  }
  if (metaExists.stdout !== 't' && bizSchema.stdout === 't') {
    throw new Error('?? schema ?????? platform_instance ??????');
  }

  return { markerPresent: metaExists.stdout === 't' };
}

function readMarkerCount(instance, metaExists) {
  if (metaExists.stdout !== 't') {
    return '0';
  }
  const markerCount = psqlQuery(instance, `SELECT COUNT(*)::text FROM p0_02_meta.platform_instance`);
  if (markerCount.status !== 0) {
    throw new Error(`??????????? platform_instance?${markerCount.stderr}?`);
  }
  return markerCount.stdout;
}

export function classifyInstanceAdmission(runId, instance) {
  assertInstancePaths(runId, instance);
  assertInstanceMetadataContract(instance);
  if (!fs.existsSync(instance.dataDir)) {
    throw new Error('dataDir ??????????');
  }

  const metaExists = psqlQuery(
    instance,
    `SELECT to_regclass('p0_02_meta.platform_instance') IS NOT NULL`,
  );
  if (metaExists.status !== 0) {
    throw new Error(`??????????? platform_instance?${metaExists.stderr}?`);
  }
  const markerCount = readMarkerCount(instance, metaExists);
  const bizSchema = psqlQuery(instance, `SELECT to_regclass('public.role') IS NOT NULL`);
  if (bizSchema.status !== 0) {
    throw new Error(`??????????? public.role?${bizSchema.stderr}?`);
  }

  if (markerCount === '1') {
    return { phase: 'established' };
  }
  if (markerCount !== '0') {
    throw new Error(`platform_instance ??=${markerCount}?????`);
  }
  if (bizSchema.stdout === 't') {
    throw new Error('???? schema ? platform_instance ?????????');
  }
  const pendingPath = path.join(runRoot(runId), 'bootstrap-pending.json');
  if (!fs.existsSync(pendingPath)) {
    throw new Error('???? bootstrap ???????????????????');
  }
  const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf8').replace(/^\uFEFF/, ''));
  if (pending.runId !== runId) {
    throw new Error(`bootstrap ?? runId=${pending.runId} ? ${runId} ???`);
  }
  return { phase: 'first-bootstrap' };
}

export function loadAndGuardInstance(runId) {
  assertRunId(runId);
  const instance = loadInstance(runId);
  assertInstancePaths(runId, instance);
  assertInstanceMetadataContract(instance);
  const envFile = path.join(runRoot(runId), 'env.p0-02.json');
  if (fs.existsSync(envFile)) {
    const envJson = JSON.parse(fs.readFileSync(envFile, 'utf8').replace(/^\uFEFF/, ''));
    assertInstanceConnectionUrls(instance, envJson);
  }
  return instance;
}

export function admitSchemaBootstrapOrMutate(runId) {
  const instance = loadAndGuardInstance(runId);
  const admission = classifyInstanceAdmission(runId, instance);
  if (admission.phase === 'established') {
    const state = verifyReadOnlyInstanceState(runId, instance);
    return { instance, ...state, phase: 'established' };
  }
  verifyConnectionAndInstancePaths(runId, instance);
  return { instance, markerPresent: false, phase: 'first-bootstrap' };
}

export function guardBeforeMutate(runId) {
  const instance = loadAndGuardInstance(runId);
  const admission = classifyInstanceAdmission(runId, instance);
  if (admission.phase !== 'established') {
    throw new Error('实例尚未完成首次标记，拒绝 mutating 操作');
  }
  const state = verifyReadOnlyInstanceState(runId, instance);
  return { instance, ...state };
}

export function assertPlatformMarkerBeforeMutate(runId, markerRunId, { allowMissing = false } = {}) {
  if (markerRunId === null || markerRunId === '') {
    if (allowMissing) {
      return;
    }
    throw new Error('platform_instance ??????????????');
  }
  if (markerRunId !== runId) {
    throw new Error(
      `platform_instance ??? ${markerRunId}???? ${runId} ??????????`,
    );
  }
}
