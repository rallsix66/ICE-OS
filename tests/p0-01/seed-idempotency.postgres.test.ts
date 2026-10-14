import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import { Pool } from 'pg';

import { assertInstanceMarker, createAppPool, FIXTURE, loadInstanceEnv } from './helpers';

describe('P0-01 seed / prepare idempotency (PostgreSQL)', () => {
  const env = loadInstanceEnv();
  let pool: Pool;
  let bootstrap: Pool;

  beforeAll(async () => {
    process.env.P0_01_ENABLED = 'true';
    process.env.P0_01_RUN_ID = env.runId;
    process.env.P0_01_APP_DATABASE_URL = env.appUrl;
    process.env.P0_01_AUTH_DATABASE_URL = env.authUrl;
    process.env.P0_01_BETTER_AUTH_SECRET = 'test-secret-not-used-in-db-tests-0123456789';
    process.env.P0_01_BETTER_AUTH_URL = 'http://127.0.0.1:3000';
    process.env.P0_01_POOL_MAX = '1';
    process.env.P0_01_EXPECTED_HOST = env.host;
    process.env.P0_01_EXPECTED_PORT = String(env.port);
    process.env.P0_01_EXPECTED_DATABASE = env.dbName;
    process.env.P0_01_EXPECTED_APP_USER = env.appRunnerUser;
    process.env.P0_01_EXPECTED_AUTH_USER = env.authRunnerUser;

    pool = createAppPool(1);
    bootstrap = new Pool({
      connectionString: `postgres://postgres:${env.bootstrapPassword}@${env.host}:${env.port}/${env.dbName}`,
      max: 1,
    });
    const client = await pool.connect();
    try {
      await assertInstanceMarker(client, env.runId);
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await bootstrap.end();
    await pool.end();
  });

  function runSeed() {
    const result = spawnSync(process.execPath, [path.join(process.cwd(), 'scripts', 'p0-01', 'seed.mjs')], {
      env: { ...process.env, P0_01_RUN_ID: env.runId },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
  }

  it('重复 seed 不恢复已撤销的仓库/市场/金额授权', async () => {
    await bootstrap.query(`DELETE FROM p0_01_biz.user_warehouse_grants WHERE user_id = $1`, [FIXTURE.operator]);
    await bootstrap.query(`DELETE FROM p0_01_biz.user_market_grants WHERE user_id = $1`, [FIXTURE.managerNoAmount]);
    await bootstrap.query(`DELETE FROM p0_01_biz.user_amount_grants WHERE user_id = $1`, [FIXTURE.manager]);
    await bootstrap.query(`UPDATE p0_01_biz.ice_users SET is_enabled = false WHERE id = $1`, [FIXTURE.managerNoAmount]);

    runSeed();
    runSeed();

    const wh = await bootstrap.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM p0_01_biz.user_warehouse_grants WHERE user_id = $1`,
      [FIXTURE.operator],
    );
    const market = await bootstrap.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM p0_01_biz.user_market_grants WHERE user_id = $1`,
      [FIXTURE.managerNoAmount],
    );
    const amount = await bootstrap.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM p0_01_biz.user_amount_grants WHERE user_id = $1`,
      [FIXTURE.manager],
    );
    const disabled = await bootstrap.query<{ is_enabled: boolean }>(
      `SELECT is_enabled FROM p0_01_biz.ice_users WHERE id = $1`,
      [FIXTURE.managerNoAmount],
    );

    expect(wh.rows[0]?.c).toBe(0);
    expect(market.rows[0]?.c).toBe(0);
    expect(amount.rows[0]?.c).toBe(0);
    expect(disabled.rows[0]?.is_enabled).toBe(false);
  });
});
