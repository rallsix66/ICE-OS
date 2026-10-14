import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { Pool } from 'pg';

import { DEFAULT_RUN_ID } from './common.mjs';
import { guardBeforeMutate } from './instance-guard.mjs';

const runId = DEFAULT_RUN_ID;
const { instance } = guardBeforeMutate(runId);

const authSearchPath = encodeURIComponent('-c search_path=p0_01_auth');
const pool = new Pool({
  connectionString: `postgres://${instance.bootstrapUser}:${instance.bootstrapPassword}@${instance.host}:${instance.port}/${instance.dbName}?options=${authSearchPath}`,
});

const auth = betterAuth({
  baseURL: 'http://127.0.0.1:3000',
  secret: instance.betterAuthSecret,
  database: pool,
  emailAndPassword: { enabled: true },
});

const m = await getMigrations(auth.options);
console.log('toBeCreated', m.toBeCreated.map((t) => t.table));
await m.runMigrations();
await pool.end();
