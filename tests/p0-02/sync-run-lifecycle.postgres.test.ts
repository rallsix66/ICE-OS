import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import { PostgresSyncRepository } from '@/features/sync/postgres-sync-repository';

import { appPoolFromEnv, bootstrapPoolFromInstance, loadP002InstanceEnv } from './helpers';
import {
  captureSyncSnapshot,
  prepareExclusiveSyncFixture,
  restoreExclusiveSyncFixture,
  safeReleaseSyncRun,
  teardownExclusiveSyncFixture,
  watchWarehouseIds,
  type ExclusiveSyncFixture,
  type SyncSnapshot,
} from './sync-fixture';

function assertSyncSnapshotUnchanged(before: SyncSnapshot, after: SyncSnapshot): void {
  expect(JSON.stringify(after.syncRuns)).toBe(JSON.stringify(before.syncRuns));
  expect(JSON.stringify(after.syncLogs)).toBe(JSON.stringify(before.syncLogs));
  expect(JSON.stringify(after.locks)).toBe(JSON.stringify(before.locks));
}

async function runClaimReleaseCycle(
  adminProfileId: string,
  fixture: ExclusiveSyncFixture,
): Promise<string> {
  const runId = randomUUID();
  fixture.createdRunIds.push(runId);
  const repo = new PostgresSyncRepository({ profileUserId: adminProfileId });
  const claimed = await repo.claimSyncRun({
    warehouseId: fixture.testWarehouseId,
    mode: 'dry_run',
    runId,
    leaseDuration: 120,
    triggeredBy: adminProfileId,
    triggeredFrom: 'web',
    inputArtifactHash: 'test-input-hash',
    planArtifactHash: 'test-plan-hash',
  });
  expect(claimed).toBe(runId);
  await repo.releaseSyncRun({
    runId,
    status: 'completed',
    exitCode: 0,
    resultSummary: { variantsCreated: 0, rawRowCount: 0 },
    planDriftCheck: 'PASS',
    planDriftCount: 0,
    planDriftDifferences: [],
    planArtifactHash: 'test-plan-hash',
  });
  return runId;
}

describe('P0-02 sync run lifecycle (isolated fixture)', () => {
  let appPool: Pool;
  let adminProfileId: string;
  let operatorProfileId: string;

  beforeAll(async () => {
    const { envJson } = loadP002InstanceEnv();
    process.env.P0_02_ENABLED = 'true';
    for (const [key, value] of Object.entries(envJson)) {
      process.env[key] = value;
    }
    appPool = appPoolFromEnv();
    const bootstrap = bootstrapPoolFromInstance();
    const client = await bootstrap.connect();
    try {
      const map = await client.query<{ ice_user_id: string; role_name: string }>(
        `SELECT m.ice_user_id::text, r.name AS role_name
         FROM p0_02_meta.ice_auth_user_map m
         JOIN profiles p ON p.id = m.ice_user_id
         JOIN role r ON r.id = p.role_id
         WHERE r.name IN ('admin', 'operator')`,
      );
      for (const row of map.rows) {
        if (row.role_name === 'admin') adminProfileId = row.ice_user_id;
        if (row.role_name === 'operator') operatorProfileId = row.ice_user_id;
      }
      if (!adminProfileId || !operatorProfileId) {
        throw new Error('fixture 缺少 admin/operator identity');
      }
    } finally {
      client.release();
      await bootstrap.end();
    }
  });

  it('claim/release leaves sentinel and pre-existing sync rows unchanged', async () => {
    const bootstrap = bootstrapPoolFromInstance();
    const client = await bootstrap.connect();
    const fixture = await prepareExclusiveSyncFixture(client, adminProfileId);
    let before: SyncSnapshot;
    try {
      before = await captureSyncSnapshot(client, watchWarehouseIds(fixture));
      await runClaimReleaseCycle(adminProfileId, fixture);
    } finally {
      await restoreExclusiveSyncFixture(client, fixture);
      const after = await captureSyncSnapshot(client, watchWarehouseIds(fixture));
      assertSyncSnapshotUnchanged(before!, after);
      await teardownExclusiveSyncFixture(client, fixture);
      client.release();
      await bootstrap.end();
    }
  });

  it('recovers when failure happens after claim (finally release + cleanup)', async () => {
    const bootstrap = bootstrapPoolFromInstance();
    const client = await bootstrap.connect();
    const fixture = await prepareExclusiveSyncFixture(client, adminProfileId);
    let before: SyncSnapshot;
    const runId = randomUUID();
    fixture.createdRunIds.push(runId);
    const repo = new PostgresSyncRepository({ profileUserId: adminProfileId });
    try {
      before = await captureSyncSnapshot(client, watchWarehouseIds(fixture));
      const claimed = await repo.claimSyncRun({
        warehouseId: fixture.testWarehouseId,
        mode: 'dry_run',
        runId,
        leaseDuration: 120,
        triggeredBy: adminProfileId,
        triggeredFrom: 'web',
        inputArtifactHash: 'test-input-hash',
        planArtifactHash: 'test-plan-hash',
      });
      expect(claimed).toBe(runId);
      throw new Error('simulated failure after claim');
    } catch (error) {
      expect((error as Error).message).toContain('simulated failure after claim');
    } finally {
      await safeReleaseSyncRun(repo, runId);
      await restoreExclusiveSyncFixture(client, fixture);
      const after = await captureSyncSnapshot(client, watchWarehouseIds(fixture));
      assertSyncSnapshotUnchanged(before!, after);
      await teardownExclusiveSyncFixture(client, fixture);
      client.release();
      await bootstrap.end();
    }
  });

  it('recovers when failure happens after release', async () => {
    const bootstrap = bootstrapPoolFromInstance();
    const client = await bootstrap.connect();
    const fixture = await prepareExclusiveSyncFixture(client, adminProfileId);
    let before: SyncSnapshot;
    try {
      before = await captureSyncSnapshot(client, watchWarehouseIds(fixture));
      await runClaimReleaseCycle(adminProfileId, fixture);
      throw new Error('simulated failure after release');
    } catch (error) {
      expect((error as Error).message).toContain('simulated failure after release');
    } finally {
      await restoreExclusiveSyncFixture(client, fixture);
      const after = await captureSyncSnapshot(client, watchWarehouseIds(fixture));
      assertSyncSnapshotUnchanged(before!, after);
      await teardownExclusiveSyncFixture(client, fixture);
      client.release();
      await bootstrap.end();
    }
  });

  it('repeated claim/release cycles in one test do not mutate sentinel state', async () => {
    const bootstrap = bootstrapPoolFromInstance();
    const client = await bootstrap.connect();
    const fixture = await prepareExclusiveSyncFixture(client, adminProfileId);
    let before: SyncSnapshot;
    try {
      before = await captureSyncSnapshot(client, watchWarehouseIds(fixture));
      await runClaimReleaseCycle(adminProfileId, fixture);
      await runClaimReleaseCycle(adminProfileId, fixture);
    } finally {
      await restoreExclusiveSyncFixture(client, fixture);
      const after = await captureSyncSnapshot(client, watchWarehouseIds(fixture));
      assertSyncSnapshotUnchanged(before!, after);
      await teardownExclusiveSyncFixture(client, fixture);
      client.release();
      await bootstrap.end();
    }
  });

  it('does not delete pre-existing sync_run on test warehouse', async () => {
    const bootstrap = bootstrapPoolFromInstance();
    const client = await bootstrap.connect();
    const fixture = await prepareExclusiveSyncFixture(client, adminProfileId);
    try {
      await runClaimReleaseCycle(adminProfileId, fixture);
      const row = await client.query<{ id: string }>(
        `SELECT id::text FROM public.sync_run WHERE id = $1::uuid`,
        [fixture.preExistingRunId],
      );
      expect(row.rows[0]?.id).toBe(fixture.preExistingRunId);
    } finally {
      await restoreExclusiveSyncFixture(client, fixture);
      await teardownExclusiveSyncFixture(client, fixture);
      client.release();
      await bootstrap.end();
    }
  });

  it('operator cannot read dry-run binding metadata via repository', async () => {
    const bootstrap = bootstrapPoolFromInstance();
    const client = await bootstrap.connect();
    let completedRunId: string | null = null;
    try {
      const row = await client.query<{ id: string }>(
        `SELECT id::text FROM public.sync_run
         WHERE status = 'completed' AND mode = 'dry_run'
         ORDER BY finished_at DESC NULLS LAST LIMIT 1`,
      );
      completedRunId = row.rows[0]?.id ?? null;
    } finally {
      client.release();
      await bootstrap.end();
    }
    if (!completedRunId) {
      throw new Error('fixture 缺少 completed dry_run 供绑定读取回归');
    }

    const adminRepo = new PostgresSyncRepository({ profileUserId: adminProfileId });
    const binding = await adminRepo.getDryRunBindingMetadata(completedRunId);
    expect(binding).not.toBeNull();
    expect(binding?.status).toBe('completed');

    const operatorRepo = new PostgresSyncRepository({ profileUserId: operatorProfileId });
    const operatorBinding = await operatorRepo.getDryRunBindingMetadata(completedRunId);
    expect(operatorBinding).toBeNull();
  });

  afterAll(async () => {
    await appPool.end();
  });
});
