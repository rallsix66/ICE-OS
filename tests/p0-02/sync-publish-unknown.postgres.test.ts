import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import { createSyncService } from '@/features/sync/sync-service';
import { FileSystemArtifactProvider } from '@/features/sync/file-system-artifact-provider';
import { PostgresSyncRepository } from '@/features/sync/postgres-sync-repository';
import type { SyncExecuteParams, SyncExecuteResult, SyncRunner } from '@/features/sync/types';

import { callAppRpc } from '@/lib/database/app-db';

import { bootstrapPoolFromInstance, loadP002InstanceEnv } from './helpers';

const adminProfileId = '11111111-1111-4111-8111-111111111101';

class PublishUnknownProbeRunner implements SyncRunner {
  async capabilities() {
    return { maxTimeoutMs: 120_000, supportsDryRun: true, supportsRealWrite: true };
  }

  async execute(params: SyncExecuteParams): Promise<SyncExecuteResult> {
    if (params.mode === 'dry_run') {
      return {
        success: true,
        exitCode: 0,
        summary: {
          warehouseId: params.warehouseId,
          warehouseName: 'P0-02 publish unknown wh',
          variantsCreated: 0,
          variantsSkipped: 0,
          inventoryInserted: 0,
          inventoryUpdated: 0,
          inventoryUnchanged: 0,
          warehouseRenamed: false,
        },
        syncLog: { status: 'success', written: false },
        planDriftCheck: 'PASS',
        planDriftCount: 0,
        planDriftDifferences: [],
        errors: [],
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 1,
        planArtifact: {
          warehouse_rename_required: { warehouse_id: params.warehouseId, action: 'none' },
          inventory_updates: [],
        },
      };
    }
    return {
      success: false,
      exitCode: 2,
      commitOutcome: 'unknown',
      publishCommitted: false,
      summary: {
        warehouseId: params.warehouseId,
        warehouseName: 'P0-02 publish unknown wh',
        variantsCreated: 0,
        variantsSkipped: 0,
        inventoryInserted: 0,
        inventoryUpdated: 0,
        inventoryUnchanged: 0,
        warehouseRenamed: false,
      },
      syncLog: { status: 'failed', written: false },
      planDriftCheck: 'PASS',
      planDriftCount: 0,
      planDriftDifferences: [],
      errors: ['发布 commit 结果未知（探针）'],
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 1,
    };
  }
}

describe('P0-02 publish unknown persistence and claim guard', () => {
  let bootstrap: Pool;
  let warehouseId: string;
  let artifactDir: string;

  beforeAll(async () => {
    const { envJson } = loadP002InstanceEnv();
    process.env.P0_02_ENABLED = 'true';
    for (const [key, value] of Object.entries(envJson)) {
      process.env[key] = value;
    }
    warehouseId = randomUUID();
    bootstrap = bootstrapPoolFromInstance();
    const client = await bootstrap.connect();
    try {
      await client.query(
        `INSERT INTO public.warehouse (id, name, country, type, is_active)
         VALUES ($1::uuid, $2, 'TH', 'overseas', true)`,
        [warehouseId, 'P0-02 publish unknown wh'],
      );
      await client.query(
        `INSERT INTO public.sync_warehouse_lock (warehouse_id) VALUES ($1::uuid)
         ON CONFLICT (warehouse_id) DO NOTHING`,
        [warehouseId],
      );
    } finally {
      client.release();
    }
    artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p0-02-unknown-artifacts-'));
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
    }
    if (artifactDir && fs.existsSync(artifactDir)) {
      fs.rmSync(artifactDir, { recursive: true, force: true });
    }
  });

  it('persists unknown summary, blocks claim until reconciled', async () => {
    const repository = new PostgresSyncRepository({ profileUserId: adminProfileId });
    const artifactProvider = new FileSystemArtifactProvider(artifactDir);
    const runner = new PublishUnknownProbeRunner();
    const service = createSyncService({
      repository,
      artifactProvider,
      runner,
    });

    const inputArtifact = { source: 'unknown-probe' };
    const dry = await service.executeSync({
      mode: 'dry_run',
      warehouseId,
      triggeredBy: adminProfileId,
      inputArtifact,
    });
    expect(dry.status).toBe('completed');

    const real = await service.executeSync({
      mode: 'real_write',
      warehouseId,
      triggeredBy: adminProfileId,
      dryRunRunId: dry.runId!,
      confirmToken: 'P5-SY8D-TH',
      inputArtifact,
    });
    expect(real.status).toBe('indeterminate');
    expect(real.runId).toBeTruthy();

    const client = await bootstrap.connect();
    try {
      const row = await client.query<{
        exit_code: number;
        result_summary: Record<string, unknown> | null;
      }>(
        `SELECT exit_code, result_summary FROM public.sync_run WHERE id = $1::uuid`,
        [real.runId],
      );
      expect(row.rows[0]?.exit_code).toBe(2);
      expect(row.rows[0]?.result_summary?.commitOutcome).toBe('unknown');

      let blocked = false;
      try {
        await repository.claimSyncRun({
          runId: randomUUID(),
          warehouseId,
          mode: 'dry_run',
          leaseDuration: 60,
          triggeredBy: adminProfileId,
          triggeredFrom: 'web',
          inputArtifactHash: 'blocked-probe',
        });
      } catch {
        blocked = true;
      }
      expect(blocked).toBe(true);

      await callAppRpc(
        { profileUserId: adminProfileId },
        'public.reconcile_sync_run_publish_unknown',
        [real.runId],
      );

      const claimId = randomUUID();
      const claimed = await repository.claimSyncRun({
        runId: claimId,
        warehouseId,
        mode: 'dry_run',
        leaseDuration: 60,
        triggeredBy: adminProfileId,
        triggeredFrom: 'web',
        inputArtifactHash: 'after-reconcile',
      });
      expect(claimed).toBe(claimId);
    } finally {
      client.release();
    }
  });
});
