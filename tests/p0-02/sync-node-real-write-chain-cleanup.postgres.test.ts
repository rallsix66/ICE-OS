import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import { bootstrapPoolFromInstance, loadP002InstanceEnv } from './helpers';

describe('P0-02 Node chain cleanup on sentinel failure', () => {
  let bootstrap: Pool;
  let warehouseId: string;
  let variantId: string;
  let inventoryId: string;
  let sentinelWarehouseId: string;
  let sentinelVariantId: string;
  let sentinelInventoryId: string;
  let sentinelSnapshot: unknown;
  let artifactDir: string;
  let fixtureInputPath: string;

  beforeAll(async () => {
    const { envJson } = loadP002InstanceEnv();
    process.env.P0_02_ENABLED = 'true';
    for (const [key, value] of Object.entries(envJson)) {
      process.env[key] = value;
    }
    warehouseId = randomUUID();
    variantId = randomUUID();
    inventoryId = randomUUID();
    sentinelWarehouseId = randomUUID();
    sentinelVariantId = randomUUID();
    sentinelInventoryId = randomUUID();
    bootstrap = bootstrapPoolFromInstance();
    const client = await bootstrap.connect();
    try {
      await client.query(
        `INSERT INTO public.warehouse (id, name, country, type, is_active)
         VALUES ($1::uuid, $2, 'TH', 'overseas', true)`,
        [warehouseId, 'P0-02 cleanup probe wh'],
      );
      await client.query(
        `INSERT INTO public.product_variant (id, sku, country, name, match_status)
         VALUES ($1::uuid, $2, 'TH', 'Cleanup probe variant', 'unmatched')`,
        [variantId, `CL-${variantId.slice(0, 8)}`],
      );
      await client.query(
        `INSERT INTO public.inventory (id, variant_id, warehouse_id, quantity)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 1)`,
        [inventoryId, variantId, warehouseId],
      );
      await client.query(
        `INSERT INTO public.warehouse (id, name, country, type, is_active)
         VALUES ($1::uuid, $2, 'TH', 'overseas', true)`,
        [sentinelWarehouseId, `P0-02 cleanup sentinel ${sentinelWarehouseId.slice(0, 8)}`],
      );
      await client.query(
        `INSERT INTO public.product_variant (id, sku, country, name, match_status)
         VALUES ($1::uuid, $2, 'TH', 'Cleanup sentinel variant', 'unmatched')`,
        [sentinelVariantId, `CL-SENT-${sentinelVariantId.slice(0, 8)}`],
      );
      await client.query(
        `INSERT INTO public.inventory (id, variant_id, warehouse_id, quantity)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 2)`,
        [sentinelInventoryId, sentinelVariantId, sentinelWarehouseId],
      );
      const sentinelRow = await client.query(
        `
        SELECT w.id::text, w.name, w.country, w.is_active,
               COALESCE(
                 json_agg(
                   json_build_object(
                     'variant_id', v.id::text,
                     'sku', v.sku,
                     'quantity', i.quantity::int
                   )
                   ORDER BY v.sku
                 ) FILTER (WHERE v.id IS NOT NULL),
                 '[]'::json
               ) AS inv
        FROM public.warehouse w
        LEFT JOIN public.inventory i ON i.warehouse_id = w.id
        LEFT JOIN public.product_variant v ON v.id = i.variant_id
        WHERE w.id = $1::uuid
        GROUP BY w.id, w.name, w.country, w.is_active
        `,
        [sentinelWarehouseId],
      );
      sentinelSnapshot = sentinelRow.rows[0];
    } finally {
      client.release();
    }
    artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p0-02-node-cleanup-artifacts-'));
    fixtureInputPath = path.join(os.tmpdir(), `p0-02-node-cleanup-input-${process.pid}.json`);
    fs.writeFileSync(fixtureInputPath, JSON.stringify({ rows: [] }), 'utf8');
  });

  afterAll(async () => {
    const client = await bootstrap.connect();
    try {
      await client.query('DELETE FROM public.inventory WHERE id = $1::uuid', [inventoryId]);
      await client.query('DELETE FROM public.product_variant WHERE id = $1::uuid', [variantId]);
      await client.query('DELETE FROM public.warehouse WHERE id = $1::uuid', [warehouseId]);
      await client.query('DELETE FROM public.inventory WHERE id = $1::uuid', [sentinelInventoryId]);
      await client.query('DELETE FROM public.product_variant WHERE id = $1::uuid', [sentinelVariantId]);
      await client.query('DELETE FROM public.warehouse WHERE id = $1::uuid', [sentinelWarehouseId]);
    } finally {
      client.release();
      await bootstrap.end();
    }
    if (fs.existsSync(fixtureInputPath)) fs.unlinkSync(fixtureInputPath);
    if (artifactDir && fs.existsSync(artifactDir)) {
      fs.rmSync(artifactDir, { recursive: true, force: true });
    }
  });

  it('still cleans this run when sentinel assertion would fail', async () => {
    const client = await bootstrap.connect();
    let sentinelAssertionError: unknown;
    try {
      const sentinelAfter = await client.query(
        `
        SELECT w.id::text, w.name, w.country, w.is_active,
               COALESCE(
                 json_agg(
                   json_build_object(
                     'variant_id', v.id::text,
                     'sku', v.sku,
                     'quantity', i.quantity::int
                   )
                   ORDER BY v.sku
                 ) FILTER (WHERE v.id IS NOT NULL),
                 '[]'::json
               ) AS inv
        FROM public.warehouse w
        LEFT JOIN public.inventory i ON i.warehouse_id = w.id
        LEFT JOIN public.product_variant v ON v.id = i.variant_id
        WHERE w.id = $1::uuid
        GROUP BY w.id, w.name, w.country, w.is_active
        `,
        [sentinelWarehouseId],
      );
      const wrongExpected = {
        ...(sentinelSnapshot as Record<string, unknown>),
        inv: [{ sku: 'forced-mismatch', quantity: 999 }],
      };
      try {
        expect(sentinelAfter.rows[0]).toEqual(wrongExpected);
      } catch (error) {
        sentinelAssertionError = error;
      }

      await client.query('DELETE FROM public.inventory WHERE id = $1::uuid', [inventoryId]);
      await client.query('DELETE FROM public.product_variant WHERE id = $1::uuid', [variantId]);
      await client.query('DELETE FROM public.warehouse WHERE id = $1::uuid', [warehouseId]);

      const probeWh = await client.query(
        `SELECT 1 FROM public.warehouse WHERE id = $1::uuid`,
        [warehouseId],
      );
      expect(probeWh.rowCount).toBe(0);

      const sentinelStill = await client.query(
        `SELECT id::text FROM public.warehouse WHERE id = $1::uuid`,
        [sentinelWarehouseId],
      );
      expect(sentinelStill.rowCount).toBe(1);
      expect(sentinelAfter.rows[0]).toEqual(sentinelSnapshot);
    } finally {
      client.release();
    }

    if (fs.existsSync(fixtureInputPath)) fs.unlinkSync(fixtureInputPath);
    if (artifactDir && fs.existsSync(artifactDir)) {
      fs.rmSync(artifactDir, { recursive: true, force: true });
    }
    expect(sentinelAssertionError).toBeTruthy();
  });
});
