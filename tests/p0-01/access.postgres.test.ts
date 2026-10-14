import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import { Pool } from 'pg';

import {
  assertP001DatabaseUrlMatches,
  parseP001PostgresUrl,
} from '@/lib/independent-platform/p0-01-database-url';

import { AuthorizationError } from '@/features/p0-01-access/authorization';
import { getInventoryForUser } from '@/features/p0-01-access/inventory-service';

import {
  assertInstanceMarker,
  createAppPool,
  FIXTURE,
  loadInstanceEnv,
  withIdentity,
} from './helpers';

const operatorUser = {
  iceUserId: FIXTURE.operator,
  email: 'operator@p0-01.test',
  displayName: 'Operator User',
  role: 'operator' as const,
  isEnabled: true,
};

const managerUser = {
  iceUserId: FIXTURE.manager,
  email: 'manager@p0-01.test',
  displayName: 'Manager User',
  role: 'manager' as const,
  isEnabled: true,
};

describe('P0-01 PostgreSQL RLS and amount isolation', () => {
  const env = loadInstanceEnv();
  let pool: Pool;

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
    const client = await pool.connect();
    try {
      await assertInstanceMarker(client, env.runId);
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  it('连接 URL 精确匹配实例（非 includes）', () => {
    assertP001DatabaseUrlMatches(
      env.appUrl,
      {
        host: env.host,
        port: env.port,
        database: env.dbName,
        user: env.appRunnerUser,
      },
      'P0_01_APP_DATABASE_URL',
    );
    expect(() =>
      parseP001PostgresUrl(
        'postgres://ice_p0_01_app_runner:secret@remote.example.invalid:5432/iceos_p0_01_test',
        'remote',
      ),
    ).toThrow();
  });

  it('admin 仅能在授权交集内看到库存行', async () => {
    const client = await pool.connect();
    try {
      const rows = await withIdentity(client, FIXTURE.admin, async () => {
        const result = await client.query<{ warehouse_code: string }>(
          `SELECT w.code AS warehouse_code
           FROM p0_01_biz.inventory i
           INNER JOIN p0_01_biz.warehouses w ON w.id = i.warehouse_id
           ORDER BY w.code`,
        );
        return result.rows.map((r) => r.warehouse_code);
      });
      expect(rows).toEqual(['WH-A1', 'WH-A2', 'WH-B1']);
    } finally {
      client.release();
    }
  });

  it('operator 仅能看到 WH-A1', async () => {
    const client = await pool.connect();
    try {
      const rows = await withIdentity(client, FIXTURE.operator, async () => {
        const result = await client.query(`SELECT COUNT(*)::int AS c FROM p0_01_biz.inventory`);
        return result.rows[0]?.c as number;
      });
      expect(rows).toBe(1);
    } finally {
      client.release();
    }
  });

  it('跨市场仓库过滤：manager 看不到 WH-B1', async () => {
    const client = await pool.connect();
    try {
      const count = await withIdentity(client, FIXTURE.manager, async () => {
        const result = await client.query(
          `SELECT COUNT(*)::int AS c
           FROM p0_01_biz.inventory i
           INNER JOIN p0_01_biz.warehouses w ON w.id = i.warehouse_id
           WHERE w.code = 'WH-B1'`,
        );
        return result.rows[0]?.c as number;
      });
      expect(count).toBe(0);
    } finally {
      client.release();
    }
  });

  it('无身份时读不到库存', async () => {
    const client = await pool.connect();
    try {
      const result = await client.query(`SELECT COUNT(*)::int AS c FROM p0_01_biz.inventory`);
      expect(result.rows[0]?.c).toBe(0);
    } finally {
      client.release();
    }
  });

  it('无金额权限不能读取成本表', async () => {
    const client = await pool.connect();
    try {
      const count = await withIdentity(client, FIXTURE.managerNoAmount, async () => {
        const result = await client.query(`SELECT COUNT(*)::int AS c FROM p0_01_biz.inventory_unit_costs`);
        return result.rows[0]?.c as number;
      });
      expect(count).toBe(0);
    } finally {
      client.release();
    }
  });

  it('有金额权限可以读取 fixture 成本', async () => {
    const client = await pool.connect();
    try {
      const amount = await withIdentity(client, FIXTURE.manager, async () => {
        const result = await client.query<{ unit_cost_excl_freight: string }>(
          `SELECT unit_cost_excl_freight::text
           FROM p0_01_biz.inventory_unit_costs c
           INNER JOIN p0_01_biz.warehouses w ON w.id = c.warehouse_id
           WHERE w.code = 'WH-A1'
           LIMIT 1`,
        );
        return result.rows[0]?.unit_cost_excl_freight;
      });
      expect(amount).toBe('12.5000');
    } finally {
      client.release();
    }
  });

  it('业务角色不能读取认证 schema', async () => {
    const client = await pool.connect();
    try {
      await expect(
        client.query(`SELECT 1 FROM p0_01_auth.user LIMIT 1`),
      ).rejects.toThrow();
    } finally {
      client.release();
    }
  });

  it('业务角色不能修改授权表', async () => {
    const client = await pool.connect();
    try {
      await expect(
        withIdentity(client, FIXTURE.operator, async () =>
          client.query(
            `INSERT INTO p0_01_biz.user_market_grants (user_id, market_id)
             SELECT $1, market_id FROM p0_01_biz.user_market_grants LIMIT 1`,
            [FIXTURE.operator],
          ),
        ),
      ).rejects.toThrow();
    } finally {
      client.release();
    }
  });

  it('业务表 owner 为 ice_p0_01_owner', async () => {
    const bootstrap = new Pool({
      connectionString: `postgres://postgres:${env.bootstrapPassword}@${env.host}:${env.port}/${env.dbName}`,
      max: 1,
    });
    const result = await bootstrap.query<{ tablename: string; tableowner: string }>(
      `SELECT tablename, tableowner
       FROM pg_tables
       WHERE schemaname = 'p0_01_biz'
       ORDER BY tablename`,
    );
    await bootstrap.end();
    expect(result.rowCount).toBeGreaterThan(0);
    for (const row of result.rows) {
      expect(row.tableowner).toBe('ice_p0_01_owner');
    }
  });

  it('app_runner 不是 owner 角色成员', async () => {
    const bootstrap = new Pool({
      connectionString: `postgres://postgres:${env.bootstrapPassword}@${env.host}:${env.port}/${env.dbName}`,
      max: 1,
    });
    const result = await bootstrap.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c
       FROM pg_auth_members m
       INNER JOIN pg_roles member ON member.oid = m.member
       INNER JOIN pg_roles granted ON granted.oid = m.roleid
       WHERE member.rolname = 'ice_p0_01_app_runner'
         AND granted.rolname = 'ice_p0_01_owner'`,
    );
    await bootstrap.end();
    expect(result.rows[0]?.c).toBe(0);
  });

  it('无有效市场/仓库授权交集时 inventory 服务拒绝', async () => {
    const bootstrap = new Pool({
      connectionString: `postgres://postgres:${env.bootstrapPassword}@${env.host}:${env.port}/${env.dbName}`,
      max: 1,
    });
    await bootstrap.query(`DELETE FROM p0_01_biz.user_warehouse_grants WHERE user_id = $1`, [FIXTURE.operator]);
    try {
      await expect(getInventoryForUser(operatorUser, {})).rejects.toBeInstanceOf(AuthorizationError);
    } finally {
      await bootstrap.query(
        `INSERT INTO p0_01_biz.user_warehouse_grants (user_id, warehouse_id)
         SELECT $1, w.id FROM p0_01_biz.warehouses w WHERE w.code = 'WH-A1'
         ON CONFLICT DO NOTHING`,
        [FIXTURE.operator],
      );
      await bootstrap.end();
    }
  });

  it('市场与仓库授权不相交时 inventory 服务拒绝', async () => {
    const bootstrap = new Pool({
      connectionString: `postgres://postgres:${env.bootstrapPassword}@${env.host}:${env.port}/${env.dbName}`,
      max: 1,
    });
    await bootstrap.query(`DELETE FROM p0_01_biz.user_warehouse_grants WHERE user_id = $1`, [FIXTURE.operator]);
    await bootstrap.query(
      `INSERT INTO p0_01_biz.user_market_grants (user_id, market_id)
       SELECT $1, m.id FROM p0_01_biz.markets m WHERE m.code = 'MKT-B'
       ON CONFLICT DO NOTHING`,
      [FIXTURE.operator],
    );
    try {
      await expect(getInventoryForUser(operatorUser, {})).rejects.toBeInstanceOf(AuthorizationError);
    } finally {
      await bootstrap.query(`DELETE FROM p0_01_biz.user_market_grants WHERE user_id = $1 AND market_id IN (
        SELECT id FROM p0_01_biz.markets WHERE code = 'MKT-B')`, [FIXTURE.operator]);
      await bootstrap.query(
        `INSERT INTO p0_01_biz.user_warehouse_grants (user_id, warehouse_id)
         SELECT $1, w.id FROM p0_01_biz.warehouses w WHERE w.code = 'WH-A1'
         ON CONFLICT DO NOTHING`,
        [FIXTURE.operator],
      );
      await bootstrap.end();
    }
  });

  it('授权范围内无库存时 inventory 服务返回空列表', async () => {
    const bootstrap = new Pool({
      connectionString: `postgres://postgres:${env.bootstrapPassword}@${env.host}:${env.port}/${env.dbName}`,
      max: 1,
    });
    const backup = await bootstrap.query<{
      id: string;
      product_variant_id: string;
      warehouse_id: string;
      available_quantity: number;
    }>(
      `SELECT i.id, i.product_variant_id, i.warehouse_id, i.available_quantity
       FROM p0_01_biz.inventory i
       INNER JOIN p0_01_biz.warehouses w ON w.id = i.warehouse_id
       WHERE w.code IN ('WH-A1', 'WH-A2')`,
    );
    await bootstrap.query(
      `DELETE FROM p0_01_biz.inventory i USING p0_01_biz.warehouses w
       WHERE w.id = i.warehouse_id AND w.code IN ('WH-A1', 'WH-A2')`,
    );
    try {
      const list = await getInventoryForUser(managerUser, {});
      expect(list.items).toEqual([]);
    } finally {
      for (const row of backup.rows) {
        await bootstrap.query(
          `INSERT INTO p0_01_biz.inventory (id, product_variant_id, warehouse_id, available_quantity)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (id) DO UPDATE SET available_quantity = EXCLUDED.available_quantity`,
          [row.id, row.product_variant_id, row.warehouse_id, row.available_quantity],
        );
      }
      await bootstrap.end();
    }
  });

  it('记录 app_runner 非 superuser 且无 BYPASSRLS', async () => {
    const bootstrap = new Pool({
      connectionString: `postgres://postgres:${env.bootstrapPassword}@${env.host}:${env.port}/${env.dbName}`,
      max: 1,
    });
    const result = await bootstrap.query<{
      rolname: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>(
      `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname IN ('ice_p0_01_app_runner', 'ice_p0_01_auth_runner') ORDER BY rolname`,
    );
    await bootstrap.end();
    for (const row of result.rows) {
      expect(row.rolsuper).toBe(false);
      expect(row.rolbypassrls).toBe(false);
    }
  });
});
