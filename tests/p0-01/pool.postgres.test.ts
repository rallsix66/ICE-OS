import { describe, expect, it, afterAll, beforeAll } from 'vitest';

import { closeP001AppPool, getP001AppPool } from '@/lib/independent-platform/p0-01-app-pool';
import { withIceTransaction } from '@/lib/independent-platform/p0-01-tx-context';
import { AuthorizationError } from '@/features/p0-01-access/authorization';

import { assertInstanceMarker, FIXTURE, loadInstanceEnv } from './helpers';

describe('P0-01 connection pool identity isolation (withIceTransaction)', () => {
  const env = loadInstanceEnv();

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

    await withIceTransaction({ iceUserId: FIXTURE.admin }, async (client) => {
      await assertInstanceMarker(client, env.runId);
    });
  });

  afterAll(async () => {
    await closeP001AppPool();
  });

  it('max=1 复用连接且 backend pid 一致、身份交替', async () => {
    process.env.P0_01_POOL_MAX = '1';
    await closeP001AppPool();

    const pids: number[] = [];
    const counts: number[] = [];

    for (const iceUserId of [FIXTURE.admin, FIXTURE.operator]) {
      await withIceTransaction({ iceUserId }, async (client) => {
        const pidRow = await client.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`);
        pids.push(Number(pidRow.rows[0]?.pid));
        const countRow = await client.query<{ c: number }>(
          `SELECT COUNT(*)::int AS c FROM p0_01_biz.inventory`,
        );
        counts.push(countRow.rows[0]?.c ?? 0);
      });
    }

    expect(pids[0]).toBeGreaterThan(0);
    expect(pids[0]).toBe(pids[1]);
    expect(counts).toEqual([3, 1]);
  });

  it('SQL 异常回滚后连接无身份残留', async () => {
    process.env.P0_01_POOL_MAX = '1';
    await closeP001AppPool();

    await expect(
      withIceTransaction({ iceUserId: FIXTURE.manager }, async (client) => {
        await client.query(`SELECT 1 / 0`);
      }),
    ).rejects.toThrow();

    const pool = getP001AppPool();
    const client = await pool.connect();
    try {
      const setting = await client.query<{ setting: string }>(
        `SELECT current_setting('ice.user_id', true) AS setting`,
      );
      expect(setting.rows[0]?.setting ?? '').toBe('');
      const count = await client.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM p0_01_biz.inventory`,
      );
      expect(count.rows[0]?.c).toBe(0);
    } finally {
      client.release();
    }
  });

  it('应用主动抛错后回滚且连接身份清空', async () => {
    process.env.P0_01_POOL_MAX = '1';
    await closeP001AppPool();

    await expect(
      withIceTransaction({ iceUserId: FIXTURE.operator }, async () => {
        throw new AuthorizationError('测试拒绝');
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);

    const pool = getP001AppPool();
    const client = await pool.connect();
    try {
      const setting = await client.query<{ setting: string }>(
        `SELECT current_setting('ice.user_id', true) AS setting`,
      );
      expect(setting.rows[0]?.setting ?? '').toBe('');
    } finally {
      client.release();
    }
  });

  it('max=2 并发事务互不串用', async () => {
    process.env.P0_01_POOL_MAX = '2';
    await closeP001AppPool();

    let ready = 0;
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    const runUser = async (iceUserId: string, expected: number) => {
      return withIceTransaction({ iceUserId }, async (client) => {
        ready += 1;
        if (ready === 2) {
          releaseGate();
        }
        await gate;
        const result = await client.query<{ c: number }>(
          `SELECT COUNT(*)::int AS c FROM p0_01_biz.inventory`,
        );
        expect(result.rows[0]?.c).toBe(expected);
        return result.rows[0]?.c as number;
      });
    };

    const [adminCount, operatorCount] = await Promise.all([
      runUser(FIXTURE.admin, 3),
      runUser(FIXTURE.operator, 1),
    ]);
    expect(adminCount).toBe(3);
    expect(operatorCount).toBe(1);
  });
});
