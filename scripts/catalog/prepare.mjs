import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { startPostgresServer } from '../p0-02/postgres-process.mjs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CATALOG_ROOT = path.join(REPO_ROOT, '.local', 'catalog');
const RUN_PATTERN = /^run-\d{8}T\d{6}Z-[a-f0-9]{8}$/;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
export const FIXTURE_IDS = Object.freeze({
  admin: '11111111-1111-4111-8111-111111111101',
  operator: '11111111-1111-4111-8111-111111111104',
  inactive: '11111111-1111-4111-8111-111111111106',
});

export function readArgs(argv = process.argv.slice(2)) {
  const index = argv.indexOf('--run-id');
  const runId = index < 0 ? undefined : argv[index + 1];
  if (!runId || !RUN_PATTERN.test(runId)) throw new Error('CATALOG_RUN_ID_REQUIRED: use a fresh run-YYYYMMDDTHHMMSSZ-8hex');
  const hostIndex = argv.indexOf('--host');
  const host = hostIndex < 0 ? '127.0.0.1' : argv[hostIndex + 1];
  if (!LOOPBACK.has(host)) throw new Error('CATALOG_NON_LOOPBACK_DENIED');
  if (fs.existsSync(path.join(REPO_ROOT, '.local', 'p0-02', runId))) throw new Error('CATALOG_OLD_RUN_DENIED');
  const root = path.resolve(CATALOG_ROOT, runId);
  if (path.dirname(root) !== CATALOG_ROOT) throw new Error('CATALOG_PATH_ESCAPE');
  for (const location of [path.join(REPO_ROOT, '.local'), CATALOG_ROOT, root]) {
    if (fs.existsSync(location) && fs.lstatSync(location).isSymbolicLink()) throw new Error('CATALOG_LINK_DENIED');
  }
  return { runId, host, root, instanceRoot: path.join(root, 'instance') };
}

export function hashFile(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
export function newEvidence(root, label) {
  fs.mkdirSync(path.join(root, 'evidence'), { recursive: true });
  const dir = path.join(root, 'evidence', `${label}-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: false });
  return dir;
}
export function safeEnv(extra = {}) {
  const env = {};
  const allowed = /^(PATH|Path|PATHEXT|SystemRoot|SYSTEMROOT|TEMP|TMP|USERPROFILE|HOMEDRIVE|HOMEPATH|COMPUTERNAME|NUMBER_OF_PROCESSORS|OS|PROCESSOR_ARCHITECTURE|WINDIR|ComSpec|APPDATA|LOCALAPPDATA|USERNAME|USERDOMAIN|SESSIONNAME|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|CommonProgramFiles|CommonProgramFiles\(x86\)|CommonProgramW6432|CI|TERM|FORCE_COLOR|NO_COLOR)$/;
  for (const [key, value] of Object.entries(process.env)) if (allowed.test(key)) env[key] = value;
  return { ...env, NEXT_TELEMETRY_DISABLED: '1', ...extra };
}

/** Windows: prevent detached postgres/next from opening a visible console window. */
export const WIN_CREATE_NO_WINDOW = 0x08000000;
export function detachedHiddenSpawnOptions(extra = {}) {
  const opts = { detached: true, windowsHide: true, ...extra };
  if (process.platform === 'win32') opts.creationFlags = (opts.creationFlags ?? 0) | WIN_CREATE_NO_WINDOW;
  return opts;
}

export function runCommand(command, args, { cwd = REPO_ROOT, env = safeEnv(), evidenceDir, name = 'command' } = {}) {
  const startedAt = new Date().toISOString();
  const syncOpts = { cwd, env, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 };
  if (process.platform === 'win32') syncOpts.creationFlags = WIN_CREATE_NO_WINDOW;
  const result = spawnSync(command, args, syncOpts);
  if (evidenceDir) {
    // No environment or connection credentials are written to ordinary receipts.
    writeJson(path.join(evidenceDir, `${name}.json`), { command, args, cwd, startedAt, endedAt: new Date().toISOString(), exitCode: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr, error: result.error?.message });
  }
  if (result.status !== 0) throw new Error(`CATALOG_COMMAND_FAILED:${name}:${result.status ?? result.error?.code}`);
  return result;
}

export function openRun(args = readArgs()) {
  const markerFile = path.join(args.instanceRoot, 'catalog-instance.json');
  if (!fs.existsSync(markerFile)) throw new Error('CATALOG_INSTANCE_MISSING');
  const instance = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
  if (instance.runId !== args.runId || !['catalog-isolated-v1', 'catalog-local-preview-v1'].includes(instance.label) || !LOOPBACK.has(instance.host)) throw new Error('CATALOG_INSTANCE_MISMATCH');
  if (path.resolve(instance.dataDir) !== path.join(args.instanceRoot, 'pgdata') || fs.lstatSync(args.instanceRoot).isSymbolicLink() || fs.lstatSync(instance.dataDir).isSymbolicLink()) throw new Error('CATALOG_INSTANCE_PATH_MISMATCH');
  const expectedDb = `iceos_catalog_${args.runId.replace(/[^a-z0-9]+/gi, '_')}`;
  if (instance.dbName !== expectedDb) throw new Error('CATALOG_DATABASE_MISMATCH');
  const env = JSON.parse(fs.readFileSync(path.join(args.instanceRoot, 'env.catalog.json'), 'utf8'));
  for (const key of ['P0_02_APP_DATABASE_URL', 'P0_02_AUTH_DATABASE_URL', 'P0_02_SYNC_DATABASE_URL']) {
    const url = new URL(env[key]);
    if (url.hostname !== instance.host || Number(url.port) !== instance.port || decodeURIComponent(url.pathname.slice(1)) !== expectedDb) throw new Error('CATALOG_ENV_TARGET_MISMATCH');
  }
  if (env.P0_02_RUN_ID !== args.runId) throw new Error('CATALOG_ENV_RUN_MISMATCH');
  return { ...args, instance, env };
}

export async function assertLiveInstance(run) {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: run.env.P0_02_APP_DATABASE_URL, max: 1 });
  try {
    const { rows } = await pool.query(`SELECT current_database() AS database, inet_server_port() AS port, current_user AS runtime, (SELECT run_id FROM p0_02_meta.platform_instance LIMIT 1) AS run_id`);
    const row = rows[0];
    if (row.database !== run.instance.dbName || row.port !== run.instance.port || row.run_id !== run.runId || row.runtime !== run.instance.appRunnerUser) throw new Error('CATALOG_LIVE_MARKER_MISMATCH');
    return { database: row.database, port: row.port, runId: row.run_id, runtime: row.runtime };
  } finally { await pool.end(); }
}

const COPY_ENTRIES = ['src', 'public', 'db', 'scripts', 'tests/catalog', 'docs/catalog', 'package.json', 'package-lock.json', 'next.config.ts', 'tsconfig.json', 'postcss.config.mjs', 'eslint.config.mjs', 'components.json', 'vitest.config.catalog.mts', 'playwright.config.catalog.ts'];
export function collectWorkspaceSourceHashes() {
  const files = {};
  function walk(root, relative = '') {
    for (const child of fs.readdirSync(root, { withFileTypes: true })) {
      const rel = path.posix.join(relative.replace(/\\/g, '/'), child.name);
      const full = path.join(root, child.name);
      if (child.isSymbolicLink()) throw new Error('CATALOG_SOURCE_LINK_DENIED');
      if (child.isDirectory()) walk(full, rel); else files[rel] = hashFile(full);
    }
  }
  for (const entry of COPY_ENTRIES) {
    const full = path.join(REPO_ROOT, entry);
    if (!fs.existsSync(full)) continue;
    if (fs.statSync(full).isDirectory()) walk(full, entry); else files[entry] = hashFile(full);
  }
  const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
  return sorted;
}
export function snapshotWorkspace(workspace) {
  const sorted = collectWorkspaceSourceHashes();
  for (const [relative, sha] of Object.entries(sorted)) {
    const destination = path.join(workspace, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, relative), destination);
    if (hashFile(destination) !== sha) throw new Error('CATALOG_WORKSPACE_COPY_MISMATCH');
  }
  const nodeModules = path.join(workspace, 'node_modules');
  fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), nodeModules, process.platform === 'win32' ? 'junction' : 'dir');
  return { createdAt: new Date().toISOString(), sourceRoot: REPO_ROOT, workspace, files: sorted, sourceSnapshotHash: crypto.createHash('sha256').update(JSON.stringify(sorted)).digest('hex') };
}

async function pickPort() {
  return new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const address = server.address(); server.close(() => resolve(address.port)); }); });
}

export async function prepare(argv = process.argv.slice(2)) {
  // All destination, old-run and host guards execute before loading any reusable helper or database library.
  const args = readArgs(argv);
  if (fs.existsSync(args.instanceRoot)) {
    if (fs.lstatSync(args.instanceRoot).isSymbolicLink() || fs.readdirSync(args.instanceRoot).length) throw new Error('CATALOG_NONEMPTY_TARGET_DENIED');
  }
  for (const name of ['P0_02_APP_DATABASE_URL', 'P0_02_AUTH_DATABASE_URL', 'P0_02_SYNC_DATABASE_URL', 'DATABASE_URL', 'PGHOST', 'PGPORT', 'PGDATABASE']) {
    if (process.env[name]) throw new Error(`CATALOG_INHERITED_TARGET_DENIED:${name}`);
  }
  const bin = path.join(REPO_ROOT, '.local', 'p0-02', 'run-20261014-r2', 'pg', 'pgsql', 'bin');
  for (const exe of ['initdb', 'postgres', 'psql']) if (!fs.existsSync(path.join(bin, `${exe}.exe`))) throw new Error('CATALOG_LOCAL_BINARY_MISSING');
  for (const file of ['db/catalog/001_catalog.sql', 'db/catalog/002_catalog_security.sql']) if (!fs.existsSync(path.join(REPO_ROOT, file))) throw new Error(`CATALOG_DDL_MISSING:${file}`);
  fs.mkdirSync(args.root, { recursive: true });
  fs.mkdirSync(args.instanceRoot, { recursive: true });
  const evidenceDir = newEvidence(args.root, 'prepare');
  const { default: pg } = await import('pg');
  const { betterAuth } = await import('better-auth');
  const { getMigrations } = await import('better-auth/db/migration');
  const secret = () => crypto.randomBytes(32).toString('hex');
  const instance = { runId: args.runId, label: 'catalog-isolated-v1', host: '127.0.0.1', port: await pickPort(), dbName: `iceos_catalog_${args.runId.replace(/[^a-z0-9]+/gi, '_')}`, dataDir: path.join(args.instanceRoot, 'pgdata'), pgBinDir: bin, bootstrapUser: 'postgres', bootstrapPassword: secret(), appRunnerUser: 'ice_p0_02_app_runner', appRunnerPassword: secret(), authRunnerUser: 'ice_p0_02_auth_runner', authRunnerPassword: secret(), syncRunnerUser: 'ice_p0_02_sync_runner', syncRunnerPassword: secret(), betterAuthSecret: secret(), createdAt: new Date().toISOString() };
  // A private pending record permits attribution/recovery of this new instance after a failed bootstrap.
  writeJson(path.join(args.instanceRoot, 'catalog-bootstrap-pending.json'), instance);
  runCommand(path.join(bin, 'initdb.exe'), ['-D', instance.dataDir, '-U', 'postgres', '-A', 'trust', '--encoding=UTF8', '--locale=C'], { evidenceDir, name: 'initdb' });
  const postgresLog = path.join(args.instanceRoot, 'postgres.log');
  startPostgresServer({
    runRootDir: args.instanceRoot,
    dataDir: instance.dataDir,
    port: instance.port,
    host: instance.host,
    logFile: postgresLog,
    postgresExe: path.join(bin, 'postgres.exe'),
  });
  let bootstrap;
  for (let attempt = 0; attempt < 120; attempt++) {
    try { bootstrap = new pg.Client({ host: instance.host, port: instance.port, user: 'postgres', database: 'postgres' }); await bootstrap.connect(); break; }
    catch { await bootstrap?.end().catch(() => {}); bootstrap = undefined; await new Promise((resolve) => setTimeout(resolve, 250)); }
  }
  if (!bootstrap) throw new Error('CATALOG_POSTGRES_START_FAILED');
  await bootstrap.query(`ALTER USER postgres PASSWORD '${instance.bootstrapPassword}'`);
  await bootstrap.query(`CREATE DATABASE "${instance.dbName}"`);
  await bootstrap.end();
  const ownerConnection = `postgres://postgres:${instance.bootstrapPassword}@${instance.host}:${instance.port}/${instance.dbName}`;
  const owner = new pg.Client({ connectionString: ownerConnection }); await owner.connect();
  const applied = [];
  async function apply(relative) {
    const file = path.join(REPO_ROOT, relative); const sql = fs.readFileSync(file, 'utf8');
    await owner.query(sql); await owner.query('RESET ROLE; RESET ALL'); applied.push({ path: relative, sha256: hashFile(file) });
  }
  try {
    await apply('db/p0-02/001_instance_and_roles.sql');
    await owner.query(`ALTER ROLE ice_p0_02_auth_runner PASSWORD '${instance.authRunnerPassword}'; ALTER ROLE ice_p0_02_app_runner PASSWORD '${instance.appRunnerPassword}'; ALTER ROLE ice_p0_02_sync_runner PASSWORD '${instance.syncRunnerPassword}'`);
    await apply('db/p0-02/002_session_identity.sql');
    await owner.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public AUTHORIZATION ice_p0_02_owner');
    await apply('db/p0-02/003_extensions.sql');
    await apply('db/p0-02/010_public_schema.sql');
    await apply('db/p0-02/007_reference_data.sql');
    await apply('db/p0-02/003_auth_schema_grants.sql');
    await owner.query(`INSERT INTO p0_02_meta.platform_instance (run_id,label) VALUES ($1,'catalog-isolated-v1')`, [args.runId]);
    const authPool = new pg.Pool({ connectionString: `${ownerConnection}?options=${encodeURIComponent('-c search_path=p0_02_auth')}` });
    const auth = betterAuth({ appName: 'iceos-catalog-isolated-fixture', baseURL: 'http://127.0.0.1:3000', basePath: '/api/auth', secret: instance.betterAuthSecret, database: authPool, emailAndPassword: { enabled: true, disableSignUp: false } });
    await (await getMigrations(auth.options)).runMigrations();
    for (const relative of ['004_auth_runtime_grants.sql', '005_identity_resolution.sql', '006_least_privilege_grants.sql', '007_sync_runner_rls.sql', '008_runtime_grants_incremental.sql', '009_sync_reads_auth_rpc_deps.sql', '011_seal_app_inventory_quantity.sql', '012_tracking_event_partial_warehoused.sql', '013_sync_publish_unknown_guard.sql', '014_sync_publish_unknown_reconcile_evidence.sql', '015_sync_publish_unknown_hardening.sql']) await apply(`db/p0-02/${relative}`);
    for (const account of [
      { key: 'admin', role: 'admin', email: 'admin@catalog.test', password: 'CatalogAdmin123!', active: true },
      { key: 'operator', role: 'operator', email: 'operator@catalog.test', password: 'CatalogOperator123!', active: true },
      { key: 'inactive', role: 'admin', email: 'inactive@catalog.test', password: 'CatalogInactive123!', active: false },
    ]) {
      const created = await auth.api.signUpEmail({ body: { email: account.email, password: account.password, name: `ISOLATED TEST ${account.key}` } });
      const profileId = FIXTURE_IDS[account.key];
      await owner.query(`INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,'{}'::jsonb)`, [profileId, account.email]);
      await owner.query(`INSERT INTO public.profiles(id,display_name,role_id,is_active) SELECT $1,$2,id,$3 FROM public.role WHERE name=$4`, [profileId, `ISOLATED TEST ${account.key}`, account.active, account.role]);
      await owner.query(`INSERT INTO p0_02_meta.ice_auth_user_map(auth_user_id,ice_user_id) VALUES($1,$2)`, [created.user.id, profileId]);
    }
    await authPool.end();
    // Seed nonempty old public tables before the catalog boundary snapshot; no catalog action may touch these rows.
    await owner.query(`INSERT INTO public.warehouse(id,name,country,type,is_active) VALUES('33333333-3333-4333-8333-333333333301','ISOLATED TEST WAREHOUSE','CN','domestic',true); INSERT INTO public.product(id,code,name,unit) VALUES('44444444-4444-4444-8444-444444444401','TEST-CATALOG-OLD','ISOLATED OLD PRODUCT','件'); INSERT INTO public.product_variant(id,product_id,sku,country,name) VALUES('55555555-5555-4555-8555-555555555501','44444444-4444-4444-8444-444444444401','TEST-CATALOG-OLD-SKU','CN','ISOLATED OLD VARIANT'); INSERT INTO public.inventory(id,variant_id,warehouse_id,quantity) VALUES('66666666-6666-4666-8666-666666666601','55555555-5555-4555-8555-555555555501','33333333-3333-4333-8333-333333333301',17)`);
    const publicRows = {};
    for (const table of ['product', 'product_variant', 'inventory']) publicRows[table] = (await owner.query(`SELECT * FROM public.${table} ORDER BY id`)).rows;
    writeJson(path.join(args.root, 'public-three-tables-before.json'), publicRows);
    writeJson(path.join(args.root, 'schema-before-catalog.json'), {
      runId: args.runId,
      catalogSchemas: (await owner.query(`SELECT nspname FROM pg_namespace WHERE nspname IN('catalog','catalog_private') ORDER BY nspname`)).rows,
      publicTables: (await owner.query(`SELECT c.relname,pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN('product','product_variant','inventory') ORDER BY c.relname`)).rows,
      recordedAt: new Date().toISOString(),
    });
    await apply('db/catalog/001_catalog.sql'); await apply('db/catalog/002_catalog_security.sql');
    await owner.query('REVOKE ice_p0_02_owner FROM postgres');
    const hba = path.join(instance.dataDir, 'pg_hba.conf');
    fs.writeFileSync(hba, '# isolated catalog: password-only loopback\nhost all all 127.0.0.1/32 scram-sha-256\nhost all all ::1/128 scram-sha-256\n');
    await owner.query('SELECT pg_reload_conf()');
  } finally { await owner.end(); }
  const url = (user, password) => `postgres://${user}:${password}@${instance.host}:${instance.port}/${instance.dbName}`;
  const env = {
    P0_02_ENABLED: 'true', P0_02_RUN_ID: args.runId, P0_02_APP_DATABASE_URL: url(instance.appRunnerUser, instance.appRunnerPassword), P0_02_SYNC_DATABASE_URL: url(instance.syncRunnerUser, instance.syncRunnerPassword), P0_02_AUTH_DATABASE_URL: `${url(instance.authRunnerUser, instance.authRunnerPassword)}?options=${encodeURIComponent('-c search_path=p0_02_auth')}`, P0_02_BETTER_AUTH_SECRET: instance.betterAuthSecret, P0_02_BETTER_AUTH_URL: 'http://127.0.0.1:3000', P0_02_POOL_MAX: '2', P0_02_EXPECTED_HOST: instance.host, P0_02_EXPECTED_PORT: String(instance.port), P0_02_EXPECTED_DATABASE: instance.dbName, P0_02_EXPECTED_APP_USER: instance.appRunnerUser, P0_02_EXPECTED_AUTH_USER: instance.authRunnerUser, P0_02_EXPECTED_SYNC_USER: instance.syncRunnerUser, NEXT_PUBLIC_ICE_USE_BETTER_AUTH: 'true', P0_02_DISABLE_AUTH_RATE_LIMIT: 'true', CATALOG_RUN_ID: args.runId, CATALOG_RUN_ROOT: args.root, CATALOG_SOURCE_ROOT: REPO_ROOT, CATALOG_EVIDENCE_ROOT: path.join(args.root, 'private-evidence'),
  };
  writeJson(path.join(args.instanceRoot, 'catalog-instance.json'), instance);
  writeJson(path.join(args.instanceRoot, 'env.catalog.json'), env);
  writeJson(path.join(evidenceDir, 'bootstrap-manifest.json'), { runId: args.runId, isolated: true, host: instance.host, port: instance.port, database: instance.dbName, dataDir: instance.dataDir, applied, binaryHashes: Object.fromEntries(['postgres.exe', 'initdb.exe', 'psql.exe'].map((name) => [name, hashFile(path.join(bin, name))])), fixtures: Object.keys(FIXTURE_IDS), createdAt: new Date().toISOString() });
  await assertLiveInstance(openRun(args));
  console.log(`catalog prepare complete: ${args.runId}; fresh loopback instance; ${applied.length} frozen/bootstrap and catalog SQL files`);
  return args;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) prepare().catch((error) => {
  try { const args = readArgs(); if (fs.existsSync(args.root)) writeJson(path.join(newEvidence(args.root, 'prepare-failure'), 'failure.json'), { code: error.message, recordedAt: new Date().toISOString(), published: false }); } catch { /* invalid target must not create directories */ }
  console.error(error.message); process.exitCode = 1;
});
