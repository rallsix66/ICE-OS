import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const SOURCE_IDENTITY_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RUN_RE = /^run-\d{8}T\d{6}Z-[a-f0-9]{8}$/;
const ROOT = path.join(SOURCE_IDENTITY_REPO_ROOT, '.local/catalog');
export const FIXTURE_PINS = Object.freeze({
  'scope-grants.fixture.json': '379b1118ea2f68fda23ea8abee5b6f7bba5d8183f8991407a0b210cd084768f3',
  'products-v1.json': '4ca41781c8bcb3ed7ff2563cc414c1d9f120c63bc5977ebabe82c67c20c9cebb',
  'products-reordered-v2.json': '3f160b341941d2255412592b458931d6631483a6020b0030dee2dd729f836ae9',
  'products-conflicts-v3.json': 'f93833e1374b0b7c10bd29e9a377f2efd759b29ed041e9a39ce480c6b15af0a9',
});
const CONFIGS = ['vitest.config.catalog-source-identity.mts', 'playwright.config.catalog-source-identity.ts'];
const BASE_SQL = ['db/catalog/001_catalog.sql', 'db/catalog/002_catalog_security.sql'];
const N1_SQL = ['db/catalog/003_source_identity.sql', 'db/catalog/004_source_identity_security.sql'];
let ownedPrepareAttempt;
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
export const fileHash = (file) => hash(fs.readFileSync(file));

function rejectLinksTo(candidate) {
  const relative = path.relative(SOURCE_IDENTITY_REPO_ROOT, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('N1A_PATH_ESCAPE');
  let current = SOURCE_IDENTITY_REPO_ROOT;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('N1A_LINK_DENIED'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

/** Standard-library-only admission. No old helper/database/module is loaded here. */
export function sourceIdentityArgs(argv = process.argv.slice(2), { fresh = false } = {}) {
  const allowed = new Set(['--run-id', '--host']);
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!allowed.has(argv[index]) || !argv[index + 1] || parsed[argv[index]] !== undefined) throw new Error('N1A_ARGUMENT_DENIED');
    parsed[argv[index]] = argv[index + 1];
  }
  const runId = parsed['--run-id'];
  if (!runId || !RUN_RE.test(runId)) throw new Error('N1A_FRESH_RUN_REQUIRED');
  const host = parsed['--host'] ?? '127.0.0.1';
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('N1A_NON_LOOPBACK_DENIED');
  const root = path.join(ROOT, runId), instanceRoot = path.join(root, 'instance');
  rejectLinksTo(root);
  for (const lane of ['p0-01', 'p0-02', 'p0-03']) if (fs.existsSync(path.join(SOURCE_IDENTITY_REPO_ROOT, '.local', lane, runId))) throw new Error('N1A_OLD_RUN_DENIED');
  if (fresh && fs.existsSync(root)) throw new Error('N1A_EXISTING_RUN_ROOT_DENIED');
  if (fresh) {
    for (const key of Object.keys(process.env)) {
      if ((/(?:DATABASE_URL|CONNECTION_STRING)$/i.test(key) || /^PG(?:HOST|PORT|DATABASE|USER|PASSWORD|SERVICE|SERVICEFILE|PASSFILE|OPTIONS)$/i.test(key) || key === 'P0_02_RUN_ID') && process.env[key]) throw new Error(`N1A_INHERITED_TARGET_DENIED:${key}`);
      if (/^(?:P0_02|CATALOG|BETTER_AUTH|NEXT_PUBLIC_SUPABASE|SUPABASE).*URL$/i.test(key) && process.env[key]) {
        let inherited;
        try { inherited = new URL(process.env[key]); } catch { throw new Error(`N1A_INHERITED_TARGET_DENIED:${key}`); }
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(inherited.hostname)) throw new Error(`N1A_INHERITED_TARGET_DENIED:${key}`);
      }
    }
    if (process.env.CATALOG_RUN_ROOT && path.resolve(process.env.CATALOG_RUN_ROOT) !== root) throw new Error('N1A_INHERITED_ROOT_DENIED');
    if (process.env.CATALOG_SOURCE_ROOT && path.resolve(process.env.CATALOG_SOURCE_ROOT) !== SOURCE_IDENTITY_REPO_ROOT) throw new Error('N1A_INHERITED_SOURCE_DENIED');
  }
  return { runId, host, root, instanceRoot };
}

export const newRunId = () => `run-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}-${crypto.randomBytes(4).toString('hex')}`;
export async function sourceIdentityHelpers() { return import('./prepare.mjs'); }

export async function runSourceIdentityGuardNegatives(evidenceDirectory) {
  const helper = await sourceIdentityHelpers();
  const fixtureRoot = path.join(ROOT, newRunId());
  fs.mkdirSync(fixtureRoot); fs.writeFileSync(path.join(fixtureRoot, 'guard-sentinel.txt'), 'new guard fixture, preserve');
  fs.mkdirSync(path.join(fixtureRoot, 'instance')); fs.writeFileSync(path.join(fixtureRoot, 'instance/guard-target.dat'), 'nonempty new guard target');
  const emptyRunId = newRunId(), emptyRoot = path.join(ROOT, emptyRunId); fs.mkdirSync(emptyRoot);
  const rootRunId = path.basename(fixtureRoot), before = fileHash(path.join(fixtureRoot, 'guard-sentinel.txt'));
  const oldMarker = path.join(ROOT, 'run-20261020T084451Z-15fc329f/instance/catalog-instance.json');
  const oldMarkerBefore = fileHash(oldMarker);
  const linkRunId = newRunId(), linkRoot = path.join(ROOT, linkRunId);
  const linkTarget = path.join(evidenceDirectory, 'link-target'); fs.mkdirSync(linkTarget);
  fs.symlinkSync(linkTarget, linkRoot, process.platform === 'win32' ? 'junction' : 'dir');
  const observer = `import{registerHooks}from'node:module';import fs from'node:fs';import net from'node:net';registerHooks({resolve(s,c,n){if(s==='./prepare.mjs'||s==='pg'||s==='better-auth')throw Error('GUARD_HELPER_LOADED');return n(s,c)}});fs.mkdirSync=()=>{throw Error('GUARD_DIRECTORY_CREATED')};net.Socket.prototype.connect=function(){throw Error('GUARD_CONNECTION_OPENED')};`;
  const importObserver = `data:text/javascript,${encodeURIComponent(observer)}`;
  const cases = [
    { name: 'missing-run', args: [] },
    { name: 'old-p0-run', args: ['--run-id', 'run-20261014-r2'] },
    { name: 'old-catalog-run', args: ['--run-id', 'run-20261020T084451Z-15fc329f'] },
    { name: 'existing-empty-root', args: ['--run-id', emptyRunId] },
    { name: 'existing-root-and-nonempty-target', args: ['--run-id', rootRunId] },
    { name: 'nonloopback', args: ['--run-id', newRunId(), '--host', '203.0.113.8'] },
    { name: 'inherited-connection', args: ['--run-id', newRunId()], extra: { DATABASE_URL: 'postgres://fixture:fixture@203.0.113.8/no_connection' } },
    { name: 'inherited-external-auth-url', args: ['--run-id', newRunId()], extra: { P0_02_BETTER_AUTH_URL: 'https://203.0.113.8/no_connection' } },
    { name: 'link-escape', args: ['--run-id', linkRunId] },
    { name: 'arbitrary-url-argument', args: ['--run-id', newRunId(), '--url', 'postgres://203.0.113.8/no_connection'] },
  ];
  const results = cases.map((entry) => {
    const args = ['--import', importObserver, path.join(SOURCE_IDENTITY_REPO_ROOT, 'scripts/catalog/prepare-source-identity.mjs'), ...entry.args];
    const result = spawnSync(process.execPath, args, { cwd: SOURCE_IDENTITY_REPO_ROOT, env: helper.safeEnv(entry.extra ?? {}), encoding: 'utf8', windowsHide: true });
    const pass = result.status === 1 && /N1A_(?:FRESH_RUN_REQUIRED|EXISTING_RUN_ROOT_DENIED|NON_LOOPBACK_DENIED|INHERITED_TARGET_DENIED|LINK_DENIED|ARGUMENT_DENIED)/.test(result.stderr) && !/GUARD_(?:HELPER_LOADED|DIRECTORY_CREATED|CONNECTION_OPENED)/.test(result.stderr);
    return { name: entry.name, arguments: entry.args, exitCode: result.status, stdout: result.stdout, stderr: result.stderr, pass, helperDirectoryConnectionTrapsInstalled: true };
  });
  const sentinelUnchanged = fileHash(path.join(fixtureRoot, 'guard-sentinel.txt')) === before;
  const oldMarkerAfter = fileHash(oldMarker), oldMarkerUnchanged = oldMarkerBefore === oldMarkerAfter;
  helper.writeJson(path.join(evidenceDirectory, 'prepare-guard-negatives.json'), { results, sentinelUnchanged, oldMarker, oldMarkerBefore, oldMarkerAfter, oldMarkerUnchanged, fixtureRoot, emptyRoot, linkRoot, linkTarget, allPass: results.every((r) => r.pass) && sentinelUnchanged && oldMarkerUnchanged, fixtureDirectoriesPreserved: true });
  if (!results.every((r) => r.pass) || !sentinelUnchanged || !oldMarkerUnchanged) throw new Error('N1A_GUARD_NEGATIVE_FAILED');
}

function fixtureInputs() {
  const directory = path.join(SOURCE_IDENTITY_REPO_ROOT, 'tests/catalog/fixtures/source-identity');
  const inputs = {};
  for (const [name, sha] of Object.entries(FIXTURE_PINS)) {
    const file = path.join(directory, name); rejectLinksTo(file);
    const bytes = fs.readFileSync(file);
    if (hash(bytes) !== sha) throw new Error('N1A_FIXTURE_PIN_MISMATCH');
    inputs[name] = { bytes, value: JSON.parse(bytes.toString('utf8')) };
  }
  return inputs;
}

export async function openSourceIdentityRun(argv = process.argv.slice(2)) {
  const args = sourceIdentityArgs(argv);
  const helper = await sourceIdentityHelpers();
  const base = helper.openRun(args);
  const file = path.join(args.instanceRoot, 'source-identity-manifest.json'); rejectLinksTo(file);
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (manifest.label !== 'catalog-source-identity-fixture-v1' || manifest.fixtureMode !== 'fixture' || !manifest.nonceConsumed || manifest.runId !== args.runId || manifest.host !== base.instance.host || manifest.port !== base.instance.port || manifest.database !== base.instance.dbName || path.resolve(manifest.dataDir) !== path.resolve(base.instance.dataDir)) throw new Error('N1A_SECONDARY_MANIFEST_MISMATCH');
  if (manifest.primaryMarkerSha256 !== fileHash(path.join(args.instanceRoot, 'catalog-instance.json')) || manifest.baseEnvSha256 !== fileHash(path.join(args.instanceRoot, 'env.catalog.json'))) throw new Error('N1A_BASE_MARKER_CHANGED');
  for (const entry of [...manifest.baseDdl, ...manifest.sql]) if (fileHash(path.join(SOURCE_IDENTITY_REPO_ROOT, entry.path)) !== entry.sha256) throw new Error('N1A_DDL_SOURCE_CHANGED_USE_FRESH_RUN');
  const envFile = path.join(args.instanceRoot, 'env.catalog-source-identity.json');
  const env = JSON.parse(fs.readFileSync(envFile, 'utf8'));
  if (env.CATALOG_SOURCE_IDENTITY_ENABLED !== 'true' || env.CATALOG_SOURCE_IDENTITY_FIXTURE_RUN_ID !== args.runId || path.resolve(env.CATALOG_SOURCE_IDENTITY_MANIFEST) !== file) throw new Error('N1A_ENV_MARKER_MISMATCH');
  for (const key of ['P0_02_APP_DATABASE_URL', 'P0_02_AUTH_DATABASE_URL', 'P0_02_SYNC_DATABASE_URL']) if (env[key] !== base.env[key]) throw new Error('N1A_ENV_TARGET_CHANGED');
  return { ...base, env, manifest, envFile, helper };
}

export async function assertSourceIdentityLive(run) {
  const live = await run.helper.assertLiveInstance(run);
  const { default: pg } = await import('pg');
  const i = run.instance;
  const client = new pg.Client({ connectionString: `postgres://${i.bootstrapUser}:${i.bootstrapPassword}@${i.host}:${i.port}/${i.dbName}` });
  await client.connect();
  try {
    const row = (await client.query(`SELECT current_setting('data_directory') AS data_directory,current_database() AS database,inet_server_port() AS port,(SELECT run_id FROM p0_02_meta.platform_instance LIMIT 1) AS run_id`)).rows[0];
    if (path.resolve(row.data_directory) !== path.resolve(i.dataDir) || row.database !== i.dbName || row.port !== i.port || row.run_id !== run.runId) throw new Error('N1A_EXACT_LIVE_TARGET_MISMATCH');
    return { ...live, dataDirectory: row.data_directory, fixtureMode: run.manifest.fixtureMode };
  } finally { await client.end(); }
}

export async function collectSourceIdentityHashes() {
  const helper = await sourceIdentityHelpers();
  const files = { ...helper.collectWorkspaceSourceHashes() };
  for (const relative of CONFIGS) { const file = path.join(SOURCE_IDENTITY_REPO_ROOT, relative); rejectLinksTo(file); files[relative] = fileHash(file); }
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
}
export async function snapshotSourceIdentityWorkspace(workspace) {
  const helper = await sourceIdentityHelpers();
  helper.snapshotWorkspace(workspace);
  const files = await collectSourceIdentityHashes();
  for (const relative of CONFIGS) fs.copyFileSync(path.join(SOURCE_IDENTITY_REPO_ROOT, relative), path.join(workspace, relative));
  for (const [relative, sha] of Object.entries(files)) if (fileHash(path.join(workspace, relative)) !== sha) throw new Error('N1A_WORKSPACE_COPY_CHANGED');
  return { createdAt: new Date().toISOString(), sourceRoot: SOURCE_IDENTITY_REPO_ROOT, workspace, files, sourceSnapshotHash: hash(JSON.stringify(files)) };
}

export async function stopExactCatalogInstance(runId, evidenceDirectory, name = 'owned-instance-stop') {
  const args = sourceIdentityArgs(['--run-id', runId]);
  const helper = await sourceIdentityHelpers();
  const marker = path.join(args.instanceRoot, 'catalog-instance.json');
  if (!fs.existsSync(marker)) { helper.writeJson(path.join(evidenceDirectory, `${name}.json`), { runId, stopped: false, code: 'NO_COMPLETED_BASE_INSTANCE_MARKER', dataPreserved: true }); return; }
  const run = helper.openRun(args), i = run.instance;
  if (!fs.existsSync(path.join(i.dataDir, 'postmaster.pid'))) { helper.writeJson(path.join(evidenceDirectory, `${name}.json`), { runId, stopped: true, alreadyStopped: true, dataPreserved: true }); return; }
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: `postgres://${i.bootstrapUser}:${i.bootstrapPassword}@${i.host}:${i.port}/${i.dbName}` });
  await client.connect();
  let live;
  try { live = (await client.query(`SELECT current_setting('data_directory') AS data_directory,current_database() AS database,inet_server_port() AS port,(SELECT run_id FROM p0_02_meta.platform_instance LIMIT 1) AS run_id`)).rows[0]; } finally { await client.end(); }
  if (path.resolve(live.data_directory) !== path.resolve(i.dataDir) || live.database !== i.dbName || live.port !== i.port || live.run_id !== runId) throw new Error('N1A_STOP_TARGET_MISMATCH');
  helper.runCommand(path.join(i.pgBinDir, 'pg_ctl.exe'), ['stop', '-D', i.dataDir, '-m', 'fast', '-w'], { evidenceDir: evidenceDirectory, name, env: helper.safeEnv() });
  helper.writeJson(path.join(evidenceDirectory, `${name}-verified.json`), { runId, live, dataPreserved: fs.existsSync(i.dataDir), postmasterPidPresent: fs.existsSync(path.join(i.dataDir, 'postmaster.pid')), stoppedAt: new Date().toISOString() });
}

export async function prepareSourceIdentity(argv = process.argv.slice(2)) {
  const args = sourceIdentityArgs(argv, { fresh: true });
  const startedAt = new Date().toISOString();
  const nonce = crypto.randomBytes(32).toString('hex');
  const inputs = fixtureInputs();
  for (const file of N1_SQL) { rejectLinksTo(path.join(SOURCE_IDENTITY_REPO_ROOT, file)); if (!fs.existsSync(path.join(SOURCE_IDENTITY_REPO_ROOT, file))) throw new Error('N1A_DDL_NOT_READY'); }
  const baseDdl = BASE_SQL.map((relative) => ({ path: relative, sha256: fileHash(path.join(SOURCE_IDENTITY_REPO_ROOT, relative)) }));
  ownedPrepareAttempt = { runId: args.runId, root: args.root, startedAt };
  // This is the only installation path: the base helper is loaded only after
  // every admission check, and creates this absent root in this invocation.
  process.env.P0_02_RUN_ID = args.runId;
  const helper = await sourceIdentityHelpers();
  try { await helper.prepare(['--run-id', args.runId, '--host', args.host]); }
  finally { delete process.env.P0_02_RUN_ID; }
  const run = helper.openRun(args);
  const evidenceDirectory = helper.newEvidence(args.root, 'source-identity-prepare');
  const primaryMarkerSha256 = fileHash(path.join(args.instanceRoot, 'catalog-instance.json'));
  const baseEnvSha256 = fileHash(path.join(args.instanceRoot, 'env.catalog.json'));
  const nonceFile = path.join(args.instanceRoot, 'source-identity-bootstrap-nonce.json');
  const nonceSha256 = hash(nonce);
  helper.writeJson(nonceFile, { runId: args.runId, processId: process.pid, startedAt, nonceSha256, consumed: false });
  const { default: pg } = await import('pg');
  const i = run.instance;
  const ownerConnection = `postgres://${i.bootstrapUser}:${i.bootstrapPassword}@${i.host}:${i.port}/${i.dbName}`;
  const owner = new pg.Client({ connectionString: ownerConnection }); await owner.connect();
  const sql = N1_SQL.map((relative) => ({ path: relative, sha256: fileHash(path.join(SOURCE_IDENTITY_REPO_ROOT, relative)) }));
  try {
    const live = (await owner.query(`SELECT current_setting('data_directory') AS data_directory,current_database() AS database,inet_server_port() AS port,(SELECT run_id FROM p0_02_meta.platform_instance LIMIT 1) AS run_id,to_regclass('catalog.source_record') AS existing_n1`)).rows[0];
    if (path.resolve(live.data_directory) !== path.resolve(i.dataDir) || live.database !== i.dbName || live.port !== i.port || live.run_id !== args.runId || live.existing_n1 !== null || i.createdAt < startedAt) throw new Error('N1A_FRESH_BASE_PROOF_FAILED');
    const prepareDirs = fs.readdirSync(path.join(args.root, 'evidence')).filter((name) => name.startsWith('prepare-'));
    if (prepareDirs.length !== 1) throw new Error('N1A_BASE_MANIFEST_AMBIGUOUS');
    const baseManifest = JSON.parse(fs.readFileSync(path.join(args.root, 'evidence', prepareDirs[0], 'bootstrap-manifest.json'), 'utf8'));
    for (const entry of baseDdl) if (!baseManifest.applied.some((a) => a.path === entry.path && a.sha256 === entry.sha256) || entry.sha256 !== fileHash(path.join(SOURCE_IDENTITY_REPO_ROOT, entry.path))) throw new Error('N1A_BASE_DDL_HASH_MISMATCH');
    const ticket = JSON.parse(fs.readFileSync(nonceFile, 'utf8'));
    if (ticket.consumed || ticket.runId !== args.runId || ticket.processId !== process.pid || ticket.nonceSha256 !== hash(nonce)) throw new Error('N1A_NONCE_REJECTED');
    helper.writeJson(path.join(evidenceDirectory, 'fresh-base-proof.json'), { runId: args.runId, live, baseDdl, nonceSha256, primaryMarkerSha256, baseEnvSha256 });
    await owner.query('BEGIN');
    try {
      await owner.query('GRANT ice_p0_02_owner TO postgres');
      for (const entry of sql) { await owner.query(fs.readFileSync(path.join(SOURCE_IDENTITY_REPO_ROOT, entry.path), 'utf8')); await owner.query('RESET ROLE; RESET ALL'); }
      await owner.query('REVOKE ice_p0_02_owner FROM postgres');
      await owner.query('COMMIT');
      helper.writeJson(nonceFile, { ...ticket, consumed: true, consumedAt: new Date().toISOString() });
    } catch (error) { await owner.query('ROLLBACK'); throw error; }
    const { betterAuth } = await import('better-auth');
    const authPool = new pg.Pool({ connectionString: `${ownerConnection}?options=${encodeURIComponent('-c search_path=p0_02_auth')}` });
    const auth = betterAuth({ appName: 'iceos-source-identity-fixture', baseURL: 'http://127.0.0.1:3000', basePath: '/api/auth', secret: i.betterAuthSecret, database: authPool, emailAndPassword: { enabled: true, disableSignUp: false } });
    const config = inputs['scope-grants.fixture.json'].value;
    try {
      for (const actor of config.actors) {
        if (actor.profileId === '11111111-1111-4111-8111-111111111101') continue;
        const created = await auth.api.signUpEmail({ body: { email: actor.email, password: actor.password, name: `ISOLATED IDENTITY FIXTURE ${actor.key}` } });
        await owner.query(`INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,'{}')`, [actor.profileId, actor.email]);
        await owner.query(`INSERT INTO public.profiles(id,display_name,role_id,is_active) SELECT $1,$2,id,$3 FROM public.role WHERE name=$4`, [actor.profileId, `ISOLATED IDENTITY FIXTURE ${actor.key}`, actor.active, actor.role]);
        await owner.query(`INSERT INTO p0_02_meta.ice_auth_user_map(auth_user_id,ice_user_id) VALUES($1,$2)`, [created.user.id, actor.profileId]);
      }
    } finally { await authPool.end(); }
    const scopes = [];
    for (const scope of config.scopes) {
      const proof = inputs[`${scope.proofFixtureId}.json`];
      if (!proof || proof.value.environment !== 'fixture' || proof.value.scopeId !== scope.scopeId || proof.value.accountId !== scope.accountParts[0] || proof.value.datasetId !== scope.resourceParts[0] || proof.value.records.some((record) => record.scopeId && record.scopeId !== scope.scopeId)) throw new Error('N1A_MIXED_SCOPE_PROOF_DENIED');
      const proofSha256 = hash(proof.bytes), proofHandle = `${proofSha256.slice(0, 2)}/${proofSha256}`;
      const stored = path.join(args.root, 'private-evidence', ...proofHandle.split('/')); rejectLinksTo(stored);
      fs.mkdirSync(path.dirname(stored), { recursive: true }); fs.writeFileSync(stored, proof.bytes, { flag: 'wx', mode: 0o600 });
      if (fileHash(stored) !== proofSha256) throw new Error('N1A_PROOF_STORE_MISMATCH');
      const bootstrap = { ...scope, proofSha256, proofSize: proof.bytes.length, proofHandle };
      await owner.query('SELECT catalog.identity_fixture_bootstrap($1::jsonb)', [JSON.stringify(bootstrap)]);
      scopes.push({ scopeId: scope.scopeId, contractId: scope.contractId, proofId: scope.proofId, proofSha256, strategy: scope.strategy });
    }
    const manifest = { label: 'catalog-source-identity-fixture-v1', fixtureMode: 'fixture', runId: args.runId, host: i.host, port: i.port, database: i.dbName, dataDir: i.dataDir, nonceConsumed: true, nonceSha256, primaryMarkerSha256, baseEnvSha256, baseDdl, sql, fixturePins: FIXTURE_PINS, scopeIds: scopes.map((s) => s.scopeId), createdAt: new Date().toISOString() };
    const manifestFile = path.join(args.instanceRoot, 'source-identity-manifest.json');
    helper.writeJson(manifestFile, manifest);
    helper.writeJson(nonceFile, { ...ticket, consumed: true, consumedAt: new Date().toISOString() });
    helper.writeJson(path.join(args.instanceRoot, 'env.catalog-source-identity.json'), { ...run.env, CATALOG_SOURCE_IDENTITY_ENABLED: 'true', CATALOG_SOURCE_IDENTITY_FIXTURE_RUN_ID: args.runId, CATALOG_SOURCE_IDENTITY_MANIFEST: manifestFile });
    helper.writeJson(path.join(evidenceDirectory, 'bootstrap-summary.json'), { ...manifest, scopes, actorProfileIds: config.actors.map((actor) => actor.profileId), credentialsOmitted: true });
  } finally { await owner.end(); }
  await assertSourceIdentityLive(await openSourceIdentityRun(['--run-id', args.runId]));
  console.log(`source identity fixture prepare complete: ${args.runId}`);
  return args;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) prepareSourceIdentity().catch(async (error) => {
  if (ownedPrepareAttempt && fs.existsSync(ownedPrepareAttempt.root)) {
    const helper = await sourceIdentityHelpers();
    const evidenceDirectory = helper.newEvidence(ownedPrepareAttempt.root, 'source-identity-prepare-failure');
    helper.writeJson(path.join(evidenceDirectory, 'failure.json'), { ...ownedPrepareAttempt, code: error.code ?? null, error: error.message, published: false });
    try { await stopExactCatalogInstance(ownedPrepareAttempt.runId, evidenceDirectory); } catch (stopError) { helper.writeJson(path.join(evidenceDirectory, 'stop-failure.json'), { code: stopError.message, dataPreserved: true }); }
  }
  console.error(error.message); process.exitCode = 1;
});
