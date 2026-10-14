import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import { productOverviewRepository } from '@/features/product-overview/repository';
import { replenishmentRepository } from '@/features/replenishment/repository';

import { appPoolFromEnv, bootstrapPoolFromInstance, hasFunctionPrivilege, loadP002InstanceEnv } from './helpers';

describe('P0-02 RPC dependency ACL (forecast_stockout)', () => {
  let appPool: Pool;
  let adminProfileId: string;
  let appUser: string;
  let syncUser: string;

  beforeAll(async () => {
    const { envJson, instance } = loadP002InstanceEnv();
    syncUser = instance.syncRunnerUser;
    process.env.P0_02_ENABLED = 'true';
    for (const [key, value] of Object.entries(envJson)) {
      process.env[key] = value;
    }
    appUser = instance.appRunnerUser;
    appPool = appPoolFromEnv();
    const bootstrap = bootstrapPoolFromInstance();
    const client = await bootstrap.connect();
    try {
      const map = await client.query<{ ice_user_id: string }>(
        `SELECT m.ice_user_id::text
         FROM p0_02_meta.ice_auth_user_map m
         JOIN profiles p ON p.id = m.ice_user_id
         JOIN role r ON r.id = p.role_id AND r.name = 'admin'
         LIMIT 1`,
      );
      adminProfileId = map.rows[0]!.ice_user_id;
    } finally {
      client.release();
      await bootstrap.end();
    }
  });

  afterAll(async () => {
    await appPool.end();
  });

  it('app runner has execute on forecast_stockout only', async () => {
    const client = await appPool.connect();
    try {
      expect(
        await hasFunctionPrivilege(
          client,
          appUser,
          'public.forecast_stockout(integer,numeric,integer,jsonb)',
        ),
      ).toBe(true);
      expect(
        await hasFunctionPrivilege(
          client,
          syncUser,
          'public.forecast_stockout(integer,numeric,integer,jsonb)',
        ),
      ).toBe(false);
    } finally {
      client.release();
    }
  });

  it('product overview, variant detail and replenishment succeed with fixtures', async () => {
    const overview = await productOverviewRepository.getProductOverview(adminProfileId, {
      page: 1,
      pageSize: 20,
    });
    expect(overview.totalCount).toBeGreaterThanOrEqual(0);

    const bootstrap = bootstrapPoolFromInstance();
    const client = await bootstrap.connect();
    let variantId: string | null = null;
    try {
      const row = await client.query<{ id: string }>(
        `SELECT id::text FROM public.product_variant ORDER BY created_at LIMIT 1`,
      );
      variantId = row.rows[0]?.id ?? null;
    } finally {
      client.release();
      await bootstrap.end();
    }
    if (!variantId) {
      throw new Error('fixture 缺少 product_variant');
    }

    const detail = await productOverviewRepository.getProductVariantDetail(adminProfileId, variantId);
    expect(detail.variantId).toBe(variantId);

    const replenishment = await replenishmentRepository.getSuggestions(adminProfileId, {
      page: 1,
      pageSize: 20,
      includeZero: false,
    });
    expect(replenishment.total).toBeGreaterThanOrEqual(0);
  });
});
