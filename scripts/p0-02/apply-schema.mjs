import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  DEFAULT_RUN_ID,
  REPO_ROOT,
  pgExe,
  runRoot,
  withHiddenWindowsSpawnOptions,
} from './common.mjs';
import { guardP001Entry } from './entry-guard.mjs';
import { admitSchemaBootstrapOrMutate, assertPlatformMarkerBeforeMutate } from './instance-guard.mjs';
import { migrateAuthSchema } from './migrate-auth-schema.mjs';

const runId = DEFAULT_RUN_ID;
guardP001Entry(runId);
const { instance } = admitSchemaBootstrapOrMutate(runId);
const env = { PGPASSWORD: instance.bootstrapPassword };

function psql(sqlFileOrCommand, file = false, { singleTransaction = false } = {}) {
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
    if (singleTransaction) {
      args.push('-1');
    }
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
  const sqlDir = path.join(REPO_ROOT, 'db', 'p0-02');
  psql(path.join(sqlDir, '001_instance_and_roles.sql'), true);

  const metaExists = queryScalar(`SELECT to_regclass('p0_02_meta.platform_instance') IS NOT NULL`);
  let existingMarker = null;
  let markerRowCount = '0';
  if (metaExists === 't') {
    markerRowCount = queryScalar(`SELECT COUNT(*)::text FROM p0_02_meta.platform_instance`) ?? '0';
    if (markerRowCount !== '0') {
      if (markerRowCount !== '1') {
        throw new Error(`platform_instance 行数=${markerRowCount}，拒绝继续修改`);
      }
      existingMarker = queryScalar(`SELECT run_id FROM p0_02_meta.platform_instance LIMIT 1`);
    }
  }
  assertPlatformMarkerBeforeMutate(runId, existingMarker, { allowMissing: markerRowCount === '0' });

  const publicHasRole = queryScalar(`SELECT to_regclass('public.role') IS NOT NULL`);
  const freshBusiness = publicHasRole !== 't';

  if (!existingMarker) {
    psql(
      `ALTER ROLE ice_p0_02_auth_runner PASSWORD '${instance.authRunnerPassword}'; ALTER ROLE ice_p0_02_app_runner PASSWORD '${instance.appRunnerPassword}'; ALTER ROLE ice_p0_02_sync_runner PASSWORD '${instance.syncRunnerPassword}';`,
    );
  }

  if (freshBusiness) {
    psql(path.join(sqlDir, '002_session_identity.sql'), true);
    psql(`DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public AUTHORIZATION ice_p0_02_owner;`);
    psql(path.join(sqlDir, '003_extensions.sql'), true);
    psql(path.join(sqlDir, '010_public_schema.sql'), true, { singleTransaction: true });
    psql(path.join(sqlDir, '007_reference_data.sql'), true);
    psql(path.join(sqlDir, '003_auth_schema_grants.sql'), true);
    psql(`ALTER SCHEMA public OWNER TO ice_p0_02_owner;`);
  }

  const freshBootstrap = !existingMarker;
  if (freshBootstrap) {
    psql(`INSERT INTO p0_02_meta.platform_instance (run_id, label) VALUES ('${runId}', 'p0-02') ON CONFLICT DO NOTHING;`);
  }

  await migrateAuthSchema(instance, runId);
  psql(path.join(sqlDir, '004_auth_runtime_grants.sql'), true);
  psql(path.join(sqlDir, '005_identity_resolution.sql'), true);
  psql(path.join(sqlDir, '006_least_privilege_grants.sql'), true);
  psql(path.join(sqlDir, '007_sync_runner_rls.sql'), true);
  psql(path.join(sqlDir, '008_runtime_grants_incremental.sql'), true);
  psql(path.join(sqlDir, '009_sync_reads_auth_rpc_deps.sql'), true);

  psql(`REVOKE ice_p0_02_owner FROM ${instance.bootstrapUser};`);

  if (freshBootstrap) {
    const pendingPath = path.join(runRoot(runId), 'bootstrap-pending.json');
    if (fs.existsSync(pendingPath)) {
      fs.unlinkSync(pendingPath);
    }
    fs.writeFileSync(
      path.join(runRoot(runId), 'established.json'),
      `${JSON.stringify({ runId, establishedAt: new Date().toISOString() }, null, 2)}\n`,
    );
  }

  console.log('P0-02 独立基线 DDL 与 Better Auth migrate 完成');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
