/**
 * Writable test-target guard for the inventory-sync maintenance / drill scripts.
 *
 * The 3031 / PG50499 incident showed that a writable PG entry point must never trust a caller-supplied
 * path or connection string. Before any maintenance script opens a database connection it must prove
 * that the target is this package's own isolated **writable test instance**:
 *
 *   - `<instanceRoot>/inventory-instance.json` exists (fallback `<runRoot>/inventory-manifest.json`);
 *   - `package === 'inventory-sync-v1'` and `testWritable === true`;
 *   - the marker `runId` matches the run being operated and is not a protected/delivered run;
 *   - `database.host` is loopback, `database.port` is not a protected port and `database.name`
 *     belongs to the marker `runId` (`iceos_catalog_<normalized runId>`).
 *
 * Repair v4 (R4/F5) closes two residual gaps from the v3 independent review:
 *
 *   1. **The checked target is the driver's final target.** Environment database URLs are parsed with
 *      the very same `pg-connection-string` parser used by the installed `pg` driver, and any query
 *      parameter that can override the connection target (`host`, `hostaddr`, `port`, `dbname`,
 *      `database`, `user`, `password`) is rejected up front with
 *      `INVENTORY_TEST_TARGET_ENV_OVERRIDE`. Loopback / protected-port / marker-port / database-name
 *      checks then run on the parsed host/port/database, not on `new URL()`'s main part.
 *   2. **A file check is not proof of the live server.** After a real client connects and before any
 *      write, `assertConnectedTarget(client, guard, purpose)` opens `BEGIN READ ONLY`, reads
 *      `current_database()`, `inet_server_addr()` and `inet_server_port()`, compares them with the
 *      marker, rolls back, and throws `INVENTORY_TEST_TARGET_DB_VERIFY_MISMATCH` on any difference.
 *      `inet_server_addr()` is NULL for a Unix-domain socket; that case is treated as loopback and
 *      recorded explicitly instead of being silently accepted.
 *
 * The checks are file/parse-only until a caller passes an already-connected client; nothing here opens
 * a connection. A missing/invalid/foreign marker is a hard error with an `INVENTORY_TEST_TARGET_*`
 * code; callers must not fall back to an old/default instance.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parse as parsePgConnectionString } from 'pg-connection-string';

export const PACKAGE = 'inventory-sync-v1';

/** Delivered/candidate instance run ids that must never be written by a drill/test tool. */
export const PROTECTED_RUN_IDS = new Set([
  'run-20261025T175500Z-f7a8b9c0', // 3031 / PG50499 delivered v1-repair instance
  'run-20261026T013000Z-b4d7f2e1', // 3032 / PG59532 delivered candidate
  'run-20261026T123800Z-d3f4a5b6', // 3033 / PG53442 v3 delivered field
]);

/** Old 3031 / PG50499, the delivered 3032 / PG59532 and the delivered 3033 / PG53442 database ports. */
export const PROTECTED_DB_PORTS = new Set([50499, 59532, 53442]);

/** Query parameters that can change the driver's final connection target; any of them is rejected. */
export const ENV_OVERRIDE_KEYS = new Set(['host', 'hostaddr', 'port', 'dbname', 'database', 'user', 'password']);

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0:0:0:0:0:0:0:1']);
const DATABASE_URL_KEYS = [
  'P0_02_APP_DATABASE_URL',
  'P0_02_SYNC_DATABASE_URL',
  'P0_02_AUTH_DATABASE_URL',
  'ownerDbUrl',
  'appDbUrl',
  'syncDbUrl',
];

export class TestTargetError extends Error {
  constructor(code, message) {
    super(`${code}:${message}`);
    this.name = 'TestTargetError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new TestTargetError(code, message);
}

function normalizeHost(value) {
  // `inet_server_addr()::text` renders an inet with its netmask (e.g. `127.0.0.1/32`); strip it.
  return String(value ?? '').trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\/\d{1,2}$/, '');
}

/** True for every loopback spelling the driver / PostgreSQL can report. */
export function isLoopbackHost(value) {
  const host = normalizeHost(value);
  if (!host) return false;
  if (LOOPBACK_HOSTS.has(host)) return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
    || /^(::ffff:)?127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/i.test(host);
}

/** Normalize a run id / database name to its comparable alphanumeric form. */
export function normalizeRunId(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/** Where the instance / run markers live for a given instance root. */
export function testMarkerPaths(instanceRoot) {
  const resolved = path.resolve(String(instanceRoot));
  const runRoot = path.basename(resolved).toLowerCase() === 'instance'
    ? path.dirname(resolved)
    : resolved;
  return {
    instanceRoot: resolved,
    runRoot,
    instanceMarker: path.join(resolved, 'inventory-instance.json'),
    manifestMarker: path.join(runRoot, 'inventory-manifest.json'),
  };
}

/**
 * Read the writable-test marker without validating it.
 *
 * Returns `{ instanceRoot, runRoot, markerPath, source, marker }`, or `null` when neither marker file
 * exists. Invalid JSON returns `{ ..., marker: null, invalid: true, error }` so callers can report the
 * exact file instead of treating an unreadable marker as "no marker".
 */
export function readWritableTestMarker(instanceRoot) {
  const paths = testMarkerPaths(instanceRoot);
  const candidates = [
    { markerPath: paths.instanceMarker, source: 'inventory-instance.json' },
    { markerPath: paths.manifestMarker, source: 'inventory-manifest.json' },
  ];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate.markerPath)) continue;
    try {
      const raw = fs.readFileSync(candidate.markerPath, 'utf8');
      const marker = JSON.parse(raw);
      if (!marker || typeof marker !== 'object' || Array.isArray(marker)) {
        return { ...paths, ...candidate, marker: null, invalid: true, error: 'marker is not a JSON object' };
      }
      return { ...paths, ...candidate, marker };
    } catch (error) {
      return { ...paths, ...candidate, marker: null, invalid: true, error: String(error?.message ?? error) };
    }
  }
  return null;
}

function databaseNameMatches(databaseName, runId) {
  const normDb = normalizeRunId(databaseName);
  const normRun = normalizeRunId(runId);
  if (!normDb || !normRun) return false;
  return normDb === normRun || normDb === `iceos_catalog_${normRun}` || normDb.endsWith(`_${normRun}`);
}

/**
 * Resolve the host/port/database the installed `pg` driver will actually connect to for a URL.
 *
 * `pg-connection-string` is exactly what `pg.Client({ connectionString })` uses; it lets `host`,
 * `port`, `user`, `password` (and `dbname` on older driver paths) query parameters win over the URL
 * main part. The remaining fallbacks mirror `pg/lib/connection-parameters.js`:
 * `PGHOST` -> `localhost`, `PGPORT` -> 5432, `PGDATABASE` -> the user name.
 *
 * @returns {{host:string, port:number, database:string, user:string|null, overrides:string[]}}
 */
export function resolveDriverTarget(connectionString, env = process.env) {
  const text = String(connectionString ?? '').trim();
  const parsed = parsePgConnectionString(text);
  const overrides = [];
  try {
    const url = new URL(text);
    for (const [key] of url.searchParams) {
      if (ENV_OVERRIDE_KEYS.has(String(key).toLowerCase())) overrides.push(String(key));
    }
  } catch {
    /* parse() already handled URL variants; override detection is best-effort here */
  }
  const user = parsed.user || env.PGUSER || null;
  const host = normalizeHost(parsed.host || env.PGHOST || 'localhost');
  const port = Number(parsed.port || env.PGPORT || 5432);
  const database = String(parsed.database || env.PGDATABASE || user || '');
  return { host, port, database, user, overrides };
}

function assertEnvUrlTarget({ key, value, markerRunId, markerDatabase }) {
  const text = String(value);
  let url;
  try {
    url = new URL(text);
  } catch {
    fail('INVENTORY_TEST_TARGET_ENV_INVALID', `${key} is not a valid URL`);
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    fail('INVENTORY_TEST_TARGET_ENV_INVALID', `${key} is not a PostgreSQL URL`);
  }
  // Any query parameter that can override the driver's final target is refused before connecting:
  // the guard must never accept "checked address != connected address".
  const overrides = [];
  for (const [param] of url.searchParams) {
    if (ENV_OVERRIDE_KEYS.has(String(param).toLowerCase())) overrides.push(String(param));
  }
  if (overrides.length > 0) {
    fail('INVENTORY_TEST_TARGET_ENV_OVERRIDE',
      `${key} has connection-target override query parameter(s) ${overrides.join(',')}; `
      + 'remove them instead of relying on the URL main part');
  }
  const target = resolveDriverTarget(text);
  if (!isLoopbackHost(target.host)) {
    fail('INVENTORY_TEST_TARGET_HOST_DENIED', `${key} driver target host ${target.host} is not loopback`);
  }
  if (!Number.isInteger(target.port) || target.port <= 0 || target.port > 65535) {
    fail('INVENTORY_TEST_TARGET_ENV_INVALID', `${key} has no valid port (${String(target.port)})`);
  }
  if (PROTECTED_DB_PORTS.has(target.port)) {
    fail('INVENTORY_TEST_TARGET_PROTECTED_PORT', `${key} driver target uses protected database port ${target.port}`);
  }
  if (target.port !== Number(markerDatabase.port)) {
    fail('INVENTORY_TEST_TARGET_ENV_MISMATCH',
      `${key} driver target port ${target.port} does not match marker database port ${markerDatabase.port}`);
  }
  if (!databaseNameMatches(target.database, markerRunId)) {
    fail('INVENTORY_TEST_TARGET_ENV_MISMATCH',
      `${key} driver target database ${target.database || '<empty>'} does not belong to ${markerRunId}`);
  }
  return { key, host: target.host, port: target.port, database: target.database, resolvedBy: 'pg-connection-string' };
}

function assertEnvironmentalTargets({ env, markerRunId, markerDatabase }) {
  if (!env || typeof env !== 'object') return [];
  const checked = [];
  for (const key of DATABASE_URL_KEYS) {
    const value = env[key];
    if (value == null || value === '') continue;
    checked.push(assertEnvUrlTarget({ key, value, markerRunId, markerDatabase }));
  }
  return checked;
}

function assertInstanceTarget({ instance, markerRunId, markerDatabase }) {
  if (!instance || typeof instance !== 'object') return;
  if (instance.runId != null && String(instance.runId).trim() !== markerRunId) {
    fail('INVENTORY_TEST_TARGET_INSTANCE_MISMATCH',
      `instance runId ${instance.runId} does not match marker runId ${markerRunId}`);
  }
  if (instance.host != null && !isLoopbackHost(instance.host)) {
    fail('INVENTORY_TEST_TARGET_HOST_DENIED', `instance host ${instance.host} is not loopback`);
  }
  if (instance.port != null) {
    const port = Number(instance.port);
    if (PROTECTED_DB_PORTS.has(port)) {
      fail('INVENTORY_TEST_TARGET_PROTECTED_PORT', `instance uses protected database port ${port}`);
    }
    if (port !== Number(markerDatabase.port)) {
      fail('INVENTORY_TEST_TARGET_INSTANCE_MISMATCH',
        `instance port ${port} does not match marker database port ${markerDatabase.port}`);
    }
  }
  if (instance.dbName != null && !databaseNameMatches(instance.dbName, markerRunId)) {
    fail('INVENTORY_TEST_TARGET_INSTANCE_MISMATCH',
      `instance database ${instance.dbName} does not belong to ${markerRunId}`);
  }
}

function describeDatabase(host, port, name) {
  return { host: normalizeHost(host), port: Number(port), name: String(name ?? '').trim() };
}

/**
 * Assert that a maintenance/drill entry point may write to its target.
 *
 * @param {object} options
 * @param {string} options.instanceRoot  Instance directory (e.g. `.local/catalog/<run>/instance`).
 * @param {string} [options.runId]       Run being operated; must equal the marker run id.
 * @param {object} [options.instance]    Optional catalog instance marker (cross-checked when present).
 * @param {object} [options.env]         Optional inventory env (DB URLs cross-checked when present).
 * @param {string} [options.purpose]     Human-readable purpose recorded in the return/error context.
 * @returns {{ok:true, instanceRoot:string, runRoot:string, markerPath:string, marker:object,
 *            runId:string, database:object, envTargets:Array<object>, purpose:string|null}}
 */
export function assertWritableTestTarget({ instanceRoot, runId, instance, env, purpose } = {}) {
  if (typeof instanceRoot !== 'string' || !instanceRoot.trim()) {
    fail('INVENTORY_TEST_TARGET_INSTANCE_REQUIRED',
      'no writable test instance directory was provided');
  }
  const found = readWritableTestMarker(instanceRoot);
  if (!found) {
    fail('INVENTORY_TEST_TARGET_MARKER_MISSING',
      `no inventory-instance.json / inventory-manifest.json under ${path.resolve(instanceRoot)}`);
  }
  if (found.invalid || !found.marker) {
    fail('INVENTORY_TEST_TARGET_MARKER_INVALID',
      `${found.markerPath} is not a readable marker: ${found.error ?? 'unknown error'}`);
  }
  const marker = found.marker;
  if (marker.package !== PACKAGE) {
    fail('INVENTORY_TEST_TARGET_PACKAGE_MISMATCH',
      `${found.markerPath} package ${String(marker.package)} is not ${PACKAGE}`);
  }
  if (marker.testWritable !== true) {
    fail('INVENTORY_TEST_TARGET_NOT_WRITABLE',
      `${found.markerPath} does not declare testWritable=true (read-only/protected instance)`);
  }
  const markerRunId = String(marker.runId ?? '').trim();
  if (!markerRunId) fail('INVENTORY_TEST_TARGET_RUN_ID_REQUIRED', 'marker has no runId');
  const requestedRunId = runId == null ? markerRunId : String(runId).trim();
  if (!requestedRunId) fail('INVENTORY_TEST_TARGET_RUN_ID_REQUIRED', 'run id is empty');
  if (requestedRunId !== markerRunId) {
    fail('INVENTORY_TEST_TARGET_RUN_ID_MISMATCH',
      `requested run ${requestedRunId} does not match marker run ${markerRunId}`);
  }
  if (PROTECTED_RUN_IDS.has(markerRunId) || PROTECTED_RUN_IDS.has(requestedRunId)) {
    fail('INVENTORY_TEST_TARGET_PROTECTED_RUN',
      `run ${markerRunId} is a protected/delivered instance and must not be written`);
  }

  const database = marker.database;
  if (!database || typeof database !== 'object') {
    fail('INVENTORY_TEST_TARGET_DATABASE_MISSING', 'marker has no database object');
  }
  if (!isLoopbackHost(database.host)) {
    fail('INVENTORY_TEST_TARGET_HOST_DENIED', `database host ${String(database.host)} is not loopback`);
  }
  const port = Number(database.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    fail('INVENTORY_TEST_TARGET_PORT_INVALID', `database port ${String(database.port)} is invalid`);
  }
  if (PROTECTED_DB_PORTS.has(port)) {
    fail('INVENTORY_TEST_TARGET_PROTECTED_PORT', `database port ${port} is protected`);
  }
  const databaseName = String(database.name ?? '').trim();
  if (!databaseName) fail('INVENTORY_TEST_TARGET_DATABASE_MISSING', 'marker has no database name');
  if (!databaseNameMatches(databaseName, markerRunId)) {
    fail('INVENTORY_TEST_TARGET_DATABASE_MISMATCH',
      `database ${databaseName} does not belong to run ${markerRunId}`);
  }

  assertInstanceTarget({ instance, markerRunId, markerDatabase: database });
  const envTargets = assertEnvironmentalTargets({ env, markerRunId, markerDatabase: database });

  return {
    ok: true,
    instanceRoot: found.instanceRoot,
    runRoot: found.runRoot,
    markerPath: found.markerPath,
    marker,
    runId: markerRunId,
    database: describeDatabase(database.host, database.port, databaseName),
    envTargets,
    purpose: purpose ?? null,
  };
}

/**
 * Build a connected-target guard from an instance record instead of the writable marker file.
 *
 * Used in two narrow cases where the writable marker is not (yet) available but the live identity still
 * has to be proven:
 *   - `prepare-instance.mjs` opens the bootstrap connection before it writes `inventory-instance.json`;
 *   - read-only inspection of an already-delivered instance (never a write path).
 *
 * It performs the same database-identity validation as `assertWritableTestTarget` but does not require
 * `testWritable=true`; callers that write must use `assertWritableTestTarget` instead.
 *
 * @param {boolean} [options.allowProtectedTarget] read-only inspection of a delivered instance: the
 *   protected run id / port are not rejected, because nothing is written; the live identity is still
 *   compared in full by `assertConnectedTarget`.
 *
 * @returns {{ok:true, instanceRoot:string|null, markerPath:string|null, marker:object|null,
 *            runId:string, database:object, writable:boolean, purpose:string|null}}
 */
export function buildConnectedTargetGuard({ instanceRoot, instance, runId, purpose, allowProtectedTarget = false } = {}) {
  let found = null;
  if (typeof instanceRoot === 'string' && instanceRoot.trim()) {
    found = readWritableTestMarker(instanceRoot);
    if (found?.invalid) {
      fail('INVENTORY_TEST_TARGET_MARKER_INVALID',
        `${found.markerPath} is not a readable marker: ${found.error ?? 'unknown error'}`);
    }
  }
  const marker = found?.marker ?? null;
  const source = marker ?? instance;
  if (!source || typeof source !== 'object') {
    fail('INVENTORY_TEST_TARGET_INSTANCE_REQUIRED',
      'no marker and no instance record were provided for the connected-target guard');
  }
  const markerRunId = String(runId ?? marker?.runId ?? instance?.runId ?? '').trim();
  if (!markerRunId) fail('INVENTORY_TEST_TARGET_RUN_ID_REQUIRED', 'no run id for the connected-target guard');
  if (!allowProtectedTarget && PROTECTED_RUN_IDS.has(markerRunId)) {
    fail('INVENTORY_TEST_TARGET_PROTECTED_RUN',
      `run ${markerRunId} is a protected/delivered instance and must not be written`);
  }
  const database = marker?.database ?? { host: instance.host, port: instance.port, name: instance.dbName };
  if (!database || typeof database !== 'object') {
    fail('INVENTORY_TEST_TARGET_DATABASE_MISSING', 'instance record has no database identity');
  }
  if (!isLoopbackHost(database.host)) {
    fail('INVENTORY_TEST_TARGET_HOST_DENIED', `database host ${String(database.host)} is not loopback`);
  }
  const port = Number(database.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    fail('INVENTORY_TEST_TARGET_PORT_INVALID', `database port ${String(database.port)} is invalid`);
  }
  if (!allowProtectedTarget && PROTECTED_DB_PORTS.has(port)) {
    fail('INVENTORY_TEST_TARGET_PROTECTED_PORT', `database port ${port} is protected`);
  }
  const databaseName = String(database.name ?? '').trim();
  if (!databaseName) fail('INVENTORY_TEST_TARGET_DATABASE_MISSING', 'instance record has no database name');
  if (!databaseNameMatches(databaseName, markerRunId)) {
    fail('INVENTORY_TEST_TARGET_DATABASE_MISMATCH',
      `database ${databaseName} does not belong to run ${markerRunId}`);
  }
  return {
    ok: true,
    instanceRoot: found?.instanceRoot ?? (typeof instanceRoot === 'string' ? path.resolve(instanceRoot) : null),
    markerPath: found?.markerPath ?? null,
    marker,
    runId: markerRunId,
    database: describeDatabase(database.host, database.port, databaseName),
    writable: marker ? marker.testWritable === true : false,
    purpose: purpose ?? null,
  };
}

/**
 * Prove the **live** server identity of an already-connected client before it is allowed to write.
 *
 * Runs `BEGIN READ ONLY` -> `SELECT current_database(), inet_server_addr(), inet_server_port()` ->
 * `ROLLBACK` and compares the result with the guard built by `assertWritableTestTarget` /
 * `buildConnectedTargetGuard`:
 *   - database name must equal `guard.database.name` (or one explicitly allowed scratch name);
 *   - server port must equal `guard.database.port` (so a driver-side `?port=` override or a wrong
 *     profile cannot pass);
 *   - `inet_server_addr()` must be loopback when it is not NULL; NULL (Unix-domain socket) is treated
 *     as loopback and recorded as such.
 * Any difference throws `INVENTORY_TEST_TARGET_DB_VERIFY_MISMATCH`.
 *
 * @param {{query:Function}} client connected pg client (any role)
 * @param {object} guard result of assertWritableTestTarget / buildConnectedTargetGuard
 * @param {string} [purpose]
 * @param {{allowDatabaseNames?:string[]}} [options] read-only scratch targets (e.g. backup restore copy)
 * @returns {Promise<{ok:true, purpose:string, expected:object, observed:object, addressIsNull:boolean}>}
 */
export async function assertConnectedTarget(client, guard, purpose = 'connected-target', options = {}) {
  const expected = guard?.database;
  if (!client || typeof client.query !== 'function') {
    fail('INVENTORY_TEST_TARGET_DB_VERIFY_MISMATCH',
      `${purpose}: no connected client was provided for the post-connect identity check`);
  }
  if (!expected || !expected.name) {
    fail('INVENTORY_TEST_TARGET_GUARD_REQUIRED',
      `${purpose}: guard has no database identity (run assertWritableTestTarget / buildConnectedTargetGuard first)`);
  }
  const allowedNames = Array.isArray(options.allowDatabaseNames) && options.allowDatabaseNames.length > 0
    ? options.allowDatabaseNames.map((name) => String(name))
    : [String(expected.name)];

  let row = null;
  let identityError = null;
  let beginError = null;
  try {
    await client.query('BEGIN READ ONLY');
  } catch (error) {
    beginError = error;
  }
  if (beginError) {
    try { await client.query('ROLLBACK'); } catch { /* no transaction to roll back */ }
    fail('INVENTORY_TEST_TARGET_DB_VERIFY_MISMATCH',
      `${purpose}: read-only identity transaction could not start (${beginError.message}); refusing any write`);
  }
  try {
    const result = await client.query(
      `SELECT current_database() AS database,
              host(inet_server_addr()) AS address,
              inet_server_port() AS port`);
    row = result?.rows?.[0] ?? null;
  } catch (error) {
    identityError = error;
  }
  let rollbackError = null;
  try {
    await client.query('ROLLBACK');
  } catch (error) {
    rollbackError = error;
  }
  if (identityError || rollbackError) {
    fail('INVENTORY_TEST_TARGET_DB_VERIFY_MISMATCH',
      `${purpose}: read-only identity transaction failed (identity=${identityError?.message ?? 'ok'}, `
      + `rollback=${rollbackError?.message ?? 'ok'})`);
  }
  if (!row) {
    fail('INVENTORY_TEST_TARGET_DB_VERIFY_MISMATCH', `${purpose}: identity query returned no row`);
  }

  const observed = {
    database: row.database == null ? null : String(row.database),
    address: row.address == null ? null : String(row.address),
    port: row.port == null ? null : Number(row.port),
  };
  const problems = [];
  if (!allowedNames.includes(String(observed.database))) {
    problems.push(`database ${String(observed.database)} is not ${allowedNames.join('/')}`);
  }
  if (Number(observed.port) !== Number(expected.port)) {
    problems.push(`server port ${String(observed.port)} != marker port ${expected.port}`);
  }
  if (observed.address !== null && !isLoopbackHost(observed.address)) {
    problems.push(`server address ${observed.address} is not loopback`);
  }
  if (!isLoopbackHost(expected.host)) {
    problems.push(`marker host ${expected.host} is not loopback`);
  }
  if (problems.length > 0) {
    fail('INVENTORY_TEST_TARGET_DB_VERIFY_MISMATCH',
      `${purpose}: ${problems.join('; ')} `
      + `(observed=${JSON.stringify(observed)}, marker=${JSON.stringify(expected)})`);
  }

  return {
    ok: true,
    purpose,
    expected: { database: String(expected.name), host: normalizeHost(expected.host), port: Number(expected.port) },
    observed,
    addressIsNull: observed.address === null,
    addressSource: observed.address === null
      ? 'inet_server_addr()=NULL (domain/unix socket) — treated as loopback, recorded'
      : 'inet_server_addr()',
    verifiedAt: new Date().toISOString(),
  };
}

/**
 * Convenience wrapper: connect a pg client, prove the live identity, and only then hand it to the
 * caller. Kept here so maintenance scripts cannot accidentally run the identity check after a write.
 */
export async function connectVerifiedTarget({ pg, connectionString, guard, purpose, clientOptions = {} }) {
  if (!pg?.Client) throw new TestTargetError('INVENTORY_TEST_TARGET_CLIENT_REQUIRED', 'pg module is required');
  const client = new pg.Client({ connectionString, ...clientOptions });
  await client.connect();
  try {
    const verification = await assertConnectedTarget(client, guard, purpose);
    return { client, verification };
  } catch (error) {
    try { await client.end(); } catch { /* ignore */ }
    throw error;
  }
}
