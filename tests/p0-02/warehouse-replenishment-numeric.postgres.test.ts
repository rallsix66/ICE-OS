import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';

import { WarehouseError, warehouseRepository } from '@/features/warehouse/repository';

import { appPoolFromEnv, bootstrapPoolFromInstance, loadP002InstanceEnv } from './helpers';

type StoredParams = {
  buffer_ratio: string;
  target_cover_multiplier: string;
};

async function readWarehouseParams(client: PoolClient, warehouseId: string): Promise<StoredParams> {
  const row = await client.query<StoredParams>(
    `SELECT buffer_ratio::text, target_cover_multiplier::text
     FROM public.warehouse WHERE id = $1::uuid`,
    [warehouseId],
  );
  if (!row.rows[0]) {
    throw new Error('replenishment fixture warehouse missing');
  }
  return row.rows[0];
}

describe('P0-02 warehouse replenishment numeric DTO', () => {
  let appPool: Pool;
  let bootstrapPool: Pool;
  let adminProfileId: string;
  let operatorProfileId: string;
  let replWarehouseId: string;
  let baseline: StoredParams;

  beforeAll(async () => {
    replWarehouseId = randomUUID();
    const { envJson } = loadP002InstanceEnv();
    process.env.P0_02_ENABLED = 'true';
    for (const [key, value] of Object.entries(envJson)) {
      process.env[key] = value;
    }
    appPool = appPoolFromEnv();
    bootstrapPool = bootstrapPoolFromInstance();

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

      await client.query(
        `INSERT INTO public.warehouse (
           id, name, country, type, is_active, buffer_ratio, target_cover_multiplier
         ) VALUES ($1::uuid, $2, 'XX', 'overseas', true, 1.0, 1.0)`,
        [replWarehouseId, `P0-02 Repl Numeric ${replWarehouseId.slice(0, 8)}`],
      );
      baseline = await readWarehouseParams(client, replWarehouseId);
    } finally {
      client.release();
      await bootstrap.end();
    }
  });

  afterAll(async () => {
    const bootstrap = bootstrapPoolFromInstance();
    const client = await bootstrap.connect();
    try {
      await client.query(`DELETE FROM public.warehouse WHERE id = $1::uuid`, [replWarehouseId]);
    } finally {
      client.release();
      await bootstrap.end();
    }
    await appPool.end();
    await bootstrapPool.end();
  });

  it('list returns finite number bufferRatio and targetCoverMultiplier', async () => {
    const list = await warehouseRepository.listReplenishmentParams({
      profileUserId: adminProfileId,
    });
    const item = list.find((w) => w.id === replWarehouseId);
    expect(item).toBeDefined();
    expect(typeof item!.bufferRatio).toBe('number');
    expect(typeof item!.targetCoverMultiplier).toBe('number');
    expect(Number.isFinite(item!.bufferRatio)).toBe(true);
    expect(Number.isFinite(item!.targetCoverMultiplier)).toBe(true);
  });

  it('admin update accepts decimal ratios and persists', async () => {
    const bufferRatio = 1.25;
    const targetCoverMultiplier = 2.375;

    const updated = await warehouseRepository.updateReplenishmentParams(
      replWarehouseId,
      bufferRatio,
      targetCoverMultiplier,
      { profileUserId: adminProfileId },
    );
    expect(updated.bufferRatio).toBeCloseTo(bufferRatio, 6);
    expect(updated.targetCoverMultiplier).toBeCloseTo(targetCoverMultiplier, 6);

    const bootstrap = bootstrapPoolFromInstance();
    const client = await bootstrap.connect();
    try {
      const stored = await readWarehouseParams(client, replWarehouseId);
      expect(Number(stored.buffer_ratio)).toBeCloseTo(bufferRatio, 6);
      expect(Number(stored.target_cover_multiplier)).toBeCloseTo(targetCoverMultiplier, 6);
    } finally {
      client.release();
      await bootstrap.end();
    }
  });

  it('failed update does not mutate warehouse row', async () => {
    const beforeClient = await bootstrapPoolFromInstance().connect();
    let before: StoredParams;
    try {
      before = await readWarehouseParams(beforeClient, replWarehouseId);
    } finally {
      beforeClient.release();
    }

    const bogusId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa99';
    await expect(
      warehouseRepository.updateReplenishmentParams(
        bogusId,
        9.99,
        9.99,
        { profileUserId: adminProfileId },
      ),
    ).rejects.toThrow(WarehouseError);

    const afterClient = await bootstrapPoolFromInstance().connect();
    try {
      const after = await readWarehouseParams(afterClient, replWarehouseId);
      expect(after.buffer_ratio).toBe(before.buffer_ratio);
      expect(after.target_cover_multiplier).toBe(before.target_cover_multiplier);
    } finally {
      afterClient.release();
    }
  });

  it('operator cannot update replenishment params (RLS)', async () => {
    await expect(
      warehouseRepository.updateReplenishmentParams(
        replWarehouseId,
        1.5,
        1.5,
        { profileUserId: operatorProfileId },
      ),
    ).rejects.toThrow(WarehouseError);
  });
});
