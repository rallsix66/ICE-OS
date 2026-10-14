import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

import { PostgresSyncRepository } from '@/features/sync/postgres-sync-repository';

/** Seed 预置仓库：生命周期测试只读观测，不得修改或删除。 */
export const SENTINEL_WAREHOUSE_ID = '33333333-3333-4333-8333-333333333302';

export type SyncSnapshot = {
  syncRuns: unknown[];
  syncLogs: unknown[];
  locks: unknown[];
};

export async function captureSyncSnapshot(
  client: PoolClient,
  warehouseIds: string[],
): Promise<SyncSnapshot> {
  const syncRuns = (
    await client.query(
      `SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) AS j FROM (
         SELECT id::text, warehouse_id::text, status, mode
         FROM public.sync_run WHERE warehouse_id = ANY($1::uuid[])
         ORDER BY id
       ) t`,
      [warehouseIds],
    )
  ).rows[0]?.j;
  const syncLogs = (
    await client.query(
      `SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) AS j FROM (
         SELECT id::text, sync_run_id::text, warehouse_id::text, status
         FROM public.sync_log WHERE warehouse_id = ANY($1::uuid[])
         ORDER BY id
       ) t`,
      [warehouseIds],
    )
  ).rows[0]?.j;
  const locks = (
    await client.query(
      `SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) AS j FROM (
         SELECT warehouse_id::text, locked_by::text, locked_at::text
         FROM public.sync_warehouse_lock WHERE warehouse_id = ANY($1::uuid[])
         ORDER BY warehouse_id
       ) t`,
      [warehouseIds],
    )
  ).rows[0]?.j;
  return {
    syncRuns: typeof syncRuns === 'string' ? JSON.parse(syncRuns) : (syncRuns ?? []),
    syncLogs: typeof syncLogs === 'string' ? JSON.parse(syncLogs) : (syncLogs ?? []),
    locks: typeof locks === 'string' ? JSON.parse(locks) : (locks ?? []),
  };
}

export type ExclusiveSyncFixture = {
  /** 本测试独占仓库（country=XX，不影响 TH 生产读网关）。 */
  testWarehouseId: string;
  /** 本测试在 setup 时插入的“预存在” completed dry_run。 */
  preExistingRunId: string;
  insertedTestWarehouse: boolean;
  insertedPreExistingRun: boolean;
  initialLock: { locked_by: string | null; locked_at: string | null };
  createdRunIds: string[];
};

export function watchWarehouseIds(fixture: ExclusiveSyncFixture): string[] {
  return [SENTINEL_WAREHOUSE_ID, fixture.testWarehouseId];
}

export async function prepareExclusiveSyncFixture(
  client: PoolClient,
  adminProfileId: string,
): Promise<ExclusiveSyncFixture> {
  const testWarehouseId = randomUUID();
  const preExistingRunId = randomUUID();

  await client.query(
    `INSERT INTO public.warehouse (id, name, country, type, is_active)
     VALUES ($1::uuid, $2, 'XX', 'overseas', true)`,
    [testWarehouseId, `P0-02 sync lifecycle ${testWarehouseId.slice(0, 8)}`],
  );

  await client.query(
    `INSERT INTO public.sync_warehouse_lock (warehouse_id) VALUES ($1::uuid)
     ON CONFLICT (warehouse_id) DO NOTHING`,
    [testWarehouseId],
  );

  const lockRow = await client.query<{ locked_by: string | null; locked_at: string | null }>(
    `SELECT locked_by::text, locked_at::text FROM public.sync_warehouse_lock WHERE warehouse_id = $1::uuid`,
    [testWarehouseId],
  );
  const initialLock = lockRow.rows[0] ?? { locked_by: null, locked_at: null };

  await client.query(
    `INSERT INTO public.sync_run (
       id, warehouse_id, status, mode, triggered_by, triggered_from,
       started_at, finished_at, exit_code, result_summary,
       plan_drift_check, plan_drift_count, plan_drift_differences,
       input_artifact_hash, plan_artifact_hash
     ) VALUES (
       $1::uuid, $2::uuid, 'completed', 'dry_run', $3::uuid, 'web',
       now(), now(), 0, '{"variantsCreated":0}'::jsonb,
       'PASS', 0, '[]'::jsonb,
       'p0-02-preexisting-input-hash', 'p0-02-preexisting-plan-hash'
     )`,
    [preExistingRunId, testWarehouseId, adminProfileId],
  );

  return {
    testWarehouseId,
    preExistingRunId,
    insertedTestWarehouse: true,
    insertedPreExistingRun: true,
    initialLock,
    createdRunIds: [],
  };
}

export async function restoreExclusiveSyncFixture(
  client: PoolClient,
  fixture: ExclusiveSyncFixture,
): Promise<void> {
  if (fixture.createdRunIds.length > 0) {
    await client.query(`DELETE FROM public.sync_log WHERE sync_run_id = ANY($1::uuid[])`, [
      fixture.createdRunIds,
    ]);
    await client.query(`DELETE FROM public.sync_run WHERE id = ANY($1::uuid[])`, [
      fixture.createdRunIds,
    ]);
  }

  await client.query(
    `UPDATE public.sync_warehouse_lock
     SET locked_by = $2::uuid, locked_at = $3::timestamptz
     WHERE warehouse_id = $1::uuid`,
    [
      fixture.testWarehouseId,
      fixture.initialLock.locked_by,
      fixture.initialLock.locked_at,
    ],
  );

}

/** 快照断言通过后撤掉本测试独占仓库（不影响 seed sentinel）。 */
export async function teardownExclusiveSyncFixture(
  client: PoolClient,
  fixture: ExclusiveSyncFixture,
): Promise<void> {
  if (!fixture.insertedTestWarehouse) {
    return;
  }
  await client.query(`DELETE FROM public.sync_log WHERE warehouse_id = $1::uuid`, [
    fixture.testWarehouseId,
  ]);
  await client.query(`DELETE FROM public.sync_run WHERE warehouse_id = $1::uuid`, [
    fixture.testWarehouseId,
  ]);
  await client.query(`DELETE FROM public.sync_warehouse_lock WHERE warehouse_id = $1::uuid`, [
    fixture.testWarehouseId,
  ]);
  await client.query(`DELETE FROM public.warehouse WHERE id = $1::uuid`, [fixture.testWarehouseId]);
}

export async function safeReleaseSyncRun(
  repo: PostgresSyncRepository,
  runId: string,
): Promise<void> {
  try {
    await repo.releaseSyncRun({
      runId,
      status: 'failed',
      exitCode: 1,
      errorMessage: 'p0-02 test cleanup',
      planDriftCheck: 'PASS',
      planDriftCount: 0,
      planDriftDifferences: [],
      planArtifactHash: 'test-plan-hash',
    });
  } catch {
    // release 可能因 run 未 claim 或已释放而失败；清理由 restore 删除 run 行兜底
  }
}
