import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { REPO_ROOT } from './prepare.mjs';

const runId = process.argv[2] ?? 'run-20261021T100700Z-b3c4d5e6';
const instance = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, '.local/catalog', runId, 'instance', 'catalog-instance.json'), 'utf8'));
const client = new pg.Client({
  connectionString: `postgres://${instance.bootstrapUser}:${instance.bootstrapPassword}@${instance.host}:${instance.port}/${instance.dbName}`,
});
await client.connect();
const row = (await client.query(`
  SELECT proname, pg_get_function_result(p.oid) AS result_type,
         pg_catalog.has_function_privilege('ice_p0_02_app_runner', p.oid, 'EXECUTE') AS runner_grant
  FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = 'catalog' AND p.proname = 'read_baseline_item_amounts_map' AND p.pronargs = 0
`)).rows[0];
await client.end();
console.log(JSON.stringify({ runId, database: instance.dbName, row, ok: Boolean(row?.runner_grant) }, null, 2));
