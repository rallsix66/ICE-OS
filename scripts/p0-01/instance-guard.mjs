import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { instancePath, loadInstance, pgExe, runRoot, withHiddenWindowsSpawnOptions } from './common.mjs';
import { assertInstanceConnectionUrls, assertInstanceMetadataContract } from './connection-target.mjs';

const RUN_ID_PATTERN = /^run-[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function assertRunId(runId) {
  if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) {
    throw new Error(`无效 run ID: ${runId}`);
  }
  if (runId.includes('..') || runId.includes('/') || runId.includes('\\')) {
    throw new Error(`run ID 含非法路径段: ${runId}`);
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
    throw new Error(`无法解析真实路径: ${targetPath} (${String(error)})`);
  }
}

function assertRealPathWithinRun(runId, targetPath, label) {
  const root = path.resolve(runRoot(runId));
  const real = resolveRealPath(targetPath);
  if (!real.startsWith(root + path.sep) && real !== root) {
    throw new Error(`${label} realpath 越界: ${real}`);
  }
  return real;
}

export function assertInstancePaths(runId, instance) {
  assertRunId(runId);
  if (instance.runId !== runId) {
    throw new Error(`instance.json runId=${instance.runId} 与 P0_01_RUN_ID=${runId} 不一致`);
  }

  const root = path.resolve(runRoot(runId));
  const p0Root = path.resolve(path.join(runRoot(runId), '..'));
  const expectedSuffix = normalize(path.join('.local', 'p0-01', runId));
  if (!normalize(root).endsWith(expectedSuffix)) {
    throw new Error('run 根目录路径不符合预期');
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
      throw new Error('dataDir 与兄弟 run 目录冲突');
    }
    if (normalize(dataDir).startsWith(`${normalize(sibling)}/`)) {
      throw new Error('dataDir 路径越界到兄弟 run');
    }
  }

  if (!dataDir.startsWith(root + path.sep) && dataDir !== root) {
    throw new Error('dataDir 必须位于当前 run 目录内');
  }

  if (!recordPath.startsWith(root + path.sep)) {
    throw new Error('instance.json 必须位于当前 run 目录内');
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
    throw new Error(`只读核验失败：无法连接数据库（${dbProbe.stderr || dbProbe.stdout}）`);
  }
  if (dbProbe.stdout.toLowerCase() !== instance.dbName.toLowerCase()) {
    throw new Error(`只读核验失败：current_database=${dbProbe.stdout} 与 instance.dbName 不一致`);
  }

  const portProbe = psqlQuery(instance, 'SELECT inet_server_port()::text');
  if (portProbe.status !== 0) {
    throw new Error(`只读核验失败：无法读取 inet_server_port（${portProbe.stderr}）`);
  }
  if (Number.parseInt(portProbe.stdout, 10) !== instance.port) {
    throw new Error(`只读核验失败：端口 ${portProbe.stdout} 与 instance.port 不一致`);
  }

  const dataDirProbe = psqlQuery(instance, `SHOW data_directory`);
  if (dataDirProbe.status !== 0) {
    throw new Error(`只读核验失败：无法读取 data_directory（${dataDirProbe.stderr}）`);
  }
  const serverDataDir = resolveRealPath(dataDirProbe.stdout);
  const expectedDataDir = resolveRealPath(instance.dataDir);
  if (normalize(serverDataDir) !== normalize(expectedDataDir)) {
    throw new Error(
      `只读核验失败：data_directory=${serverDataDir} 与 instance.dataDir=${expectedDataDir} 不一致`,
    );
  }
}

export function verifyConnectionAndInstancePaths(runId, instance) {
  assertInstancePaths(runId, instance);
  if (!fs.existsSync(instance.dataDir)) {
    throw new Error('dataDir 不存在，无法核验实例');
  }
  verifyLiveConnectionTargets(instance);
}

export function verifyReadOnlyInstanceState(runId, instance) {
  assertInstancePaths(runId, instance);

  if (!fs.existsSync(instance.dataDir)) {
    throw new Error('dataDir 不存在，无法核验实例');
  }

  verifyLiveConnectionTargets(instance);

  const metaExists = psqlQuery(
    instance,
    `SELECT to_regclass('p0_01_meta.platform_instance') IS NOT NULL`,
  );
  if (metaExists.status !== 0) {
    throw new Error(`只读核验失败：无法检查 platform_instance（${metaExists.stderr}）`);
  }

  if (metaExists.stdout === 't') {
    const markerCount = psqlQuery(instance, `SELECT COUNT(*)::text FROM p0_01_meta.platform_instance`);
    if (markerCount.status !== 0) {
      throw new Error(`只读核验失败：无法统计 platform_instance（${markerCount.stderr}）`);
    }
    if (markerCount.stdout !== '1') {
      throw new Error(
        `只读核验失败：platform_instance 行数=${markerCount.stdout ?? '(空)'}，要求唯一任务标记`,
      );
    }
    const marker = psqlQuery(instance, `SELECT run_id FROM p0_01_meta.platform_instance LIMIT 1`);
    if (marker.status !== 0) {
      throw new Error(`只读核验失败：无法读取 platform_instance 标记（${marker.stderr}）`);
    }
    if (!marker.stdout || marker.stdout.trim() === '') {
      throw new Error('只读核验失败：platform_instance 标记为空');
    }
    if (marker.stdout !== runId) {
      throw new Error(`platform_instance 标记为 ${marker.stdout}，与 ${runId} 不一致`);
    }
  }

  const bizSchema = psqlQuery(instance, `SELECT to_regnamespace('p0_01_biz') IS NOT NULL`);
  if (bizSchema.status !== 0) {
    throw new Error(`只读核验失败：无法检查 p0_01_biz（${bizSchema.stderr}）`);
  }
  if (metaExists.stdout !== 't' && bizSchema.stdout === 't') {
    throw new Error('业务 schema 已存在但缺少 platform_instance 表，拒绝准入');
  }

  return { markerPresent: metaExists.stdout === 't' };
}

function readMarkerCount(instance, metaExists) {
  if (metaExists.stdout !== 't') {
    return '0';
  }
  const markerCount = psqlQuery(instance, `SELECT COUNT(*)::text FROM p0_01_meta.platform_instance`);
  if (markerCount.status !== 0) {
    throw new Error(`只读核验失败：无法统计 platform_instance（${markerCount.stderr}）`);
  }
  return markerCount.stdout;
}

export function classifyInstanceAdmission(runId, instance) {
  assertInstancePaths(runId, instance);
  assertInstanceMetadataContract(instance);
  if (!fs.existsSync(instance.dataDir)) {
    throw new Error('dataDir 不存在，无法核验实例');
  }

  const metaExists = psqlQuery(
    instance,
    `SELECT to_regclass('p0_01_meta.platform_instance') IS NOT NULL`,
  );
  if (metaExists.status !== 0) {
    throw new Error(`只读核验失败：无法检查 platform_instance（${metaExists.stderr}）`);
  }
  const markerCount = readMarkerCount(instance, metaExists);
  const bizSchema = psqlQuery(instance, `SELECT to_regnamespace('p0_01_biz') IS NOT NULL`);
  if (bizSchema.status !== 0) {
    throw new Error(`只读核验失败：无法检查 p0_01_biz（${bizSchema.stderr}）`);
  }

  if (markerCount === '1') {
    return { phase: 'established' };
  }
  if (markerCount !== '0') {
    throw new Error(`platform_instance 行数=${markerCount}，拒绝准入`);
  }
  if (bizSchema.stdout === 't') {
    throw new Error('已有业务 schema 但 platform_instance 标记缺失，拒绝准入');
  }
  const pendingPath = path.join(runRoot(runId), 'bootstrap-pending.json');
  if (!fs.existsSync(pendingPath)) {
    throw new Error('缺少首次 bootstrap 凭据，已存在实例不得重新判为首次初始化');
  }
  const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf8').replace(/^\uFEFF/, ''));
  if (pending.runId !== runId) {
    throw new Error(`bootstrap 凭据 runId=${pending.runId} 与 ${runId} 不一致`);
  }
  return { phase: 'first-bootstrap' };
}

export function loadAndGuardInstance(runId) {
  assertRunId(runId);
  const instance = loadInstance(runId);
  assertInstancePaths(runId, instance);
  assertInstanceMetadataContract(instance);
  const envFile = path.join(runRoot(runId), 'env.p0-01.json');
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
    throw new Error('platform_instance 标记缺失或为空，拒绝继续修改');
  }
  if (markerRunId !== runId) {
    throw new Error(
      `platform_instance 标记为 ${markerRunId}，与当前 ${runId} 不一致，拒绝继续修改`,
    );
  }
}
