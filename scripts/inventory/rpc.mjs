/**
 * Small operator/RPC helper for the inventory instance (used by the run book and by verification).
 *
 *   node scripts/inventory/rpc.mjs --run-id <run> --fn catalog.read_inventory_sync_overview
 *   node scripts/inventory/rpc.mjs --run-id <run> --fn catalog.request_inventory_manual_sync \
 *        --args '["<requestId>","manual|admin|<ts>"]'
 *   node scripts/inventory/rpc.mjs --run-id <run> --fn catalog.read_inventory_list --args '["","","",50,0]'
 *
 * App functions run inside a transaction with `request.jwt.claim.sub` set to the fixture admin so the
 * SECURITY DEFINER guards behave exactly like the web server does; sync functions run on the sync role.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openRun, readArgs } from '../catalog/prepare.mjs';
import { assertConnectedTarget, assertWritableTestTarget, buildConnectedTargetGuard } from './test-target-guard.mjs';

const args = readArgs(process.argv.slice(2));
const run = openRun(args);
const envPath = path.join(run.instanceRoot, 'env.inventory.json');
if (!fs.existsSync(envPath)) throw new Error('INVENTORY_INSTANCE_NOT_PREPARED');
const inventoryEnv = JSON.parse(fs.readFileSync(envPath, 'utf8'));
const fn = process.argv[process.argv.indexOf('--fn') + 1];
if (!fn) throw new Error('INVENTORY_RPC_FUNCTION_REQUIRED');
// PowerShell mangles embedded double quotes in native arguments, so callers can pass the JSON
// through a file (preferred on Windows) or through the INVENTORY_RPC_ARGS environment variable.
const argsFileIndex = process.argv.indexOf('--args-file');
const envArgs = process.env.INVENTORY_RPC_ARGS;
const argsIndex = process.argv.indexOf('--args');
const fnArgs = argsFileIndex >= 0
  ? JSON.parse(fs.readFileSync(process.argv[argsFileIndex + 1], 'utf8'))
  : envArgs
    ? JSON.parse(envArgs)
    : argsIndex >= 0
      ? JSON.parse(process.argv[argsIndex + 1])
      : [];
const role = process.argv.includes('--sync') ? 'sync' : 'app';
const adminUserId = process.env.INVENTORY_ADMIN_USER_ID ?? '11111111-1111-4111-8111-111111111101';

// Read-only catalog functions may inspect any instance (e.g. the delivered candidate); anything that
// can write must prove it targets a dedicated writable test instance before connecting (F5.3).
const readOnlyFunction = /^catalog\.(read_|search_)/.test(fn);
// R4: read-only inspection still gets a target guard, so the live server identity is proved after
// connecting; it only skips the writable/protected-target refusal because nothing is written.
const guard = readOnlyFunction
  ? buildConnectedTargetGuard({
    instanceRoot: run.instanceRoot, instance: run.instance, runId: args.runId,
    purpose: `rpc:${fn} (read-only)`, allowProtectedTarget: true,
  })
  : assertWritableTestTarget({ instanceRoot: run.instanceRoot, runId: args.runId, instance: run.instance, env: inventoryEnv, purpose: `rpc:${fn}` });

const { default: pg } = await import('pg');
const connectionString = role === 'sync' ? inventoryEnv.syncDbUrl : inventoryEnv.appDbUrl;
const client = new pg.Client({ connectionString });
await client.connect();
await assertConnectedTarget(client, guard, `rpc:${fn} (${role})`);
try {
  await client.query('BEGIN');
  if (role === 'app') {
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [adminUserId]);
  }
  const placeholders = fnArgs.map((_, index) => `$${index + 1}`).join(', ');
  const sql = `SELECT ${fn}(${placeholders}) AS result`;
  const result = await client.query(sql, fnArgs);
  await client.query('COMMIT');
  console.log(JSON.stringify({ fn, role, result: result.rows[0]?.result ?? null }, null, 2));
} catch (error) {
  try {
    await client.query('ROLLBACK');
  } catch {
    /* ignore */
  }
  console.error(JSON.stringify({ fn, role, error: error.message }, null, 2));
  process.exitCode = 1;
} finally {
  await client.end();
}

if (process.argv.includes('--request-id-out')) {
  console.log(randomUUID());
}
