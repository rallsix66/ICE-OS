import pg from 'pg';

const WATCH_TABLES = [
  'product_variant',
  'inventory',
  'warehouse',
  'sync_log',
  'sync_run',
  'user_warehouses',
];

const KEY_FUNCTIONS = [
  'get_product_overview',
  'sync_warehouse_inventory',
  'claim_sync_run',
  'release_sync_run',
];

function poolFor(instance) {
  return new pg.Pool({
    host: instance.host,
    port: instance.port,
    database: instance.dbName,
    user: instance.bootstrapUser,
    password: instance.bootstrapPassword,
    max: 1,
  });
}

function poolForRole(instance, user, password) {
  return new pg.Pool({
    host: instance.host,
    port: instance.port,
    database: instance.dbName,
    user,
    password,
    max: 1,
  });
}

export async function captureRestoreContract(instance) {
  const pool = poolFor(instance);
  const client = await pool.connect();
  try {
    const { rows: tableRls } = await client.query(
      `
      SELECT c.relname AS table_name,
             c.relrowsecurity AS rls_enabled,
             c.relforcerowsecurity AS rls_forced
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND c.relname = ANY($1::text[])
      ORDER BY c.relname
      `,
      [WATCH_TABLES],
    );

    const { rows: constraints } = await client.query(
      `
      SELECT c.conname,
             t.relname AS table_name,
             pg_get_constraintdef(c.oid, true) AS definition
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public'
        AND t.relname = ANY($1::text[])
      ORDER BY t.relname, c.conname
      `,
      [WATCH_TABLES],
    );

    const { rows: policies } = await client.query(
      `
      SELECT schemaname,
             tablename,
             policyname,
             permissive,
             roles,
             cmd,
             qual,
             with_check
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = ANY($1::text[])
      ORDER BY tablename, policyname
      `,
      [WATCH_TABLES],
    );

    const { rows: owners } = await client.query(
      `
      SELECT c.relname AS table_name, pg_get_userbyid(c.relowner) AS owner
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND c.relname = ANY($1::text[])
      ORDER BY c.relname
      `,
      [WATCH_TABLES],
    );

    const { rows: functionMeta } = await client.query(
      `
      SELECT p.oid::text AS oid,
             p.proname,
             pg_get_function_identity_arguments(p.oid) AS identity_args,
             pg_get_userbyid(p.proowner) AS owner,
             p.prosecdef AS security_definer,
             md5(pg_get_functiondef(p.oid)) AS definition_hash
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname = ANY($1::text[])
      ORDER BY p.proname, pg_get_function_identity_arguments(p.oid)
      `,
      [KEY_FUNCTIONS],
    );

    const { rows: functionPrivileges } = await client.query(
      `
      SELECT p.proname,
             has_function_privilege($1, p.oid, 'EXECUTE') AS app_execute,
             has_function_privilege($2, p.oid, 'EXECUTE') AS sync_execute
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname = ANY($3::text[])
      ORDER BY p.proname
      `,
      [instance.appRunnerUser, instance.syncRunnerUser, KEY_FUNCTIONS],
    );

    const roleChecks = {};
    for (const role of [instance.appRunnerUser, instance.syncRunnerUser]) {
      const { rows } = await client.query(
        `
        SELECT
          has_table_privilege($1, 'public.inventory', 'SELECT') AS inventory_select,
          has_table_privilege($1, 'public.inventory', 'INSERT') AS inventory_insert,
          has_table_privilege($1, 'public.inventory', 'UPDATE') AS inventory_update,
          has_table_privilege($1, 'public.sync_log', 'SELECT') AS sync_log_select,
          has_table_privilege($1, 'public.sync_log', 'INSERT') AS sync_log_insert
        `,
        [role],
      );
      roleChecks[role] = rows[0];
    }

    const roleBehavior = await captureRestoreRoleBehavior(instance);

    return {
      tableRls,
      constraints,
      policies,
      owners,
      functionMeta,
      functionPrivileges,
      roleChecks,
      roleBehavior,
    };
  } finally {
    client.release();
    await pool.end();
  }
}

export async function captureRestoreRoleBehavior(instance) {
  const operatorId = '11111111-1111-4111-8111-111111111104';
  const appPool = poolForRole(
    instance,
    instance.appRunnerUser,
    instance.appRunnerPassword,
  );
  const syncPool = poolForRole(
    instance,
    instance.syncRunnerUser,
    instance.syncRunnerPassword,
  );
  const appClient = await appPool.connect();
  const syncClient = await syncPool.connect();
  try {
    await appClient.query('BEGIN');
    await appClient.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [
      operatorId,
    ]);
    const operatorInv = await appClient.query(
      `SELECT COUNT(*)::int AS c FROM public.inventory`,
    );
    await appClient.query('ROLLBACK');

    await syncClient.query('BEGIN');
    const syncClaimExec = await syncClient.query(
      `
      SELECT has_function_privilege(current_user, 'public.claim_sync_run(uuid,text,uuid,integer,uuid,text,uuid,text,text)', 'EXECUTE') AS ok
      `,
    );
    await syncClient.query('ROLLBACK');

    return {
      operatorInventoryVisibleRows: operatorInv.rows[0]?.c ?? null,
      syncCanExecuteClaimSyncRun: Boolean(syncClaimExec.rows[0]?.ok),
    };
  } finally {
    appClient.release();
    syncClient.release();
    await appPool.end();
    await syncPool.end();
  }
}

function normalizeContractSection(section, value) {
  if (section !== 'functionMeta' || !Array.isArray(value)) {
    return value;
  }
  return value
    .map((row) => ({
      proname: row.proname,
      identity_args: row.identity_args ?? '',
      definition_hash: row.definition_hash ?? '',
      owner: row.owner,
      security_definer: row.security_definer,
    }))
    .sort((a, b) =>
      `${a.proname}:${a.identity_args}:${a.owner}`.localeCompare(
        `${b.proname}:${b.identity_args}:${b.owner}`,
      ),
    );
}

export function compareRestoreContracts(source, restored) {
  const mismatches = [];
  const sections = [
    'tableRls',
    'constraints',
    'policies',
    'owners',
    'functionMeta',
    'functionPrivileges',
    'roleChecks',
    'roleBehavior',
  ];
  for (const section of sections) {
    const left = JSON.stringify(normalizeContractSection(section, source[section] ?? null));
    const right = JSON.stringify(normalizeContractSection(section, restored[section] ?? null));
    if (left !== right) {
      mismatches.push(section);
    }
  }
  return mismatches;
}

export function operatorCsvRowsetMatches(expectedRows, parsedCsv) {
  const key = (row) =>
    `${String(row.sku ?? row.SKU ?? '').trim()}|${String(row.warehouse_name ?? row.warehouse ?? row['仓库'] ?? '').trim()}|${String(row.quantity ?? row['当前库存'] ?? row['数量'] ?? '').trim()}`;
  const expectedKeys = expectedRows.map(key).sort();
  const actualKeys = (parsedCsv.rows ?? [])
    .map((row) =>
      key({
        sku: row.SKU ?? row.sku,
        warehouse_name: row['仓库'] ?? row.warehouse_name ?? row.warehouse,
        quantity: row['当前库存'] ?? row['数量'] ?? row.quantity,
      }),
    )
    .filter(Boolean)
    .sort();
  if (expectedKeys.length !== actualKeys.length) {
    return false;
  }
  return expectedKeys.every((value, index) => value === actualKeys[index]);
}
