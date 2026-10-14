import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { DEFAULT_RUN_ID, REPO_ROOT, pgExe, runRoot, withHiddenWindowsSpawnOptions } from './common.mjs';
import { captureFixtureIntegrity } from './fixture-integrity.mjs';
import { guardBeforeMutate } from './instance-guard.mjs';
import { guardP001Entry } from './entry-guard.mjs';

const OPERATOR_ID = '11111111-1111-4111-8111-111111111104';
const WH_DOMESTIC = '33333333-3333-4333-8333-333333333301';
const WH_OVERSEAS = '33333333-3333-4333-8333-333333333302';
const VARIANT1 = '55555555-5555-4555-8555-555555555501';
const FAVORITE_PREF_ID = 'f0a2c4e6-0000-4000-8000-000000000001';

const runId = DEFAULT_RUN_ID;
guardP001Entry(runId);
const { instance } = guardBeforeMutate(runId);

function psqlExec(sql) {
  const result = spawnSync(
    pgExe('psql', runId),
    [
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
      '-c',
      sql,
    ],
    withHiddenWindowsSpawnOptions({
      encoding: 'utf8',
      env: { PGPASSWORD: instance.bootstrapPassword },
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'psql failed');
  }
}

function runSeedRefresh() {
  const result = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'p0-02', 'seed.mjs')], {
    stdio: 'inherit',
    cwd: REPO_ROOT,
    env: { ...process.env, P0_02_RUN_ID: runId },
  });
  if (result.status !== 0) {
    throw new Error('seed.mjs 刷新失败');
  }
}

const before = captureFixtureIntegrity(instance);
const whBefore = before.rowCounts['public.user_warehouses'] ?? 0;
const prefBefore = before.rowCounts['public.user_variant_preference'] ?? 0;
const warehouseBefore = before.rowCounts['public.warehouse'] ?? 0;
const seedRefreshUsed = warehouseBefore < 2;

if (seedRefreshUsed) {
  runSeedRefresh();
}

psqlExec(
  `INSERT INTO public.user_warehouses (user_id, warehouse_id) VALUES
     ('${OPERATOR_ID}', '${WH_DOMESTIC}'),
     ('${OPERATOR_ID}', '${WH_OVERSEAS}')
   ON CONFLICT (user_id, warehouse_id) DO NOTHING;`,
);

psqlExec(
  `INSERT INTO public.user_variant_preference (id, user_id, variant_id, preference_type)
   VALUES ('${FAVORITE_PREF_ID}', '${OPERATOR_ID}', '${VARIANT1}', 'favorited')
   ON CONFLICT (user_id, variant_id, preference_type) DO NOTHING;`,
);

const after = captureFixtureIntegrity(instance);
const record = {
  repairedAt: new Date().toISOString(),
  runId,
  cause:
    '历史 run-postgres-tests 使用 restoreBizFixture 删除 profiles 触发 ON DELETE CASCADE，清空 user_warehouses；快照未包含该表导致无法恢复。失败的 restore 还可能清空 warehouse 等父表行。',
  evidenceRefs: [
    '.local/p0-02/run-20261014-r2/reviews/independent-c1-c3-20261014-01/runtime-and-cascade-probes.json',
    'scripts/p0-02/seed.mjs',
  ],
  before: {
    user_warehouses: whBefore,
    user_variant_preference: prefBefore,
    warehouse: warehouseBefore,
  },
  after: {
    user_warehouses: after.rowCounts['public.user_warehouses'],
    user_variant_preference: after.rowCounts['public.user_variant_preference'],
    warehouse: after.rowCounts['public.warehouse'],
  },
  rowsInserted: {
    user_warehouses: [
      { user_id: OPERATOR_ID, warehouse_id: WH_DOMESTIC },
      { user_id: OPERATOR_ID, warehouse_id: WH_OVERSEAS },
    ],
    user_variant_preference: {
      id: FAVORITE_PREF_ID,
      user_id: OPERATOR_ID,
      variant_id: VARIANT1,
      preference_type: 'favorited',
    },
  },
  seedRefreshUsed,
};

const outPath = path.join(runRoot(runId), 'fixture-recovery-20261014.json');
fs.writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`);
console.log(`fixture recovery recorded: ${outPath}`);
