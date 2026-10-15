import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';

import { PostgresSyncRepository } from '@/features/sync/postgres-sync-repository';
import { callAppRpc } from '@/lib/database/app-db';

import { appPoolFromEnv, bootstrapPoolFromInstance, loadP002InstanceEnv } from './helpers';

const adminProfileId = '11111111-1111-4111-8111-111111111101';
const operatorProfileId = '11111111-1111-4111-8111-111111111104';

async function withIdentity<T>(
  client: PoolClient,
  profileUserId: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [profileUserId ?? '']);
    const result = await fn();
    await client.query('ROLLBACK');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

describe('P0-02 expire_stale_sync_runs_for_warehouse authorization', () => {
  let bootstrap: Pool;
  let appPool: Pool;
  let warehouseId: string;
  let staleRunId: string;
  let dryRunId: string;

  beforeAll(async () => {
    const { envJson } = loadP002InstanceEnv();
    process.env.P0_02_ENABLED = 'true';
    for (const [key, value] of Object.entries(envJson)) {
      process.env[key] = value;
    }
    bootstrap = bootstrapPoolFromInstance();
    appPool = appPoolFromEnv();
    warehouseId = randomUUID();
    staleRunId = randomUUID();
    dryRunId = randomUUID();
    const client = await bootstrap.connect();
    try {
      await client.query(
        `INSERT INTO public.warehouse (id, name, country, type, is_active)
         VALUES ($1::uuid, $2, 'TH', 'overseas', true)`,
        [warehouseId, 'P0-02 expiry auth wh'],
      );
      await client.query(
        `
        INSERT INTO public.sync_run (
          id, warehouse_id, mode, status, triggered_by, triggered_from,
          started_at, heartbeat_at, created_at, finished_at,
          exit_code, plan_drift_check, plan_drift_count, plan_drift_differences,
          result_summary, input_artifact_hash, plan_artifact_hash
        ) VALUES (
          $1::uuid, $2::uuid, 'dry_run', 'completed', $3::uuid, 'web',
          now() - interval '10 minutes', now() - interval '10 minutes', now() - interval '10 minutes',
          now() - interval '5 minutes', 0, 'PASS', 0, '[]'::jsonb,
          '{}'::jsonb, 'expiry-auth-input', 'expiry-auth-plan'
        )
        `,
        [dryRunId, warehouseId, adminProfileId],
      );
      await client.query(
        `
        INSERT INTO public.sync_run (
          id, warehouse_id, mode, status, triggered_by, triggered_from,
          started_at, heartbeat_at, created_at, locked_by, lease_expires_at,
          dry_run_run_id, input_artifact_hash, plan_artifact_hash
        ) VALUES (
          $1::uuid, $2::uuid, 'real_write', 'in_progress', $3::uuid, 'web',
          now() - interval '2 hours', now() - interval '2 hours', now() - interval '2 hours',
          $1::uuid, now() - interval '1 hour',
          $4::uuid, 'expiry-auth-input', 'expiry-auth-plan'
        )
        `,
        [staleRunId, warehouseId, adminProfileId, dryRunId],
      );
      await client.query(
        `UPDATE public.sync_warehouse_lock SET locked_by = $1::uuid WHERE warehouse_id = $2::uuid`,
        [staleRunId, warehouseId],
      );
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    const client = await bootstrap.connect();
    try {
      await client.query('DELETE FROM public.sync_run WHERE warehouse_id = $1::uuid', [warehouseId]);
      await client.query('DELETE FROM public.sync_run WHERE id = $1::uuid', [dryRunId]);
      await client.query('DELETE FROM public.sync_warehouse_lock WHERE warehouse_id = $1::uuid', [warehouseId]);
      await client.query('DELETE FROM public.warehouse WHERE id = $1::uuid', [warehouseId]);
    } finally {
      client.release();
      await bootstrap.end();
      await appPool.end();
    }
  });

  async function readStaleSnapshot() {
    const client = await bootstrap.connect();
    try {
      const run = await client.query<{ status: string; result_summary: Record<string, unknown> | null }>(
        `SELECT status, result_summary FROM public.sync_run WHERE id = $1::uuid`,
        [staleRunId],
      );
      const lock = await client.query<{ locked_by: string | null }>(
        `SELECT locked_by FROM public.sync_warehouse_lock WHERE warehouse_id = $1::uuid`,
        [warehouseId],
      );
      return { run: run.rows[0], lock: lock.rows[0] };
    } finally {
      client.release();
    }
  }

  it('rejects expire without identity, operator, or invalid admin without mutating run/lock', async () => {
    const client = await appPool.connect();
    try {
      const before = await readStaleSnapshot();

      for (const identity of [null, operatorProfileId, '00000000-0000-4000-8000-000000000099']) {
        let rejected = false;
        await withIdentity(client, identity, async () => {
          try {
            await client.query(`SELECT public.expire_stale_sync_runs_for_warehouse($1::uuid)`, [warehouseId]);
          } catch {
            rejected = true;
          }
        });
        expect(rejected).toBe(true);
      }

      const after = await readStaleSnapshot();
      expect(after.run?.status).toBe(before.run?.status);
      expect(after.lock?.locked_by).toBe(before.lock?.locked_by);
    } finally {
      client.release();
    }
  });

  it('allows authorized admin expire and blocks subsequent claim until reconcile', async () => {
    await callAppRpc(
      { profileUserId: adminProfileId },
      'public.expire_stale_sync_runs_for_warehouse',
      [warehouseId],
    );

    const client = await bootstrap.connect();
    try {
      const row = await client.query<{ status: string; result_summary: Record<string, unknown> | null }>(
        `SELECT status, result_summary FROM public.sync_run WHERE id = $1::uuid`,
        [staleRunId],
      );
      expect(row.rows[0]?.status).toBe('failed');
      expect(row.rows[0]?.result_summary?.leaseExpiredWithoutFinalRelease).toBe(true);

      const lock = await client.query<{ locked_by: string | null }>(
        `SELECT locked_by FROM public.sync_warehouse_lock WHERE warehouse_id = $1::uuid`,
        [warehouseId],
      );
      expect(lock.rows[0]?.locked_by).toBeNull();
    } finally {
      client.release();
    }

    const repository = new PostgresSyncRepository({ profileUserId: adminProfileId });
    let blocked = false;
    try {
      await repository.claimSyncRun({
        runId: randomUUID(),
        warehouseId,
        mode: 'dry_run',
        leaseDuration: 60,
        triggeredBy: adminProfileId,
        triggeredFrom: 'web',
        inputArtifactHash: 'after-expire-auth',
      });
    } catch {
      blocked = true;
    }
    expect(blocked).toBe(true);
  });

  it('operator claim fails before any expire side-effect on stale warehouse', async () => {
    const wh2 = randomUUID();
    const run2 = randomUUID();
    const bootstrapClient = await bootstrap.connect();
    try {
      await bootstrapClient.query(
        `INSERT INTO public.warehouse (id, name, country, type, is_active)
         VALUES ($1::uuid, $2, 'TH', 'overseas', true)`,
        [wh2, `P0-02 expiry auth wh 2 ${wh2.slice(0, 8)}`],
      );
      await bootstrapClient.query(
        `
        INSERT INTO public.sync_run (
          id, warehouse_id, mode, status, triggered_by, triggered_from,
          started_at, heartbeat_at, created_at, locked_by, lease_expires_at,
          input_artifact_hash, plan_artifact_hash
        ) VALUES (
          $1::uuid, $2::uuid, 'dry_run', 'in_progress', $3::uuid, 'web',
          now() - interval '2 hours', now() - interval '2 hours', now() - interval '2 hours',
          $1::uuid, now() - interval '1 hour',
          'expiry-auth-2-input', 'expiry-auth-2-plan'
        )
        `,
        [run2, wh2, adminProfileId],
      );
      await bootstrapClient.query(
        `UPDATE public.sync_warehouse_lock SET locked_by = $1::uuid WHERE warehouse_id = $2::uuid`,
        [run2, wh2],
      );

      const before = await bootstrapClient.query<{ status: string }>(
        `SELECT status FROM public.sync_run WHERE id = $1::uuid`,
        [run2],
      );

      const operatorRepo = new PostgresSyncRepository({ profileUserId: operatorProfileId });
      let denied = false;
      try {
        await operatorRepo.claimSyncRun({
          runId: randomUUID(),
          warehouseId: wh2,
          mode: 'dry_run',
          leaseDuration: 60,
          triggeredBy: operatorProfileId,
          triggeredFrom: 'web',
          inputArtifactHash: 'operator-expire-deny',
        });
      } catch {
        denied = true;
      }
      expect(denied).toBe(true);

      const after = await bootstrapClient.query<{ status: string; locked_by: string | null }>(
        `SELECT sr.status, swl.locked_by
         FROM public.sync_run sr
         JOIN public.sync_warehouse_lock swl ON swl.warehouse_id = sr.warehouse_id
         WHERE sr.id = $1::uuid`,
        [run2],
      );
      expect(after.rows[0]?.status).toBe(before.rows[0]?.status);
      expect(after.rows[0]?.locked_by).toBe(run2);

      await bootstrapClient.query('DELETE FROM public.sync_run WHERE warehouse_id = $1::uuid', [wh2]);
      await bootstrapClient.query('DELETE FROM public.sync_warehouse_lock WHERE warehouse_id = $1::uuid', [wh2]);
      await bootstrapClient.query('DELETE FROM public.warehouse WHERE id = $1::uuid', [wh2]);
    } finally {
      bootstrapClient.release();
    }
  });
});
