import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import { createSyncService } from '@/features/sync/sync-service';
import { FileSystemArtifactProvider } from '@/features/sync/file-system-artifact-provider';
import { PostgresSyncRepository } from '@/features/sync/postgres-sync-repository';
import { RealSyncRunner } from '@/features/sync/real-sync-runner';

import { bootstrapPoolFromInstance, loadP002InstanceEnv } from './helpers';

const adminProfileId = '11111111-1111-4111-8111-111111111101';
const CONFIRM_TOKEN = 'P5-SY8D-TH';

describe('P0-02 Node claim → bridge → real_write chain', () => {
  let bootstrap: Pool;
  let warehouseId: string;
  let decoyWarehouseId: string;
  let prefixSentinelWarehouseId: string;
  let prefixSentinelInventoryId: string;
  let prefixSentinelVariantId: string;
  let variantId: string;
  let inventoryId: string;
  let sku: string;
  let artifactDir: string;
  let fixtureInputPath: string;

  beforeAll(async () => {
    const { envJson } = loadP002InstanceEnv();
    process.env.P0_02_ENABLED = 'true';
    for (const [key, value] of Object.entries(envJson)) {
      process.env[key] = value;
    }
    process.env.BS_WAREHOUSE_COUNTRY = 'TH';
    process.env.BS_TARGET_WAREHOUSE_NAME = 'P0-02 node chain wh';
    process.env.BS_OLD_WAREHOUSE_NAME = 'P0-02 node chain wh';
    process.env.BS_NEW_VARIANT_COUNTRY = 'TH';

    warehouseId = randomUUID();
    variantId = randomUUID();
    inventoryId = randomUUID();
    sku = `NC-${variantId.slice(0, 8)}`;

    bootstrap = bootstrapPoolFromInstance();
    const client = await bootstrap.connect();
    try {
      prefixSentinelWarehouseId = randomUUID();
      prefixSentinelVariantId = randomUUID();
      prefixSentinelInventoryId = randomUUID();
      await client.query(
        `INSERT INTO public.warehouse (id, name, country, type, is_active)
         VALUES ($1::uuid, $2, 'TH', 'overseas', true)`,
        [warehouseId, 'P0-02 node chain wh'],
      );
      await client.query(
        `INSERT INTO public.product_variant (id, sku, country, name, match_status)
         VALUES ($1::uuid, $2, 'TH', 'Node chain variant', 'unmatched')`,
        [variantId, sku],
      );
      await client.query(
        `INSERT INTO public.inventory (id, variant_id, warehouse_id, quantity)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 4)`,
        [inventoryId, variantId, warehouseId],
      );
      await client.query(
        `INSERT INTO public.sync_warehouse_lock (warehouse_id) VALUES ($1::uuid)
         ON CONFLICT (warehouse_id) DO NOTHING`,
        [warehouseId],
      );
      // 同国家第二活跃仓：bridge 必须按目标 UUID 而非“唯一 TH 仓”解析
      decoyWarehouseId = randomUUID();
      await client.query(
        `INSERT INTO public.warehouse (id, name, country, type, is_active)
         VALUES ($1::uuid, $2, 'TH', 'overseas', true)
         ON CONFLICT (id) DO NOTHING`,
        [decoyWarehouseId, `P0-02 node chain decoy ${decoyWarehouseId.slice(0, 8)}`],
      );
      await client.query(
        `INSERT INTO public.warehouse (id, name, country, type, is_active)
         VALUES ($1::uuid, $2, 'TH', 'overseas', true)
         ON CONFLICT (id) DO NOTHING`,
        [
          prefixSentinelWarehouseId,
          `P0-02 node chain decoy sentinel ${prefixSentinelWarehouseId.slice(0, 8)}`,
        ],
      );
      await client.query(
        `INSERT INTO public.product_variant (id, sku, country, name, match_status)
         VALUES ($1::uuid, $2, 'TH', 'Prefix sentinel variant', 'unmatched')`,
        [prefixSentinelVariantId, `NC-SENT-${prefixSentinelVariantId.slice(0, 8)}`],
      );
      await client.query(
        `INSERT INTO public.inventory (id, variant_id, warehouse_id, quantity)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 2)`,
        [prefixSentinelInventoryId, prefixSentinelVariantId, prefixSentinelWarehouseId],
      );
    } finally {
      client.release();
    }

    artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p0-02-node-chain-artifacts-'));
    fixtureInputPath = path.join(os.tmpdir(), `p0-02-node-chain-input-${process.pid}.json`);
    fs.writeFileSync(
      fixtureInputPath,
      JSON.stringify({
        rows: [{ sku, product_name: 'Node chain variant', available_quantity: 8 }],
        metadata: { raw_row_count: 1, valid_sku_count: 1, invalid_sku_count: 0 },
      }),
      'utf8',
    );
    process.env.P0_02_FIXTURE_INPUT_PATH = fixtureInputPath;
  });

  afterAll(async () => {
    const client = await bootstrap.connect();
    try {
      await client.query('DELETE FROM public.sync_log WHERE warehouse_id = $1::uuid', [warehouseId]);
      await client.query('DELETE FROM public.sync_run WHERE warehouse_id = $1::uuid', [warehouseId]);
      await client.query('DELETE FROM public.inventory WHERE warehouse_id = $1::uuid', [warehouseId]);
      await client.query('DELETE FROM public.product_variant WHERE id = $1::uuid', [variantId]);
      await client.query('DELETE FROM public.sync_warehouse_lock WHERE warehouse_id = $1::uuid', [warehouseId]);
      await client.query('DELETE FROM public.warehouse WHERE id = $1::uuid', [warehouseId]);
      await client.query('DELETE FROM public.warehouse WHERE id = $1::uuid', [decoyWarehouseId]);
      await client.query('DELETE FROM public.inventory WHERE id = $1::uuid', [
        prefixSentinelInventoryId,
      ]);
      await client.query('DELETE FROM public.product_variant WHERE id = $1::uuid', [
        prefixSentinelVariantId,
      ]);
      await client.query('DELETE FROM public.warehouse WHERE id = $1::uuid', [
        prefixSentinelWarehouseId,
      ]);
    } finally {
      client.release();
      await bootstrap.end();
    }
    if (fs.existsSync(fixtureInputPath)) fs.unlinkSync(fixtureInputPath);
    if (artifactDir && fs.existsSync(artifactDir)) {
      fs.rmSync(artifactDir, { recursive: true, force: true });
    }
    delete process.env.P0_02_FIXTURE_INPUT_PATH;
  });

  it('runs dry_run then real_write through SyncService and RealSyncRunner', async () => {
    const repository = new PostgresSyncRepository({ profileUserId: adminProfileId });
    const artifactProvider = new FileSystemArtifactProvider(artifactDir);
    const runner = new RealSyncRunner([
      {
        id: warehouseId,
        name: 'P0-02 node chain wh',
        oldName: 'P0-02 node chain wh',
        country: 'TH',
        token: CONFIRM_TOKEN,
      },
    ]);
    const service = createSyncService({ repository, artifactProvider, runner });

    const dry = await service.executeSync({
      mode: 'dry_run',
      warehouseId,
      triggeredBy: adminProfileId,
      inputArtifact: { source: 'p0-02-node-chain-fixture', sku, targetQty: 8 },
    });
    expect(dry.status).toBe('completed');
    expect(dry.runId).toBeTruthy();

    const real = await service.executeSync({
      mode: 'real_write',
      warehouseId,
      triggeredBy: adminProfileId,
      dryRunRunId: dry.runId!,
      confirmToken: CONFIRM_TOKEN,
      inputArtifact: { source: 'p0-02-node-chain-fixture', sku, targetQty: 8 },
    });
    expect(real.status).toBe('completed');

    const client = await bootstrap.connect();
    try {
      const inv = await client.query<{ quantity: string }>(
        'SELECT quantity::text FROM public.inventory WHERE id = $1::uuid',
        [inventoryId],
      );
      expect(Number(inv.rows[0]?.quantity)).toBe(8);
      const log = await client.query<{ status: string; sync_run_id: string }>(
        `SELECT status, sync_run_id::text FROM public.sync_log
         WHERE warehouse_id = $1::uuid AND sync_run_id = $2::uuid
         ORDER BY finished_at DESC NULLS LAST LIMIT 1`,
        [warehouseId, real.runId],
      );
      expect(log.rows[0]?.status).toBe('success');
    } finally {
      client.release();
    }
  }, 120_000);
});
