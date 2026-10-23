/**
 * Guardrails for catalog SQL increment PostgreSQL tests — never mutate live preview databases.
 */
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { REPO_ROOT } from './prepare.mjs';

export const INCREMENT_TEST_DB_PREFIX = 'iceos_catalog_sql_increment_test_';

/** Env keys that must never select a live preview run for increment PG tests. */
const FORBIDDEN_ENV_KEYS = ['CATALOG_SQL_INCREMENT_TEST_RUN_ID'];

function parseDatabaseName(connectionString) {
  try {
    const url = new URL(connectionString);
    return decodeURIComponent(url.pathname.replace(/^\//, ''));
  } catch {
    return null;
  }
}

/** @returns {string[]} */
export function listLivePreviewDatabaseNames() {
  const catalogRoot = path.join(REPO_ROOT, '.local/catalog');
  if (!fs.existsSync(catalogRoot)) return [];
  const names = [];
  for (const entry of fs.readdirSync(catalogRoot)) {
    if (!/^run-\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(entry)) continue;
    const instancePath = path.join(catalogRoot, entry, 'instance', 'catalog-instance.json');
    if (!fs.existsSync(instancePath)) continue;
    try {
      const instance = JSON.parse(fs.readFileSync(instancePath, 'utf8'));
      if (instance?.dbName) names.push(String(instance.dbName));
    } catch {
      /* ignore corrupt instance files */
    }
  }
  return names;
}

/**
 * @param {{ connectionString: string, label?: string }} target
 */
export function assertIncrementTestTargetAllowed(target) {
  for (const key of FORBIDDEN_ENV_KEYS) {
    if (process.env[key]?.trim()) {
      throw new Error(`CATALOG_SQL_INCREMENT_TEST_FORBIDDEN_ENV:${key}`);
    }
  }

  const ownerUrl = process.env.CATALOG_SQL_INCREMENT_TEST_OWNER_URL?.trim();
  if (!ownerUrl) {
    throw new Error('CATALOG_SQL_INCREMENT_TEST_OWNER_URL_REQUIRED');
  }
  if (target.connectionString !== ownerUrl) {
    throw new Error('CATALOG_SQL_INCREMENT_TEST_TARGET_URL_MISMATCH');
  }

  const database = parseDatabaseName(ownerUrl);
  if (!database) {
    throw new Error('CATALOG_SQL_INCREMENT_TEST_DATABASE_PARSE_FAILED');
  }

  if (!database.startsWith(INCREMENT_TEST_DB_PREFIX)) {
    throw new Error(`CATALOG_SQL_INCREMENT_TEST_DATABASE_PREFIX_REQUIRED:${database}`);
  }

  if (/^iceos_catalog_run_/i.test(database)) {
    throw new Error(`CATALOG_SQL_INCREMENT_TEST_LIVE_PREVIEW_DATABASE:${database}`);
  }

  const liveNames = listLivePreviewDatabaseNames();
  if (liveNames.includes(database)) {
    throw new Error(`CATALOG_SQL_INCREMENT_TEST_ACTIVE_PREVIEW_DATABASE:${database}`);
  }

  return { database, label: target.label ?? database };
}

/**
 * Connect owner client after guard checks. Caller must call assertIncrementTestTargetAllowed first.
 */
export async function connectIncrementTestOwner() {
  const connectionString = process.env.CATALOG_SQL_INCREMENT_TEST_OWNER_URL?.trim();
  assertIncrementTestTargetAllowed({ connectionString });
  const client = new pg.Client({ connectionString });
  await client.connect();
  return client;
}
