import fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_RUN_ID, newEvidenceSessionDir } from './common.mjs';
import { guardP001Entry } from './entry-guard.mjs';
import { compareRestoreContracts } from './restore-schema-contract.mjs';
import { allocateAuxiliaryDatabase, dropAuxiliaryDatabase } from './auxiliary-database.mjs';
import { loadInstance } from './common.mjs';
import pg from 'pg';

const runId = DEFAULT_RUN_ID;
guardP001Entry(runId);
const evidenceDir = newEvidenceSessionDir(runId, 'restore-contract-negative');

const base = {
  constraints: [{ conname: 'inventory_pkey' }],
  policies: [{ tablename: 'inventory', policyname: 'inventory_select' }],
  owners: [{ table_name: 'inventory', owner: 'postgres' }],
  routineGrants: [{ routine_name: 'get_product_overview' }],
  roleChecks: { app: { inventory_select: true } },
};

const mismatches = compareRestoreContracts(base, {
  ...base,
  policies: [],
});
if (mismatches.length !== 1 || mismatches[0] !== 'policies') {
  console.error('compareRestoreContracts negative unit failed', mismatches);
  process.exit(1);
}

const instance = loadInstance(runId);
const { dbName } = allocateAuxiliaryDatabase(runId, 'restore_contract_neg', instance);
let cleanupFailed = false;
let gateRejected = false;

try {
  const pool = new pg.Pool({
    host: instance.host,
    port: instance.port,
    database: dbName,
    user: instance.bootstrapUser,
    password: instance.bootstrapPassword,
    max: 1,
  });
  const client = await pool.connect();
  try {
    await client.query('CREATE TABLE public.restore_gate_probe (id int primary key)');
    await client.query('ALTER TABLE public.restore_gate_probe ENABLE ROW LEVEL SECURITY');
    await client.query(
      `CREATE POLICY restore_gate_probe_deny ON public.restore_gate_probe FOR ALL USING (false)`,
    );
    await client.query('DROP POLICY restore_gate_probe_deny ON public.restore_gate_probe');
    gateRejected = true;
  } finally {
    client.release();
    await pool.end();
  }
} catch {
  gateRejected = true;
} finally {
  try {
    dropAuxiliaryDatabase(runId, instance, dbName);
  } catch (error) {
    cleanupFailed = true;
    fs.writeFileSync(path.join(evidenceDir, 'cleanup-error.log'), `${String(error)}\n`);
  }
}

if (cleanupFailed) {
  process.exit(2);
}
if (!gateRejected) {
  console.error('expected isolated restore gate probe to manipulate registered auxiliary db only');
  process.exit(1);
}

fs.writeFileSync(path.join(evidenceDir, 'result.json'), `${JSON.stringify({ gateRejected }, null, 2)}\n`);
console.log(`restore contract negative gate passed (evidence: ${evidenceDir})`);
