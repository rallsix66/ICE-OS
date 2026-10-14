import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import { PostgresSyncRepository } from '@/features/sync/postgres-sync-repository';

import { appPoolFromEnv, bootstrapPoolFromInstance, loadP002InstanceEnv } from './helpers';

describe('P0-02 sync read visibility (PostgresSyncRepository)', () => {
  let appPool: Pool;
  let adminProfileId: string;
  let operatorProfileId: string;
  let completedDryRunId: string;
  let warehouseId: string;

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
      const identities = await client.query<{ ice_user_id: string; role_name: string }>(
        `SELECT m.ice_user_id::text, r.name AS role_name
         FROM p0_02_meta.ice_auth_user_map m
         JOIN profiles p ON p.id = m.ice_user_id
         JOIN role r ON r.id = p.role_id
         WHERE r.name IN ('admin', 'operator')`,
      );
      for (const row of identities.rows) {
        if (row.role_name === 'admin') adminProfileId = row.ice_user_id;
        if (row.role_name === 'operator') operatorProfileId = row.ice_user_id;
      }
      const run = await client.query<{ id: string; warehouse_id: string }>(
        `SELECT id::text, warehouse_id::text
         FROM public.sync_run
         WHERE status = 'completed' AND mode = 'dry_run'
           AND input_artifact_hash IS NOT NULL AND plan_artifact_hash IS NOT NULL
         ORDER BY finished_at DESC NULLS LAST
         LIMIT 1`,
      );
      if (!run.rowCount) {
        throw new Error('fixture 缺少带 artifact hash 的 completed dry_run');
      }
      completedDryRunId = run.rows[0]!.id;
      warehouseId = run.rows[0]!.warehouse_id;
    } finally {
      client.release();
      await bootstrap.end();
    }
  });

  afterAll(async () => {
    await appPool.end();
  });

  it('admin reads binding, history, protection sets and sync_log when present', async () => {
    const repo = new PostgresSyncRepository({ profileUserId: adminProfileId });
    const binding = await repo.getDryRunBindingMetadata(completedDryRunId);
    expect(binding).not.toBeNull();
    expect(binding?.id).toBe(completedDryRunId);
    expect(binding?.input_artifact_hash).toBeTruthy();
    expect(binding?.plan_artifact_hash).toBeTruthy();

    const history = await repo.getWarehouseHistory(warehouseId);
    expect(history.hasBaseline).toBe(true);

    const since = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    const recent = await repo.getRecentlyCompletedRunIds(since);
    expect(recent.has(completedDryRunId)).toBe(true);

    const active = await repo.getActiveRunIds();
    expect(active instanceof Set).toBe(true);

    const referenced = await repo.getReferencedDryRunIds();
    expect(referenced instanceof Set).toBe(true);

    const log = await repo.getSyncLog(completedDryRunId);
    if (log) {
      expect(log.syncRunId).toBe(completedDryRunId);
    }
  });

  it('operator is denied binding metadata and worker protection sets', async () => {
    const repo = new PostgresSyncRepository({ profileUserId: operatorProfileId });
    expect(await repo.getDryRunBindingMetadata(completedDryRunId)).toBeNull();
    expect((await repo.getActiveRunIds()).size).toBe(0);
    expect((await repo.getReferencedDryRunIds()).size).toBe(0);
  });
});
