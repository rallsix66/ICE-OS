import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { catalogRepository } from '@/features/catalog/repository';
import { basisDocumentSha256, buildCatalogDisplayOverview } from '@/features/catalog/local-display/service';
import { coverageForWarehouseFilter } from '@/features/catalog/local-display/client-scope';
import { seedDisplayForTests } from './local-preview-seed-helper';

const ADMIN = '11111111-1111-4111-8111-111111111101';
const DENIED = '11111111-1111-4111-8111-111111111199';
const identity = { profileUserId: ADMIN };
const app = new Pool({ connectionString: process.env.P0_02_APP_DATABASE_URL, max: 2 });

async function rpc<T>(actor: string, name: string, values: unknown[]): Promise<T> {
  const client = await app.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`, [actor]);
    const args = values.map((_, i) => `$${i + 1}`).join(',');
    const result = await client.query<{ result: T }>(`SELECT catalog.${name}(${args}) AS result`, values);
    await client.query('COMMIT');
    return result.rows[0]!.result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

describe('local preview display read path', () => {
  it('reads inventory via repository RPC and builds 126-row overview', async () => {
    await seedDisplayForTests();
    const rows = await catalogRepository.allBsSampleRows(identity);
    expect(rows.length).toBe(530);
    expect(rows.some((r) => r.orderLocked !== undefined && r.inTransit !== undefined)).toBe(true);
    const overview = await buildCatalogDisplayOverview(identity, { amountAllowed: true });
    expect(overview).not.toBeNull();
    expect(overview!.rows.length).toBe(126);
    expect(overview!.coverage.bsConfirmedLines).toBe(430);
    const basis = await basisDocumentSha256();
    expect(overview!.basisDocumentSha256).toBe(basis);
    const wm0072 = overview!.rows.find((r) => r.item.iceCode === 'WM0072');
    const wm0072Adopted = wm0072?.adoptedUnitCost;
    expect(wm0072Adopted?.state).toBe('priced');
    if (wm0072Adopted?.state !== 'priced') throw new Error('WM0072 must carry a priced adopted unit cost');
    expect(wm0072Adopted.amountCny).toBe('5.18');
    const valued = overview!.rows.find((r) => r.bsSample.valuationState === 'valued');
    expect(valued?.bsSample.estimatedValueCny).toMatch(/^\d+(\.\d+)?$/);
    const scoped = wm0072?.bsSample.warehouseScopes;
    expect(scoped && Object.keys(scoped).length > 0).toBe(true);
    const wh = overview!.warehouseOptions[0]!;
    const whCoverage = coverageForWarehouseFilter(overview!, wh);
    expect(whCoverage.valuedItemCount).toBeLessThanOrEqual(overview!.coverage.valuedItemCount);
    expect(whCoverage.bsConfirmedLines).toBeLessThanOrEqual(overview!.coverage.bsConfirmedLines);
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`, [ADMIN]);
      await expect(client.query('SELECT count(*) FROM catalog.bs_sample_inventory_row')).rejects.toMatchObject({ code: '42501' });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    await expect(rpc(DENIED, 'read_bs_sample_inventory_rows', [])).rejects.toMatchObject({ code: '42501' });
    const first = await catalogRepository.list(identity, { baselinePublishedOnly: true });
    const second = await catalogRepository.list(identity, { baselinePublishedOnly: true });
    expect(first.map((i) => i.itemId).sort()).toEqual(second.map((i) => i.itemId).sort());
    const wm = first.find((i) => i.iceCode === 'WM0072')!;
    const again = (await catalogRepository.list(identity, { baselinePublishedOnly: true })).find((i) => i.iceCode === 'WM0072')!;
    expect(again.itemId).toBe(wm.itemId);
  }, 600_000);
});
