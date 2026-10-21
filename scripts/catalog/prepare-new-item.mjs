import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const NEW_ITEM_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ROOT = path.join(NEW_ITEM_REPO_ROOT, '.local/catalog');
const RUN = /^run-\d{8}T\d{6}Z-[a-f0-9]{8}$/;
const CONFIGS = ['vitest.config.catalog-new-item.mts', 'playwright.config.catalog-new-item.ts'];
const SQL = ['db/catalog/007_new_item_intake.sql', 'db/catalog/008_new_item_intake_security.sql'];
const FIXTURE_NAMES = ['new-item-bootstrap.json', 'new-item-scope-a.json', 'new-item-scope-b.json', 'new-item-scope-unresolved.json', 'new-item-fixture-manifest.json'];
const SCOPED_RAWS = Object.freeze({ 'new-item-scope-a.json': 'cccccccc-aaaa-4ccc-8aaa-cccccccccca1', 'new-item-scope-b.json': 'cccccccc-bbbb-4ccc-8bbb-ccccccccccb2', 'new-item-scope-unresolved.json': 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3' });
export const NEW_ITEM_FIXTURE_PINS = Object.freeze({
  'new-item-bootstrap.json': '2e20c4e9875dd9621cbed23be35e75951ccd936ff94b02ed431d88df3cb30fa5',
  'new-item-scope-a.json': 'd68c9c629d24220ba6d4e81a3198b6f14dd0639ae4a5447fee4366dbc8f68782',
  'new-item-scope-b.json': '98760817ef167db1702dff0069572b6c818ff684869d2cbd51f171d783f03ab2',
  'new-item-scope-unresolved.json': '5e283e90bb4b6681d8a476b84658628e7bd9fea97c68b88f062cc556cff02ae9',
  'new-item-fixture-manifest.json': '427bd68ddc3fbc38597999cd336fea3ba78ddaa014322968ec90bbe6dbd0cdb5',
});
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`;
  const encoded = JSON.stringify(value); if (encoded === undefined) throw new Error('N1C_INVALID_CANONICAL_TYPE'); return encoded;
};
export const fileHash = (file) => hash(fs.readFileSync(file));
export const newRunId = () => `run-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}-${crypto.randomBytes(4).toString('hex')}`;
let ownedPrepareAttempt;

export function rejectNewItemLinks(candidate) {
  const relative = path.relative(NEW_ITEM_REPO_ROOT, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('N1C_PATH_ESCAPE');
  let current = NEW_ITEM_REPO_ROOT;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error('N1C_REPARSE_DENIED');
      const resolved = fs.realpathSync.native(current), expected = path.resolve(current);
      if ((process.platform === 'win32' ? resolved.toLowerCase() !== expected.toLowerCase() : resolved !== expected)) throw new Error('N1C_REPARSE_DENIED');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

/** Standard-library-only; reject before A/base helper import, create or connection. */
export function newItemArgs(argv = process.argv.slice(2), { fresh = false } = {}) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!['--run-id', '--host'].includes(key) || !argv[index + 1] || parsed[key] !== undefined) throw new Error('N1C_ARGUMENT_DENIED');
    parsed[key] = argv[index + 1];
  }
  const runId = parsed['--run-id'];
  if (!runId || !RUN.test(runId)) throw new Error('N1C_FRESH_RUN_REQUIRED');
  const host = parsed['--host'] ?? '127.0.0.1';
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('N1C_NON_LOOPBACK_DENIED');
  const root = path.join(ROOT, runId), instanceRoot = path.join(root, 'instance');
  rejectNewItemLinks(root);
  for (const lane of ['p0-01', 'p0-02', 'p0-03']) if (fs.existsSync(path.join(NEW_ITEM_REPO_ROOT, '.local', lane, runId))) throw new Error('N1C_OLD_RUN_DENIED');
  if (fresh && fs.existsSync(root)) throw new Error('N1C_EXISTING_RUN_ROOT_DENIED');
  if (fresh) {
    for (const [key, value] of Object.entries(process.env)) {
      if (!value) continue;
      if (/(?:DATABASE_URL|CONNECTION_STRING)$/i.test(key) || /^PG(?:HOST|PORT|DATABASE|USER|PASSWORD|SERVICE|SERVICEFILE|PASSFILE|OPTIONS)$/i.test(key) || key === 'P0_02_RUN_ID') throw new Error(`N1C_INHERITED_TARGET_DENIED:${key}`);
      if (/^(?:P0_02|CATALOG|BETTER_AUTH|NEXT_PUBLIC_SUPABASE|SUPABASE).*URL$/i.test(key)) {
        let url; try { url = new URL(value); } catch { throw new Error(`N1C_INHERITED_TARGET_DENIED:${key}`); }
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error(`N1C_INHERITED_TARGET_DENIED:${key}`);
      }
    }
    if (process.env.CATALOG_RUN_ROOT && path.resolve(process.env.CATALOG_RUN_ROOT) !== root) throw new Error('N1C_INHERITED_ROOT_DENIED');
    if (process.env.CATALOG_SOURCE_ROOT && path.resolve(process.env.CATALOG_SOURCE_ROOT) !== NEW_ITEM_REPO_ROOT) throw new Error('N1C_INHERITED_SOURCE_DENIED');
    if (process.env.CATALOG_NEW_ITEM_FIXTURE_RUN_ID && process.env.CATALOG_NEW_ITEM_FIXTURE_RUN_ID !== runId) throw new Error('N1C_INHERITED_RUN_DENIED');
    if (process.env.CATALOG_NEW_ITEM_MANIFEST && path.resolve(process.env.CATALOG_NEW_ITEM_MANIFEST) !== path.join(instanceRoot, 'new-item-manifest.json')) throw new Error('N1C_INHERITED_MANIFEST_DENIED');
  }
  return { runId, host, root, instanceRoot };
}

export async function newItemHelpers() { const a = await import('./prepare-source-identity.mjs'); return a.sourceIdentityHelpers(); }
const aModule = () => import('./prepare-source-identity.mjs');
function fixtureInputs() {
  if (Object.keys(NEW_ITEM_FIXTURE_PINS).length !== 5 || FIXTURE_NAMES.some((name) => !/^[a-f0-9]{64}$/.test(NEW_ITEM_FIXTURE_PINS[name] ?? ''))) throw new Error('N1C_FIXTURE_PINS_NOT_FROZEN');
  const inputs = Object.fromEntries(FIXTURE_NAMES.map((name) => {
    const file = path.join(NEW_ITEM_REPO_ROOT, 'tests/catalog/fixtures', name); rejectNewItemLinks(file);
    const bytes = fs.readFileSync(file);
    if (hash(bytes) !== NEW_ITEM_FIXTURE_PINS[name]) throw new Error('N1C_FIXTURE_PIN_MISMATCH');
    return [name, { bytes, value: JSON.parse(bytes.toString('utf8')), sha256: hash(bytes) }];
  }));
  for (const [name, scopeId] of Object.entries(SCOPED_RAWS)) {
    const raw = inputs[name].value;
    if (raw.fictional !== true || raw.scopeId !== scopeId || !Array.isArray(raw.rows) || (name === 'new-item-scope-unresolved.json' && raw.rows.length !== 1)) throw new Error('N1C_RAW_EXPLICIT_SCOPE_MISMATCH');
  }
  for (const capture of inputs['new-item-fixture-manifest.json'].value.captures) if (SCOPED_RAWS[capture.rawFile] !== capture.scopeId || inputs[capture.rawFile]?.value.scopeId !== capture.scopeId) throw new Error('N1C_CAPTURE_RAW_SCOPE_MISMATCH');
  for (const capture of inputs['new-item-bootstrap.json'].value.identityCaptures) if (SCOPED_RAWS[capture.rawFile] !== capture.scopeId || capture.scopeId === SCOPED_RAWS['new-item-scope-unresolved.json']) throw new Error('N1C_IDENTITY_RAW_SCOPE_MISMATCH');
  return inputs;
}

function storeFixtureBytes(args, input) {
  const storageHandle = `${input.sha256.slice(0, 2)}/${input.sha256}`;
  const target = path.join(args.root, 'private-evidence', ...storageHandle.split('/')); rejectNewItemLinks(target);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (!fs.existsSync(target)) fs.writeFileSync(target, input.bytes, { flag: 'wx', mode: 0o600 });
  if (fileHash(target) !== input.sha256 || fs.statSync(target).size !== input.bytes.length) throw new Error('N1C_PRIVATE_FIXTURE_BYTES_MISMATCH');
  return storageHandle;
}

async function bootstrapIdentityScopes(owner, config, inputs) {
  for (const scope of config.scopes) {
    const rawName = Object.keys(SCOPED_RAWS).find((name) => SCOPED_RAWS[name] === scope.scopeId), raw = inputs[rawName];
    if (!raw || raw.value.scopeId !== scope.scopeId || raw.sha256 !== scope.proofSha256 || raw.bytes.length !== scope.proofSize || scope.proofHandle !== `${scope.proofSha256.slice(0, 2)}/${scope.proofSha256}` || (rawName === 'new-item-scope-unresolved.json' && scope.scopeState !== 'unresolved')) throw new Error('N1C_SCOPE_PROOF_PIN_MISMATCH');
    const normalized = { ...scope, accountParts: scope.accountParts ?? [scope.accountId], resourceParts: scope.resourceParts ?? [scope.resourceId], marketIdentity: scope.marketIdentity ?? null, warehouseIdentity: scope.warehouseIdentity ?? null };
    await owner.query('SELECT catalog.identity_fixture_bootstrap($1::jsonb)', [JSON.stringify(normalized)]);
  }
}

async function bootstrapIdentityMembers(base, config, inputs, evidenceDirectory) {
  const { default: pg } = await import('pg'), pool = new pg.Pool({ connectionString: base.env.P0_02_APP_DATABASE_URL, max: 1 });
  const receipts = [], records = new Map();
  const mutate = async (actor, scopeId, action, payload) => {
    const requestId = crypto.randomUUID(), intent = hash(canonicalJson(['iceos-source-request-v1', actor, scopeId, action, payload]));
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); await client.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`, [actor]);
      const role = (await client.query(`SELECT current_user AS name,rolsuper,rolbypassrls,pg_has_role(current_user,'ice_p0_02_owner','MEMBER') AS owner_member FROM pg_roles WHERE rolname=current_user`)).rows[0];
      if (role.name !== 'ice_p0_02_app_runner' || role.rolsuper || role.rolbypassrls || role.owner_member) throw new Error('N1C_BOOTSTRAP_APP_ROLE_INVALID');
      const result = (await client.query('SELECT catalog.identity_mutate($1,$2,$3,$4,$5::jsonb) AS result', [requestId, scopeId, action, intent, JSON.stringify(payload)])).rows[0].result;
      await client.query('COMMIT'); return { requestId, intent, result, role };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  };
  try {
    for (const capture of config.identityCaptures) {
      const scope = config.scopes.find((entry) => entry.scopeId === capture.scopeId), input = inputs[capture.rawFile];
      if (!scope || !input || !capture.observations.length) throw new Error('N1C_IDENTITY_CAPTURE_CONFIG_INVALID');
      for (const observation of capture.observations) {
        const projection = { ...observation }; delete projection.payloadSha256;
        if (hash(canonicalJson(projection)) !== observation.payloadSha256) throw new Error('N1C_IDENTITY_PROJECTION_SHA_MISMATCH');
        let row = input.value;
        for (const part of observation.recordPointer.slice(1).split('/').map((value) => value.replace(/~1/g, '/').replace(/~0/g, '~'))) row = row?.[part];
        if (!row) throw new Error('N1C_IDENTITY_POINTER_INVALID');
        for (const [key, field] of Object.entries(observation.fields)) if (field.state === 'value' && row[key === 'name' ? 'nameCn' : key] !== field.value) throw new Error('N1C_IDENTITY_FIELD_NOT_FROM_RAW_MEMBER');
      }
      const coverage = { complete: false, singleScope: true }, parserId = 'n1c-approved-identity', parserVersion = 'v1', contractRevision = scope.contractRevision ?? 1;
      const payload = { captureKey: `n1c-a-${capture.label}`, evidenceId: capture.evidenceId, manifestId: 'n1c-real-a-chain', bytesSha256: input.sha256, size: input.bytes.length, format: 'json', parserId, parserVersion, contractId: scope.contractId, contractRevision, coverage, projectionSha256: hash(canonicalJson(capture.observations)), observations: capture.observations, proofSemantics: capture.proofSemantics, storageHandle: `${input.sha256.slice(0, 2)}/${input.sha256}` };
      payload.adoptionDigest = hash(canonicalJson(['iceos-identity-capture-v1', payload.bytesSha256, parserId, parserVersion, scope.contractId.toLowerCase(), contractRevision, scope.scopeId.toLowerCase(), coverage, payload.projectionSha256]));
      const imported = await mutate(scope.actorId, scope.scopeId, 'import_capture', payload);
      const observation = capture.observations.find((entry) => entry.observationId === capture.observationId);
      if (!observation) throw new Error('N1C_IDENTITY_SELECTED_MEMBER_MISSING');
      const key = `${scope.scopeId}:${observation.fields.vendorRecordId.value}`, previous = records.get(key);
      if (!capture.register && !previous) throw new Error('N1C_IDENTITY_REUSE_WITHOUT_PRIOR_RECORD');
      const registration = await mutate(scope.actorId, scope.scopeId, 'register', { contractId: scope.contractId, observationId: observation.observationId, proofId: capture.evidenceId, expectedMatch: previous ? { kind: 'record', recordId: previous.recordId, revision: previous.revision } : { kind: 'none' }, reason: 'Trusted isolated C fixture: explicit real A registration' });
      const record = registration.result; records.set(key, record);
      const link = capture.link ? await mutate(scope.actorId, scope.scopeId, 'link', { operation: 'link', recordId: record.recordId, expectedRecordRevision: record.revision, expectedLinkRevision: 0, origin: { kind: 'identity', id: observation.observationId }, proofId: capture.evidenceId, reason: 'Trusted isolated C fixture: exact same bytes and pointer A member' }) : null;
      receipts.push({ label: capture.label, scopeId: scope.scopeId, rawFile: capture.rawFile, bytesSha256: input.sha256, recordPointer: observation.recordPointer, identityObservationId: observation.observationId, identityEvidenceId: capture.evidenceId, identityPayloadSha256: observation.payloadSha256, import: imported, registration, link, noAAllowlistOrSqlModified: true });
    }
    base.helper.writeJson(path.join(evidenceDirectory, 'identity-bootstrap-facts.json'), { receipts, actualAppSql: true, noMockOrDirectIdentityFactInserts: true, sameBytesAndPointersChecked: true });
  } finally { await pool.end(); }
}

export async function openNewItemRun(argv = process.argv.slice(2)) {
  const args = newItemArgs(argv), a = await aModule(), base = await a.openSourceIdentityRun(argv);
  const file = path.join(args.instanceRoot, 'new-item-manifest.json'); rejectNewItemLinks(file);
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (manifest.label !== 'catalog-new-item-fixture-v1' || manifest.fixtureMode !== 'fixture' || manifest.runId !== args.runId || !manifest.nonceConsumed || !/^[a-f0-9]{64}$/.test(manifest.nonceSha256 ?? '') || manifest.host !== base.instance.host || manifest.port !== base.instance.port || manifest.database !== base.instance.dbName || path.resolve(manifest.dataDir) !== path.resolve(base.instance.dataDir)) throw new Error('N1C_MANIFEST_TARGET_MISMATCH');
  if (manifest.primaryMarkerSha256 !== fileHash(path.join(args.instanceRoot, 'catalog-instance.json')) || manifest.baseEnvSha256 !== fileHash(path.join(args.instanceRoot, 'env.catalog-source-identity.json')) || manifest.sourceIdentityManifestSha256 !== fileHash(path.join(args.instanceRoot, 'source-identity-manifest.json'))) throw new Error('N1C_BASE_MARKER_CHANGED');
  const baseDdl = [...base.manifest.baseDdl, ...base.manifest.sql];
  if (JSON.stringify(manifest.baseDdl) !== JSON.stringify(baseDdl) || JSON.stringify(manifest.sql.map((entry) => entry.path)) !== JSON.stringify(SQL)) throw new Error('N1C_DDL_LIST_MISMATCH');
  for (const entry of [...manifest.baseDdl, ...manifest.sql]) if (fileHash(path.join(NEW_ITEM_REPO_ROOT, entry.path)) !== entry.sha256) throw new Error('N1C_DDL_CHANGED_USE_FRESH_RUN');
  fixtureInputs();
  if (JSON.stringify(manifest.fixturePins) !== JSON.stringify(NEW_ITEM_FIXTURE_PINS)) throw new Error('N1C_FIXTURE_MANIFEST_CHANGED');
  const envFile = path.join(args.instanceRoot, 'env.catalog-new-item.json'); rejectNewItemLinks(envFile);
  const env = JSON.parse(fs.readFileSync(envFile, 'utf8'));
  if (env.CATALOG_NEW_ITEM_ENABLED !== 'true' || env.CATALOG_NEW_ITEM_FIXTURE_RUN_ID !== args.runId || path.resolve(env.CATALOG_NEW_ITEM_MANIFEST) !== file) throw new Error('N1C_ENV_MARKER_MISMATCH');
  for (const key of ['P0_02_APP_DATABASE_URL', 'P0_02_AUTH_DATABASE_URL', 'P0_02_SYNC_DATABASE_URL']) if (env[key] !== base.env[key]) throw new Error('N1C_ENV_TARGET_CHANGED');
  return { ...base, env, envFile, manifest, sourceIdentityManifest: base.manifest };
}

export async function assertNewItemLive(run) { const a = await aModule(); return a.assertSourceIdentityLive(run); }
export async function stopExactNewItemInstance(runId, evidenceDirectory, name = 'owned-instance-stop') { const a = await aModule(); return a.stopExactCatalogInstance(runId, evidenceDirectory, name); }
export async function collectNewItemHashes() {
  const a = await aModule(), files = { ...await a.collectSourceIdentityHashes() };
  for (const relative of CONFIGS) { rejectNewItemLinks(path.join(NEW_ITEM_REPO_ROOT, relative)); files[relative] = fileHash(path.join(NEW_ITEM_REPO_ROOT, relative)); }
  return Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right)));
}
export async function snapshotNewItemWorkspace(workspace) {
  const a = await aModule(); await a.snapshotSourceIdentityWorkspace(workspace);
  for (const relative of CONFIGS) fs.copyFileSync(path.join(NEW_ITEM_REPO_ROOT, relative), path.join(workspace, relative));
  const files = await collectNewItemHashes();
  for (const [relative, digest] of Object.entries(files)) if (fileHash(path.join(workspace, relative)) !== digest) throw new Error('N1C_WORKSPACE_COPY_CHANGED');
  return { createdAt: new Date().toISOString(), sourceRoot: NEW_ITEM_REPO_ROOT, workspace, files, sourceSnapshotHash: hash(JSON.stringify(files)) };
}

export async function runNewItemGuardNegatives(evidenceDirectory) {
  const h = await newItemHelpers(), fixtureRoot = path.join(ROOT, newRunId()), emptyRoot = path.join(ROOT, newRunId());
  fs.mkdirSync(fixtureRoot); fs.mkdirSync(path.join(fixtureRoot, 'instance')); fs.writeFileSync(path.join(fixtureRoot, 'instance/sentinel.txt'), 'new C guard fixture'); fs.mkdirSync(emptyRoot);
  const sentinel = path.join(fixtureRoot, 'instance/sentinel.txt'), before = fileHash(sentinel);
  const oldRunId = 'run-20261020T125311Z-9fdccde6', oldMarker = path.join(ROOT, oldRunId, 'instance/catalog-instance.json'), oldBefore = fileHash(oldMarker);
  const linkRoot = path.join(ROOT, newRunId()), linkTarget = path.join(evidenceDirectory, 'link-target'); fs.mkdirSync(linkTarget); fs.symlinkSync(linkTarget, linkRoot, process.platform === 'win32' ? 'junction' : 'dir');
  const observer = `import{registerHooks}from'node:module';import fs from'node:fs';import net from'node:net';registerHooks({resolve(s,c,n){if(s==='./prepare-source-identity.mjs'||s==='./prepare.mjs'||s==='pg'||s==='better-auth')throw Error('GUARD_HELPER_LOADED');return n(s,c)}});fs.mkdirSync=()=>{throw Error('GUARD_DIRECTORY_CREATED')};net.Socket.prototype.connect=function(){throw Error('GUARD_CONNECTION_OPENED')};`;
  const cases = [{ name: 'missing-run', args: [] }, { name: 'old-p0-run', args: ['--run-id', 'run-20261014-r2'] }, { name: 'old-catalog-run', args: ['--run-id', oldRunId] }, { name: 'existing-empty-root', args: ['--run-id', path.basename(emptyRoot)] }, { name: 'nonempty-instance', args: ['--run-id', path.basename(fixtureRoot)] }, { name: 'nonloopback', args: ['--run-id', newRunId(), '--host', '203.0.113.8'] }, { name: 'inherited-connection', args: ['--run-id', newRunId()], extra: { DATABASE_URL: 'postgres://fixture:fixture@203.0.113.8/no_connection' } }, { name: 'external-auth-url', args: ['--run-id', newRunId()], extra: { P0_02_BETTER_AUTH_URL: 'https://203.0.113.8/no_connection' } }, { name: 'reparse-escape', args: ['--run-id', path.basename(linkRoot)] }, { name: 'arbitrary-url-argument', args: ['--run-id', newRunId(), '--url', 'postgres://203.0.113.8/no_connection'] }];
  const results = cases.map((entry) => {
    const args = ['--import', `data:text/javascript,${encodeURIComponent(observer)}`, path.join(NEW_ITEM_REPO_ROOT, 'scripts/catalog/prepare-new-item.mjs'), ...entry.args];
    const result = spawnSync(process.execPath, args, { cwd: NEW_ITEM_REPO_ROOT, env: h.safeEnv(entry.extra ?? {}), encoding: 'utf8', windowsHide: true });
    return { name: entry.name, command: process.execPath, actualArgv: args, arguments: entry.args, exitCode: result.status, stdout: result.stdout, stderr: result.stderr, pass: result.status === 1 && /N1C_(?:FRESH_RUN_REQUIRED|EXISTING_RUN_ROOT_DENIED|NON_LOOPBACK_DENIED|INHERITED_TARGET_DENIED|REPARSE_DENIED|ARGUMENT_DENIED)/.test(result.stderr) && !/GUARD_(?:HELPER_LOADED|DIRECTORY_CREATED|CONNECTION_OPENED)/.test(result.stderr), preHelperCreateConnectionTraps: true };
  });
  const sentinelUnchanged = fileHash(sentinel) === before, oldMarkerUnchanged = fileHash(oldMarker) === oldBefore;
  const allPass = results.every((entry) => entry.pass) && sentinelUnchanged && oldMarkerUnchanged;
  h.writeJson(path.join(evidenceDirectory, 'prepare-guard-negatives.json'), { results, sentinelUnchanged, oldMarker, oldMarkerBefore: oldBefore, oldMarkerAfter: fileHash(oldMarker), oldMarkerUnchanged, fixtureRoot, emptyRoot, linkRoot, linkTarget, fixtureDirectoriesPreserved: true, allPass });
  if (!allPass) throw new Error('N1C_GUARD_NEGATIVE_FAILED');
}

export async function prepareNewItem(argv = process.argv.slice(2)) {
  const args = newItemArgs(argv, { fresh: true }), startedAt = new Date().toISOString(), nonce = crypto.randomBytes(32).toString('hex');
  const inputs = fixtureInputs();
  for (const relative of SQL) { rejectNewItemLinks(path.join(NEW_ITEM_REPO_ROOT, relative)); if (!fs.existsSync(path.join(NEW_ITEM_REPO_ROOT, relative))) throw new Error('N1C_DDL_NOT_READY'); }
  const a = await aModule(), h = await newItemHelpers();
  ownedPrepareAttempt = { runId: args.runId, root: args.root, startedAt };
  await a.prepareSourceIdentity(argv);
  const base = await a.openSourceIdentityRun(argv), i = base.instance;
  const evidenceDirectory = h.newEvidence(args.root, 'new-item-prepare');
  const primaryMarkerSha256 = fileHash(path.join(args.instanceRoot, 'catalog-instance.json')), baseEnvSha256 = fileHash(base.envFile), sourceIdentityManifestSha256 = fileHash(path.join(args.instanceRoot, 'source-identity-manifest.json'));
  const baseDdl = [...base.manifest.baseDdl, ...base.manifest.sql], sql = SQL.map((relative) => ({ path: relative, sha256: fileHash(path.join(NEW_ITEM_REPO_ROOT, relative)) }));
  const ticketFile = path.join(args.instanceRoot, 'new-item-bootstrap-nonce.json'), nonceSha256 = hash(nonce);
  rejectNewItemLinks(ticketFile);
  fs.writeFileSync(ticketFile, JSON.stringify({ runId: args.runId, processId: process.pid, startedAt, nonceSha256, consumed: false }, null, 2), { flag: 'wx' });
  const { default: pg } = await import('pg');
  const owner = new pg.Client({ connectionString: `postgres://${i.bootstrapUser}:${i.bootstrapPassword}@${i.host}:${i.port}/${i.dbName}` }); await owner.connect();
  let scopeGrantEvidence;
  try {
    const live = (await owner.query(`SELECT current_setting('data_directory') AS data_directory,current_database() AS database,inet_server_port() AS port,(SELECT run_id FROM p0_02_meta.platform_instance LIMIT 1) AS run_id,to_regclass('catalog.product_capture') AS existing_c`)).rows[0];
    const aTicket = JSON.parse(fs.readFileSync(path.join(args.instanceRoot, 'source-identity-bootstrap-nonce.json'), 'utf8'));
    if (path.resolve(live.data_directory) !== path.resolve(i.dataDir) || live.database !== i.dbName || live.port !== i.port || live.run_id !== args.runId || live.existing_c !== null || i.createdAt < startedAt || !aTicket.consumed || aTicket.processId !== process.pid || aTicket.runId !== args.runId || aTicket.nonceSha256 !== base.manifest.nonceSha256) throw new Error('N1C_SAME_INVOCATION_FRESH_A_REQUIRED');
    for (const entry of baseDdl) if (fileHash(path.join(NEW_ITEM_REPO_ROOT, entry.path)) !== entry.sha256) throw new Error('N1C_BASE_DDL_CHANGED');
    const ticket = JSON.parse(fs.readFileSync(ticketFile, 'utf8'));
    if (ticket.consumed || ticket.runId !== args.runId || ticket.processId !== process.pid || ticket.nonceSha256 !== hash(nonce)) throw new Error('N1C_NONCE_REJECTED');
    h.writeJson(path.join(evidenceDirectory, 'fresh-a-proof.json'), { runId: args.runId, live, baseDdl, nonceSha256, primaryMarkerSha256, sourceIdentityManifestSha256, baseEnvSha256, aNonceConsumed: true });
    await owner.query('BEGIN');
    try {
      await owner.query('GRANT ice_p0_02_owner TO postgres');
      for (const entry of sql) { await owner.query(fs.readFileSync(path.join(NEW_ITEM_REPO_ROOT, entry.path), 'utf8')); await owner.query('RESET ROLE; RESET ALL'); }
      for (const name of Object.keys(SCOPED_RAWS)) storeFixtureBytes(args, inputs[name]);
      await bootstrapIdentityScopes(owner, inputs['new-item-bootstrap.json'].value, inputs);
      const scopeIds = inputs['new-item-bootstrap.json'].value.scopes.map((scope) => scope.scopeId);
      const beforePublish = (await owner.query('SELECT scope_id,profile_id,can_publish_catalog FROM catalog.source_scope_grant WHERE scope_id=ANY($1::uuid[]) ORDER BY scope_id,profile_id', [scopeIds])).rows;
      if (!beforePublish.length || beforePublish.some((grant) => grant.can_publish_catalog)) throw new Error('N1C_OLD_A_BOOTSTRAP_PUBLISH_DEFAULT_CHANGED');
      // Trusted bootstrap protocol is pinned with the five fixtures; no client payload.
      await owner.query('SELECT catalog.new_item_fixture_bootstrap($1::jsonb)', [JSON.stringify(inputs['new-item-bootstrap.json'].value)]);
      const afterPublish = (await owner.query('SELECT scope_id,profile_id,can_publish_catalog FROM catalog.source_scope_grant WHERE scope_id=ANY($1::uuid[]) ORDER BY scope_id,profile_id', [scopeIds])).rows;
      scopeGrantEvidence = { beforePublish, afterPublish, oldAFunctionUsedUnmodifiedAfterCInstallation: true };
      await owner.query('REVOKE ice_p0_02_owner FROM postgres'); await owner.query('COMMIT');
    } catch (error) { await owner.query('ROLLBACK'); throw error; }
    await bootstrapIdentityMembers(base, inputs['new-item-bootstrap.json'].value, inputs, evidenceDirectory);
    h.writeJson(path.join(evidenceDirectory, 'publish-grant-bootstrap.json'), scopeGrantEvidence);
    h.writeJson(ticketFile, { ...ticket, consumed: true, consumedAt: new Date().toISOString() });
    const manifest = { label: 'catalog-new-item-fixture-v1', fixtureMode: 'fixture', runId: args.runId, host: i.host, port: i.port, database: i.dbName, dataDir: i.dataDir, nonceConsumed: true, nonceSha256, primaryMarkerSha256, baseEnvSha256, sourceIdentityManifestSha256, baseDdl, sql, fixturePins: NEW_ITEM_FIXTURE_PINS, createdAt: new Date().toISOString() };
    const manifestFile = path.join(args.instanceRoot, 'new-item-manifest.json');
    const envFile = path.join(args.instanceRoot, 'env.catalog-new-item.json');
    rejectNewItemLinks(manifestFile); rejectNewItemLinks(envFile);
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), { flag: 'wx' });
    fs.writeFileSync(envFile, JSON.stringify({ ...base.env, CATALOG_NEW_ITEM_ENABLED: 'true', CATALOG_NEW_ITEM_FIXTURE_RUN_ID: args.runId, CATALOG_NEW_ITEM_MANIFEST: manifestFile }, null, 2), { flag: 'wx', mode: 0o600 });
    h.writeJson(path.join(evidenceDirectory, 'bootstrap-summary.json'), { ...manifest, credentialsOmitted: true });
  } finally { await owner.end(); }
  await assertNewItemLive(await openNewItemRun(argv));
  console.log(`new item fixture prepare complete: ${args.runId}`);
  return args;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) prepareNewItem().catch(async (error) => {
  if (ownedPrepareAttempt && fs.existsSync(ownedPrepareAttempt.root)) {
    const h = await newItemHelpers(), evidence = h.newEvidence(ownedPrepareAttempt.root, 'new-item-prepare-failure');
    h.writeJson(path.join(evidence, 'failure.json'), { ...ownedPrepareAttempt, code: error.code ?? null, error: error.message, published: false });
    try { await stopExactNewItemInstance(ownedPrepareAttempt.runId, evidence); } catch (stopError) { h.writeJson(path.join(evidence, 'stop-failure.json'), { error: stopError.message, dataPreserved: true }); }
  }
  console.error(error.message); process.exitCode = 1;
});
