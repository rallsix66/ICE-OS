import fs from 'node:fs';
import path from 'node:path';

import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { Pool } from 'pg';

import { runRoot } from './common.mjs';

/**
 * Run Better Auth schema migrations against p0_02_auth.
 * @param {object} instance
 * @param {string} runId
 * @param {{ runMigrations?: (migrations: Awaited<ReturnType<typeof getMigrations>>) => Promise<void> }} [hooks]
 */
export async function migrateAuthSchema(instance, runId, hooks = {}) {
  const authSearchPath = encodeURIComponent('-c search_path=p0_02_auth');
  const ownerPool = new Pool({
    connectionString: `postgres://${instance.bootstrapUser}:${instance.bootstrapPassword}@${instance.host}:${instance.port}/${instance.dbName}?options=${authSearchPath}`,
  });

  const logPath = path.join(runRoot(runId), 'better-auth-migrate.log');
  const logLines = [`--- ${new Date().toISOString()} ---`];

  try {
    const auth = betterAuth({
      appName: 'iceos-p0-02-seed',
      baseURL: 'http://127.0.0.1:3000',
      basePath: '/api/auth',
      secret: instance.betterAuthSecret,
      database: ownerPool,
      emailAndPassword: { enabled: true, disableSignUp: true },
    });

    const migrations = await getMigrations(auth.options);
    if (hooks.runMigrations) {
      await hooks.runMigrations(migrations);
    } else {
      await migrations.runMigrations();
    }
    logLines.push('runMigrations: ok');
    fs.appendFileSync(logPath, `${logLines.join('\n')}\n`);
  } catch (error) {
    logLines.push(
      `runMigrations: ERROR ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
    );
    fs.appendFileSync(logPath, `${logLines.join('\n')}\n`);
    throw error;
  } finally {
    await ownerPool.end();
  }
}
