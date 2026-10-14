import { betterAuth } from 'better-auth';
import { Pool } from 'pg';

import { DEFAULT_RUN_ID } from './common.mjs';
import { guardBeforeMutate } from './instance-guard.mjs';

const runId = DEFAULT_RUN_ID;
const { instance } = guardBeforeMutate(runId);
const refreshOnly = process.argv.includes('--refresh-fixtures');

const IDS = {
  admin: '11111111-1111-4111-8111-111111111101',
  operator: '11111111-1111-4111-8111-111111111104',
  whDomestic: '33333333-3333-4333-8333-333333333301',
  whOverseasTh: '33333333-3333-4333-8333-333333333302',
  product1: '44444444-4444-4444-8444-444444444401',
  variant1: '55555555-5555-4555-8555-555555555501',
  variant2: '55555555-5555-4555-8555-555555555502',
  invDomestic: '66666666-6666-4666-8666-666666666601',
  invOverseas: '66666666-6666-4666-8666-666666666602',
  extRefGolucky: 'e1111111-1111-4111-8111-111111111101',
  extItemGolucky: 'e2222222-2222-4222-8222-222222222201',
};

const accounts = [
  { email: 'admin@p0-02.test', password: 'AdminPass123!', profileId: IDS.admin, roleName: 'admin', name: 'Admin User' },
  { email: 'operator@p0-02.test', password: 'OperatorPass123!', profileId: IDS.operator, roleName: 'operator', name: 'Operator User' },
];

async function main() {
  const ownerPool = new Pool({
    connectionString: `postgres://${instance.bootstrapUser}:${instance.bootstrapPassword}@${instance.host}:${instance.port}/${instance.dbName}`,
  });

  const authSearchPath = encodeURIComponent('-c search_path=p0_02_auth');
  const authPool = new Pool({
    connectionString: `postgres://${instance.bootstrapUser}:${instance.bootstrapPassword}@${instance.host}:${instance.port}/${instance.dbName}?options=${authSearchPath}`,
  });

  const seedAuth = betterAuth({
    appName: 'iceos-p0-02-seed',
    baseURL: 'http://127.0.0.1:3000',
    basePath: '/api/auth',
    secret: instance.betterAuthSecret,
    database: authPool,
    emailAndPassword: { enabled: true, disableSignUp: false },
  });

  for (const account of accounts) {
    const roleRow = await ownerPool.query(`SELECT id FROM role WHERE name = $1 LIMIT 1`, [account.roleName]);
    if (!roleRow.rowCount) {
      throw new Error(`缺少 role: ${account.roleName}`);
    }
    const roleId = roleRow.rows[0].id;
    let authUserId;
    const existing = await authPool.query(`SELECT id FROM "user" WHERE email = $1 LIMIT 1`, [account.email]);
    if (existing.rowCount && existing.rows[0]?.id) {
      authUserId = existing.rows[0].id;
    } else {
      const created = await seedAuth.api.signUpEmail({
        body: { email: account.email, password: account.password, name: account.name },
      });
      if (!created?.user?.id) {
        throw new Error(`seed 用户失败: ${account.email}`);
      }
      authUserId = created.user.id;
    }

    await ownerPool.query(
      `INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ($1, $2, '{}'::jsonb)
       ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`,
      [account.profileId, account.email],
    );

    await ownerPool.query(
      `INSERT INTO profiles (id, display_name, role_id, is_active) VALUES ($1, $2, $3, true)
       ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name, role_id = EXCLUDED.role_id, is_active = true`,
      [account.profileId, account.name, roleId],
    );

    await ownerPool.query(
      `INSERT INTO p0_02_meta.ice_auth_user_map (auth_user_id, ice_user_id) VALUES ($1, $2)
       ON CONFLICT (auth_user_id) DO UPDATE SET ice_user_id = EXCLUDED.ice_user_id`,
      [authUserId, account.profileId],
    );
  }

  await ownerPool.query(
    `INSERT INTO warehouse (id, name, country, type, is_active) VALUES
      ($1, '国内仓', 'CN', 'domestic', true),
      ($2, '泰国海外仓', 'TH', 'overseas', true)
     ON CONFLICT DO NOTHING`,
    [IDS.whDomestic, IDS.whOverseasTh],
  );

  await ownerPool.query(
    `INSERT INTO product (id, code, name, safety_stock, is_active) VALUES ($1, 'ICE-P0-02', 'P0-02 Demo Product', 5, true)
     ON CONFLICT DO NOTHING`,
    [IDS.product1],
  );

  await ownerPool.query(
    `INSERT INTO product_variant (id, product_id, sku, country, name, match_status) VALUES
      ($1, $3, 'SKU-TH-001', 'TH', 'Demo Variant TH', 'matched'),
      ($2, $3, 'SKU-TH-002', 'TH', 'Demo Variant TH 2', 'unmatched')
     ON CONFLICT DO NOTHING`,
    [IDS.variant1, IDS.variant2, IDS.product1],
  );

  await ownerPool.query(
    `INSERT INTO inventory (id, variant_id, warehouse_id, quantity) VALUES
      ($1, $3, $4, 40),
      ($2, $3, $5, 12)
     ON CONFLICT DO NOTHING`,
    [IDS.invDomestic, IDS.invOverseas, IDS.variant1, IDS.whDomestic, IDS.whOverseasTh],
  );

  await ownerPool.query(
    `INSERT INTO user_warehouses (user_id, warehouse_id) VALUES ($1, $2), ($1, $3)
     ON CONFLICT DO NOTHING`,
    [IDS.operator, IDS.whDomestic, IDS.whOverseasTh],
  );

  await ownerPool.query(
    `INSERT INTO shipment_external_ref (
       id, provider, external_order_no, waybill_no, country, warehouse_id, sync_status
     ) VALUES ($1, 'golucky', 'PO-P0-02-DEMO', 'WB-P0-02-001', 'TH', $2, 'active')
     ON CONFLICT (id) DO NOTHING`,
    [IDS.extRefGolucky, IDS.whOverseasTh],
  );

  await ownerPool.query(
    `INSERT INTO shipment_external_item (
       id, external_ref_id, external_sku, external_product_name, quantity, matched_variant_id
     ) VALUES ($1, $2, 'GL-SKU-TH-001', 'GoLucky Demo Line', 3, $3)
     ON CONFLICT (id) DO UPDATE SET matched_variant_id = EXCLUDED.matched_variant_id, external_sku = EXCLUDED.external_sku`,
    [IDS.extItemGolucky, IDS.extRefGolucky, IDS.variant1],
  );

  await authPool.end();
  await ownerPool.end();
  console.log(refreshOnly ? 'seed refresh 完成' : 'seed 完成');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
