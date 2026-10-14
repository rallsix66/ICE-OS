import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import { externalTrackingRepository, P002_SYNC_RUNNER } from '@/features/in-transit/repository';

import { bootstrapPoolFromInstance, loadP002InstanceEnv, syncPoolFromEnv } from './helpers';

describe('P0-02 GoLucky sync event writes (repository + RLS)', () => {
  let bootstrap: Pool;
  let goluckyRefId: string;
  const eventPrefix = `evt-p0-02-${Date.now()}`;

  beforeAll(async () => {
    const { envJson } = loadP002InstanceEnv();
    process.env.P0_02_ENABLED = 'true';
    for (const [key, value] of Object.entries(envJson)) {
      process.env[key] = value;
    }
    bootstrap = bootstrapPoolFromInstance();
    const client = await bootstrap.connect();
    try {
      const ref = await client.query<{ id: string }>(
        `SELECT id::text FROM public.shipment_external_ref WHERE provider = 'golucky' LIMIT 1`,
      );
      goluckyRefId = ref.rows[0]?.id ?? '';
      if (!goluckyRefId) {
        throw new Error('fixture 缺少 golucky 外部引用');
      }
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    const client = await bootstrap.connect();
    try {
      await client.query(
        `DELETE FROM public.tracking_event_external
         WHERE external_event_id LIKE $1`,
        [`${eventPrefix}%`],
      );
    } finally {
      client.release();
      await bootstrap.end();
    }
  });

  it('repository inserts one event then skips duplicate', async () => {
    const eventId = `${eventPrefix}-1`;
    const payload = {
      externalEventId: eventId,
      externalCategory: 'in_transit',
      status: 'in_transit',
      description: 'P0-02 sync write probe',
      occurredAt: new Date().toISOString(),
      rawPayload: { probe: true },
    };
    const first = await externalTrackingRepository.upsertGoluckyEvents(
      goluckyRefId,
      'golucky',
      [payload],
      P002_SYNC_RUNNER,
    );
    expect(first.inserted).toBe(1);
    expect(first.skipped).toBe(0);

    const second = await externalTrackingRepository.upsertGoluckyEvents(
      goluckyRefId,
      'golucky',
      [payload],
      P002_SYNC_RUNNER,
    );
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(1);
  });

  it('rejects write without golucky sync scope', async () => {
    const pool = syncPoolFromEnv();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('p0_02.sync.mode', '', true)`);
      await client.query(`SELECT set_config('p0_02.sync.warehouse_id', '', true)`);
      await expect(
        client.query(
          `INSERT INTO public.tracking_event_external (
             external_ref_id, provider, external_event_id, external_category,
             status, description, occurred_at, raw_payload
           ) VALUES ($1, 'golucky', $2, 'in_transit', 'in_transit', 'x', now(), '{}'::jsonb)
           ON CONFLICT (external_ref_id, external_event_id) DO NOTHING
           RETURNING id`,
          [goluckyRefId, `${eventPrefix}-no-scope`],
        ),
      ).rejects.toThrow();
      await client.query('ROLLBACK');
    } finally {
      client.release();
      await pool.end();
    }
  });

  it('rejects disallowed provider via repository', async () => {
    await expect(
      externalTrackingRepository.upsertGoluckyEvents(
        goluckyRefId,
        'best',
        [
          {
            externalEventId: `${eventPrefix}-bad-provider`,
            externalCategory: 'in_transit',
            status: 'in_transit',
            description: 'should fail',
            occurredAt: new Date().toISOString(),
            rawPayload: {},
          },
        ],
        P002_SYNC_RUNNER,
      ),
    ).rejects.toThrow();
  });
});
