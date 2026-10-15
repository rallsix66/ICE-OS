import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';

import { loadP002InstanceEnv } from './helpers';

const adminProfileId = '11111111-1111-4111-8111-111111111101';

type StaleFixture = {
  warehouseId: string;
  dryRunId: string;
  staleRunId: string;
};

type RunState = {
  status: string;
  result_summary: Record<string, unknown> | null;
  locked_by: string | null;
  in_progress: number;
};

function pgError(error: unknown): { code?: string; message?: string } {
  if (error && typeof error === 'object') {
    const row = error as { code?: string; message?: string };
    return { code: row.code, message: row.message };
  }
  return {};
}

async function withTimeouts(client: PoolClient): Promise<void> {
  await client.query(`SET statement_timeout = '8000'`);
  await client.query(`SET lock_timeout = '5000'`);
}

async function beginAdmin(client: PoolClient): Promise<void> {
  await client.query('BEGIN');
  await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [adminProfileId]);
}

async function waitForAdvisoryLock(control: PoolClient, pid: number, label: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const row = await control.query<{ wait_event_type: string | null; wait_event: string | null }>(
      `SELECT wait_event_type, wait_event FROM pg_stat_activity WHERE pid = $1`,
      [pid],
    );
    const wait = row.rows[0];
    if (wait?.wait_event_type === 'Lock' && wait.wait_event === 'advisory') {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${label}: controlled advisory lock wait not observed for pid ${pid}`);
}

describe('P0-02 expire vs release lock order (real roles, committed terminal state)', () => {
  let bootstrap: Pool;
  let appPool: Pool;
  let appPool2: Pool;
  let syncPool: Pool;

  beforeAll(async () => {
    const { envJson, instance } = loadP002InstanceEnv();
    process.env.P0_02_ENABLED = 'true';
    for (const [key, value] of Object.entries(envJson)) {
      process.env[key] = value;
    }
    bootstrap = new Pool({
      host: instance.host,
      port: instance.port,
      database: instance.dbName,
      user: instance.bootstrapUser,
      password: instance.bootstrapPassword,
      max: 3,
    });
    appPool = new Pool({
      connectionString: envJson.P0_02_APP_DATABASE_URL,
      max: 4,
    });
    appPool2 = new Pool({
      connectionString: envJson.P0_02_APP_DATABASE_URL,
      max: 4,
    });
    syncPool = new Pool({
      connectionString: envJson.P0_02_SYNC_DATABASE_URL,
      max: 4,
    });
  });

  afterAll(async () => {
    await bootstrap.end();
    await appPool.end();
    await appPool2.end();
    await syncPool.end();
  });

  async function insertStaleRun(): Promise<StaleFixture> {
    const warehouseId = randomUUID();
    const dryRunId = randomUUID();
    const staleRunId = randomUUID();
    const client = await bootstrap.connect();
    try {
      await client.query(
        `INSERT INTO public.warehouse (id, name, country, type, is_active)
         VALUES ($1::uuid, $2, 'TH', 'overseas', true)`,
        [warehouseId, `P0-02 expiry lock ${warehouseId.slice(0, 8)}`],
      );
      await client.query(
        `INSERT INTO public.sync_warehouse_lock (warehouse_id) VALUES ($1::uuid)
         ON CONFLICT (warehouse_id) DO NOTHING`,
        [warehouseId],
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
        `UPDATE public.sync_warehouse_lock SET locked_by = $1::uuid, locked_at = now()
         WHERE warehouse_id = $2::uuid`,
        [staleRunId, warehouseId],
      );
    } finally {
      client.release();
    }
    return { warehouseId, dryRunId, staleRunId };
  }

  async function readRunState(fixture: StaleFixture): Promise<RunState> {
    const client = await bootstrap.connect();
    try {
      const row = await client.query<RunState>(
        `
        SELECT sr.status, sr.result_summary, swl.locked_by,
               (SELECT count(*)::int FROM public.sync_run
                WHERE warehouse_id = $2::uuid AND status = 'in_progress') AS in_progress
        FROM public.sync_run sr
        JOIN public.sync_warehouse_lock swl ON swl.warehouse_id = sr.warehouse_id
        WHERE sr.id = $1::uuid
        `,
        [fixture.staleRunId, fixture.warehouseId],
      );
      return row.rows[0]!;
    } finally {
      client.release();
    }
  }

  async function cleanupFixture(fixture: StaleFixture): Promise<void> {
    const client = await bootstrap.connect();
    try {
      await client.query('DELETE FROM public.sync_run WHERE warehouse_id = $1::uuid', [
        fixture.warehouseId,
      ]);
      await client.query('DELETE FROM public.sync_warehouse_lock WHERE warehouse_id = $1::uuid', [
        fixture.warehouseId,
      ]);
      await client.query('DELETE FROM public.warehouse WHERE id = $1::uuid', [fixture.warehouseId]);
    } finally {
      client.release();
    }
  }

  async function expectTerminalFailed(fixture: StaleFixture): Promise<void> {
    const state = await readRunState(fixture);
    expect(state.status).toBe('failed');
    expect(state.locked_by).toBeNull();
    expect(state.in_progress).toBe(0);
  }

  it('release first: expiry waits on advisory lock then commits failed terminal state', async () => {
    const fixture = await insertStaleRun();
    const control = await bootstrap.connect();
    const syncClient = await syncPool.connect();
    const appClient = await appPool.connect();
    try {
      await withTimeouts(syncClient);
      await withTimeouts(appClient);
      await syncClient.query('BEGIN');
      await syncClient.query(
        `SELECT public.release_sync_run($1::uuid, 'failed', 2, 'concurrency release-first', '{}'::jsonb)`,
        [fixture.staleRunId],
      );

      await beginAdmin(appClient);
      const appPid = (
        await appClient.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)
      ).rows[0]!.pid;
      const expirePromise = appClient.query(
        `SELECT public.expire_stale_sync_runs_for_warehouse($1::uuid)`,
        [fixture.warehouseId],
      );

      await waitForAdvisoryLock(control, appPid, 'release-first');
      await syncClient.query('COMMIT');
      await expirePromise;
      await appClient.query('COMMIT');

      await expectTerminalFailed(fixture);
    } catch (error) {
      await syncClient.query('ROLLBACK').catch(() => undefined);
      await appClient.query('ROLLBACK').catch(() => undefined);
      const err = pgError(error);
      if (err.code === '40P01') {
        throw new Error(`unexpected deadlock: ${err.message ?? ''}`);
      }
      throw error;
    } finally {
      syncClient.release();
      appClient.release();
      control.release();
      await cleanupFixture(fixture);
    }
  }, 60_000);

  it('expiry first: release waits then receives terminal-state rejection', async () => {
    const fixture = await insertStaleRun();
    const control = await bootstrap.connect();
    const syncClient = await syncPool.connect();
    const appClient = await appPool.connect();
    try {
      await withTimeouts(syncClient);
      await withTimeouts(appClient);
      await beginAdmin(appClient);
      await appClient.query(
        `SELECT public.expire_stale_sync_runs_for_warehouse($1::uuid)`,
        [fixture.warehouseId],
      );

      await syncClient.query('BEGIN');
      const syncPid = (
        await syncClient.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)
      ).rows[0]!.pid;
      const releasePromise = syncClient.query(
        `SELECT public.release_sync_run($1::uuid, 'failed', 2, 'concurrency expiry-first', '{}'::jsonb)`,
        [fixture.staleRunId],
      );

      await waitForAdvisoryLock(control, syncPid, 'expiry-first');
      await appClient.query('COMMIT');

      let releaseError: unknown;
      try {
        await releasePromise;
      } catch (error) {
        releaseError = error;
      }
      await syncClient.query('ROLLBACK');

      const err = pgError(releaseError);
      expect(err.code).toBe('P0001');
      expect(err.message ?? '').toContain('终态');

      const state = await readRunState(fixture);
      expect(state.status).toBe('failed');
      expect(state.locked_by).toBeNull();
      expect(state.in_progress).toBe(0);
      expect(state.result_summary?.commitOutcome).toBe('unknown');
      expect(state.result_summary?.publishUnknownReconciled).toBe(false);
    } catch (error) {
      await syncClient.query('ROLLBACK').catch(() => undefined);
      await appClient.query('ROLLBACK').catch(() => undefined);
      const err = pgError(error);
      if (err.code === '40P01') {
        throw new Error(`unexpected deadlock: ${err.message ?? ''}`);
      }
      throw error;
    } finally {
      syncClient.release();
      appClient.release();
      control.release();
      await cleanupFixture(fixture);
    }
  }, 60_000);

  it('expiry before competing claim: unknown run blocks new real_write claim', async () => {
    const fixture = await insertStaleRun();
    const control = await bootstrap.connect();
    const appClient = await appPool.connect();
    const appClient2 = await appPool2.connect();
    const newRunId = randomUUID();
    try {
      await withTimeouts(appClient);
      await withTimeouts(appClient2);
      await beginAdmin(appClient);
      await appClient.query(
        `SELECT public.expire_stale_sync_runs_for_warehouse($1::uuid)`,
        [fixture.warehouseId],
      );

      await beginAdmin(appClient2);
      const app2Pid = (
        await appClient2.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)
      ).rows[0]!.pid;
      const claimPromise = appClient2.query(
        `
        SELECT public.claim_sync_run(
          $1::uuid, 'real_write', $2::uuid, 60, $3::uuid, 'web', $4::uuid,
          'expiry-lock-input', 'expiry-lock-plan'
        )
        `,
        [fixture.warehouseId, newRunId, adminProfileId, fixture.dryRunId],
      );

      await waitForAdvisoryLock(control, app2Pid, 'expiry-vs-claim');
      await appClient.query('COMMIT');

      let claimError: unknown;
      try {
        await claimPromise;
      } catch (error) {
        claimError = error;
      }
      await appClient2.query('ROLLBACK');

      const err = pgError(claimError);
      expect(err.code).toBe('P0001');
      expect(err.message ?? '').toContain('未核对');

      const state = await readRunState(fixture);
      expect(state.status).toBe('failed');
      expect(state.locked_by).toBeNull();
      expect(state.in_progress).toBe(0);
      expect(state.result_summary?.publishUnknownReconciled).toBe(false);

      const dup = await bootstrap.connect();
      try {
        const exists = await dup.query(
          `SELECT 1 FROM public.sync_run WHERE id = $1::uuid`,
          [newRunId],
        );
        expect(exists.rowCount).toBe(0);
      } finally {
        dup.release();
      }
    } catch (error) {
      await appClient.query('ROLLBACK').catch(() => undefined);
      await appClient2.query('ROLLBACK').catch(() => undefined);
      const err = pgError(error);
      if (err.code === '40P01') {
        throw new Error(`unexpected deadlock: ${err.message ?? ''}`);
      }
      throw error;
    } finally {
      appClient.release();
      appClient2.release();
      control.release();
      await cleanupFixture(fixture);
    }
  }, 60_000);

  it('gate fails when release_sync_run is invoked with app runner (42501)', async () => {
    const fixture = await insertStaleRun();
    const appClient = await appPool.connect();
    try {
      await withTimeouts(appClient);
      await beginAdmin(appClient);
      let releaseError: unknown;
      try {
        await appClient.query(
          `SELECT public.release_sync_run($1::uuid, 'failed', 2, 'wrong role probe', '{}'::jsonb)`,
          [fixture.staleRunId],
        );
      } catch (error) {
        releaseError = error;
      }
      await appClient.query('ROLLBACK');

      const err = pgError(releaseError);
      expect(err.code).toBe('42501');

      const state = await readRunState(fixture);
      expect(state.status).toBe('in_progress');
      expect(state.locked_by).toBe(fixture.staleRunId);
    } finally {
      appClient.release();
      await cleanupFixture(fixture);
    }
  }, 30_000);
});
