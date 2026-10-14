import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { DEFAULT_RUN_ID, REPO_ROOT, pgExe, withHiddenWindowsSpawnOptions } from './common.mjs';
import { captureBizFixture, restoreBizFixture } from './fixture-snapshot.mjs';
import { guardBeforeMutate } from './instance-guard.mjs';

const runId = DEFAULT_RUN_ID;
const { instance } = guardBeforeMutate(runId);
const before = captureBizFixture(instance);
const beforeCostCount = before.tables.inventory_unit_costs?.length ?? 0;

const deleteOne = spawnSync(
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
    `DELETE FROM P0_02_biz.inventory_unit_costs c
     USING P0_02_biz.warehouses w
     WHERE w.id = c.warehouse_id AND w.code = 'WH-B1'`,
  ],
  withHiddenWindowsSpawnOptions({
    encoding: 'utf8',
    env: { PGPASSWORD: instance.bootstrapPassword },
    stdio: ['ignore', 'pipe', 'pipe'],
  }),
);
if (deleteOne.status !== 0) {
  console.error(JSON.stringify({ status: 'failed', phase: 'delete-cost', stderr: deleteOne.stderr }));
  process.exit(2);
}

const runner = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'p0-02', 'run-postgres-tests.mjs')], {
  stdio: 'inherit',
  cwd: REPO_ROOT,
  env: { ...process.env, P0_02_RUN_ID: runId },
});

const mid = captureBizFixture(instance);
const midCostCount = mid.tables.inventory_unit_costs?.length ?? 0;
const expectedAfterRunner = beforeCostCount - 1;

try {
  restoreBizFixture(instance, before);
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', phase: 'restore', error: String(error) }));
  process.exit(3);
}

const after = captureBizFixture(instance);
const afterCostCount = after.tables.inventory_unit_costs?.length ?? 0;
const preserved =
  midCostCount === expectedAfterRunner &&
  afterCostCount === beforeCostCount &&
  JSON.stringify(after) === JSON.stringify(before);

console.log(
  JSON.stringify(
    {
      status: preserved ? 'ok' : 'failed',
      runnerExit: runner.status,
      expectedAfterRunner,
      beforeCostCount,
      midCostCount,
      afterCostCount,
      preserved,
    },
    null,
    2,
  ),
);

if (!preserved || runner.status !== 0) {
  process.exit(1);
}
