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

export async function captureRestoreContract(instance) {
  const pool = new pg.Pool({
    host: instance.host,
    port: instance.port,
    database: instance.dbName,
    user: instance.bootstrapUser,
    password: instance.bootstrapPassword,
    max: 1,
  });
  const client = await pool.connect();
  try {
    const { rows: constraints } = await client.query(
      `
      SELECT c.conname, c.contype, t.relname AS table_name
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
      SELECT tablename, policyname, permissive, cmd
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

    return {
      constraints,
      policies,
      owners,
      functionPrivileges,
      roleChecks,
    };
  } finally {
    client.release();
    await pool.end();
  }
}

export function compareRestoreContracts(source, restored) {
  const mismatches = [];
  const sections = ['constraints', 'policies', 'owners', 'functionPrivileges', 'roleChecks'];
  for (const section of sections) {
    const left = JSON.stringify(source[section] ?? null);
    const right = JSON.stringify(restored[section] ?? null);
    if (left !== right) {
      mismatches.push(section);
    }
  }
  return mismatches;
}
