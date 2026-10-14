import { betterAuth } from 'better-auth';
import { Pool } from 'pg';

import { DEFAULT_RUN_ID } from './common.mjs';
import { guardBeforeMutate } from './instance-guard.mjs';

const runId = DEFAULT_RUN_ID;
const { instance } = guardBeforeMutate(runId);
const refreshOnly = process.argv.includes('--refresh-fixtures');

const IDS = {
  admin: '11111111-1111-4111-8111-111111111101',
  manager: '11111111-1111-4111-8111-111111111102',
  managerNoAmount: '11111111-1111-4111-8111-111111111103',
  operator: '11111111-1111-4111-8111-111111111104',
  marketA: '22222222-2222-4222-8222-222222222201',
  marketB: '22222222-2222-4222-8222-222222222202',
  whA1: '33333333-3333-4333-8333-333333333301',
  whA2: '33333333-3333-4333-8333-333333333302',
  whB1: '33333333-3333-4333-8333-333333333303',
  product1: '44444444-4444-4444-8444-444444444401',
  variant1: '55555555-5555-4555-8555-555555555501',
  variant2: '55555555-5555-4555-8555-555555555502',
  invA1: '66666666-6666-4666-8666-666666666601',
  invA2: '66666666-6666-4666-8666-666666666602',
  invB1: '66666666-6666-4666-8666-666666666603',
};

const accounts = [
  { email: 'admin@p0-01.test', password: 'AdminPass123!', iceId: IDS.admin, role: 'admin', name: 'Admin User' },
  { email: 'manager@p0-01.test', password: 'ManagerPass123!', iceId: IDS.manager, role: 'manager', name: 'Manager User' },
  {
    email: 'manager-no-amount@p0-01.test',
    password: 'ManagerNoAmt123!',
    iceId: IDS.managerNoAmount,
    role: 'manager',
    name: 'Manager No Amount',
  },
  { email: 'operator@p0-01.test', password: 'OperatorPass123!', iceId: IDS.operator, role: 'operator', name: 'Operator User' },
];

async function main() {
  const authSearchPath = encodeURIComponent('-c search_path=p0_01_auth');
  const ownerPool = new Pool({
    connectionString: `postgres://${instance.bootstrapUser}:${instance.bootstrapPassword}@${instance.host}:${instance.port}/${instance.dbName}?options=${authSearchPath}`,
  });

  const seedAuth = betterAuth({
    appName: 'iceos-p0-01-seed',
    baseURL: 'http://127.0.0.1:3000',
    basePath: '/api/p0-01/auth',
    secret: instance.betterAuthSecret,
    database: ownerPool,
    emailAndPassword: { enabled: true, disableSignUp: false },
  });

  const newFixtureUsers = new Set();

  for (const account of accounts) {
    let authUserId;
    const existingIceUser = await ownerPool.query(`SELECT id FROM p0_01_biz.ice_users WHERE id = $1 LIMIT 1`, [
      account.iceId,
    ]);
    if ((existingIceUser.rowCount ?? 0) === 0) {
      newFixtureUsers.add(account.iceId);
    }
    const existing = await ownerPool.query(`SELECT id FROM "user" WHERE email = $1 LIMIT 1`, [account.email]);
    if (existing.rowCount && existing.rows[0]?.id) {
      authUserId = existing.rows[0].id;
    } else {
      const created = await seedAuth.api.signUpEmail({
        body: {
          email: account.email,
          password: account.password,
          name: account.name,
        },
      });
      if (!created?.user?.id) {
        throw new Error(`seed 用户失败: ${account.email}`);
      }
      authUserId = created.user.id;
    }
    if (refreshOnly) {
      await ownerPool.query(
        `INSERT INTO p0_01_biz.ice_users (id, email, display_name, role, is_enabled)
         VALUES ($1, $2, $3, $4, true)
         ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, role = EXCLUDED.role`,
        [account.iceId, account.email, account.name, account.role],
      );
    } else {
      await ownerPool.query(
        `INSERT INTO p0_01_biz.ice_users (id, email, display_name, role, is_enabled)
         VALUES ($1, $2, $3, $4, true)
         ON CONFLICT (id) DO NOTHING`,
        [account.iceId, account.email, account.name, account.role],
      );
    }
    await ownerPool.query(
      `INSERT INTO p0_01_biz.ice_auth_user_map (auth_user_id, ice_user_id)
       VALUES ($1, $2)
       ON CONFLICT (auth_user_id) DO UPDATE SET ice_user_id = EXCLUDED.ice_user_id`,
      [authUserId, account.iceId],
    );
  }

  await ownerPool.query(
    `INSERT INTO p0_01_biz.markets (id, code, name) VALUES
      ($1, 'MKT-A', 'Market A'),
      ($2, 'MKT-B', 'Market B')
     ON CONFLICT DO NOTHING`,
    [IDS.marketA, IDS.marketB],
  );

  await ownerPool.query(
    `INSERT INTO p0_01_biz.warehouses (id, market_id, code, name) VALUES
      ($1, $3, 'WH-A1', 'Warehouse A1'),
      ($2, $3, 'WH-A2', 'Warehouse A2'),
      ($4, $5, 'WH-B1', 'Warehouse B1')
     ON CONFLICT DO NOTHING`,
    [IDS.whA1, IDS.whA2, IDS.marketA, IDS.whB1, IDS.marketB],
  );

  const grant = async (userId, markets, warehouses, amountMarkets = []) => {
    for (const marketId of markets) {
      await ownerPool.query(
        `INSERT INTO p0_01_biz.user_market_grants (user_id, market_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [userId, marketId],
      );
    }
    for (const warehouseId of warehouses) {
      await ownerPool.query(
        `INSERT INTO p0_01_biz.user_warehouse_grants (user_id, warehouse_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [userId, warehouseId],
      );
    }
    for (const marketId of amountMarkets) {
      await ownerPool.query(
        `INSERT INTO p0_01_biz.user_amount_grants (user_id, market_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [userId, marketId],
      );
    }
  };

  const grantDefaults = [
    [IDS.admin, [IDS.marketA, IDS.marketB], [IDS.whA1, IDS.whA2, IDS.whB1], [IDS.marketA, IDS.marketB]],
    [IDS.manager, [IDS.marketA], [IDS.whA1, IDS.whA2], [IDS.marketA]],
    [IDS.managerNoAmount, [IDS.marketA], [IDS.whA1], []],
    [IDS.operator, [IDS.marketA], [IDS.whA1], []],
  ];
  for (const [userId, markets, warehouses, amountMarkets] of grantDefaults) {
    if (refreshOnly || newFixtureUsers.has(userId)) {
      await grant(userId, markets, warehouses, amountMarkets);
    }
  }

  await ownerPool.query(
    `INSERT INTO p0_01_biz.products (id, ice_code, name) VALUES ($1, 'ICE-P0-01', 'P0-01 Demo Product')
     ON CONFLICT DO NOTHING`,
    [IDS.product1],
  );
  await ownerPool.query(
    `INSERT INTO p0_01_biz.product_variants (id, product_id, sku_label) VALUES
      ($1, $3, 'SKU-A'), ($2, $3, 'SKU-B')
     ON CONFLICT DO NOTHING`,
    [IDS.variant1, IDS.variant2, IDS.product1],
  );
  await ownerPool.query(
    `INSERT INTO p0_01_biz.inventory (id, product_variant_id, warehouse_id, available_quantity) VALUES
      ($1, $4, $5, 10),
      ($2, $6, $7, 20),
      ($3, $4, $8, 30)
     ON CONFLICT DO NOTHING`,
    [IDS.invA1, IDS.invA2, IDS.invB1, IDS.variant1, IDS.whA1, IDS.variant2, IDS.whA2, IDS.whB1],
  );
  await ownerPool.query(
    `INSERT INTO p0_01_biz.inventory_unit_costs (product_variant_id, warehouse_id, unit_cost_excl_freight, currency) VALUES
      ($1, $3, 12.5000, 'CNY'),
      ($2, $4, 8.2500, 'CNY'),
      ($1, $5, 15.0000, 'CNY')
     ON CONFLICT DO NOTHING`,
    [IDS.variant1, IDS.variant2, IDS.whA1, IDS.whA2, IDS.whB1],
  );

  await ownerPool.end();
  console.log('seed 完成');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
