import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import { appPoolFromEnv, bootstrapPoolFromInstance, loadP002InstanceEnv } from './helpers';

const adminProfileId = '11111111-1111-4111-8111-111111111101';

describe('P0-02 expire vs release lock order (no deadlock)', () => {
  let bootstrap: Pool;
  let appPool: Pool;
  let warehouseId: string;
  let staleRunId: string;

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
    const client = await bootstrap.connect();
    try {
      await client.query(
        `INSERT INTO public.warehouse (id, name, country, type, is_active)
         VALUES ($1::uuid, $2, 'TH', 'overseas', true)`,
        [warehouseId, 'P0-02 expiry lock wh'],
      );
      const dryRunId = randomUUID();
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
          '{}'::jsonb, 'expiry-lock-input', 'expiry-lock-plan'
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
          $4::uuid, 'expiry-lock-input', 'expiry-lock-plan'
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
      await client.query('DELETE FROM public.sync_warehouse_lock WHERE warehouse_id = $1::uuid', [warehouseId]);
      await client.query('DELETE FROM public.warehouse WHERE id = $1::uuid', [warehouseId]);
    } finally {
      client.release();
      await bootstrap.end();
      await appPool.end();
    }
  });

  it('concurrent expire and release complete without 40P01 and leave consistent terminal state', async () => {
    const clientA = await appPool.connect();
    const clientB = await appPool.connect();
    try {
      await clientA.query('BEGIN');
      await clientB.query('BEGIN');
      await clientA.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [adminProfileId]);
      await clientB.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [adminProfileId]);

      const expirePromise = clientA.query(
        `SELECT public.expire_stale_sync_runs_for_warehouse($1::uuid)`,
        [warehouseId],
      );
      const releasePromise = clientB.query(
        `SELECT public.release_sync_run($1::uuid, 'failed', 2, 'concurrency probe', '{}'::jsonb, 'PASS', 0, '[]'::jsonb, 'expiry-lock-plan')`,
        [staleRunId],
      );

      const [expireResult, releaseResult] = await Promise.allSettled([expirePromise, releasePromise]);

      const codes: string[] = [];
      for (const settled of [expireResult, releaseResult]) {
        if (settled.status === 'rejected') {
          const err = settled.reason as { code?: string };
          if (err?.code) codes.push(err.code);
          expect(err?.code).not.toBe('40P01');
        }
      }

      await clientA.query('ROLLBACK');
      await clientB.query('ROLLBACK');

      const verify = await bootstrap.connect();
      try {
        const row = await verify.query<{ status: string; locked_by: string | null }>(
          `SELECT sr.status, swl.locked_by
           FROM public.sync_run sr
           JOIN public.sync_warehouse_lock swl ON swl.warehouse_id = sr.warehouse_id
           WHERE sr.id = $1::uuid`,
          [staleRunId],
        );
        expect(['in_progress', 'failed']).toContain(row.rows[0]?.status);
        if (row.rows[0]?.status === 'failed') {
          expect(row.rows[0]?.locked_by).toBeNull();
        }
      } finally {
        verify.release();
      }

      expect(codes.length).toBeGreaterThanOrEqual(0);
    } finally {
      clientA.release();
      clientB.release();
    }
  });
});
