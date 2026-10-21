import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { Pool } from 'pg';
import { prepareBaseline } from '@/features/catalog/sources/baseline-adapter';
import { loadFrozenFeishu } from '@/features/catalog/sources/frozen-feishu-adapter';
import { ensureBsSampleExtract } from '@/features/catalog/sources/bs-sample-inventory-adapter';
import { prepareBsSampleImportPayload } from '@/features/catalog/local-display/service';

const ADMIN = '11111111-1111-4111-8111-111111111101';
const runRoot = process.env.CATALOG_RUN_ROOT!;
const app = new Pool({ connectionString: process.env.P0_02_APP_DATABASE_URL, max: 2 });
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function rpc<T>(name: string, values: unknown[]): Promise<T> {
  const client = await app.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`, [ADMIN]);
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

export async function seedDisplayForTests() {
  const client = await app.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`, [ADMIN]);
    const existing = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM catalog.catalog_item`);
    await client.query('COMMIT');
    if (existing.rows[0]?.n === 126) return;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  const baseline = await prepareBaseline();
  await rpc('publish_baseline', [randomUUID(), hash(baseline.contentSha256), JSON.stringify(baseline)]);
  const frozen = await loadFrozenFeishu();
  await rpc('import_frozen_observations', [randomUUID(), hash(frozen.contentSha256), JSON.stringify(frozen)]);
  const extracted = path.join(runRoot, 'bs-sample-inventory.extracted.json');
  await ensureBsSampleExtract(extracted);
  const bsPayload = await prepareBsSampleImportPayload(extracted);
  await rpc('import_bs_sample_inventory', [randomUUID(), hash(bsPayload.contentSha256), JSON.stringify(bsPayload)]);
}
