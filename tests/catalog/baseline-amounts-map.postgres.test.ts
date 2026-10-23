import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

const ADMIN = '11111111-1111-4111-8111-111111111101';
const OPERATOR = '11111111-1111-4111-8111-111111111104';
const INACTIVE_ADMIN = '11111111-1111-4111-8111-111111111106';
const NON_EXISTENT = '99999999-9999-4999-8999-999999999999';

const databaseUrl = process.env.P0_02_APP_DATABASE_URL;

async function withIdentity<T>(userId: string | null, fn: (client: import('pg').PoolClient) => Promise<T>) {
  if (!databaseUrl) throw new Error('P0_02_APP_DATABASE_URL is required for postgres catalog tests');
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (userId) await client.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`, [userId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

describe.skipIf(!databaseUrl)('baseline amounts map on prepared preview database', () => {
  it('matches per-item amounts and rejects unauthorized identities', async () => {
    const fixtures = await withIdentity(ADMIN, async (c) => {
      const profiles = await c.query(
        `SELECT p.id, r.name AS role, p.is_active
         FROM public.profiles p
         JOIN public.role r ON r.id = p.role_id
         WHERE p.id = ANY($1::uuid[])
         ORDER BY p.id`,
        [[ADMIN, OPERATOR, INACTIVE_ADMIN]],
      );
      expect(profiles.rows).toEqual([
        expect.objectContaining({ id: ADMIN, role: 'admin', is_active: true }),
        expect.objectContaining({ id: OPERATOR, role: 'operator', is_active: true }),
        expect.objectContaining({ id: INACTIVE_ADMIN, role: 'admin', is_active: false }),
      ]);
      const baselineCount = await c.query(
        `SELECT count(*)::int AS n FROM catalog.catalog_item WHERE first_release_id IS NOT NULL`,
      );
      expect(baselineCount.rows[0].n).toBe(126);
      const wm0072 = await c.query(
        `SELECT i.id
         FROM catalog.catalog_item i
         JOIN catalog.catalog_item_code c ON c.item_id = i.id
         WHERE c.ice_code = 'WM0072' AND i.first_release_id IS NOT NULL
         LIMIT 1`,
      );
      expect(wm0072.rowCount).toBe(1);
      return { wm0072Id: wm0072.rows[0].id as string };
    });

    const batchMap = await withIdentity(ADMIN, async (c) => (await c.query('SELECT catalog.read_baseline_item_amounts_map() AS payload')).rows[0].payload as Record<string, unknown>);
    const itemIds = await withIdentity(ADMIN, async (c) => (await c.query(`SELECT id FROM catalog.catalog_item WHERE first_release_id IS NOT NULL ORDER BY id`)).rows.map((r: { id: string }) => r.id));
    expect(itemIds).toHaveLength(126);

    for (const id of itemIds) {
      const perItem = await withIdentity(ADMIN, async (c) => (await c.query('SELECT catalog.read_item_amounts($1) AS payload', [id])).rows[0].payload);
      const fromBatch = Object.prototype.hasOwnProperty.call(batchMap, id) ? batchMap[id] : null;
      expect(fromBatch ?? null).toEqual(perItem ?? null);
    }

    const wm0072Amounts = await withIdentity(ADMIN, async (c) => (await c.query('SELECT catalog.read_item_amounts($1) AS payload', [fixtures.wm0072Id])).rows[0].payload as { cost?: { raw?: string } });
    expect(wm0072Amounts?.cost?.raw).toBe('5.18');

    for (const actor of [null, OPERATOR, INACTIVE_ADMIN, NON_EXISTENT]) {
      await expect(withIdentity(actor, (c) => c.query('SELECT catalog.read_baseline_item_amounts_map()'))).rejects.toMatchObject({ code: '42501' });
    }
  }, 120_000);
});

describe('baseline amounts map postgres gate', () => {
  it('fails the suite entry when database URL is missing', () => {
    if (databaseUrl) return;
    expect(databaseUrl).toBeTruthy();
  });
});
