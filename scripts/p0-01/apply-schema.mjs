import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { Pool } from 'pg';

import {
  DEFAULT_RUN_ID,
  REPO_ROOT,
  pgExe,
  runRoot,
  withHiddenWindowsSpawnOptions,
} from './common.mjs';
import { guardP001Entry } from './entry-guard.mjs';
import { admitSchemaBootstrapOrMutate, assertPlatformMarkerBeforeMutate } from './instance-guard.mjs';

const runId = DEFAULT_RUN_ID;
guardP001Entry(runId);
const { instance } = admitSchemaBootstrapOrMutate(runId);
const env = { PGPASSWORD: instance.bootstrapPassword };

function psql(sqlFileOrCommand, file = false) {
  const args = [
    '-h',
    instance.host,
    '-p',
    String(instance.port),
    '-U',
    instance.bootstrapUser,
    '-d',
    instance.dbName,
    '-v',
    'ON_ERROR_STOP=1',
  ];
  if (file) {
    args.push('-f', sqlFileOrCommand);
  } else {
    args.push('-c', sqlFileOrCommand);
  }
  const result = spawnSync(
    pgExe('psql'),
    args,
    withHiddenWindowsSpawnOptions({ encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }),
  );
  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
    throw new Error(
      `psql 失败: ${file ? sqlFileOrCommand : sqlFileOrCommand.slice(0, 80)}${detail ? `\n${detail}` : ''}`,
    );
  }
}

async function migrateAuthSchema() {
  const authSearchPath = encodeURIComponent('-c search_path=p0_01_auth');
  const ownerPool = new Pool({
    connectionString: `postgres://${instance.bootstrapUser}:${instance.bootstrapPassword}@${instance.host}:${instance.port}/${instance.dbName}?options=${authSearchPath}`,
  });
  const auth = betterAuth({
    appName: 'iceos-p0-01-seed',
    baseURL: 'http://127.0.0.1:3000',
    basePath: '/api/p0-01/auth',
    secret: instance.betterAuthSecret,
    database: ownerPool,
    emailAndPassword: { enabled: true, disableSignUp: true },
  });

  const migrations = await getMigrations(auth.options);
  await migrations.runMigrations();
  await ownerPool.end();
}

function queryScalar(sql) {
  const result = spawnSync(
    pgExe('psql'),
    [
      '-h',
      instance.host,
      '-p',
      String(instance.port),
      '-U',
      instance.bootstrapUser,
      '-d',
      instance.dbName,
      '-tA',
      '-c',
      sql,
    ],
    withHiddenWindowsSpawnOptions({
      encoding: 'utf8',
      env: { ...env, PGPASSWORD: instance.bootstrapPassword },
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
  if (result.status !== 0) {
    throw new Error(`只读查询失败: ${sql.slice(0, 80)} — ${(result.stderr ?? result.stdout ?? '').trim()}`);
  }
  return (result.stdout ?? '').trim() || null;
}

async function main() {
  const sqlDir = path.join(REPO_ROOT, 'db', 'p0-01');
  psql(path.join(sqlDir, '001_instance_and_roles.sql'), true);

  const metaExists = queryScalar(`SELECT to_regclass('p0_01_meta.platform_instance') IS NOT NULL`);
  let existingMarker = null;
  let markerRowCount = '0';
  if (metaExists === 't') {
    markerRowCount = queryScalar(`SELECT COUNT(*)::text FROM p0_01_meta.platform_instance`) ?? '0';
    if (markerRowCount !== '0') {
      if (markerRowCount !== '1') {
        throw new Error(`platform_instance 行数=${markerRowCount}，拒绝继续修改`);
      }
      existingMarker = queryScalar(`SELECT run_id FROM p0_01_meta.platform_instance LIMIT 1`);
    }
  }
  assertPlatformMarkerBeforeMutate(runId, existingMarker, { allowMissing: markerRowCount === '0' });
  if (!existingMarker) {
    psql(
      `ALTER ROLE ice_p0_01_auth_runner PASSWORD '${instance.authRunnerPassword}'; ALTER ROLE ice_p0_01_app_runner PASSWORD '${instance.appRunnerPassword}';`,
    );
  }
  for (const file of [
    '002_auth_schema_grants.sql',
    '003_business_schema.sql',
    '004_rls_policies.sql',
  ]) {
    psql(path.join(sqlDir, file), true);
  }

  if (!existingMarker) {
    psql(`INSERT INTO p0_01_meta.platform_instance (run_id, label) VALUES ('${runId}', 'p0-01') ON CONFLICT DO NOTHING;`);
    const pendingPath = path.join(runRoot(runId), 'bootstrap-pending.json');
    if (fs.existsSync(pendingPath)) {
      fs.unlinkSync(pendingPath);
    }
    fs.writeFileSync(
      path.join(runRoot(runId), 'established.json'),
      `${JSON.stringify({ runId, establishedAt: new Date().toISOString() }, null, 2)}\n`,
    );
  }

  await migrateAuthSchema();

  psql(path.join(sqlDir, '005_auth_runtime_grants.sql'), true);

  psql(`REVOKE ice_p0_01_owner FROM ${instance.bootstrapUser};`);

  console.log('DDL 与 Better Auth migrate 完成');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
