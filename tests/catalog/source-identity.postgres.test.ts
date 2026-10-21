import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Client, Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withAppDb } from '@/lib/database/app-db';
import { closeP002Pools } from '@/lib/independent-platform/p0-02-pools';
import { prepareBaseline } from '@/features/catalog/sources/baseline-adapter';
import { loadFrozenFeishu } from '@/features/catalog/sources/frozen-feishu-adapter';
import { catalogRepository } from '@/features/catalog/repository';
import { storePrivateArtifact } from '@/features/catalog/evidence-store';
import { sourceIdentityRepository, sourceIdentityIntent } from '@/features/catalog/source-identity/repository';
import { prepareSourceFixtureCapture, prepareSourceIdentityBootstrap, FIXTURE_SCOPE_A as A, FIXTURE_SCOPE_B as B } from '@/features/catalog/source-identity/fixture-adapter';
import { captureAdoptionDigest, digest, canonicalJson, encodeRecordKey, encodeScope } from '@/features/catalog/source-identity/key-codec';
import type { IdentityAction, IdentityContext, IdentityMutationResult, PreparedIdentityCapture } from '@/features/catalog/source-identity/types';

const ADMIN = '11111111-1111-4111-8111-111111111101', ADMIN_B = '11111111-1111-4111-8111-111111111107';
const OPERATOR = '11111111-1111-4111-8111-111111111104', INACTIVE = '11111111-1111-4111-8111-111111111106';
const READ = '11111111-1111-4111-8111-111111111108', NO_AMOUNT = '11111111-1111-4111-8111-111111111109', NO_EVIDENCE = '11111111-1111-4111-8111-111111111110';
const CONTRACT_A = 'cccccccc-aaaa-4ccc-8aaa-ccccccccccc1', CONTRACT_B = 'cccccccc-bbbb-4ccc-8bbb-ccccccccccc2';
const PROOF_A = 'eeeeeeee-aaaa-4eee-8aaa-eeeeeeeeeee1', PROOF_B = 'eeeeeeee-bbbb-4eee-8bbb-eeeeeeeeeee2';
const root = process.env.CATALOG_RUN_ROOT!, evidence = process.env.CATALOG_SOURCE_IDENTITY_TEST_EVIDENCE_DIR!;
const instance = JSON.parse(fs.readFileSync(path.join(root, 'instance/catalog-instance.json'), 'utf8'));
const owner = new Pool({ connectionString: `postgres://${instance.bootstrapUser}:${instance.bootstrapPassword}@${instance.host}:${instance.port}/${instance.dbName}`, max: 1 });
const app = new Pool({ connectionString: process.env.P0_02_APP_DATABASE_URL, max: 2 });
const receipt = (name: string, result: unknown) => fs.writeFileSync(path.join(evidence, name), JSON.stringify(result, null, 2));
const identity = (profileUserId = ADMIN) => ({ profileUserId });
const newTables = ['source_scope', 'source_scope_grant', 'identity_evidence', 'source_identity_contract_revision', 'source_record', 'identity_claim', 'identity_observation', 'observation_record_link', 'source_identity_request'];
async function tx<T>(actor: string | null, fn: (c: PoolClient) => Promise<T>) {
  const c = await app.connect(); try { await c.query('BEGIN'); await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`, [actor ?? '']); const out = await fn(c); await c.query('COMMIT'); return out; }
  catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
async function mutate(action: IdentityAction, payload: unknown, scope = A, actor = ADMIN, requestId = randomUUID()) {
  return sourceIdentityRepository.mutate(identity(actor), requestId, scope, action, payload);
}
async function counts() { const values: Record<string, number> = {}; for (const t of newTables) values[t] = (await owner.query(`SELECT count(*)::int n FROM catalog.${t}`)).rows[0].n; values.identity_evidence_handle = (await owner.query('SELECT count(*)::int n FROM catalog_private.identity_evidence_handle')).rows[0].n; return values; }
async function identityState(client: Pool | PoolClient = owner) {
  const rows: Record<string, unknown> = {};
  for (const table of newTables) rows[table] = (await client.query(`SELECT to_jsonb(t) row FROM catalog.${table} t ORDER BY to_jsonb(t)::text`)).rows;
  return rows;
}
async function capture(fixtureId: string, actor = ADMIN) { const p = await prepareSourceFixtureCapture(fixtureId); const result = await mutate('import_capture', p.capture, p.scopeId, actor); return { ...p, result }; }
let initialOld: unknown, originalNewItem: string, frozen: string, a1: string, a2: string, b1: string, a1new: string;
let recordA: IdentityMutationResult, recordA2: IdentityMutationResult, recordB: IdentityMutationResult;
async function oldSnapshot() {
  const out: Record<string, unknown> = {};
  for (const t of ['catalog_item','catalog_item_code','baseline_item_anchor','item_revision','item_current','source_observation','decision_evidence','audit_event']) out[t] = (await owner.query(`SELECT to_jsonb(t) AS row FROM catalog.${t} t ORDER BY to_jsonb(t)::text`)).rows;
  for (const t of ['product','product_variant','inventory']) out[`public.${t}`] = (await owner.query(`SELECT * FROM public.${t} ORDER BY id`)).rows;
  return out;
}
async function registration(observationId: string, scope = A, expectedMatch: unknown = { kind: 'none' }, actor = ADMIN) {
  return mutate('register', { contractId: scope === A ? CONTRACT_A : CONTRACT_B, observationId, proofId: scope === A ? PROOF_A : PROOF_B, expectedMatch, reason: 'ISOLATED N1A fixture registration' }, scope, actor);
}
async function injected(table: string, operation: string, fn: () => Promise<unknown>) {
  const c = await owner.connect();
  const qualified = table.includes('.') ? table : `catalog.${table}`;
  try {
    await c.query(`CREATE OR REPLACE FUNCTION pg_temp.n1a_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'ISOLATED_INJECTED_FAILURE' USING ERRCODE='P0001'; END $$`);
    await c.query(`CREATE TRIGGER n1a_injected_failure BEFORE ${operation} ON ${qualified} FOR EACH ROW EXECUTE FUNCTION pg_temp.n1a_fail()`);
    await expect(fn()).rejects.toMatchObject({ code: 'P0001', message: 'ISOLATED_INJECTED_FAILURE' });
  } finally { await c.query(`DROP TRIGGER IF EXISTS n1a_injected_failure ON ${qualified}`); c.release(); }
}
async function syntheticCapture(vendor: string, sku: string, name: string, proofSemantics?: PreparedIdentityCapture['proofSemantics'], scope = A, contractId = CONTRACT_A) {
  const template = (await prepareSourceFixtureCapture('products-v1')).capture;
  const capture = structuredClone(template), evidenceId = randomUUID(); capture.captureKey = `inline-isolated-${randomUUID()}`; capture.evidenceId = evidenceId; capture.contractId = contractId;
  capture.observations = [{ ...capture.observations[0], observationId: randomUUID(), recordPointer: '/records/0', fields: Object.fromEntries(Object.entries({ vendorRecordId: vendor, sku, name, barcode: '' }).map(([key, value]) => [key, value === '' ? { state: 'empty' as const, value: null, evidenceRef: `${evidenceId}#/records/0/${key}` } : { state: 'value' as const, value, evidenceRef: `${evidenceId}#/records/0/${key}` }])) }];
  capture.proofSemantics = proofSemantics ?? template.proofSemantics;
  const bytes = Buffer.from(canonicalJson({ environment: 'fixture', purpose: 'trusted inline PG acceptance probe only', scopeId: scope, proofSemantics: capture.proofSemantics, observations: capture.observations }));
  const stored = await storePrivateArtifact('inline-n1a-acceptance-probe.json', bytes); capture.bytesSha256 = stored.sha256; capture.size = stored.size; capture.storageHandle = stored.storageHandle;
  capture.projectionSha256 = digest(canonicalJson(capture.observations)); capture.adoptionDigest = captureAdoptionDigest({ ...capture, scopeId: scope });
  return capture;
}
type RepairScope = { scopeId: string; contractId: string; proofId: string; config: Record<string, unknown> };
const unknownContext = (): IdentityContext => ({ state: 'unknown', raw: null, reason: 'Isolated repair observation did not read this dimension' });
const knownContext = (value: string): IdentityContext => ({ state: 'known', raw: value, canonical: value, evidenceRef: 'isolated-repair-context' });
async function repairScope(policy: Record<string, unknown> = {}, sufficientProof = true): Promise<RepairScope> {
  const base = (await prepareSourceIdentityBootstrap()).scopes[0], scopeId = randomUUID(), contractId = randomUUID(), proofId = randomUUID();
  const config: Record<string, unknown> = { ...base, scopeId, contractId, proofId, accountParts: [`repair-account-${scopeId}`], resourceParts: [`repair-resource-${scopeId}`], displayName: 'Isolated N1A repair scope', proofCaptureKey: `repair-proof-${proofId}`, grants: [{ profileId: ADMIN, read: true, manage: true, evidence: true, amount: true, enabled: true }], ...policy };
  const proofSemantics = { uniqueness: sufficientProof, stability: sufficientProof, keyChange: true, reuse: true, oldObservationCompatible: true };
  const bytes = Buffer.from(canonicalJson({ environment: 'fixture', purpose: 'explicit single-scope repair policy proof', scopeId, policy, proofSemantics }));
  const stored = await storePrivateArtifact('n1a-repair-scope-proof.json', bytes);
  Object.assign(config, { proofSha256: stored.sha256, proofSize: stored.size, proofHandle: stored.storageHandle, proofSemantics });
  await owner.query('SELECT catalog.identity_fixture_bootstrap($1::jsonb)', [JSON.stringify(config)]);
  return { scopeId, contractId, proofId, config };
}
async function repairCapture(scope: Pick<RepairScope, 'scopeId' | 'contractId'>, records: { vendor: string; sku?: string; name?: string; barcode?: string; market?: IdentityContext; warehouse?: IdentityContext }[], proofSemantics?: PreparedIdentityCapture['proofSemantics'], contractRevision = 1, importNow = true) {
  const capture = structuredClone((await prepareSourceFixtureCapture('products-v1')).capture) as PreparedIdentityCapture;
  capture.captureKey = `repair-capture-${randomUUID()}`; capture.evidenceId = randomUUID(); capture.contractId = scope.contractId; capture.contractRevision = contractRevision;
  capture.parserId = 'isolated-repair-fixture'; capture.manifestId = 'isolated-repair-fixture'; capture.proofSemantics = proofSemantics ?? capture.proofSemantics;
  capture.observations = records.map((row, index) => {
    const recordPointer = `/records/${index}`, values = { vendorRecordId: row.vendor, sku: row.sku ?? `repair-${row.vendor}`, name: row.name ?? `Repair ${row.vendor}`, barcode: row.barcode ?? '' };
    return { observationId: randomUUID(), recordPointer, fields: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value === '' ? { state: 'empty' as const, value: null, evidenceRef: `${capture.evidenceId}#${recordPointer}/${key}` } : { state: 'value' as const, value, evidenceRef: `${capture.evidenceId}#${recordPointer}/${key}` }])), marketContext: row.market ?? unknownContext(), warehouseContext: row.warehouse ?? unknownContext(), position: { file: 'isolated-repair-fixture.json', row: index + 1 }, payloadSha256: digest(canonicalJson(row)), sourceEffectiveAt: null, sourceAvailability: 'not_observed' as const };
  });
  capture.coverage = { singleScope: true, complete: true, recordCount: records.length, verificationEnvironment: 'fixture' };
  const bytes = Buffer.from(canonicalJson({ environment: 'fixture', purpose: 'trusted isolated N1A repair observation', scopeId: scope.scopeId, records, proofSemantics: capture.proofSemantics }));
  const stored = await storePrivateArtifact('n1a-repair-observation.json', bytes);
  Object.assign(capture, { bytesSha256: stored.sha256, size: stored.size, storageHandle: stored.storageHandle });
  capture.projectionSha256 = digest(canonicalJson(capture.observations)); capture.adoptionDigest = captureAdoptionDigest({ ...capture, scopeId: scope.scopeId });
  if (importNow) await mutate('import_capture', capture, scope.scopeId); return capture;
}
async function repairRegister(scope: RepairScope, capture: PreparedIdentityCapture, index = 0) {
  return mutate('register', { contractId: scope.contractId, observationId: capture.observations[index].observationId, proofId: scope.proofId, expectedMatch: { kind: 'none' }, reason: 'Explicit isolated repair registration' }, scope.scopeId);
}
let repairNegativeNumber = 0;
async function rejectUnchanged(label: string, fn: () => Promise<unknown>, message: string) {
  const before = await identityState(), countsBefore = await counts();
  const outcome = await fn().then((result) => ({ accepted: true, result, error: null }), (error) => ({ accepted: false, result: null, error: { code: error.code, message: error.message } }));
  const after = await identityState(), countsAfter = await counts();
  receipt(`repair-negative-${++repairNegativeNumber}-${label}.json`, { outcome, beforeSha256: digest(canonicalJson(before)), afterSha256: digest(canonicalJson(after)), countsBefore, countsAfter, expectedMessage: message });
  expect(outcome.accepted).toBe(false); expect(outcome.error?.message).toBe(message); expect(after).toEqual(before); expect(countsAfter).toEqual(countsBefore);
}
async function collectResidualCase(failures: string[], label: string, fn: () => Promise<void>) {
  try { await fn(); } catch (error) { failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`); }
}
async function unlinkedFrozen() {
  return (await owner.query(`SELECT to_jsonb(fo) original FROM catalog.source_observation fo JOIN catalog.observation_batch b ON b.id=fo.batch_id JOIN catalog.source_dataset d ON d.id=b.dataset_id JOIN catalog.source_namespace n ON n.id=d.namespace_id WHERE n.system='bigseller' AND fo.fields->'sku'->>'meaning'='value' AND fo.fields->'name'->>'meaning'='value' AND fo.scope->'warehouse'->>'raw'='喜运达MY仓' AND NOT EXISTS(SELECT 1 FROM catalog.observation_record_link l WHERE l.frozen_observation_id=fo.id) ORDER BY fo.entry_key LIMIT 1`)).rows[0].original;
}
async function residualFrozenProbe(label: string, dimension: 'market' | 'warehouse', previousStatus: 'linked' | 'revoked' | null, frozenState: 'conflict' | 'matching' | 'unknown', sufficient = true, operation: 'link' | 'revoke' = 'link') {
  const original = await unlinkedFrozen(), expectedIdentity = dimension === 'warehouse' && frozenState === 'matching' ? original.scope.warehouse.raw : `RESIDUAL-${dimension}-W1`;
  const scope = await repairScope({ [`${dimension}Role`]: 'identity', [`${dimension}Identity`]: expectedIdentity }, sufficient);
  const capture = await repairCapture(scope, ['old', 'new'].map((suffix) => ({ vendor: `residual-${label}-${suffix}`, sku: original.fields.sku.raw, name: original.fields.name.raw, barcode: original.fields.barcode?.meaning === 'value' ? original.fields.barcode.raw : '', [dimension]: knownContext(expectedIdentity) })));
  const records = [];
  for (const observation of capture.observations) records.push(await mutate('register', { contractId: scope.contractId, observationId: observation.observationId, proofId: capture.evidenceId, expectedMatch: { kind: 'none' }, reason: 'Known matching support for isolated frozen-scope regression' }, scope.scopeId));
  const fixture = dimension === 'market' || frozenState === 'unknown', frozenRow = structuredClone(original);
  if (fixture) {
    frozenRow.id = randomUUID(); frozenRow.entry_key = `/isolated-residual/${randomUUID()}`; frozenRow.legacy_candidate_id = frozenRow.entry_key;
    frozenRow.scope[dimension] = frozenState === 'unknown' ? unknownContext() : knownContext(frozenState === 'matching' ? expectedIdentity : `RESIDUAL-${dimension}-W2`);
    frozenRow.position = { file: 'rollback-only-frozen-scope-fixture', row: 1 }; frozenRow.raw_ref = 'rollback-only-isolated-fixture#/source'; frozenRow.payload_sha256 = digest(canonicalJson({ scope: frozenRow.scope, fields: frozenRow.fields }));
  }
  const baselineBefore = await oldSnapshot(), globalBefore = await identityState(), client = await owner.connect();
  let outcome: { accepted: boolean; result: IdentityMutationResult | null; error: { code: string; message: string } | null } | undefined;
  let unchanged = false, frozenUnchanged = false, lineagePreserved = true;
  try {
    await client.query('BEGIN'); await client.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`, [ADMIN]);
    if (fixture) {
      const columns = Object.keys(frozenRow), jsonColumns = new Set(['fields', 'position', 'scope']);
      await client.query(`INSERT INTO catalog.source_observation(${columns.join(',')}) VALUES(${columns.map((_, index) => `$${index + 1}`).join(',')})`, columns.map((column) => jsonColumns.has(column) ? JSON.stringify(frozenRow[column]) : frozenRow[column]));
    }
    if (previousStatus) await client.query(`INSERT INTO catalog.observation_record_link VALUES($1,1,NULL,$2,'frozen',$3,NULL,$4,$5,$6,$7,'{}','Rollback-only preexisting association fixture',$8,now())`, [`frozen:${frozenRow.id}`, scope.scopeId, frozenRow.id, records[0].recordId, scope.contractId, scope.proofId, previousStatus, ADMIN]);
    const before = await identityState(client), frozenBefore = (await client.query('SELECT to_jsonb(fo) row FROM catalog.source_observation fo WHERE id=$1', [frozenRow.id])).rows;
    const decisionsBefore = (await client.query('SELECT to_jsonb(d) row FROM catalog.decision_evidence d WHERE observation_id=$1 ORDER BY id', [original.id])).rows;
    const target = operation === 'revoke' ? records[0] : records[1];
    const payload = { operation, recordId: target.recordId, expectedRecordRevision: 1, expectedPreviousRecordRevision: 1, expectedLinkRevision: previousStatus ? 1 : 0, origin: { kind: 'frozen', id: frozenRow.id }, proofId: capture.evidenceId, reason: `Explicit isolated ${label}` };
    await client.query('SET LOCAL ROLE ice_p0_02_app_runner'); await client.query('SAVEPOINT residual_attempt');
    outcome = await client.query('SELECT catalog.identity_mutate($1,$2,$3,$4,$5::jsonb) result', [randomUUID(), scope.scopeId, 'link', sourceIdentityIntent(identity(), scope.scopeId, 'link', payload), JSON.stringify(payload)]).then((result) => ({ accepted: true, result: result.rows[0].result, error: null }), (error) => ({ accepted: false, result: null, error: { code: error.code, message: error.message } }));
    if (!outcome.accepted) await client.query('ROLLBACK TO residual_attempt');
    await client.query('RESET ROLE'); const after = await identityState(client); unchanged = canonicalJson(before) === canonicalJson(after);
    const frozenAfter = (await client.query('SELECT to_jsonb(fo) row FROM catalog.source_observation fo WHERE id=$1', [frozenRow.id])).rows;
    const decisionsAfter = (await client.query('SELECT to_jsonb(d) row FROM catalog.decision_evidence d WHERE observation_id=$1 ORDER BY id', [original.id])).rows;
    frozenUnchanged = canonicalJson(frozenBefore) === canonicalJson(frozenAfter) && canonicalJson(decisionsBefore) === canonicalJson(decisionsAfter);
    const links = (await client.query('SELECT * FROM catalog.observation_record_link WHERE observation_key=$1 ORDER BY link_revision', [`frozen:${frozenRow.id}`])).rows;
    if (operation === 'revoke' && outcome.accepted) lineagePreserved = links.length === 2 && links[1].proof_id === links[0].proof_id && links[1].contract_id === links[0].contract_id && links[1].status === 'revoked';
    receipt(`residual-r3-${label}.json`, { outcome, scopeId: scope.scopeId, identityValue: expectedIdentity, dimension, previousStatus, frozenState, sufficientScopeProof: sufficient, originalFrozen: original, submittedFrozen: frozenRow, originalDecisions: decisionsBefore, frozenBefore, frozenAfter, decisionsAfter, links, beforeStateSha256: digest(canonicalJson(before)), afterStateSha256: digest(canonicalJson(after)), unchanged, frozenUnchanged, rollbackOnlyProbe: true, syntheticFrozenFixture: fixture, lineagePreserved });
  } finally { await client.query('ROLLBACK'); client.release(); }
  expect(await identityState()).toEqual(globalBefore); expect(await oldSnapshot()).toEqual(baselineBefore); expect(frozenUnchanged).toBe(true);
  if (operation === 'revoke' || frozenState !== 'conflict' && sufficient) { expect(outcome?.accepted).toBe(true); expect(lineagePreserved).toBe(true); }
  else { expect(outcome?.accepted).toBe(false); expect(outcome?.error?.message).toBe(frozenState === 'conflict' ? 'IDENTITY_FROZEN_SCOPE_CONTRADICTION' : 'IDENTITY_SCOPE_UNPROVEN'); expect(unchanged).toBe(true); }
}

describe.sequential('N1A actual isolated PostgreSQL', () => {
  beforeAll(async () => {
    const prepared = await prepareBaseline(); await catalogRepository.publish(identity(), randomUUID(), prepared);
    await catalogRepository.importFrozen(identity(), randomUUID(), await loadFrozenFeishu());
    originalNewItem = (await owner.query(`SELECT item_id FROM catalog.baseline_item_anchor WHERE row_position=122`)).rows[0].item_id;
    frozen = (await owner.query(`SELECT id FROM catalog.source_observation WHERE fields->'sku'->>'raw'='780103214060' AND entry_key='/candidates/0'`)).rows[0]?.id;
    if (!frozen) frozen = (await owner.query(`SELECT o.id FROM catalog.source_observation o JOIN catalog.observation_batch b ON b.id=o.batch_id JOIN catalog.source_dataset d ON d.id=b.dataset_id JOIN catalog.source_namespace n ON n.id=d.namespace_id WHERE n.system='bigseller' AND fields->'sku'->>'raw'='780103214060' ORDER BY entry_key LIMIT 1`)).rows[0].id;
    initialOld = await oldSnapshot();
    receipt('baseline-manifests.json', { full147: prepared.fullManifest, subset129: prepared.subsetManifest, originalNewItem });
  });
  afterAll(async () => { await Promise.all([owner.end(), app.end(), closeP002Pools()]); });

  it('keeps 126/1417/548 exact targets,JST references,6190 historical indexes and fixed manifests', async () => {
    const prepared = await prepareBaseline(); expect(prepared.fullManifest).toHaveLength(147); expect(prepared.subsetManifest).toHaveLength(129);
    const saved = (await owner.query(`SELECT d.*,a.json_pointer,o.entry_key AS observation_entry_key FROM catalog.decision_evidence d LEFT JOIN catalog.baseline_item_anchor a ON a.item_id=d.selected_item_id AND a.release_id=d.release_id LEFT JOIN catalog.source_observation o ON o.id=d.observation_id ORDER BY entry_kind,entry_key`)).rows;
    expect(saved).toHaveLength(6190); expect(prepared.decisions).toHaveLength(6190);
    const historyChecks = [];
    const savedByKey = new Map(saved.map((d) => [`${d.entry_kind}\n${d.entry_key}`, d]));
    for (const expected of prepared.decisions) {
      const actual = savedByKey.get(`${expected.entryKind}\n${expected.entryKey}`)!;
      expect(actual).toBeDefined(); expect(actual.payload_sha256).toBe(expected.payloadSha256); expect(actual.raw_ref).toBe(expected.rawRef);
      expect(actual.review_state).toBe(expected.reviewState); expect(actual.summary).toEqual(expected.summary);
      expect(actual.json_pointer).toBe(expected.selectedItemAnchor); expect(actual.observation_entry_key).toBe(expected.observationEntryKey);
      expect(actual.selected_jushuitan_ref).toBe(expected.selectedJushuitanRef); expect(actual.selected_jushuitan_sha256).toBe(expected.selectedJushuitanSha256);
      historyChecks.push({ entryKind: actual.entry_kind, entryKey: actual.entry_key, observationEntryKey: actual.observation_entry_key,
        selectedItemAnchor: actual.json_pointer, selectedJushuitanRef: actual.selected_jushuitan_ref, selectedJushuitanSha256: actual.selected_jushuitan_sha256,
        payloadSha256: actual.payload_sha256, reviewState: actual.review_state, summary: actual.summary, rawRef: actual.raw_ref, equal: true });
    }
    receipt('all-6190-history-exact.json', historyChecks);
    const checks = [];
    for (const selected of prepared.decisions.filter((d) => d.entryKind === 'candidate_snapshot' && d.reviewState === 'manual_selected')) {
      const actual = saved.find((d) => d.entry_kind === selected.entryKind && d.entry_key === selected.entryKey)!;
      expect(actual.json_pointer).toBe(selected.selectedItemAnchor); expect(actual.selected_jushuitan_ref).toBe(selected.selectedJushuitanRef); expect(actual.selected_jushuitan_sha256).toBe(selected.selectedJushuitanSha256); expect(actual.payload_sha256).toBe(selected.payloadSha256);
      checks.push({ source: selected.entryKey, target: actual.json_pointer, jst: actual.selected_jushuitan_ref, equal: true });
    }
    expect(checks).toHaveLength(548); receipt('frozen-548-exact.json', checks);
    const runtime = (await app.query(`SELECT current_user AS name,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`)).rows[0]; expect(runtime.rolsuper).toBe(false); expect(runtime.rolbypassrls).toBe(false);
    const policies = (await owner.query(`SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner) owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relname=ANY($1) AND n.nspname IN('catalog','catalog_private')`, [[...newTables, 'identity_evidence_handle']])).rows;
    expect(policies).toHaveLength(10); for (const p of policies) { expect(p.relrowsecurity).toBe(true); expect(p.relforcerowsecurity).toBe(true); expect(p.owner).not.toBe(runtime.name); }
    receipt('runtime-ten-tables.json', { runtime, policies });
  });

  it('enforces two-admin scope/read/manage/raw capabilities and blocks old global evidence/ledger access', async () => {
    expect((await sourceIdentityRepository.scopes(identity())).map((s) => s.scopeId)).toEqual([A]);
    expect((await sourceIdentityRepository.scopes(identity(ADMIN_B))).map((s) => s.scopeId)).toEqual([B]);
    for (const [actor, scope] of [[ADMIN, B], [ADMIN_B, A], [OPERATOR, A], [INACTIVE, A], [null, A]] as const) await expect(tx(actor, (c) => c.query('SELECT catalog.identity_read($1)', [scope]))).rejects.toMatchObject({ code: '42501' });
    for (const actor of [NO_AMOUNT, NO_EVIDENCE]) await expect(sourceIdentityRepository.evidence(identity(actor), PROOF_A)).rejects.toMatchObject({ code: '42501' });
    expect((await sourceIdentityRepository.evidence(identity(READ), PROOF_A)).evidenceId).toBe(PROOF_A);
    await expect(tx(READ, (c) => c.query(`SELECT catalog.identity_authorize($1,'manage')`, [A]))).rejects.toMatchObject({ code: '42501' });
    await expect(tx(ADMIN, (c) => c.query('SELECT * FROM catalog_private.identity_evidence_handle'))).rejects.toMatchObject({ code: '42501' });
    for (const t of newTables) await expect(tx(ADMIN, (c) => c.query(`DELETE FROM catalog.${t} WHERE false`))).rejects.toMatchObject({ code: '42501' });
    const old = await tx(ADMIN, async (c) => (await c.query('SELECT catalog.read_artifact($1) result', [PROOF_A])).rows[0].result); expect(old).toBeNull();
    const exported = await sourceIdentityRepository.evidenceExport(identity(), PROOF_A); expect(JSON.stringify(exported)).not.toMatch(/storageHandle|costPriceRaw|9988\.17|password|postgres:\/\//);
    receipt('scope-permissions.json', { actorsSeparated: true, capabilityDenials: true, readWithoutManageRawAllowed: true, appDmlDenied: true, oldEvidenceReturnsNull: true });
  });

  it('rolls back evidence/observation/success-ledger failures and captures idempotently with complete adoption digests', async () => {
    const p = await prepareSourceFixtureCapture('products-v1');
    for (const table of ['identity_evidence','catalog_private.identity_evidence_handle','identity_observation','source_identity_request']) {
      const before = await counts(); await injected(table, 'INSERT', () => mutate('import_capture', p.capture)); expect(await counts()).toEqual(before);
    }
    const request = randomUUID(), first = await sourceIdentityRepository.mutate(identity(), request, A, 'import_capture', p.capture);
    expect(await sourceIdentityRepository.mutate(identity(), request, A, 'import_capture', p.capture)).toEqual(first);
    await expect(tx(ADMIN, (c) => c.query('SELECT catalog.identity_mutate($1,$2,$3,$4,$5::jsonb)', [request, A, 'import_capture', sourceIdentityIntent(identity(), A, 'import_capture', p.capture), JSON.stringify({ ...p.capture, parserVersion: 'tampered-with-original-intent' })]))).rejects.toMatchObject({ message: 'IDENTITY_REQUEST_CONFLICT' });
    expect(await sourceIdentityRepository.receipt(identity(), request, A, 'import_capture', sourceIdentityIntent(identity(), A, 'import_capture', p.capture))).toEqual(first);
    const again = await mutate('import_capture', p.capture); expect(again.evidenceId).toBe(first.evidenceId);
    for (const change of [{ parserVersion: '2' }, { bytesSha256: '0'.repeat(64) }, { contractRevision: 2 }]) {
      const changed = { ...p.capture, ...change }; changed.adoptionDigest = captureAdoptionDigest({ ...changed, scopeId: A });
      await expect(mutate('import_capture', changed)).rejects.toBeDefined();
    }
    const changedProjection = structuredClone(p.capture); changedProjection.observations[0].fields.name = { state: 'value', value: 'renamed same capture', evidenceRef: 'fixture' };
    changedProjection.projectionSha256 = digest(canonicalJson(changedProjection.observations)); changedProjection.adoptionDigest = captureAdoptionDigest({ ...changedProjection, scopeId: A });
    await expect(mutate('import_capture', changedProjection)).rejects.toMatchObject({ code: '23505' });
    const ws = await sourceIdentityRepository.workspace(identity(), A); a1 = ws.observations.find((o) => o.fields.vendorRecordId.state === 'value' && o.fields.vendorRecordId.value === 'fixture-vendor-001')!.observationId;
    a2 = ws.observations.find((o) => o.fields.vendorRecordId.state === 'value' && o.fields.vendorRecordId.value === 'fixture-vendor-002')!.observationId;
    await capture('products-conflicts-v3', ADMIN_B); b1 = (await sourceIdentityRepository.workspace(identity(ADMIN_B), B)).observations.find((o) => o.fields.sku.state === 'value' && o.fields.sku.value === '780103214060')!.observationId;
    receipt('capture-adoption.json', { request, first, again, failedWritesNoHalf: true, changedInterpretationRejected: true });
  });

  it('atomic register rejects each record/claim/request failure; stable and business keys register independently', async () => {
    for (const table of ['source_record','identity_claim','source_identity_request']) { const before = await counts(); await injected(table, 'INSERT', () => registration(a1)); expect(await counts()).toEqual(before); }
    const attempts = await Promise.allSettled([registration(a1), registration(a1)]);
    receipt('register-concurrent-attempts.json', attempts.map((r) => r.status === 'fulfilled' ? { status: r.status, value: r.value } : { status: r.status, code: r.reason.code, message: r.reason.message }));
    expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    recordA = (attempts.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<IdentityMutationResult>).value;
    recordA2 = await registration(a2); recordB = await registration(b1, B, { kind: 'none' }, ADMIN_B); expect(recordA.recordId).not.toBe(recordB.recordId);
    const same = await registration(a1, A, { kind: 'record', recordId: recordA.recordId, revision: 1 }); expect(same.recordId).toBe(recordA.recordId); expect(same.created).toBe(false);
    await expect(registration(a1, A, { kind: 'record', recordId: null, revision: null })).rejects.toMatchObject({ code: '40001' });
    const ws = await sourceIdentityRepository.workspace(identity(ADMIN_B), B), dup = ws.observations.find((o) => o.fields.sku.state === 'value' && o.fields.sku.value === 'FIXTURE-DUPLICATE-B')!;
    await expect(registration(dup.observationId, B, { kind: 'none' }, ADMIN_B)).rejects.toMatchObject({ code: '23505' });
    const missing = (await sourceIdentityRepository.workspace(identity(), A)).observations.find((o) => o.fields.vendorRecordId.state !== 'value')!;
    await expect(registration(missing.observationId)).rejects.toBeDefined();
    receipt('register-two-strategies-concurrency.json', { recordA, recordA2, recordB, oneConcurrentSuccess: true, duplicateAndMissingKeysDenied: true });
  });

  it('C2 keeps context additions/reordering in the same scope and record, preserving SQL and TS canonical identity', async () => {
    const before = (await owner.query('SELECT * FROM catalog.source_record WHERE id=$1', [recordA.recordId])).rows[0];
    const second = await capture('products-reordered-v2'); const ws = await sourceIdentityRepository.workspace(identity(), A);
    a1new = ws.observations.find((o) => o.evidenceId === second.capture.evidenceId && o.fields.vendorRecordId.state === 'value' && o.fields.vendorRecordId.value === 'fixture-vendor-001')!.observationId;
    const same = await registration(a1new, A, { kind: 'record', recordId: recordA.recordId, revision: 1 }); expect(same.recordId).toBe(recordA.recordId);
    expect((await owner.query('SELECT * FROM catalog.source_record WHERE id=$1', [recordA.recordId])).rows[0]).toEqual(before);
    const config = (await prepareSourceIdentityBootstrap()).scopes[0];
    const expected = encodeScope(Object.fromEntries(['system','entityKind','accountKind','accountParts','resourceKind','resourceParts','marketRole','marketIdentity','warehouseRole','warehouseIdentity'].map((key) => [key, (config as Record<string, unknown>)[key]])) as never);
    expect((await owner.query('SELECT canonical_scope,scope_sha256 FROM catalog.source_scope WHERE id=$1', [A])).rows[0]).toEqual({ canonical_scope: expected.canonical, scope_sha256: expected.sha256 });
    const observation = ws.observations.find((o) => o.observationId === a1new)!;
    expect(observation.marketContext.state).toBe('known'); expect(observation.warehouseContext.state).toBe('known');
    const key = encodeRecordKey({ scopeId: A, entityKind: 'product_record', contractRevision: 1, strategy: 'vendor_stable_id', keyFields: ['vendorRecordId'], fields: observation.fields });
    const actual = (await owner.query('SELECT canonical_key,key_sha256 FROM catalog.identity_claim WHERE id=$1', [recordA.claimId])).rows[0]; expect(actual).toEqual({ canonical_key: key.canonical, key_sha256: key.sha256 });
    receipt('c2-codec-context.json', { scope: expected, key: { canonical: key.canonical, sha256: key.sha256 }, sameRecord: same.recordId, beforeHeadPreserved: true, oldObservationRetained: a1, newObservation: a1new });
  });

  it('preserves immutable link chains; wrong known frozen fields and cross-scope links cannot masquerade as corrected', async () => {
    const sql = fs.readFileSync(path.join(process.cwd(), 'db/catalog/004_source_identity_security.sql'), 'utf8');
    const marker = "'frozenHumanChoice',(", start = sql.indexOf(marker) + marker.length, end = sql.indexOf("),\n 'verificationEnvironment'", start);
    expect(start).toBeGreaterThan(marker.length); expect(end).toBeGreaterThan(start);
    const projection = sql.slice(start, end).replace('system=s.system', 'system=$1');
    const plan = await tx(ADMIN, async (c) => (await c.query(`EXPLAIN (FORMAT JSON) ${projection}`, ['bigseller'])).rows);
    receipt('frozen-choice-query-plan.json', { mode: 'EXPLAIN without ANALYZE', sourceSqlSha256: digest(sql), runtimeRole: 'ice_p0_02_app_runner', rlsBypass: false, plan });
    const link = { operation: 'link', recordId: recordA.recordId, expectedRecordRevision: 1, expectedLinkRevision: 0, origin: { kind: 'frozen', id: frozen }, proofId: PROOF_A, reason: 'explicit frozen evidence association only' };
    const beforeInvalidLink = await identityState(), countsBeforeInvalidLink = await counts();
    for (const operation of ['missing', 'json_null'] as const) {
      const payload: Record<string, unknown> = { ...link }; if (operation === 'missing') delete payload.operation; else payload.operation = null;
      await expect(tx(ADMIN, (c) => c.query('SELECT catalog.identity_mutate($1,$2,$3,$4,$5::jsonb)', [randomUUID(), A, 'link', sourceIdentityIntent(identity(), A, 'link', payload), JSON.stringify(payload)]))).rejects.toMatchObject({ code: '22023', message: 'IDENTITY_LINK_INPUT_INVALID' });
      expect(await identityState()).toEqual(beforeInvalidLink); expect(await counts()).toEqual(countsBeforeInvalidLink);
    }
    receipt('link-null-operation-guards.json', { missingAndJsonNullRejected: true, beforeStateSha256: digest(canonicalJson(beforeInvalidLink)), afterStateSha256: digest(canonicalJson(await identityState())), headsClaimsLinksSuccessRequestsAndObservationsUnchanged: true });
    await expect(mutate('link', { ...link, recordId: recordA2.recordId })).rejects.toMatchObject({ code: '23505' });
    for (const table of ['observation_record_link','source_identity_request']) { const before = await counts(); await injected(table, 'INSERT', () => mutate('link', link)); expect(await counts()).toEqual(before); }
    const linked = await mutate('link', link); expect(linked.linkRevision).toBe(1);
    const reversed = await mutate('link', { ...link, operation: 'revoke', expectedLinkRevision: 1 }); expect(reversed.linkRevision).toBe(2);
    await expect(mutate('link', link)).rejects.toMatchObject({ code: '40001' });
    await expect(mutate('link', { ...link, recordId: recordB.recordId, proofId: PROOF_B }, B, ADMIN_B)).rejects.toBeDefined();
    const history = (await sourceIdentityRepository.workspace(identity(), A)).links.filter((l) => l.originId === frozen); expect(history.map((h) => h.status)).toEqual(['linked','revoked']);
    for (const version of history) { expect(version.actorId).toBe(ADMIN); expect(version.contractId).toBe(CONTRACT_A); }
    receipt('link-history.json', { linked, reversed, history, oldFrozenChoiceUnmodified: true, wrongSkuAndScopeDenied: true });
  });

  it('explicit revoke never revives via old register; fresh-proof reverify keeps UUID with strict CAS/head facts', async () => {
    const before = await counts();
    const revoke = { recordId: recordA.recordId, expectedRecordRevision: 1, command: 'revoke', proofId: PROOF_A, reason: 'fixture tombstone' };
    const beforeInvalidRevise = await identityState();
    for (const command of ['missing', 'json_null'] as const) {
      const payload: Record<string, unknown> = { ...revoke }; if (command === 'missing') delete payload.command; else payload.command = null;
      await expect(tx(ADMIN, (c) => c.query('SELECT catalog.identity_mutate($1,$2,$3,$4,$5::jsonb)', [randomUUID(), A, 'revise', sourceIdentityIntent(identity(), A, 'revise', payload), JSON.stringify(payload)]))).rejects.toMatchObject({ code: '22023', message: 'IDENTITY_COMMAND_INVALID' });
      expect(await identityState()).toEqual(beforeInvalidRevise); expect(await counts()).toEqual(before);
    }
    for (const input of [{ action: null, payload: revoke, sqlPayload: JSON.stringify(revoke) }, { action: 'revise' as const, payload: null, sqlPayload: null }, { action: 'revise' as const, payload: null, sqlPayload: 'null' }]) {
      await expect(tx(ADMIN, (c) => c.query('SELECT catalog.identity_mutate($1,$2,$3,$4,$5::jsonb)', [randomUUID(), A, input.action, sourceIdentityIntent(identity(), A, input.action as IdentityAction, input.payload), input.sqlPayload]))).rejects.toMatchObject({ code: '22023', message: 'IDENTITY_INPUT_INVALID' });
      expect(await identityState()).toEqual(beforeInvalidRevise); expect(await counts()).toEqual(before);
    }
    receipt('revise-null-command-guards.json', { missingAndJsonNullCommandRejected: true, sqlNullActionAndSqlOrJsonNullPayloadRejected: true, beforeStateSha256: digest(canonicalJson(beforeInvalidRevise)), afterStateSha256: digest(canonicalJson(await identityState())), headsClaimsLinksSuccessRequestsAndObservationsUnchanged: true });
    await injected('source_record', 'UPDATE', () => mutate('revise', revoke)); expect(await counts()).toEqual(before);
    const headAndClaimsBefore = (await owner.query('SELECT to_jsonb(r) head,(SELECT jsonb_agg(to_jsonb(c)) FROM catalog.identity_claim c WHERE c.record_id=r.id) claims FROM catalog.source_record r WHERE id=$1', [recordA.recordId])).rows;
    await injected('source_identity_request', 'INSERT', () => mutate('revise', revoke));
    expect((await owner.query('SELECT to_jsonb(r) head,(SELECT jsonb_agg(to_jsonb(c)) FROM catalog.identity_claim c WHERE c.record_id=r.id) claims FROM catalog.source_record r WHERE id=$1', [recordA.recordId])).rows).toEqual(headAndClaimsBefore);
    expect(await counts()).toEqual(before);
    const attempts = await Promise.allSettled([mutate('revise', revoke), mutate('revise', revoke)]); expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    await expect(registration(a1, A, { kind: 'record', recordId: recordA.recordId, revision: 2 })).rejects.toMatchObject({ code: '23505' });
    const fresh = await syntheticCapture('fixture-vendor-001','780103214060','New isolated proof collected after the current tombstone'); await mutate('import_capture', fresh);
    const reverify = await mutate('revise', { recordId: recordA.recordId, expectedRecordRevision: 2, command: 'reverify', proofId: fresh.evidenceId, contractId: CONTRACT_A, observationId: fresh.observations[0].observationId, expectedClaimId: recordA.claimId, reason: 'fresh scoped fixture proof collected after the current tombstone' });
    expect(reverify.recordId).toBe(recordA.recordId); expect(reverify.revision).toBe(3); expect(reverify.state).toBe('active');
    const head = (await owner.query('SELECT * FROM catalog.source_record WHERE id=$1', [recordA.recordId])).rows[0];
    for (const sql of [`UPDATE catalog.source_record SET revision=1,latest_request_id=(SELECT request_id FROM catalog.source_identity_request WHERE source_record_id=$1 AND record_revision=1) WHERE id=$1`, `UPDATE catalog.source_record SET revision=revision+2 WHERE id=$1`, `UPDATE catalog.source_record SET state='revoked' WHERE id=$1`]) {
      const c = await owner.connect(); try { await c.query('BEGIN'); await c.query(sql, [recordA.recordId]); await expect(c.query('COMMIT')).rejects.toBeDefined(); } finally { await c.query('ROLLBACK'); c.release(); }
      expect((await owner.query('SELECT * FROM catalog.source_record WHERE id=$1', [recordA.recordId])).rows[0]).toEqual(head);
    }
    receipt('head-cas-tombstone.json', { reverify, head, oldRequestRollbackJumpAndWrongAfterDenied: true });
  });

  it('unresolved scope only stores observations and true identity policy changes require crosswalk', async () => {
    const config = (await prepareSourceIdentityBootstrap()).scopes[0], before = await counts(), c = await owner.connect();
    const unresolved = randomUUID(), contract = randomUUID();
    const p = await syntheticCapture('UNVERIFIED-ID','UNVERIFIED-SKU','Unresolved fixture only', undefined, unresolved, contract);
    const proofBytes = Buffer.from(canonicalJson({ scopeId: unresolved, purpose: 'unresolved fixture proof with account identity not verified' }));
    const handle = await storePrivateArtifact('inline-unresolved-proof.json', proofBytes);
    try {
      await c.query('BEGIN'); await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`, [ADMIN]);
      await c.query('SELECT catalog.identity_fixture_bootstrap($1::jsonb)', [JSON.stringify({ ...config, scopeId: unresolved, scopeState: 'unresolved', accountParts: [], resourceParts: [], contractId: contract, proofId: randomUUID(), proofCaptureKey: 'unresolved-proof', proofSha256: handle.sha256, proofSize: handle.size, proofHandle: handle.storageHandle, grants: [{ profileId: ADMIN, read: true, manage: true, evidence: true, amount: true }] })]);
      const imported = (await c.query('SELECT catalog.identity_mutate($1,$2,$3,$4,$5::jsonb) r', [randomUUID(), unresolved, 'import_capture', sourceIdentityIntent(identity(), unresolved, 'import_capture', p), JSON.stringify(p)])).rows[0].r;
      await c.query('SAVEPOINT unresolved_register');
      const registrationPayload = { contractId: contract, observationId: p.observations[0].observationId, proofId: p.evidenceId, expectedMatch: { kind: 'none' }, reason: 'must not create an unresolved record' };
      await expect(c.query('SELECT catalog.identity_mutate($1,$2,$3,$4,$5::jsonb)', [randomUUID(), unresolved, 'register', sourceIdentityIntent(identity(), unresolved, 'register', registrationPayload), JSON.stringify(registrationPayload)])).rejects.toMatchObject({ message: 'IDENTITY_SCOPE_UNRESOLVED' });
      await c.query('ROLLBACK TO unresolved_register');
      expect((await c.query('SELECT count(*)::int n FROM catalog.source_record WHERE scope_id=$1', [unresolved])).rows[0].n).toBe(0);
      for (const patch of [{ accountParts: ['DIFFERENT-ACCOUNT'] }, { resourceParts: ['DIFFERENT-DATASET'] }, { entityKind: 'sku_record' }, { warehouseRole: 'identity', warehouseIdentity: 'W1' }, { marketRole: 'identity', marketIdentity: 'M1' }]) {
        await c.query('SAVEPOINT changed_policy');
        await expect(c.query('SELECT catalog.identity_fixture_bootstrap($1::jsonb)', [JSON.stringify({ ...config, ...patch, proofId: randomUUID(), proofCaptureKey: randomUUID(), contractId: randomUUID(), contractRevision: 2, grants: [] })])).rejects.toMatchObject({ message: 'SCOPE_CROSSWALK_REQUIRED' });
        await c.query('ROLLBACK TO changed_policy');
      }
      receipt('unresolved-true-dimensions.json', { unresolved, imported, records: 0, changedAccountResourceEntityMarketWarehouseDenied: true, probeTransactionRolledBack: true });
    } finally { await c.query('ROLLBACK'); c.release(); }
    expect(await counts()).toEqual(before);
  });

  it('detects same hash with different full canonical text through the real app function and rolls back the probe', async () => {
    const before = await counts(), c = await owner.connect();
    try {
      await c.query('BEGIN'); await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`, [ADMIN]);
      const actual = (await c.query('SELECT * FROM catalog.identity_claim WHERE id=$1', [recordA.claimId])).rows[0];
      const forged = { ...actual, id: randomUUID(), canonical_key: 'ISOLATED-FULL-TEXT-COLLISION-PROBE', canonical_domain: 'ISOLATED-FULL-DOMAIN-COLLISION-PROBE' };
      const fields = Object.keys(forged);
      await c.query(`INSERT INTO catalog.identity_claim(${fields.join(',')}) VALUES(${fields.map((_, i) => `$${i + 1}`).join(',')})`, fields.map((key) => key === 'original_key_fields' ? JSON.stringify(forged[key]) : forged[key]));
      await c.query('SET LOCAL ROLE ice_p0_02_app_runner'); await c.query('SAVEPOINT collision_check');
      const registrationPayload = { contractId: CONTRACT_A, observationId: a1, proofId: PROOF_A, expectedMatch: { kind: 'record', recordId: recordA.recordId, revision: 3 }, reason: 'must compare full canonical text' };
      await expect(c.query('SELECT catalog.identity_mutate($1,$2,$3,$4,$5::jsonb)', [randomUUID(), A, 'register', sourceIdentityIntent(identity(), A, 'register', registrationPayload), JSON.stringify(registrationPayload)])).rejects.toMatchObject({ message: 'IDENTITY_HASH_COLLISION' });
      await c.query('ROLLBACK TO collision_check'); await c.query('RESET ROLE');
      receipt('hash-full-text-collision.json', { detected: true, runtime: 'ice_p0_02_app_runner', corruptedClaimNeverCommitted: true });
    } finally { await c.query('ROLLBACK'); c.release(); }
    expect(await counts()).toEqual(before);
  });

  it('same-scope compatible relink checks both records and commits exactly one concurrent link revision', async () => {
    const p = await syntheticCapture('fixture-vendor-002','780103214060','ICE LERSKIN 三酸净化喷雾 120ml');
    await mutate('import_capture', p);
    const initial = await mutate('link', { operation: 'link', recordId: recordA.recordId, expectedRecordRevision: 3, expectedLinkRevision: 2, origin: { kind: 'frozen', id: frozen }, proofId: PROOF_A, reason: 'restore fixture link before controlled correction' }); expect(initial.linkRevision).toBe(3);
    const payload = { operation: 'link', recordId: recordA2.recordId, expectedRecordRevision: 1, expectedPreviousRecordRevision: 3, expectedLinkRevision: 3, origin: { kind: 'frozen', id: frozen }, proofId: p.evidenceId, reason: 'explicit same-scope observation correction only; no product target change' };
    const attempts = await Promise.allSettled([mutate('link', payload), mutate('link', payload)]);
    expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const links = (await owner.query('SELECT link_revision,record_id,status FROM catalog.observation_record_link WHERE observation_key=$1 ORDER BY link_revision', [`frozen:${frozen}`])).rows;
    expect(links.map((l) => l.link_revision)).toEqual([1,2,3,4]); expect(links[3].record_id).toBe(recordA2.recordId);
    receipt('same-scope-relink-cas.json', { links, oneCommitted: true, bothRecordVersionsChecked: true, oldChoiceUnmodified: true });
  });

  it('changed-key reverify requires a fresh migration proof tied to the exact old claim, then retains the old key tombstone', async () => {
    const original = (await owner.query('SELECT * FROM catalog.source_record WHERE id=$1', [recordA2.recordId])).rows[0];
    const insufficient = await syntheticCapture('fixture-vendor-002-rekey','FIXTURE-NEW-KEY','Explicit key-change fixture'); await mutate('import_capture', insufficient);
    const revision = { recordId: recordA2.recordId, expectedRecordRevision: 1, command: 'reverify', proofId: insufficient.evidenceId, contractId: CONTRACT_A, observationId: insufficient.observations[0].observationId, expectedClaimId: recordA2.claimId, reason: 'key change requires explicit migration binding' };
    await expect(mutate('revise', revision)).rejects.toMatchObject({ message: 'CONTRACT_UPGRADE_CROSSWALK_REQUIRED' });
    expect((await owner.query('SELECT * FROM catalog.source_record WHERE id=$1', [recordA2.recordId])).rows[0]).toEqual(original);
    const approved = await syntheticCapture('fixture-vendor-002-rekey','FIXTURE-NEW-KEY','Explicit key-change fixture', { ...insufficient.proofSemantics, migrationClaimId: recordA2.claimId }); await mutate('import_capture', approved);
    const result = await mutate('revise', { ...revision, proofId: approved.evidenceId, observationId: approved.observations[0].observationId });
    expect(result.recordId).toBe(recordA2.recordId); expect(result.revision).toBe(2); expect(result.claimId).not.toBe(recordA2.claimId);
    await expect(registration(a2, A, { kind: 'record', recordId: recordA2.recordId, revision: 2 })).rejects.toMatchObject({ message: 'IDENTITY_EXPLICIT_REVERIFY_REQUIRED' });
    expect((await owner.query('SELECT count(*)::int n FROM catalog.identity_claim WHERE record_id=$1', [recordA2.recordId])).rows[0].n).toBe(2);
    receipt('changed-key-migration.json', { originalClaim: recordA2.claimId, result, oldClaimRetained: true, originalKeyCannotRevive: true, exactMigrationClaimRequired: true });
  });

  it('repair R1 revokes existing associations in every identity state while preserving original link evidence and CAS', async () => {
    const scope = await repairScope();
    for (const state of ['active', 'open_review', 'suspend', 'revoke', 'rekey'] as const) {
      const source = await repairCapture(scope, [{ vendor: `r1-${state}` }]), registered = await repairRegister(scope, source);
      const origin = { kind: 'identity', id: source.observations[0].observationId }, observationKey = `identity:${origin.id}`;
      await mutate('link', { operation: 'link', recordId: registered.recordId, expectedRecordRevision: 1, expectedLinkRevision: 0, origin, proofId: source.evidenceId, reason: 'Initial isolated repair association' }, scope.scopeId);
      let current = registered;
      if (state === 'rekey') {
        const revisedContract = randomUUID(), revisedProof = randomUUID();
        const semantics = { ...source.proofSemantics, migrationClaimId: registered.claimId! };
        const bytes = Buffer.from(canonicalJson({ scopeId: scope.scopeId, purpose: 'Explicit contract and key migration proof', originalClaimId: registered.claimId, revisedContract }));
        const stored = await storePrivateArtifact('n1a-repair-contract-proof.json', bytes);
        await owner.query('SELECT catalog.identity_fixture_bootstrap($1::jsonb)', [JSON.stringify({ ...scope.config, contractId: revisedContract, contractRevision: 2, proofId: revisedProof, proofCaptureKey: `repair-upgrade-${revisedProof}`, proofSha256: stored.sha256, proofSize: stored.size, proofHandle: stored.storageHandle, proofSemantics: semantics, grants: [] })]);
        const next = await repairCapture({ ...scope, contractId: revisedContract }, [{ vendor: `r1-${state}-new` }], semantics, 2);
        current = await mutate('revise', { command: 'reverify', recordId: registered.recordId, expectedRecordRevision: 1, expectedClaimId: registered.claimId, proofId: next.evidenceId, contractId: revisedContract, observationId: next.observations[0].observationId, reason: 'Explicit same UUID repair migration' }, scope.scopeId);
      } else if (state !== 'active') current = await mutate('revise', { command: state, recordId: registered.recordId, expectedRecordRevision: 1, proofId: scope.proofId, reason: 'Identity state before association withdrawal' }, scope.scopeId);
      const payload = { operation: 'revoke', recordId: current.recordId, expectedRecordRevision: current.revision, expectedLinkRevision: 1, origin, proofId: scope.proofId, reason: 'Withdraw existing association without requalifying old evidence' };
      const headBefore = (await owner.query('SELECT to_jsonb(r) row FROM catalog.source_record r WHERE id=$1', [current.recordId])).rows;
      if (state === 'active') {
        const otherCapture = await repairCapture(scope, [{ vendor: 'r1-wrong-object' }]), other = await repairRegister(scope, otherCapture);
        await rejectUnchanged('r1-wrong-record', () => mutate('link', { ...payload, recordId: other.recordId, expectedRecordRevision: 1, expectedPreviousRecordRevision: 1 }, scope.scopeId), 'IDENTITY_LINK_CONFLICT');
        await rejectUnchanged('r1-absent-link', () => mutate('link', { ...payload, origin: { kind: 'identity', id: randomUUID() }, expectedLinkRevision: 0 }, scope.scopeId), 'IDENTITY_LINK_CONFLICT');
        await rejectUnchanged('r1-stale-cas', () => mutate('link', { ...payload, expectedLinkRevision: 0 }, scope.scopeId), 'IDENTITY_LINK_CONFLICT');
        await rejectUnchanged('r1-cross-scope', () => mutate('link', { ...payload, recordId: recordB.recordId, expectedRecordRevision: 1, proofId: PROOF_B }, B, ADMIN_B), 'IDENTITY_LINK_CONFLICT');
        await owner.query('UPDATE catalog.source_scope_grant SET enabled=false,grant_revision=grant_revision+1 WHERE scope_id=$1 AND profile_id=$2', [scope.scopeId, ADMIN]);
        try { await rejectUnchanged('r1-withdrawn-permission', () => mutate('link', payload, scope.scopeId), 'IDENTITY_DENIED'); }
        finally { await owner.query('UPDATE catalog.source_scope_grant SET enabled=true,grant_revision=grant_revision+1 WHERE scope_id=$1 AND profile_id=$2', [scope.scopeId, ADMIN]); }
      }
      const beforeFailure = await identityState(); await injected('source_identity_request', 'INSERT', () => mutate('link', payload, scope.scopeId)); expect(await identityState()).toEqual(beforeFailure);
      const requests = [randomUUID(), randomUUID()];
      const attempts = await Promise.allSettled(requests.map((requestId) => mutate('link', payload, scope.scopeId, ADMIN, requestId)));
      receipt(`repair-r1-${state}.json`, { attempts: attempts.map((attempt) => attempt.status === 'fulfilled' ? { accepted: true, result: attempt.value } : { accepted: false, error: { code: attempt.reason.code, message: attempt.reason.message } }) });
      expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
      const success = attempts.findIndex((attempt) => attempt.status === 'fulfilled'), result = (attempts[success] as PromiseFulfilledResult<IdentityMutationResult>).value;
      const beforeRetry = await identityState(); expect(await mutate('link', payload, scope.scopeId, ADMIN, requests[success])).toEqual(result); expect(await identityState()).toEqual(beforeRetry);
      await rejectUnchanged(`r1-${state}-duplicate-request`, () => mutate('link', payload, scope.scopeId), 'IDENTITY_LINK_CONFLICT');
      const history = (await owner.query('SELECT * FROM catalog.observation_record_link WHERE observation_key=$1 ORDER BY link_revision', [observationKey])).rows;
      expect(history).toHaveLength(2); expect(history.map((row) => row.status)).toEqual(['linked', 'revoked']);
      for (const key of ['scope_id', 'record_id', 'contract_id', 'proof_id', 'origin_kind', 'frozen_observation_id', 'identity_observation_id', 'frozen_decision_ids']) expect(history[1][key]).toEqual(history[0][key]);
      expect((await owner.query('SELECT proof_id FROM catalog.source_identity_request WHERE request_id=$1', [result.requestId])).rows[0].proof_id).toBe(scope.proofId);
      expect((await owner.query('SELECT to_jsonb(r) row FROM catalog.source_record r WHERE id=$1', [current.recordId])).rows).toEqual(headBefore);
      receipt(`repair-r1-${state}-final.json`, { result, history, originalHead: headBefore, identityRemainsUnchanged: true, originalRequestIdempotent: true, duplicateIndependentRequestRejected: true });
      if (state === 'rekey') expect(history[1].contract_id).not.toBe((await owner.query('SELECT current_contract_id FROM catalog.source_record WHERE id=$1', [current.recordId])).rows[0].current_contract_id);
    }
    const original = (await owner.query('SELECT * FROM catalog.observation_record_link WHERE observation_key=$1 ORDER BY link_revision DESC LIMIT 1', [`frozen:${frozen}`])).rows[0];
    const withdrawn = await mutate('link', { operation: 'revoke', recordId: recordA2.recordId, expectedRecordRevision: 2, expectedLinkRevision: 4, origin: { kind: 'frozen', id: frozen }, proofId: PROOF_A, reason: 'Withdraw frozen observation after legitimate source key change' });
    const last = (await owner.query('SELECT * FROM catalog.observation_record_link WHERE observation_key=$1 ORDER BY link_revision DESC LIMIT 1', [`frozen:${frozen}`])).rows[0];
    for (const key of ['contract_id', 'proof_id', 'frozen_decision_ids', 'frozen_observation_id']) expect(last[key]).toEqual(original[key]);
    receipt('repair-r1-frozen-lineage.json', { withdrawn, original, last });
  });

  it('repair R2 advances per-record proof freshness through every tombstone and never consumes a batch globally', async () => {
    const scope = await repairScope();
    for (const command of ['open_review', 'suspend', 'revoke'] as const) {
      const vendor = `r2-${command}`, source = await repairCapture(scope, [{ vendor }]), record = await repairRegister(scope, source);
      const unusedBeforeInvalidation = await repairCapture(scope, [{ vendor, name: 'Read before invalidation but never used to qualify this record' }]);
      await mutate('revise', { command, recordId: record.recordId, expectedRecordRevision: 1, proofId: scope.proofId, reason: 'First proof invalidation' }, scope.scopeId);
      const firstFresh = await repairCapture(scope, [{ vendor, name: 'New observation after first invalidation' }]);
      const firstPayload = { command: 'reverify', recordId: record.recordId, expectedRecordRevision: 2, expectedClaimId: record.claimId, proofId: firstFresh.evidenceId, contractId: scope.contractId, observationId: firstFresh.observations[0].observationId, reason: 'First explicit renewed proof' }, firstRequest = randomUUID();
      const restored = await mutate('revise', firstPayload, scope.scopeId, ADMIN, firstRequest); expect(restored.revision).toBe(3); expect(restored.recordId).toBe(record.recordId); expect(restored.claimId).toBe(record.claimId);
      await mutate('revise', { command, recordId: record.recordId, expectedRecordRevision: 3, proofId: scope.proofId, reason: 'Later invalidation supersedes already used proof' }, scope.scopeId);
      const beforeOldReceipt = await identityState(); expect(await mutate('revise', firstPayload, scope.scopeId, ADMIN, firstRequest)).toEqual(restored); expect(await identityState()).toEqual(beforeOldReceipt);
      const stale = { ...firstPayload, expectedRecordRevision: 4, reason: 'Same old proof with a different request is not fresh' };
      await rejectUnchanged(`r2-${command}-used-proof`, () => mutate('revise', stale, scope.scopeId), 'IDENTITY_FRESH_PROOF_REQUIRED');
      await mutate('import_capture', firstFresh, scope.scopeId);
      await rejectUnchanged(`r2-${command}-reimport-old-capture`, () => mutate('revise', stale, scope.scopeId), 'IDENTITY_FRESH_PROOF_REQUIRED');
      const rewrappedIds = [];
      for (const [label, previousCapture] of [['already-used', firstFresh], ['never-used-before-invalidation', unusedBeforeInvalidation]] as const) {
        const rewrapped = structuredClone(previousCapture); rewrapped.captureKey = `rewrapped-old-bytes-${randomUUID()}`; rewrapped.evidenceId = randomUUID();
        rewrapped.observations = rewrapped.observations.map((observation) => ({ ...observation, observationId: randomUUID() }));
        rewrapped.projectionSha256 = digest(canonicalJson(rewrapped.observations)); rewrapped.adoptionDigest = captureAdoptionDigest({ ...rewrapped, scopeId: scope.scopeId });
        await mutate('import_capture', rewrapped, scope.scopeId); rewrappedIds.push(rewrapped.evidenceId);
        await rejectUnchanged(`r2-${command}-${label}-old-bytes-new-uuid`, () => mutate('revise', { ...stale, proofId: rewrapped.evidenceId, observationId: rewrapped.observations[0].observationId }, scope.scopeId), 'IDENTITY_FRESH_PROOF_REQUIRED');
      }
      const trulyFresh = await repairCapture(scope, [{ vendor, name: 'Truly new observation after latest invalidation' }]);
      const payload = { ...stale, proofId: trulyFresh.evidenceId, observationId: trulyFresh.observations[0].observationId, reason: 'Explicit current proof, keeping original UUID' };
      for (const table of ['source_record', 'source_identity_request']) { const beforeFailure = await identityState(); await injected(table, table === 'source_record' ? 'UPDATE' : 'INSERT', () => mutate('revise', payload, scope.scopeId)); expect(await identityState()).toEqual(beforeFailure); }
      const requests = [randomUUID(), randomUUID()], attempts = await Promise.allSettled(requests.map((requestId) => mutate('revise', payload, scope.scopeId, ADMIN, requestId)));
      expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
      const index = attempts.findIndex((attempt) => attempt.status === 'fulfilled'), result = (attempts[index] as PromiseFulfilledResult<IdentityMutationResult>).value;
      expect(result.revision).toBe(5); expect(result.recordId).toBe(record.recordId); expect(result.claimId).toBe(record.claimId);
      const beforeRetry = await identityState(); expect(await mutate('revise', payload, scope.scopeId, ADMIN, requests[index])).toEqual(result); expect(await identityState()).toEqual(beforeRetry);
      await rejectUnchanged(`r2-${command}-repeat-current-proof`, () => mutate('revise', { ...payload, expectedRecordRevision: 5 }, scope.scopeId), 'IDENTITY_FRESH_PROOF_REQUIRED');
      const facts = (await owner.query('SELECT record_revision,proof_id,before_state,after_state FROM catalog.source_identity_request WHERE source_record_id=$1 ORDER BY record_revision', [record.recordId])).rows;
      expect(facts.map((row) => row.record_revision)).toEqual([1, 2, 3, 4, 5]); expect((await owner.query('SELECT count(*)::int n FROM catalog.identity_claim WHERE record_id=$1', [record.recordId])).rows[0].n).toBe(1);
      receipt(`repair-r2-${command}.json`, { recordId: record.recordId, firstRequest, result, facts, staleIds: [firstFresh.evidenceId, ...rewrappedIds], sameOldBytesSha256: firstFresh.bytesSha256, genuineFreshBytesSha256: trulyFresh.bytesSha256, originalReceiptReadOnly: true });
    }
    const initial = await repairCapture(scope, [{ vendor: 'r2-batch-a' }, { vendor: 'r2-batch-b' }]), records = await Promise.all([repairRegister(scope, initial, 0), repairRegister(scope, initial, 1)]);
    for (const record of records) await mutate('revise', { command: 'suspend', recordId: record.recordId, expectedRecordRevision: 1, proofId: scope.proofId, reason: 'Invalidate before shared fresh batch' }, scope.scopeId);
    const freshBatch = await repairCapture(scope, [{ vendor: 'r2-batch-a', name: 'new batch a' }, { vendor: 'r2-batch-b', name: 'new batch b' }]);
    const restored = [];
    for (const [index, record] of records.entries()) restored.push(await mutate('revise', { command: 'reverify', recordId: record.recordId, expectedRecordRevision: 2, expectedClaimId: record.claimId, proofId: freshBatch.evidenceId, contractId: scope.contractId, observationId: freshBatch.observations[index].observationId, reason: 'One genuine batch can support separate source records' }, scope.scopeId));
    expect(restored.map((row) => row.recordId)).toEqual(records.map((row) => row.recordId)); expect(restored.map((row) => row.revision)).toEqual([3, 3]);
    receipt('repair-r2-shared-batch.json', { sharedProofId: freshBatch.evidenceId, restored, perRecordFreshness: true });
    const initialLate = await repairCapture(scope, [{ vendor: 'r2-late-transaction' }]), lateRecord = await repairRegister(scope, initialLate);
    const early = await app.connect(); let lateProof: PreparedIdentityCapture, earlyStart: string, earlyPid: number, proofPid = 0, invalidation: IdentityMutationResult;
    try {
      await early.query('BEGIN'); await early.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`, [ADMIN]);
      const started = (await early.query('SELECT transaction_timestamp()::text started,pg_backend_pid() pid')).rows[0]; earlyStart = started.started; earlyPid = started.pid;
      lateProof = await repairCapture(scope, [{ vendor: 'r2-late-transaction', name: 'Captured after transaction began, before its late invalidation fact' }], undefined, 1, false);
      await tx(ADMIN, async (other) => { proofPid = (await other.query('SELECT pg_backend_pid() pid')).rows[0].pid; await other.query('SELECT catalog.identity_mutate($1,$2,$3,$4,$5::jsonb)', [randomUUID(), scope.scopeId, 'import_capture', sourceIdentityIntent(identity(), scope.scopeId, 'import_capture', lateProof), JSON.stringify(lateProof)]); });
      expect(proofPid).not.toBe(earlyPid);
      const payload = { command: 'suspend', recordId: lateRecord.recordId, expectedRecordRevision: 1, proofId: scope.proofId, reason: 'Late invalidation in an already-open transaction' };
      invalidation = (await early.query('SELECT catalog.identity_mutate($1,$2,$3,$4,$5::jsonb) result', [randomUUID(), scope.scopeId, 'revise', sourceIdentityIntent(identity(), scope.scopeId, 'revise', payload), JSON.stringify(payload)])).rows[0].result;
      await early.query('COMMIT');
    } finally { await early.query('ROLLBACK'); early.release(); }
    const chronology = (await owner.query(`SELECT e.collected_at::text proof_collected_at,q.recorded_at::text tombstone_recorded_at,e.collected_at>$3::timestamptz proof_after_early_begin,e.collected_at<q.recorded_at proof_predates_tombstone FROM catalog.identity_evidence e JOIN catalog.source_identity_request q ON q.request_id=$2 WHERE e.id=$1`, [lateProof!.evidenceId, invalidation!.requestId, earlyStart!])).rows[0];
    receipt('repair-r2-late-transaction-boundary.json', { recordId: lateRecord.recordId, earlyPid: earlyPid!, proofPid, earlyStart: earlyStart!, chronology, noSleepUsed: true });
    expect(chronology.proof_after_early_begin).toBe(true); expect(chronology.proof_predates_tombstone).toBe(true);
    await rejectUnchanged('r2-transaction-start-is-not-fact-time', () => mutate('revise', { command: 'reverify', recordId: lateRecord.recordId, expectedRecordRevision: 2, expectedClaimId: lateRecord.claimId, contractId: scope.contractId, proofId: lateProof!.evidenceId, observationId: lateProof!.observations[0].observationId, reason: 'Already-open transaction must not make old proof fresh' }, scope.scopeId), 'IDENTITY_FRESH_PROOF_REQUIRED');
  });

  it('repair R3 rejects known identity market and warehouse contradictions in register reuse reverify and link', async () => {
    for (const dimension of ['warehouse', 'market'] as const) {
      const identityValue = dimension === 'warehouse' ? (await unlinkedFrozen()).scope.warehouse.raw : 'FIXTURE-IDENTITY-1';
      const scope = await repairScope({ [`${dimension}Role`]: 'identity', [`${dimension}Identity`]: identityValue });
      const good = await repairCapture(scope, [{ vendor: `r3-${dimension}`, [dimension]: knownContext(identityValue) }]), record = await repairRegister(scope, good);
      const wrong = await repairCapture(scope, [{ vendor: `r3-${dimension}`, [dimension]: knownContext('FIXTURE-IDENTITY-2') }, { vendor: `r3-${dimension}-new`, [dimension]: knownContext('FIXTURE-IDENTITY-2') }]);
      await rejectUnchanged(`r3-${dimension}-register`, () => repairRegister(scope, wrong, 1), 'IDENTITY_SCOPE_CONTRADICTION');
      await rejectUnchanged(`r3-${dimension}-reuse`, () => mutate('register', { contractId: scope.contractId, observationId: wrong.observations[0].observationId, proofId: scope.proofId, expectedMatch: { kind: 'record', recordId: record.recordId, revision: 1 }, reason: 'Known contrary identity scope is not reuse' }, scope.scopeId), 'IDENTITY_SCOPE_CONTRADICTION');
      await rejectUnchanged(`r3-${dimension}-reverify`, () => mutate('revise', { command: 'reverify', recordId: record.recordId, expectedRecordRevision: 1, expectedClaimId: record.claimId, proofId: wrong.evidenceId, contractId: scope.contractId, observationId: wrong.observations[0].observationId, reason: 'Known contrary identity scope is not new qualification' }, scope.scopeId), 'IDENTITY_SCOPE_CONTRADICTION');
      await rejectUnchanged(`r3-${dimension}-new-link`, () => mutate('link', { operation: 'link', recordId: record.recordId, expectedRecordRevision: 1, expectedLinkRevision: 0, origin: { kind: 'identity', id: wrong.observations[0].observationId }, proofId: wrong.evidenceId, reason: 'Cannot adopt contrary observed identity scope' }, scope.scopeId), 'IDENTITY_SCOPE_CONTRADICTION');
      const frozenRow = (await owner.query(`SELECT fo.id,fo.fields FROM catalog.source_observation fo JOIN catalog.observation_batch b ON b.id=fo.batch_id JOIN catalog.source_dataset d ON d.id=b.dataset_id JOIN catalog.source_namespace n ON n.id=d.namespace_id WHERE n.system='bigseller' AND fo.fields->'sku'->>'meaning'='value' AND fo.fields->'name'->>'meaning'='value' AND ($1='market' OR fo.scope->'warehouse'->>'raw'=$2) AND NOT EXISTS(SELECT 1 FROM catalog.observation_record_link l WHERE l.frozen_observation_id=fo.id) ORDER BY fo.entry_key LIMIT 1`, [dimension, identityValue])).rows[0];
      const supportVendor = `r3-${dimension}-frozen-support`, goodSupport = await repairCapture(scope, [{ vendor: supportVendor, [dimension]: knownContext(identityValue) }]), supportRecord = await repairRegister(scope, goodSupport);
      const wrongSupport = await repairCapture(scope, [{ vendor: supportVendor, sku: frozenRow.fields.sku.raw, name: frozenRow.fields.name.raw, barcode: frozenRow.fields.barcode?.meaning === 'value' ? frozenRow.fields.barcode.raw : '', [dimension]: knownContext('FIXTURE-IDENTITY-2') }]);
      await rejectUnchanged(`r3-${dimension}-frozen-wrong-support`, () => mutate('link', { operation: 'link', recordId: supportRecord.recordId, expectedRecordRevision: 1, expectedLinkRevision: 0, origin: { kind: 'frozen', id: frozenRow.id }, proofId: wrongSupport.evidenceId, reason: 'A contradictory supporting observation cannot qualify a frozen association' }, scope.scopeId), 'IDENTITY_OBSERVATION_CONTRADICTION');
      const beforeLegacyProbe = await identityState(), client = await owner.connect();
      try {
        await client.query('BEGIN'); await client.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`, [ADMIN]);
        await client.query(`INSERT INTO catalog.observation_record_link VALUES($1,1,NULL,$2,'identity',NULL,$3,$4,$5,$6,'linked','{}','Explicit rollback-only historical bad-context fixture',$7,now())`, [`identity:${wrong.observations[0].observationId}`, scope.scopeId, wrong.observations[0].observationId, record.recordId, scope.contractId, wrong.evidenceId, ADMIN]);
        const staged = await identityState(client);
        const payload = { operation: 'link', recordId: supportRecord.recordId, expectedRecordRevision: 1, expectedPreviousRecordRevision: 1, expectedLinkRevision: 1, origin: { kind: 'identity', id: wrong.observations[0].observationId }, proofId: wrong.evidenceId, reason: 'Existing linked contrary observation cannot be reassigned as qualified' };
        await client.query('SET LOCAL ROLE ice_p0_02_app_runner'); await client.query('SAVEPOINT reject_legacy_relink');
        await expect(client.query('SELECT catalog.identity_mutate($1,$2,$3,$4,$5::jsonb)', [randomUUID(), scope.scopeId, 'link', sourceIdentityIntent(identity(), scope.scopeId, 'link', payload), JSON.stringify(payload)])).rejects.toMatchObject({ message: 'IDENTITY_SCOPE_CONTRADICTION' });
        await client.query('ROLLBACK TO reject_legacy_relink'); await client.query('RESET ROLE'); expect(await identityState(client)).toEqual(staged);
        receipt(`repair-r3-${dimension}-existing-link.json`, { appFunctionRejected: true, stagedStateSha256: digest(canonicalJson(staged)), rollbackOnlyHistoricalFixture: true });
      } finally { await client.query('ROLLBACK'); client.release(); }
      expect(await identityState()).toEqual(beforeLegacyProbe);
      const compatible = await repairCapture(scope, [{ vendor: `r3-${dimension}`, [dimension]: knownContext(identityValue) }]);
      const reused = await mutate('register', { contractId: scope.contractId, observationId: compatible.observations[0].observationId, proofId: scope.proofId, expectedMatch: { kind: 'record', recordId: record.recordId, revision: 1 }, reason: 'Explicit matching identity scope reuse' }, scope.scopeId); expect(reused.recordId).toBe(record.recordId);
      for (const context of [unknownContext(), { state: 'not_applicable' as const, raw: null, evidenceRef: 'field not applicable in trusted single-scope batch' }]) {
        const observation = await repairCapture(scope, [{ vendor: `r3-${dimension}`, [dimension]: context }]);
        const same = await mutate('register', { contractId: scope.contractId, observationId: observation.observations[0].observationId, proofId: scope.proofId, expectedMatch: { kind: 'record', recordId: record.recordId, revision: 1 }, reason: 'Existing sufficient scope proof without rewriting unknown row context' }, scope.scopeId); expect(same.recordId).toBe(record.recordId);
        expect((await sourceIdentityRepository.workspace(identity(), scope.scopeId)).observations.find((row) => row.observationId === observation.observations[0].observationId)![`${dimension}Context`]).toEqual(context);
      }
      const unfounded = await repairScope({ [`${dimension}Role`]: 'identity', [`${dimension}Identity`]: identityValue }, false);
      const unknown = await repairCapture(unfounded, [{ vendor: `r3-unproven-${dimension}` }]);
      await rejectUnchanged(`r3-${dimension}-unknown-unproven`, () => mutate('register', { contractId: unfounded.contractId, observationId: unknown.observations[0].observationId, proofId: unknown.evidenceId, expectedMatch: { kind: 'none' }, reason: 'Missing row dimension requires sufficient scope proof' }, unfounded.scopeId), 'IDENTITY_SCOPE_UNPROVEN');
      receipt(`repair-r3-${dimension}.json`, { scopeId: scope.scopeId, recordId: record.recordId, claimId: record.claimId, rejectedObservationIds: wrong.observations.map((row) => row.observationId), knownMatchingAccepted: true, unknownAndNotApplicablePreservedUnderSufficientScopeProof: true, insufficientScopeProofDenied: true });
    }
  });

  it('residual R2 binds fresh proof to actual observation members and the capture contract across every invalidation', async () => {
    const failures: string[] = [];
    for (const command of ['open_review', 'suspend', 'revoke'] as const) {
      const scope = await repairScope();
      for (const pairing of ['old-a-observation', 'separately-fresh-a-observation'] as const) await collectResidualCase(failures, `${command}-${pairing}`, async () => {
        const vendor = `residual-r2-${command}-${pairing}`, old = await repairCapture(scope, [{ vendor }]), record = await repairRegister(scope, old);
        await mutate('revise', { command, recordId: record.recordId, expectedRecordRevision: 1, proofId: scope.proofId, reason: 'Invalidate A before proof membership check' }, scope.scopeId);
        const aObservation = pairing === 'old-a-observation' ? old : await repairCapture(scope, [{ vendor, name: 'Actual A in a separate fresh capture' }]);
        const unrelated = await repairCapture(scope, [{ vendor: `${vendor}-unrelated-b`, name: 'Only B is a member of this fresh proof' }]);
        await rejectUnchanged(`residual-r2-${command}-${pairing}`, () => mutate('revise', { command: 'reverify', recordId: record.recordId, expectedRecordRevision: 2, expectedClaimId: record.claimId, contractId: scope.contractId, proofId: unrelated.evidenceId, observationId: aObservation.observations[0].observationId, reason: 'A different same-scope capture is not proof coverage' }, scope.scopeId), 'IDENTITY_PROOF_COVERAGE_REQUIRED');
      });
      await collectResidualCase(failures, `${command}-genuine-member`, async () => {
        const vendor = `residual-r2-positive-${command}`, old = await repairCapture(scope, [{ vendor }]), record = await repairRegister(scope, old);
        await mutate('revise', { command, recordId: record.recordId, expectedRecordRevision: 1, proofId: scope.proofId, reason: 'Invalidate before genuine member capture' }, scope.scopeId);
        const fresh = await repairCapture(scope, [{ vendor, name: 'A actually read in its submitted new proof' }]), requestId = randomUUID();
        const payload = { command: 'reverify', recordId: record.recordId, expectedRecordRevision: 2, expectedClaimId: record.claimId, contractId: scope.contractId, proofId: fresh.evidenceId, observationId: fresh.observations[0].observationId, reason: 'Use an actual member of this new capture' };
        await rejectUnchanged(`residual-r2-${command}-wrong-claim`, () => mutate('revise', { ...payload, expectedClaimId: randomUUID() }, scope.scopeId), 'IDENTITY_FRESH_PROOF_REQUIRED');
        await rejectUnchanged(`residual-r2-${command}-wrong-cas`, () => mutate('revise', { ...payload, expectedRecordRevision: 1 }, scope.scopeId), 'IDENTITY_REVISION_CONFLICT');
        await rejectUnchanged(`residual-r2-${command}-cross-scope-proof`, () => mutate('revise', { ...payload, proofId: PROOF_B }, scope.scopeId), 'query returned no rows');
        await rejectUnchanged(`residual-r2-${command}-cross-scope-observation`, () => mutate('revise', { ...payload, observationId: b1 }, scope.scopeId), 'query returned no rows');
        const restored = await mutate('revise', payload, scope.scopeId, ADMIN, requestId); expect(restored.recordId).toBe(record.recordId); expect(restored.revision).toBe(3); expect(restored.claimId).toBe(record.claimId);
        const beforeRetry = await identityState(); expect(await mutate('revise', payload, scope.scopeId, ADMIN, requestId)).toEqual(restored); expect(await identityState()).toEqual(beforeRetry);
        receipt(`residual-r2-${command}-genuine-member.json`, { restored, observationId: fresh.observations[0].observationId, evidenceId: fresh.evidenceId, originalRequestReadOnly: true });
      });
    }
    await collectResidualCase(failures, 'capture-contract-does-not-match-selected-contract', async () => {
      const scope = await repairScope(), vendor = 'residual-r2-contract', old = await repairCapture(scope, [{ vendor }]), record = await repairRegister(scope, old);
      await mutate('revise', { command: 'revoke', recordId: record.recordId, expectedRecordRevision: 1, proofId: scope.proofId, reason: 'Invalidate before different contract capture' }, scope.scopeId);
      const otherContract = randomUUID(), otherProof = randomUUID(), bytes = Buffer.from(canonicalJson({ scopeId: scope.scopeId, otherContract, purpose: 'Isolated contract revision proof' }));
      const stored = await storePrivateArtifact('residual-contract-proof.json', bytes);
      await owner.query('SELECT catalog.identity_fixture_bootstrap($1::jsonb)', [JSON.stringify({ ...scope.config, contractId: otherContract, contractRevision: 2, proofId: otherProof, proofCaptureKey: `residual-contract-${otherProof}`, proofSha256: stored.sha256, proofSize: stored.size, proofHandle: stored.storageHandle, grants: [] })]);
      const fresh = await repairCapture({ ...scope, contractId: otherContract }, [{ vendor, name: 'Actual member parsed using another contract revision' }], undefined, 2);
      await rejectUnchanged('residual-r2-contract-mismatch', () => mutate('revise', { command: 'reverify', recordId: record.recordId, expectedRecordRevision: 2, expectedClaimId: record.claimId, contractId: scope.contractId, proofId: fresh.evidenceId, observationId: fresh.observations[0].observationId, reason: 'Capture contract cannot be silently replaced by another selected contract' }, scope.scopeId), 'IDENTITY_PROOF_COVERAGE_REQUIRED');
    });
    receipt('residual-r2-case-summary.json', { failures, scenariosContinueAfterFailure: true }); expect(failures).toEqual([]);
  });

  it('residual R3 checks frozen known scope on first link correction and remount without reopening revoke eligibility', async () => {
    const failures: string[] = [];
    for (const dimension of ['warehouse', 'market'] as const) {
      for (const previous of [null, 'linked', 'revoked'] as const) await collectResidualCase(failures, `${dimension}-${previous ?? 'first'}-conflict`, () => residualFrozenProbe(`${dimension}-${previous ?? 'first'}-conflict`, dimension, previous, 'conflict'));
      await collectResidualCase(failures, `${dimension}-matching`, () => residualFrozenProbe(`${dimension}-matching`, dimension, null, 'matching'));
      await collectResidualCase(failures, `${dimension}-unknown-sufficient`, () => residualFrozenProbe(`${dimension}-unknown-sufficient`, dimension, null, 'unknown'));
      await collectResidualCase(failures, `${dimension}-unknown-insufficient`, () => residualFrozenProbe(`${dimension}-unknown-insufficient`, dimension, null, 'unknown', false));
      await collectResidualCase(failures, `${dimension}-revoke-known-conflicting-old-link`, () => residualFrozenProbe(`${dimension}-revoke-known-conflicting-old-link`, dimension, 'linked', 'conflict', true, 'revoke'));
    }
    receipt('residual-r3-case-summary.json', { failures, scenariosContinueAfterFailure: true, warehouseNegativeUsesActualFrozenRow: true, marketFixtureRollbackOnly: true }); expect(failures).toEqual([]);
  });

  it('composite FKs bind true contract revision and reject cross-scope claims, unapproved contract upgrades and oversized keys', async () => {
    const original = (await owner.query('SELECT * FROM catalog.identity_claim WHERE id=$1', [recordA.claimId])).rows[0];
    const fields = Object.keys(original), values = Object.values(original); const row = { ...original, id: randomUUID(), contract_revision: 99 };
    await expect(owner.query(`INSERT INTO catalog.identity_claim(${fields.join(',')}) VALUES(${values.map((_, i) => `$${i + 1}`).join(',')})`, fields.map((k) => k === 'original_key_fields' ? JSON.stringify(row[k]) : row[k]))).rejects.toMatchObject({ code: '23503' });
    const config = (await prepareSourceIdentityBootstrap()).scopes[0];
    const upgrade = { ...config, proofId: randomUUID(), proofCaptureKey: 'fixture-contract-upgrade', contractId: randomUUID(), contractRevision: 2, grants: [], proofSemantics: { uniqueness: true, stability: true, keyChange: true, reuse: true, oldObservationCompatible: true } };
    await owner.query('SELECT catalog.identity_fixture_bootstrap($1::jsonb)', [JSON.stringify(upgrade)]);
    await expect(mutate('register', { contractId: upgrade.contractId, observationId: a1new, proofId: upgrade.proofId, expectedMatch: { kind: 'none' }, reason: 'cannot bypass old claim with revision2' })).rejects.toMatchObject({ code: '40001' });
    const long = '汉'.repeat(500); await expect(owner.query('SELECT catalog.identity_scope_canonical($1::jsonb)', [JSON.stringify({ ...config, accountParts: [long], resourceParts: [long] })])).rejects.toMatchObject({ message: 'SCOPE_KEY_TOO_LONG' });
    receipt('composite-contract-tombstone.json', { wrongTrueRevisionDenied: true, contractUpgradeCannotCreateParallelRecord: true, keyOverLimitDenied: true });
  });

  it('really commits then loses COMMIT acknowledgement, reconciles exact scoped intent once and denies revoked receipts', async () => {
    const captureData = await prepareSourceFixtureCapture('products-v1'), requestId = randomUUID();
    const proto = Client.prototype as unknown as { query: (...args: unknown[]) => Promise<unknown> }; const real = proto.query;
    let lost = 0; const calls: string[] = [];
    const spy = vi.spyOn(proto, 'query').mockImplementation(function (this: unknown, ...args: unknown[]) {
      const text = String(args[0]); calls.push(text.includes('identity_mutate') ? 'mutation' : text.includes('identity_receipt') ? 'receipt' : text);
      const result = real.apply(this, args); if (text === 'COMMIT' && lost === 0) return Promise.resolve(result).then(() => { lost++; throw Object.assign(new Error('ISOLATED_ACK_LOST'), { code: 'ECONNRESET' }); }); return result;
    });
    let result; try { result = await sourceIdentityRepository.mutate(identity(), requestId, A, 'import_capture', captureData.capture); } finally { spy.mockRestore(); }
    expect(lost).toBe(1); expect(calls.filter((c) => c === 'mutation')).toHaveLength(1); expect(calls.indexOf('receipt')).toBeGreaterThan(calls.indexOf('COMMIT'));
    const intent = sourceIdentityIntent(identity(), A, 'import_capture', captureData.capture);
    expect(await sourceIdentityRepository.receipt(identity(), requestId, A, 'import_capture', intent)).toEqual(result);
    await expect(sourceIdentityRepository.receipt(identity(), requestId, A, 'import_capture', '0'.repeat(64))).rejects.toMatchObject({ code: '23505' });
    try { await owner.query('UPDATE catalog.source_scope_grant SET enabled=false,grant_revision=grant_revision+1 WHERE scope_id=$1 AND profile_id=$2', [A, ADMIN]); await expect(sourceIdentityRepository.receipt(identity(), requestId, A, 'import_capture', intent)).rejects.toMatchObject({ code: '42501' }); }
    finally { await owner.query('UPDATE catalog.source_scope_grant SET enabled=true,grant_revision=grant_revision+1 WHERE scope_id=$1 AND profile_id=$2', [A, ADMIN]); }
    expect((await owner.query('SELECT count(*)::int n FROM catalog.source_identity_request WHERE request_id=$1', [requestId])).rows[0].n).toBe(1);
    receipt('real-commit-ack-reconciliation.json', { result, requestId, lost, calls: calls.filter((c) => ['mutation','receipt','COMMIT'].includes(c)), facts: 1, revokedReceiptDenied: true });
  });

  it('reused pooled connections and rollback never carry scope identity; original catalog and public rows remain exact', async () => {
    const trace = [];
    for (const actor of [ADMIN, ADMIN_B, OPERATOR, null, ADMIN]) trace.push(await withAppDb(actor ? identity(actor) : null, async (c) => ({ actor, ...(await c.query(`SELECT pg_backend_pid() pid,current_setting('request.jwt.claim.sub',true) actor, catalog.identity_scope_allowed($1,'read') a,catalog.identity_scope_allowed($2,'read') b`, [A, B])).rows[0] })));
    expect(trace.map((r) => [r.a, r.b])).toEqual([[true,false],[false,true],[false,false],[false,false],[true,false]]);
    expect(new Set(trace.map((r) => r.pid)).size).toBe(1);
    await expect(withAppDb(identity(), async () => { throw new Error('ISOLATED_ROLLBACK'); })).rejects.toThrow('ISOLATED_ROLLBACK');
    await withAppDb(null, async (c) => expect((await c.query(`SELECT catalog.identity_scope_allowed($1,'read') ok`, [A])).rows[0].ok).toBe(false));
    expect(await oldSnapshot()).toEqual(initialOld);
    expect((await owner.query('SELECT item_id FROM catalog.baseline_item_anchor WHERE row_position=122')).rows[0].item_id).toBe(originalNewItem);
    const oldMoney = await catalogRepository.amounts(identity(), (await owner.query(`SELECT item_id FROM catalog.catalog_item_code WHERE ice_code='WM0072'`)).rows[0].item_id); expect(oldMoney?.cost.raw).toBe('5.18'); expect(oldMoney?.operatingPrice.raw).toBe('5.68');
    const anchors = (await owner.query(`SELECT a.json_pointer,a.item_id,a.row_position,a.payload_sha256,c.ice_code FROM catalog.baseline_item_anchor a LEFT JOIN catalog.catalog_item_code c USING(item_id) ORDER BY a.row_position`)).rows;
    const frozenSources = (await owner.query(`SELECT o.id,o.entry_key,o.legacy_candidate_id,o.position,o.payload_sha256,n.system FROM catalog.source_observation o JOIN catalog.observation_batch b ON b.id=o.batch_id JOIN catalog.source_dataset d ON d.id=b.dataset_id JOIN catalog.source_namespace n ON n.id=d.namespace_id WHERE n.system IN('bigseller','jushuitan') ORDER BY n.system,o.entry_key`)).rows;
    expect(anchors).toHaveLength(126); expect(frozenSources).toHaveLength(1417);
    receipt('output-anchor-uuid126.json', anchors); receipt('output-frozen-observation1417.json', frozenSources);
    const scopes = (await owner.query('SELECT id,system,entity_kind,scope_state,evidence_mode,canonical_scope,scope_sha256 FROM catalog.source_scope ORDER BY id')).rows;
    const contracts = (await owner.query('SELECT scope_id,contract_id,revision,previous_revision,entity_kind,strategy,key_fields,identity_dimensions,proof_id FROM catalog.source_identity_contract_revision ORDER BY scope_id,revision')).rows;
    const claims = (await owner.query('SELECT id,record_id,scope_id,entity_kind,contract_id,contract_revision,strategy,canonical_key,key_sha256,canonical_domain,domain_sha256,proof_id FROM catalog.identity_claim ORDER BY scope_id,record_id,recorded_at')).rows;
    const heads = (await owner.query('SELECT * FROM catalog.source_record ORDER BY scope_id,id')).rows;
    const observations = (await owner.query('SELECT id,scope_id,evidence_id,record_pointer,position,payload_sha256,market_context,warehouse_context FROM catalog.identity_observation ORDER BY scope_id,evidence_id,record_pointer')).rows;
    const links = (await owner.query('SELECT observation_key,link_revision,previous_revision,scope_id,origin_kind,frozen_observation_id,identity_observation_id,record_id,contract_id,proof_id,status,frozen_decision_ids,actor_id,recorded_at FROM catalog.observation_record_link ORDER BY observation_key,link_revision')).rows;
    receipt('output-source-identity-manifest.json', { verificationEnvironment: 'fixture', relationshipUsable: false, scopes, contracts, claims, heads, observations, links, noRawAmountsHandlesOrSessions: true });
    receipt('pool-and-baseline-protection.json', { trace, originalNewItem, oldRowsAnd548And6190Unchanged: true, oldMoneyPointerUnchanged: true, newCounts: await counts() });
  });
});
