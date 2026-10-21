import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareBaseline } from '@/features/catalog/sources/baseline-adapter';
import { loadFrozenFeishu } from '@/features/catalog/sources/frozen-feishu-adapter';
import { catalogRepository } from '@/features/catalog/repository';
import { closeP002Pools } from '@/lib/independent-platform/p0-02-pools';
import { canonicalJson } from '@/features/catalog/source-identity/key-codec';
import type { PreparedBaseline } from '@/features/catalog/types';
import { storePrivateArtifact } from '@/features/catalog/evidence-store';
import { confirmationPreview } from '@/features/catalog/new-item/field-projection';
import type { AdoptableFieldKey, NewItemWorkspaceDto, ProductObservationDto } from '@/features/catalog/new-item/types';
import { newItemRepository, newItemIntent } from '@/features/catalog/new-item/repository';
import * as appDb from '@/lib/database/app-db';

const ADMIN = '11111111-1111-4111-8111-111111111101';
const ADMIN_B = '11111111-1111-4111-8111-111111111107';
const OPERATOR = '11111111-1111-4111-8111-111111111104';
const INACTIVE = '11111111-1111-4111-8111-111111111106';
const READ = '11111111-1111-4111-8111-111111111108';
const NO_AMOUNT = '11111111-1111-4111-8111-111111111109';
const NO_EVIDENCE = '11111111-1111-4111-8111-111111111110';
const runRoot = process.env.CATALOG_RUN_ROOT!;
const evidence = process.env.CATALOG_NEW_ITEM_TEST_EVIDENCE_DIR ?? process.env.CATALOG_TEST_EVIDENCE_DIR!;
const instance = JSON.parse(fs.readFileSync(path.join(runRoot, 'instance/catalog-instance.json'), 'utf8'));
const owner = new Pool({ connectionString: `postgres://${instance.bootstrapUser}:${instance.bootstrapPassword}@${instance.host}:${instance.port}/${instance.dbName}`, max: 2 });
const app = new Pool({ connectionString: process.env.P0_02_APP_DATABASE_URL, max: 2 });
const C_TABLES = ['catalog.product_capture', 'catalog_private.product_capture_handle', 'catalog.product_observation',
  'catalog.intake_classification_revision', 'catalog.new_item_decision', 'catalog.item_observation_origin',
  'catalog.new_item_source_claim', 'catalog.new_item_request'];
const A_TABLES = ['catalog.source_scope', 'catalog.source_scope_grant', 'catalog.identity_evidence',
  'catalog_private.identity_evidence_handle', 'catalog.source_identity_contract_revision', 'catalog.source_record',
  'catalog.identity_claim', 'catalog.identity_observation', 'catalog.observation_record_link', 'catalog.source_identity_request'];
const OLD_TABLES = ['catalog.catalog_item', 'catalog.catalog_item_code', 'catalog.baseline_item_anchor', 'catalog.item_revision',
  'catalog.item_current', 'catalog.source_observation', 'catalog.decision_evidence', 'catalog.audit_event',
  'catalog_private.item_financial_revision', 'public.product', 'public.product_variant', 'public.inventory'];
type JsonObject = Record<string, unknown>;
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const save = (name: string, value: unknown) => fs.writeFileSync(path.join(evidence, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const identity = (profileUserId = ADMIN) => ({ profileUserId });
async function tx<T>(actor: string | null, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const c = await app.connect();
  try { await c.query('BEGIN'); await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`, [actor ?? '']); const value = await fn(c); await c.query('COMMIT'); return value; }
  catch (error) { await c.query('ROLLBACK'); throw error; } finally { c.release(); }
}
async function snapshot(tables = [...C_TABLES, ...A_TABLES, ...OLD_TABLES], client: Pool | PoolClient = owner) {
  const rows: Record<string, unknown> = {};
  for (const table of tables) rows[table] = (await client.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
  return rows;
}
let negativeIndex = 0;
async function rejectUnchanged(label: string, action: () => Promise<unknown>, expected: { code?: string; message?: string }) {
  const before = await snapshot();
  const result = await action().then((value) => ({ accepted: true, value, error: null }), (error) => ({ accepted: false, value: null, error: { code: String(error.code ?? ''), message: String(error.message ?? '') } }));
  const after = await snapshot();
  save(`negative-${++negativeIndex}-${label}.json`, { result, expected, beforeSha256: hash(before), afterSha256: hash(after), fullStateCompared: true });
  expect(result.accepted).toBe(false);
  if (expected.code) expect(result.error?.code).toBe(expected.code);
  if (expected.message) expect(result.error?.message).toBe(expected.message);
  expect(after).toEqual(before);
}
async function mutate(action: string, payload: unknown, scope = A, actor = ADMIN, requestId: string = randomUUID()) {
  const intent = hash(['iceos-new-item-request-v1', actor, scope, action, payload]);
  return tx(actor, async (c) => (await c.query('SELECT catalog.new_item_mutate($1,$2,$3,$4,$5::jsonb) result', [requestId, scope, action, intent, JSON.stringify(payload)])).rows[0].result as JsonObject);
}
async function read(scope = A, observationId: string | null = null, projection = 'safe', actor = ADMIN) {
  return tx(actor, async (c) => (await c.query('SELECT catalog.new_item_read($1,$2,$3) result', [scope, observationId, projection])).rows[0].result as JsonObject);
}
async function inject(table: string, operation: string, action: () => Promise<unknown>) {
  const c = await owner.connect();
  try {
    await c.query(`CREATE OR REPLACE FUNCTION pg_temp.c_fail_write() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'N1C_INJECTED_WRITE_FAILURE' USING ERRCODE='P0001'; END$$`);
    await c.query(`CREATE TRIGGER c_injected_failure BEFORE ${operation} ON ${table} FOR EACH ROW EXECUTE FUNCTION pg_temp.c_fail_write()`);
    await rejectUnchanged(`injected-${table.replaceAll('.', '-')}-${operation.toLowerCase()}`, action, { code: 'P0001', message: 'N1C_INJECTED_WRITE_FAILURE' });
  } finally { await c.query(`DROP TRIGGER IF EXISTS c_injected_failure ON ${table}`); c.release(); }
}
let baseline: PreparedBaseline, original122: string, wmId: string;
let initialPublic: Record<string, unknown>, initialDecisions: Record<string, unknown>, originalAnchors: unknown[];
type CaptureFixture = { approvedFixtureId: string; scopeId: string; rawFile: string; [key: string]: unknown };
const fixturesRoot = path.resolve(process.env.CATALOG_SOURCE_ROOT ?? process.cwd(), 'tests/catalog/fixtures');
const manifestBytes = fs.readFileSync(path.join(fixturesRoot, 'new-item-fixture-manifest.json'));
const fixtureManifest = JSON.parse(manifestBytes.toString('utf8')) as { manifestId: string; captures: CaptureFixture[] };
const A = fixtureManifest.captures.find((row) => row.approvedFixtureId === 'a-main')!.scopeId;
const B = fixtureManifest.captures.find((row) => row.approvedFixtureId === 'b-main')!.scopeId;
const manifestSha = createHash('sha256').update(manifestBytes).digest('hex');
function envelopeDigest(p: JsonObject) {
  return hash(['iceos-product-capture-v2', p.approvedFixtureId, p.fixtureManifestId, p.fixtureManifestSha256, p.scopeId,
    p.captureKey, p.bytesSha256, p.sizeBytes, p.format, p.parserId, p.parserVersion, p.schemaVersion,
    p.coverage, p.projectionSha256, p.associationProofs, p.sourceAvailability, p.sourceEffectiveAt,
    p.documentAvailability, p.documentModifiedAt, p.collectedAt]);
}
async function fixturePayload(id: string): Promise<JsonObject> {
  const f = fixtureManifest.captures.find((row) => row.approvedFixtureId === id); if (!f) throw new Error(`TEST_FIXTURE_MISSING:${id}`);
  const raw = fs.readFileSync(path.join(fixturesRoot, f.rawFile));
  const stored = await storePrivateArtifact(f.rawFile, raw);
  const keys = ['approvedFixtureId', 'scopeId', 'captureKey', 'bytesSha256', 'sizeBytes', 'format', 'parserId', 'parserVersion',
    'schemaVersion', 'coverage', 'projectionSha256', 'associationProofs', 'sourceAvailability', 'sourceEffectiveAt',
    'documentAvailability', 'documentModifiedAt', 'collectedAt', 'observations'];
  const p: JsonObject = Object.fromEntries(keys.map((key) => [key, f[key]]));
  p.fixtureManifestId = fixtureManifest.manifestId; p.fixtureManifestSha256 = manifestSha; p.storageHandle = stored.storageHandle;
  p.adoptionDigest = envelopeDigest(p); return p;
}
async function importCapture(id: string, actor = ADMIN) {
  const p = await fixturePayload(id), result = await mutate('import_product_capture', p, String(p.scopeId), actor);
  const observations = (await owner.query(`SELECT o.id,o.record_pointer,o.payload_sha256,o.fields FROM catalog.product_observation o JOIN catalog.product_capture c ON c.id=o.capture_id WHERE c.approved_fixture_id=$1 ORDER BY o.record_pointer`, [id])).rows;
  return { payload: p, result, observations };
}
async function observation(id: string, scope = A, actor = ADMIN): Promise<ProductObservationDto> {
  const w = await read(scope, id, 'safe', actor) as unknown as NewItemWorkspaceDto;
  const o = w.observations.find((row) => row.observationId === id); expect(o).toBeDefined(); return o!;
}
function sourceSnapshot(o: ProductObservationDto) {
  const s = o.currentSource; return s ? { recordId: s.recordId, revision: s.revision, claimId: s.claimId } : null;
}
async function classify(id: string, classification = 'new_item', scope = A, actor = ADMIN, extra: JsonObject = {}) {
  const o = await observation(id, scope, actor);
  return mutate('classify_observation', { observationId: id, expectedClassificationRevision: o.classification?.revision ?? 0,
    classification, reviewState: 'proposed', proposedItemId: null, expectedItemRevision: null, proposedFieldKeys: [],
    expectedSourceSnapshot: sourceSnapshot(o), privateReason: 'Explicit isolated classification', ...extra }, scope, actor);
}
const adopted: AdoptableFieldKey[] = ['nameCn', 'englishName', 'specification', 'barcode', 'factory', 'packaging', 'cartonQuantity'];
async function confirmation(id: string, scope = A, actor = ADMIN, reason = 'Explicit isolated new item', keys = adopted) {
  const o = await observation(id, scope, actor), p = confirmationPreview(scope, o, keys, null);
  return { observationId: id, expectedClassificationRevision: p.expectedClassificationRevision,
    expectedSourceSnapshot: p.expectedSourceSnapshot, expectedSourceDisposition: p.expectedSourceDisposition,
    previewId: p.previewId, adoptedFieldKeys: p.adoptedFieldKeys, initialCode: null, privateReason: reason };
}
let mainObservation: string, mainItem: string, mainRequest: string, mainConfirmation: JsonObject;
async function rollbackProbe(label: string, fixture: (c: PoolClient) => Promise<void>, action: string, payload: JsonObject,
  expected: { code?: string; message?: string } = {}) {
  const c = await owner.connect(); const globallyBefore = await snapshot(); let outcome;
  try {
    await c.query('BEGIN'); await fixture(c); const before = await snapshot(undefined, c);
    await c.query('SET LOCAL ROLE ice_p0_02_app_runner'); await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`, [ADMIN]);
    await c.query('SAVEPOINT c_guard_attempt');
    outcome = await c.query('SELECT catalog.new_item_mutate($1,$2,$3,$4,$5::jsonb) result', [randomUUID(), A, action,
      hash(['iceos-new-item-request-v1', ADMIN, A, action, payload]), JSON.stringify(payload)])
      .then((r) => ({ accepted: true, result: r.rows[0].result, error: null }), (error) => ({ accepted: false, result: null, error: { code: String(error.code), message: String(error.message), where: String(error.where ?? ''), detail: String(error.detail ?? '') } }));
    if (!outcome.accepted) await c.query('ROLLBACK TO c_guard_attempt');
    await c.query('RESET ROLE'); const after = await snapshot(undefined, c);
    save(`rollback-guard-${label}.json`, { outcome, beforeSha256: hash(before), afterSha256: hash(after), actualAppRole: true,
      constructedGuardFixtureOnlyInOwnerRollbackTransaction: true, expected });
    expect(outcome.accepted).toBe(false);
    if (expected.code) expect(outcome.error?.code).toBe(expected.code);
    if (expected.message) expect(outcome.error?.message).toBe(expected.message);
    expect(outcome.error?.message).toMatch(/SOURCE|CLAIM|LINK|REVIEW|FROZEN|CONFLICT|B_PROVIDER/);
    expect(after).toEqual(before);
  } finally { await c.query('ROLLBACK'); c.release(); }
  expect(await snapshot()).toEqual(globallyBefore);
}
async function catalogAssociation(obsId: string, targetId: string, basisAnchorOrOrigin: JsonObject, proofRef: JsonObject, reason = 'Explicit isolated catalog evidence association') {
  const o = await observation(obsId), current = (await owner.query('SELECT revision FROM catalog.item_current WHERE item_id=$1', [targetId])).rows[0];
  const basis = { kind: 'catalog_proof', basisAnchorOrOrigin, associationProofRef: proofRef, targetItemId: targetId, expectedItemRevision: current.revision };
  return { observationId: obsId, expectedClassificationRevision: o.classification!.revision, expectedSourceDisposition: o.sourceDisposition.sha256,
    previewId: hash(['iceos-catalog-proof-preview-v1', A, obsId, o.classification!.revision, o.sourceDisposition.sha256, basis]), basis, privateReason: reason };
}
let reliableItem: string, reliableRecord: string, reliableRepeat: string;
let fixtureRestoreFailed = false;

describe.sequential('N1C actual isolated PostgreSQL acceptance C01-C22', () => {
  beforeEach(() => { if (fixtureRestoreFailed) throw new Error('STOP_INSTANCE_TESTS_AFTER_FIXTURE_RESTORE_FAILURE'); });
  beforeAll(async () => {
    baseline = await prepareBaseline();
    await catalogRepository.publish(identity(), randomUUID(), baseline);
    await catalogRepository.importFrozen(identity(), randomUUID(), await loadFrozenFeishu());
    original122 = (await owner.query('SELECT item_id FROM catalog.baseline_item_anchor WHERE row_position=122')).rows[0].item_id;
    wmId = (await owner.query(`SELECT item_id FROM catalog.catalog_item_code WHERE ice_code='WM0072'`)).rows[0].item_id;
    originalAnchors = (await owner.query('SELECT * FROM catalog.baseline_item_anchor ORDER BY json_pointer')).rows;
    initialPublic = await snapshot(['public.product', 'public.product_variant', 'public.inventory']);
    initialDecisions = await snapshot(['catalog.decision_evidence', 'catalog.source_observation']);
    save('baseline-input-manifests.json', { full147: baseline.fullManifest, subset129: baseline.subsetManifest, counts: baseline.counts, original122, wmId, anchors: originalAnchors });
  });
  afterAll(async () => { await Promise.all([owner.end(), app.end(), closeP002Pools()]); });

  it('C18/C21 runtime is nonowner/nonbypass, eight tables FORCE RLS and old public tables untouched', async () => {
    const runtime = (await app.query(`SELECT current_user AS name,current_database() AS database,r.rolsuper,r.rolbypassrls,(SELECT run_id FROM p0_02_meta.platform_instance LIMIT 1) run FROM pg_roles r WHERE rolname=current_user`)).rows[0];
    expect(runtime).toMatchObject({ name: 'ice_p0_02_app_runner', database: instance.dbName, rolsuper: false, rolbypassrls: false, run: instance.runId });
    const checks = [];
    for (const table of C_TABLES) {
      const row = (await owner.query('SELECT c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner) AS owner FROM pg_class c WHERE c.oid=$1::regclass', [table])).rows[0];
      expect(row).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true }); expect(row.owner).not.toBe(runtime.name); checks.push({ table, ...row });
      await expect(tx(ADMIN, (c) => c.query(`SELECT * FROM ${table}`))).rejects.toMatchObject({ code: '42501' });
    }
    await expect(tx(ADMIN, (c) => c.query('SELECT creation_decision_id FROM catalog.catalog_item'))).rejects.toMatchObject({ code: '42501' });
    expect((await tx(ADMIN, (c) => c.query('SELECT id,first_release_id,new_product_confirmed,confirmation_ref,recorded_at FROM catalog.catalog_item'))).rowCount).toBe(126);
    for (const actor of [null, OPERATOR, INACTIVE]) await expect(read(A, null, 'safe', actor ?? '')).rejects.toMatchObject({ code: '42501' });
    await expect(read(A, null, 'safe', ADMIN_B)).rejects.toMatchObject({ code: '42501' });
    expect(await snapshot(['public.product', 'public.product_variant', 'public.inventory'])).toEqual(initialPublic);
    save('C18-runtime-rls-column-privileges.json', { runtime, checks, publicTablesUnchanged: true, creationDecisionPhysicalColumnDenied: true });
    const ddl = (await owner.query(`SELECT n.nspname,c.relname,c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('catalog','catalog_private') AND c.relkind='r' ORDER BY n.nspname,c.relname`)).rows;
    const constraints = (await owner.query(`SELECT conrelid::regclass::text AS relation,conname,pg_get_constraintdef(oid) AS definition,condeferrable,condeferred FROM pg_constraint WHERE connamespace IN('catalog'::regnamespace,'catalog_private'::regnamespace) ORDER BY conrelid::regclass::text,conname`)).rows;
    save('C-schema-rls-constraints-dump.json', { ddl, constraints });
  });

  it('C21 protects all 548 original targets/JST and 6190 history occurrences,147 artifacts separately from129', async () => {
    expect(baseline.fullManifest).toHaveLength(147); expect(baseline.subsetManifest).toHaveLength(129);
    expect(baseline.bundleSha256).toBe('28d8d81c7d62beb95b99ebd188467c8a8ec69a9a6a4fe17df5970d8a0c6816ae');
    expect(baseline.effectiveCsvSha256).toBe('4428f4c80dcdde1c47508ac9eb433baa4f9a941934ae943cdd5e0116d3b49c14');
    const saved = (await owner.query(`SELECT d.*,a.json_pointer AS selected_anchor,o.entry_key AS observation_entry_key FROM catalog.decision_evidence d LEFT JOIN catalog.baseline_item_anchor a ON a.item_id=d.selected_item_id AND a.release_id=d.release_id LEFT JOIN catalog.source_observation o ON o.id=d.observation_id ORDER BY entry_kind,entry_key`)).rows;
    const byKey = new Map(saved.map((row) => [`${row.entry_kind}\n${row.entry_key}`, row]));
    expect(saved).toHaveLength(6190); expect(baseline.decisions).toHaveLength(6190);
    const history = [], selected = [];
    for (const expected of baseline.decisions) {
      const row = byKey.get(`${expected.entryKind}\n${expected.entryKey}`)!;
      expect(row).toBeDefined(); expect(row.payload_sha256).toBe(expected.payloadSha256); expect(row.raw_ref).toBe(expected.rawRef);
      expect(row.selected_anchor).toBe(expected.selectedItemAnchor); expect(row.observation_entry_key).toBe(expected.observationEntryKey);
      expect(row.selected_jushuitan_ref).toBe(expected.selectedJushuitanRef); expect(row.selected_jushuitan_sha256).toBe(expected.selectedJushuitanSha256);
      expect(row.review_state).toBe(expected.reviewState); expect(row.summary).toEqual(expected.summary);
      const exact = { entryKind: expected.entryKind, entryKey: expected.entryKey, payloadSha256: row.payload_sha256,
        observation: row.observation_entry_key, targetItemId: row.selected_item_id, targetAnchor: row.selected_anchor,
        jstRef: row.selected_jushuitan_ref, jstSha256: row.selected_jushuitan_sha256, summary: row.summary, equal: true };
      history.push(exact); if (expected.entryKind === 'candidate_snapshot' && expected.selectedItemAnchor) selected.push(exact);
    }
    expect(selected).toHaveLength(548); expect(saved.filter((row) => row.entry_kind === 'effective_csv_record')).toHaveLength(3160);
    expect(saved.filter((row) => row.entry_kind === 'history:batch_brush_preservation')).toHaveLength(2);
    expect(saved.filter((row) => row.entry_kind === 'history:batch_bs_not_created')).toHaveLength(2);
    const money = await catalogRepository.amounts(identity(), wmId);
    expect(money?.cost.raw).toBe('5.18'); expect(money?.operatingPrice.raw).toBe('5.68');
    const observed = await tx(ADMIN, async (c) => (await c.query(`SELECT o.position,catalog.read_observation_amounts(o.id) AS amounts FROM catalog.source_observation o WHERE o.position->>'cell' IN('I66','J66') ORDER BY o.position->>'cell'`)).rows);
    expect(observed).toHaveLength(2); expect(observed.map((row) => Object.values(row.amounts as Record<string, { raw: string }>)[0].raw)).toEqual(['5', '5.5']);
    expect((await catalogRepository.get(identity(), original122))?.iceCode).toBeNull();
    save('exact-548-target-jst-history.json', selected); save('all-6190-history.json', history);
    save('C21-baseline-prices-statuses.json', { original122, money, sharedObservation: observed, brushes: saved.filter((row) => row.entry_kind === 'history:batch_brush_preservation'), bsNotCreated: saved.filter((row) => row.entry_kind === 'history:batch_bs_not_created') });
  });

  it('C01 app SQL pins all legal times,availability and envelope IDs before the first correct import', async () => {
    // Complementary approved fixtures exercise both known -> NULL and NULL -> known.
    // Each negative runs before the corresponding fixture's first correct import.
    for (const fixtureId of ['a-main', 'a-states']) {
    const p = await fixturePayload(fixtureId);
    const legal: { name: string; patch: JsonObject }[] = [
      { name: 'collection', patch: { collectedAt: '2026-10-20T01:02:03.987654Z' } },
      { name: 'source-known', patch: { sourceAvailability: 'known', sourceEffectiveAt: '2026-10-19T01:02:03.123456Z' } },
      { name: 'source-unobserved', patch: { sourceAvailability: 'not_observed', sourceEffectiveAt: null } },
      { name: 'document-known', patch: { documentAvailability: 'known', documentModifiedAt: '2026-10-19T04:05:06.654321Z' } },
      { name: 'document-unobserved', patch: { documentAvailability: 'not_observed', documentModifiedAt: null } },
      { name: 'capture-key', patch: { captureKey: String(p.captureKey) + '-changed' } },
      { name: 'manifest-id', patch: { fixtureManifestId: 'legal-but-unapproved-manifest' } },
      { name: 'fixture-id', patch: { approvedFixtureId: 'legal-but-unapproved-fixture' } },
      { name: 'manifest-sha', patch: { fixtureManifestSha256: 'f'.repeat(64) } },
    ];
    for (const entry of legal) {
      const altered = { ...p, ...entry.patch }; if (hash(altered) === hash(p)) continue;
      for (const recompute of [false, true]) {
        const payload = { ...altered, adoptionDigest: recompute ? envelopeDigest(altered) : p.adoptionDigest };
        await rejectUnchanged(`C01-${fixtureId}-${entry.name}-${recompute ? 'recomputed' : 'original'}-pin`, () => mutate('import_product_capture', payload), { code: '22023', message: 'PRODUCT_CAPTURE_PIN_CONFLICT' });
      }
    }
    for (const [label, patch] of [
      ['offset', { collectedAt: '2026-10-20T01:02:03.123456+00:00' }],
      ['milliseconds', { collectedAt: '2026-10-20T01:02:03.123Z' }],
      ['invalid-day', { collectedAt: '2026-02-30T01:02:03.123456Z' }],
      ['numeric-epoch', { collectedAt: 1792464000 }],
      ['null-collection', { collectedAt: null }],
      ['known-null', { sourceAvailability: 'known', sourceEffectiveAt: null }],
      ['unobserved-nonnull', { documentAvailability: 'not_observed', documentModifiedAt: '2026-10-19T04:05:06.654321Z' }],
    ] as const) await rejectUnchanged(`C01-${fixtureId}-invalid-${label}`, () => mutate('import_product_capture', { ...p, ...patch }), { code: '22023', message: 'PRODUCT_CAPTURE_ENVELOPE_INVALID' });
    const request = randomUUID(), first = await mutate('import_product_capture', p, A, ADMIN, request);
    expect(await mutate('import_product_capture', p, A, ADMIN, request)).toEqual(first);
    const repeated = await mutate('import_product_capture', p); expect(repeated.captureId).toBe(first.captureId);
    const capture = (await owner.query(`SELECT id,approved_fixture_id,fixture_manifest_sha256,adoption_digest,
      CASE WHEN source_effective_at IS NULL THEN NULL ELSE to_char(source_effective_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END source_time,
      CASE WHEN document_modified_at IS NULL THEN NULL ELSE to_char(document_modified_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END document_time,
      to_char(collected_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') collected_time,source_availability,document_availability
      FROM catalog.product_capture WHERE id=$1`, [first.captureId])).rows[0];
    expect(capture).toMatchObject({ approved_fixture_id: fixtureId, fixture_manifest_sha256: manifestSha, adoption_digest: p.adoptionDigest,
      source_time: p.sourceEffectiveAt, document_time: p.documentModifiedAt, collected_time: p.collectedAt,
      source_availability: p.sourceAvailability, document_availability: p.documentAvailability });
    if (fixtureId === 'a-main') mainObservation = (await owner.query('SELECT id FROM catalog.product_observation WHERE capture_id=$1', [first.captureId])).rows[0].id;
    if (fixtureId === 'a-states') {
      expect(capture.source_time).toBe('2026-10-20T13:59:59.000123Z'); expect(capture.document_time).toBeNull();
      const raw = JSON.parse(fs.readFileSync(path.join(fixturesRoot, fixtureManifest.captures.find((f) => f.approvedFixtureId === fixtureId)!.rawFile), 'utf8'));
      expect(raw.fixtureSourceTimes[fixtureId]).toBe(capture.source_time);
    }
    save(`C01-${fixtureId}-correct-frozen-times-idempotent.json`, { first, repeated, capture, noRuntimeTimestampRefresh: true, negativeCount: negativeIndex });
    }
  });

  it('C02/C03 retains six field states and missing data; classifications append suggestions without publishing', async () => {
    const states = await importCapture('a-states');
    const o = await observation(states.observations[0].id);
    const all = Object.values(o.fields);
    expect(all.some((f) => f.state === 'observed' && f.raw === '0')).toBe(true);
    expect(all.some((f) => f.state === 'observed' && f.meaning === 'explicit_empty')).toBe(true);
    expect(all.some((f) => f.state === 'observed' && f.meaning === 'explicit_null')).toBe(true);
    expect(all.some((f) => f.state === 'not_read')).toBe(true);
    expect(all.some((f) => f.state === 'parse_failed')).toBe(true);
    expect(all.some((f) => f.state === 'no_text')).toBe(true);
    const countBefore = (await owner.query('SELECT count(*)::int n FROM catalog.catalog_item')).rows[0].n;
    await classify(mainObservation); await classify(o.observationId, 'external_sku');
    await importCapture('a-version'); // C12 later verifies persistent suspicion without contaminating the R1 positive path.
    const bad = await importCapture('a-bad-name'); await classify(bad.observations[0].id, 'item_update', A, ADMIN, { proposedItemId: original122, expectedItemRevision: 1, proposedFieldKeys: ['factory'] });
    expect((await owner.query('SELECT count(*)::int n FROM catalog.catalog_item')).rows[0].n).toBe(countBefore);
    expect((await owner.query('SELECT count(*)::int n FROM catalog.new_item_decision')).rows[0].n).toBe(0);
    await classify(bad.observations[0].id); const badConfirm = await confirmation(bad.observations[0].id);
    await rejectUnchanged('C02-empty-name', () => mutate('confirm_new_item', badConfirm), { code: '22023' });
    save('C02-C03-states-and-four-classifications.json', { fields: o.fields, countBefore, onlyClassificationFactsWritten: true });
  });

  it('C16 each capture/classification/creation/code/current/origin/slot/success-ledger write failure leaves no half result', async () => {
    const notImported = await fixturePayload('b-same-sku');
    for (const table of ['catalog.product_capture', 'catalog_private.product_capture_handle', 'catalog.product_observation', 'catalog.new_item_request'])
      await inject(table, 'INSERT', () => mutate('import_product_capture', notImported, B, ADMIN_B));
    await inject('catalog.intake_classification_revision', 'INSERT', () => classify(mainObservation));
    const base = await confirmation(mainObservation);
    for (const table of ['catalog.catalog_item', 'catalog.new_item_decision', 'catalog.item_revision', 'catalog.item_current', 'catalog.item_observation_origin', 'catalog.new_item_request'])
      await inject(table, 'INSERT', () => mutate('confirm_new_item', base));
    const o = await observation(mainObservation), codePreview = confirmationPreview(A, o, adopted, 'FIX-FAIL-CODE');
    const withCode = { ...base, initialCode: 'FIX-FAIL-CODE', previewId: codePreview.previewId };
    await inject('catalog.catalog_item_code', 'INSERT', () => mutate('confirm_new_item', withCode));
    const reliable = await importCapture('a-r1-first'); await classify(reliable.observations[0].id);
    expect((await observation(reliable.observations[0].id)).currentSource).not.toBeNull();
    await inject('catalog.new_item_source_claim', 'INSERT', async () => mutate('confirm_new_item', await confirmation(reliable.observations[0].id)));
    expect((await owner.query('SELECT count(*)::int n FROM catalog.catalog_item')).rows[0].n).toBe(126);
    save('C16-all-write-boundaries.json', { injectedTables: [...C_TABLES, 'catalog.catalog_item', 'catalog.catalog_item_code', 'catalog.item_revision', 'catalog.item_current'], noHalfBusinessPublication: true, inputCaptureCanRemainAfterCreationFailure: true, privateUnreferencedBytesRetained: true });
  });

  it('C04/C07 creates one127 UUID without a code, preserves122 and exactly reuses original/equivalent requests', async () => {
    mainConfirmation = await confirmation(mainObservation); mainRequest = randomUUID();
    const first = await mutate('confirm_new_item', mainConfirmation, A, ADMIN, mainRequest); mainItem = String(first.itemId);
    expect(first).toMatchObject({ revision: 1, created: true, codeState: 'awaiting_code', relationshipUsable: false });
    expect(await mutate('confirm_new_item', mainConfirmation, A, ADMIN, mainRequest)).toEqual(first);
    const equivalent = await mutate('confirm_new_item', mainConfirmation); expect(equivalent).toMatchObject({ itemId: mainItem, created: false });
    expect((await owner.query('SELECT count(*)::int n FROM catalog.catalog_item')).rows[0].n).toBe(127);
    expect((await owner.query('SELECT count(*)::int n FROM catalog.new_item_decision WHERE observation_id=$1', [mainObservation])).rows[0].n).toBe(1);
    const head = (await owner.query('SELECT * FROM catalog.item_current WHERE item_id=$1', [mainItem])).rows[0];
    expect(head).toMatchObject({ revision: 1, financial_revision: null });
    expect((await catalogRepository.get(identity(), original122))?.iceCode).toBeNull();
    expect((await catalogRepository.get(identity(), mainItem))?.codeState).toBe('awaiting_code');
    const row = (await owner.query('SELECT * FROM catalog.catalog_item WHERE id=$1', [mainItem])).rows[0];
    expect(row.first_release_id).toBeNull(); expect(row.creation_decision_id).toBe(first.creationDecisionId);
    const receiptRow = (await owner.query('SELECT * FROM catalog.new_item_request WHERE request_id=$1', [mainRequest])).rows[0];
    expect(receiptRow.actor_id).toBe(ADMIN); expect(receiptRow.item_id).toBe(mainItem);
    await rejectUnchanged('C07-changed-reason', () => mutate('confirm_new_item', { ...mainConfirmation, privateReason: 'different reason' }), { code: '23505' });
    save('C04-C07-created127-original122-and-requests.json', { mainItem, original122, first, equivalent, head, origin: row, originalRequest: mainRequest });
  });

  it('C05/C19/C20 code and nonprice revisions preserve oldmissing snapshots and private audit; reimport does not reset', async () => {
    const beforeOrigin = await snapshot(['catalog.new_item_decision', 'catalog.item_observation_origin', 'catalog.new_item_source_claim']);
    const codePayload = { itemId: mainItem, expectedRevision: 1, code: 'FIX-C127-001', privateReason: 'PRIVATE-CODE-PRICE-7722.15' };
    const codeRequest = randomUUID(), coded = await mutate('assign_initial_code', codePayload, A, ADMIN, codeRequest);
    expect(coded).toMatchObject({ itemId: mainItem, revision: 2 });
    const patch = { factory: { state: 'observed', meaning: 'value', raw: 'ISOLATED FACTORY', evidenceRef: 'private-source-reference' },
      specification: { state: 'observed', meaning: 'value', raw: 'ISOLATED SPECIFICATION', evidenceRef: 'private-source-reference' } };
    const revisionRequest = randomUUID();
    const revised = await mutate('append_nonprice_revision', { itemId: mainItem, expectedRevision: 2, fields: patch,
      privateReason: 'PRIVATE-REVISION-PRICE-8822.16' }, A, ADMIN, revisionRequest);
    expect(revised).toMatchObject({ itemId: mainItem, revision: 3 });
    expect(await snapshot(['catalog.new_item_decision', 'catalog.item_observation_origin', 'catalog.new_item_source_claim'])).toEqual(beforeOrigin);
    const old = await catalogRepository.get(identity(), mainItem, 1), current = await catalogRepository.get(identity(), mainItem);
    expect(old?.iceCode).toBeNull(); expect(old?.specification).toMatchObject({ state: 'not_read', raw: null });
    expect(current?.iceCode).toBe('FIX-C127-001'); expect(current?.specification.raw).toBe('ISOLATED SPECIFICATION');
    const history = await catalogRepository.history(identity(), mainItem), publicBytes = JSON.stringify({ current, history });
    expect(publicBytes).not.toMatch(/PRIVATE-CODE|PRIVATE-REVISION|7722\.15|8822\.16|private-source-reference|storageHandle|creationDecisionId/);
    expect(history.map((row) => row.revisionAudit.reason)).toEqual(['NONPRICE_REVISED', 'INITIAL_CODE_ASSIGNED', 'NEW_ITEM_CONFIRMED']);
    expect((await owner.query('SELECT request_id FROM catalog.catalog_item_code WHERE item_id=$1', [mainItem])).rows[0].request_id).toBeNull();
    expect((await owner.query('SELECT financial_revision FROM catalog.item_current WHERE item_id=$1', [mainItem])).rows[0].financial_revision).toBeNull();
    const sourceHistory = await read(A, mainObservation, 'sensitive_history');
    const events = sourceHistory.events as JsonObject[];
    expect(events.find((row) => row.requestId === codeRequest)?.privateReason).toBe(codePayload.privateReason);
    expect(events.find((row) => row.requestId === revisionRequest)?.privateReason).toBe('PRIVATE-REVISION-PRICE-8822.16');
    for (const requestId of [codeRequest, revisionRequest]) expect((await owner.query('SELECT count(*)::int n FROM catalog.audit_event WHERE request_id=$1', [requestId])).rows[0].n).toBe(0);
    const currentBefore = await snapshot(['catalog.catalog_item', 'catalog.catalog_item_code', 'catalog.item_current', 'catalog.item_revision', 'catalog_private.item_financial_revision']);
    await catalogRepository.publish(identity(), randomUUID(), await prepareBaseline());
    expect(await snapshot(['catalog.catalog_item', 'catalog.catalog_item_code', 'catalog.item_current', 'catalog.item_revision', 'catalog_private.item_financial_revision'])).toEqual(currentBefore);
    expect(await mutate('assign_initial_code', codePayload, A, ADMIN, codeRequest)).toEqual(coded);
    expect((await owner.query('SELECT count(*)::int n FROM catalog.catalog_item')).rows[0].n).toBe(127);
    expect((await owner.query('SELECT * FROM catalog.baseline_item_anchor ORDER BY json_pointer')).rows).toEqual(originalAnchors);
    await rejectUnchanged('C05-image-not-published', () => mutate('append_nonprice_revision', { itemId: mainItem, expectedRevision: 3,
      fields: { imageRef: { state: 'observed', meaning: 'value', raw: 'private-image-object', evidenceRef: 'private-object' } }, privateReason: 'Isolated image attempt' }), { code: '22023', message: 'IMAGE_PUBLICATION_NOT_IMPLEMENTED' });
    for (const oldFunction of ['assign_initial_code', 'append_nonprice_revision']) {
      const args = oldFunction === 'assign_initial_code' ? [randomUUID(), 'a'.repeat(64), mainItem, 3, 'FIX-OLD-BYPASS', 'private-reason', 'private-evidence']
        : [randomUUID(), 'a'.repeat(64), mainItem, 3, JSON.stringify(patch), 'private-reason', 'private-evidence'];
      await rejectUnchanged(`C19-old-${oldFunction}`, () => tx(ADMIN, (c) => c.query(`SELECT catalog.${oldFunction}($1,$2,$3,$4,$5,$6,$7)`, args)), { code: '42501', message: 'NEW_ITEM_SCOPED_ACTION_REQUIRED' });
    }
    save('C05-C19-C20-revisions-reimport-private-history.json', { mainItem, coded, revised, oldRevision: old, current, publicHistory: history, sensitiveHistory: sourceHistory,
      oldOriginDecisionSlotUnchanged: true, codeRequestColumnNull: true, reimportNoCurrentCodeFinancialRollback: true });
  });

  it('C18/C20 current read/evidence/amount separately protect history,raw and shared reads', async () => {
    const captureId = (await owner.query('SELECT capture_id FROM catalog.product_observation WHERE id=$1', [mainObservation])).rows[0].capture_id;
    for (const actor of [READ, NO_AMOUNT, NO_EVIDENCE, ADMIN_B, OPERATOR, INACTIVE]) {
      if (actor === READ) {
        // Read-only has raw audit rights only when its current evidence+amount grants explicitly allow it.
        const grant = (await owner.query('SELECT can_read,can_evidence,can_amount,enabled FROM catalog.source_scope_grant WHERE scope_id=$1 AND profile_id=$2', [A, actor])).rows[0];
        if (grant?.enabled && grant.can_read && grant.can_evidence && grant.can_amount) {
          expect((await read(A, mainObservation, 'sensitive_history', actor)).projection).toBe('sensitive_history');
          continue;
        }
      }
      await expect(read(A, mainObservation, 'sensitive_history', actor)).rejects.toMatchObject({ code: '42501' });
      await expect(tx(actor, (c) => c.query('SELECT catalog.new_item_read_evidence($1)', [captureId]))).rejects.toMatchObject({ code: '42501' });
    }
    const safe = await read(A, mainObservation, 'safe', READ);
    expect(JSON.stringify(safe)).not.toMatch(/PRIVATE-CODE|PRIVATE-REVISION|7722\.15|8822\.16|storageHandle|privateReason/);
    const evidenceMeta = await tx(ADMIN, async (c) => (await c.query('SELECT catalog.new_item_read_evidence($1) result', [captureId])).rows[0].result);
    expect(Object.keys(evidenceMeta).sort()).toEqual(['evidenceId', 'format', 'scopeId', 'sha256', 'size', 'storageHandle']);
    const shared = await catalogRepository.get(identity(ADMIN_B), mainItem);
    expect(shared?.iceCode).toBe('FIX-C127-001'); expect(JSON.stringify(shared)).not.toMatch(/creationDecision|source_slot_basis|storageHandle|PRIVATE/);
    for (const actor of [READ, ADMIN_B]) await rejectUnchanged(`C18-no-publish-${actor.slice(-3)}`, () => mutate('append_nonprice_revision', {
      itemId: mainItem, expectedRevision: 3, fields: { factory: { state: 'observed', meaning: 'value', raw: 'FORBIDDEN', evidenceRef: 'fixture' } }, privateReason: 'No publish attempt' }, A, actor), { code: '42501' });
    const c = await owner.connect();
    try {
      await c.query('BEGIN');
      await c.query('UPDATE catalog.source_scope_grant SET can_amount=false WHERE scope_id=$1 AND profile_id=$2', [A, ADMIN]);
      await c.query('SET LOCAL ROLE ice_p0_02_app_runner'); await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`, [ADMIN]);
      await expect(c.query('SELECT catalog.new_item_read($1,$2,$3)', [A, mainObservation, 'sensitive_history'])).rejects.toMatchObject({ code: '42501' });
    } finally { await c.query('ROLLBACK'); c.release(); }
    expect((await read(A, mainObservation, 'sensitive_history')).projection).toBe('sensitive_history');
    save('C18-C20-current-permissions-sensitive-raw.json', { captureId, safe, allowedMetadataKeys: Object.keys(evidenceMeta), shared,
      noManagePublishRequiredForAuthorizedAudit: true, missingRawCapabilityDenied: true, currentRevocationChecked: true });
  });

  it('C13 real two-connection barrier gives exactly one concurrent item-CAS revision and no identity leakage', async () => {
    const blocker = await owner.connect();
    const before = (await owner.query('SELECT * FROM catalog.item_current WHERE item_id=$1', [mainItem])).rows[0];
    const requests = [randomUUID(), randomUUID()]; let attempts: PromiseSettledResult<JsonObject>[] = [];
    const payloads = requests.map((_, index) => ({ itemId: mainItem, expectedRevision: before.revision,
      fields: { factory: { state: 'observed', meaning: 'value', raw: `ISOLATED-RACE-${index}`, evidenceRef: 'private-race-evidence' } }, privateReason: `Explicit concurrent revision ${index}` }));
    let waiting = 0;
    await blocker.query('SELECT pg_advisory_lock(hashtextextended($1,301))', [A]);
    const running = payloads.map((payload, i) => mutate('append_nonprice_revision', payload, A, ADMIN, requests[i]));
    const settled = Promise.allSettled(running);
    try {
      for (let n = 0; n < 100; n++) {
        waiting = (await owner.query(`SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND usename='ice_p0_02_app_runner' AND wait_event_type='Lock' AND query LIKE 'SELECT catalog.new_item_mutate%'`)).rows[0].n;
        if (waiting >= 2) break; await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(waiting).toBe(2);
    } finally { await blocker.query('SELECT pg_advisory_unlock(hashtextextended($1,301))', [A]); blocker.release(); attempts = await settled; }
    expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const after = (await owner.query('SELECT * FROM catalog.item_current WHERE item_id=$1', [mainItem])).rows[0];
    expect(after.revision).toBe(before.revision + 1); expect(after.financial_revision).toBe(before.financial_revision);
    expect((await owner.query('SELECT count(*)::int n FROM catalog.new_item_request WHERE request_id=ANY($1::uuid[])', [requests])).rows[0].n).toBe(1);
    for (const actor of [ADMIN, READ, null, ADMIN_B, OPERATOR, ADMIN]) {
      const seen = await tx(actor, async (c) => (await c.query(`SELECT nullif(current_setting('request.jwt.claim.sub',true),'') actor`)).rows[0].actor);
      expect(seen).toBe(actor);
      const outside = (await app.query(`SELECT nullif(current_setting('request.jwt.claim.sub',true),'') actor`)).rows[0].actor;
      expect(outside).toBeNull();
    }
    save('C13-two-real-connections-cas-pool.json', { waitingBeforeRelease: waiting, before, after, attempts: attempts.map((r) => r.status === 'fulfilled' ? r : { status: r.status, code: r.reason.code, message: r.reason.message }), oneSuccessReceipt: true, transactionLocalIdentityNotLeaked: true });
  });

  it('C17 actual committed SQL then lost COMMIT result recovers only the original scoped ledger', async () => {
    const before = (await owner.query('SELECT revision FROM catalog.item_current WHERE item_id=$1', [mainItem])).rows[0].revision;
    const payload = { itemId: mainItem, expectedRevision: before, fields: { factory: { state: 'observed', meaning: 'value', raw: 'COMMIT-RECOVERED', evidenceRef: 'private-commit-evidence' } }, privateReason: 'PRIVATE-ACTUAL-COMMIT-9911.17' };
    const actual = appDb.withAppDb, requestId = randomUUID(); let committedThenLost = false;
    const spy = vi.spyOn(appDb, 'withAppDb').mockImplementation(async <T>(who: appDb.DbIdentity | null, fn: (c: PoolClient) => Promise<T>): Promise<T> => {
      const result = await actual(who, fn);
      if (!committedThenLost) { committedThenLost = true; throw Object.assign(new Error('INJECTED_COMMIT_ACK_LOST_AFTER_REAL_COMMIT'), { code: '08006' }); }
      return result;
    });
    let recovered;
    try { recovered = await newItemRepository.mutate(identity(), requestId, A, 'append_nonprice_revision', payload); }
    finally { spy.mockRestore(); }
    expect(committedThenLost).toBe(true); expect(recovered).toMatchObject({ itemId: mainItem, revision: before + 1 });
    expect((await owner.query('SELECT count(*)::int n FROM catalog.new_item_request WHERE request_id=$1', [requestId])).rows[0].n).toBe(1);
    expect((await owner.query('SELECT count(*)::int n FROM catalog.audit_event WHERE request_id=$1', [requestId])).rows[0].n).toBe(0);
    const next = { ...payload, expectedRevision: before + 1, privateReason: 'PRIVATE-UNKNOWN-RECOVERY-9911.18' }, unknownRequest = randomUUID();
    let calls = 0;
    const broken = vi.spyOn(appDb, 'withAppDb').mockImplementation(async <T>(who: appDb.DbIdentity | null, fn: (c: PoolClient) => Promise<T>): Promise<T> => {
      calls++; if (calls > 1) throw Object.assign(new Error('INJECTED_RECEIPT_CONNECTION_LOST'), { code: '08006' });
      await actual(who, fn); throw Object.assign(new Error('INJECTED_COMMIT_ACK_LOST_AFTER_REAL_COMMIT'), { code: '08006' });
    });
    try { await expect(newItemRepository.mutate(identity(), unknownRequest, A, 'append_nonprice_revision', next)).rejects.toThrow('REQUEST_OUTCOME_UNKNOWN'); }
    finally { broken.mockRestore(); }
    const intent = newItemIntent(identity(), A, 'append_nonprice_revision', next);
    const original = await newItemRepository.receipt(identity(), unknownRequest, A, 'append_nonprice_revision', intent);
    expect(original).toMatchObject({ itemId: mainItem, revision: before + 2 });
    expect(await newItemRepository.mutate(identity(), unknownRequest, A, 'append_nonprice_revision', next)).toEqual(original);
    for (const actor of [ADMIN_B, READ]) await expect(newItemRepository.receipt(identity(actor), unknownRequest, A, 'append_nonprice_revision', intent)).rejects.toMatchObject({ code: '42501' });
    await expect(newItemRepository.receipt(identity(), unknownRequest, A, 'assign_initial_code', intent)).rejects.toBeDefined();
    await expect(newItemRepository.receipt(identity(), unknownRequest, A, 'append_nonprice_revision', 'a'.repeat(64))).rejects.toBeDefined();
    expect((await owner.query('SELECT revision FROM catalog.item_current WHERE item_id=$1', [mainItem])).rows[0].revision).toBe(before + 2);
    save('C17-real-commit-unknown-receipt.json', { requestId, unknownRequest, before, recovered, original, commitActuallyExecutedBeforeInjectedLoss: true,
      actualDatabaseReceiptRead: true, oldGlobalAuditNotUsed: true, originalActorScopeActionIntentOnly: true });
  });

  it('C10 zero-proof newbatch exact A member reuses the original slot UUID; revoked/source/risk guards remain live', async () => {
    const first = await importCapture('a-r1-first'), firstId = first.observations[0].id;
    const firstObs = await observation(firstId); expect(firstObs.currentSource).not.toBeNull();
    const created = await mutate('confirm_new_item', await confirmation(firstId)); reliableItem = String(created.itemId);
    reliableRecord = String(firstObs.currentSource!.recordId);
    const repeat = await importCapture('a-r1-repeat'); reliableRepeat = repeat.observations[0].id;
    expect(repeat.payload.associationProofs).toEqual([]); await classify(reliableRepeat, 'external_sku');
    const o = await observation(reliableRepeat), preview = o.sourceSlotPreview;
    expect(preview).not.toBeNull(); expect(preview!.slot.itemId).toBe(reliableItem); expect(o.currentSource?.recordId).toBe(reliableRecord);
    for (const actor of [ADMIN, NO_AMOUNT, NO_EVIDENCE]) {
      const scopedSafe = await observation(reliableRepeat, A, actor);
      expect(scopedSafe.sourceSlotPreview?.sourceCoverage).toBeDefined();
      expect(scopedSafe.sourceSlotPreview!.sourceCoverage).not.toHaveProperty('sourceProof');
      expect(scopedSafe.sourceSlotPreview!.sourceCoverage).not.toHaveProperty('identityLinkProofId');
      expect(scopedSafe.sourceSlotPreview!.sourceCoverage.proofPathDigest).toMatch(/^[a-f0-9]{64}$/);
    }
    const payload = { observationId: reliableRepeat, expectedClassificationRevision: o.classification!.revision,
      expectedSourceDisposition: preview!.sourceDispositionSha256, previewId: preview!.previewId, basis: { kind: 'source_slot' }, privateReason: 'EXPLICIT SAME-SOURCE NO EXTRA PROOF' };
    const identityRow = (await owner.query(`SELECT po.identity_observation_id,ie.bytes_sha256,io.record_pointer,l.* FROM catalog.product_observation po
      JOIN catalog.identity_observation io ON io.id=po.identity_observation_id JOIN catalog.identity_evidence ie ON ie.id=io.evidence_id
      JOIN LATERAL(SELECT * FROM catalog.observation_record_link ll WHERE ll.observation_key='identity:'||io.id::text ORDER BY link_revision DESC LIMIT 1) l ON true WHERE po.id=$1`, [reliableRepeat])).rows[0];
    expect(identityRow.status).toBe('linked'); expect(identityRow.record_id).toBe(reliableRecord);
    for (const state of ['suspended', 'revoked', 'review_required']) await rollbackProbe(`C10-source-${state}`,
      (c) => c.query('UPDATE catalog.source_record SET state=$1 WHERE id=$2', [state, reliableRecord]).then(() => undefined), 'associate_existing_item', payload, { code: '23505' });
    await rollbackProbe('C10-highest-link-revoked', async (c) => {
      await c.query(`INSERT INTO catalog.observation_record_link(observation_key,link_revision,previous_revision,scope_id,origin_kind,frozen_observation_id,identity_observation_id,record_id,contract_id,proof_id,status,frozen_decision_ids,reason,actor_id)
       VALUES($1,$2,$3,$4,'identity',NULL,$5,$6,$7,$8,'revoked','{}','ISOLATED rollback later revoke',$9)`,
      [identityRow.observation_key, identityRow.link_revision + 1, identityRow.link_revision, A, identityRow.identity_observation_id, reliableRecord, identityRow.contract_id, identityRow.proof_id, ADMIN]);
    }, 'associate_existing_item', payload, { code: '23505' });
    await rejectUnchanged('C10-client-cannot-reselect-target', () => mutate('associate_existing_item', { ...payload, basis: { kind: 'source_slot', targetItemId: original122 } }), { code: '22023' });
    const wrongSource = (await importCapture('a-proof-new')).observations[0].id; await classify(wrongSource, 'external_sku');
    const wrongObs = await observation(wrongSource);
    await rejectUnchanged('C10-unreliable-member-not-slot', () => mutate('associate_existing_item', { ...payload, observationId: wrongSource,
      expectedClassificationRevision: wrongObs.classification!.revision, expectedSourceDisposition: wrongObs.sourceDisposition.sha256 }), { code: '40001' });
    const before = await snapshot([...OLD_TABLES, 'catalog.product_capture', 'catalog.product_observation', 'catalog.intake_classification_revision', 'catalog.new_item_decision', 'catalog.new_item_source_claim', ...A_TABLES]);
    const slotBefore = (await owner.query('SELECT * FROM catalog.new_item_source_claim WHERE source_record_id=$1', [reliableRecord])).rows[0];
    const requestId = randomUUID(), associated = await mutate('associate_existing_item', payload, A, ADMIN, requestId);
    expect(associated).toEqual({ itemId: reliableItem, revision: 1, created: false, associated: true, originId: expect.any(String), relationshipUsable: false });
    expect(await mutate('associate_existing_item', payload, A, ADMIN, requestId)).toEqual(associated);
    const equivalentRequest = randomUUID();
    expect(await mutate('associate_existing_item', payload, A, ADMIN, equivalentRequest)).toEqual(associated);
    const equivalentReceipt = (await owner.query('SELECT * FROM catalog.new_item_request WHERE request_id=$1', [equivalentRequest])).rows[0];
    expect(equivalentReceipt.publication_token).toBeNull(); expect(equivalentReceipt.private_field_evidence).toEqual({});
    expect(await snapshot([...OLD_TABLES, 'catalog.product_capture', 'catalog.product_observation', 'catalog.intake_classification_revision', 'catalog.new_item_decision', 'catalog.new_item_source_claim', ...A_TABLES])).toEqual(before);
    const origin = (await owner.query('SELECT * FROM catalog.item_observation_origin WHERE id=$1', [associated.originId])).rows[0];
    expect(origin).toMatchObject({ association_basis_kind: 'source_slot', basis_source_slot_record_id: reliableRecord,
      basis_origin_id: slotBefore.origin_id, creation_decision_id: slotBefore.creation_decision_id, item_id: reliableItem,
      coverage_identity_observation_id: identityRow.identity_observation_id, coverage_identity_link_revision: identityRow.link_revision,
      association_capture_id: null, association_proof_key: null });
    const receipt = (await owner.query('SELECT * FROM catalog.new_item_request WHERE request_id=$1', [requestId])).rows[0];
    const basis = receipt.private_field_evidence.source_slot_basis;
    expect(receipt.publication_token).toBeNull(); expect(receipt.adopted_field_keys).toEqual([]);
    expect(basis.slot).toMatchObject({ sourceRecordId: reliableRecord, itemId: reliableItem, creationDecisionId: slotBefore.creation_decision_id, originId: slotBefore.origin_id });
    expect(basis.identityMember.observationId).toBe(identityRow.identity_observation_id); expect(basis.identityLink.revision).toBe(identityRow.link_revision);
    const history = await read(A, reliableRepeat, 'sensitive_history');
    const event = (history.events as JsonObject[]).find((row) => row.requestId === requestId)!;
    expect(event.associationProof).toBeNull(); expect((event.fieldEvidence as JsonObject).source_slot_basis).toEqual(basis);
    save('C10-real-A-direct-member-zero-proof-slot-reuse.json', { first: created, repeatCapture: repeat.result, associated,
      exactDirectMember: identityRow, slotBefore, origin, privateAudit: basis, historyEvent: event, actualFixtureProofs: repeat.payload.associationProofs,
      noSecondItemOrAdoptionOrTargetChange: true });
  });

  it('C09 saved direct-member ID is required even when an A member later exists at the same bytes and pointer', async () => {
    const before = await snapshot(), c = await owner.connect();
    const temporaryCapture = randomUUID(), temporaryObservation = randomUUID();
    try {
      await c.query('BEGIN');
      const original = (await c.query('SELECT * FROM catalog.product_observation WHERE id=$1', [reliableRepeat])).rows[0];
      expect(original.identity_observation_id).not.toBeNull();
      await c.query(`INSERT INTO catalog.product_capture SELECT (jsonb_populate_record(NULL::catalog.product_capture,to_jsonb(pc)||jsonb_build_object('id',$1::text,'capture_key',$2::text))).* FROM catalog.product_capture pc WHERE pc.id=$3`, [temporaryCapture, `owner-only-qualification-negative-${temporaryCapture}`, original.capture_id]);
      await c.query(`INSERT INTO catalog.product_observation SELECT (jsonb_populate_record(NULL::catalog.product_observation,to_jsonb(o)||jsonb_build_object('id',$1::text,'capture_id',$2::text,'identity_observation_id',NULL,'source_record_id',NULL,'source_record_revision',NULL,'source_claim_id',NULL))).* FROM catalog.product_observation o WHERE o.id=$3`, [temporaryObservation, temporaryCapture, reliableRepeat]);
      const fixtureBeforeRead = await snapshot(undefined, c);
      await c.query('SET LOCAL ROLE ice_p0_02_app_runner'); await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`, [ADMIN]);
      const result = (await c.query(`SELECT catalog.new_item_read($1,$2,'safe') result`, [A, temporaryObservation])).rows[0].result;
      const observed = result.observations.find((row: JsonObject) => row.observationId === temporaryObservation);
      expect(observed).toBeDefined(); expect(observed.currentSource).toBeNull(); expect(observed.sourceSlotPreview).toBeNull();
      await c.query('RESET ROLE'); expect(await snapshot(undefined, c)).toEqual(fixtureBeforeRead);
      save('C09-null-direct-ID-qualification-negative.json', { temporaryCapture, temporaryObservation, originalSavedMember: original.identity_observation_id,
        observed, ownerRollbackQualificationFixtureOnly: true, notAnApprovedProductImportOrSuccessfulIdentityFact: true, actualAppRead: true });
    } finally { await c.query('ROLLBACK'); c.release(); }
    expect(await snapshot()).toEqual(before);
  });

  it('C08 same-item product proof associates old UUID; noID oldpointer/reason and wrong endpoint still reject', async () => {
    const old = await importCapture('a-proof-old'); await classify(old.observations[0].id);
    const created = await mutate('confirm_new_item', await confirmation(old.observations[0].id));
    const target = String(created.itemId), oldOrigin = (await observation(old.observations[0].id)).origin!;
    const next = await importCapture('a-proof-new'), obsId = next.observations[0].id;
    const seen = await observation(obsId); if (!seen.classification) await classify(obsId, 'external_sku');
    const proof = (next.payload.associationProofs as JsonObject[]).find((p) => p.semantics === 'same_catalog_item')!;
    expect(proof).toBeDefined();
    const ref = { captureId: next.result.captureId, proofKey: proof.proofKey };
    const payload = await catalogAssociation(obsId, target, { kind: 'origin', originId: oldOrigin.originId }, ref);
    await rejectUnchanged('C08-origin-reason-no-proof', () => mutate('associate_existing_item', { ...payload, basis: { ...payload.basis, associationProofRef: null } }), { code: '22023' });
    const wrong = await catalogAssociation(obsId, target, { kind: 'origin', originId: String((await observation(mainObservation)).origin!.originId) }, ref);
    await rejectUnchanged('C08-real-proof-wrong-origin', () => mutate('associate_existing_item', wrong), { code: '22023', message: 'ASSOCIATION_PROOF_INVALID' });
    const before = await snapshot([...OLD_TABLES, 'catalog.new_item_decision', 'catalog.new_item_source_claim', ...A_TABLES]);
    const result = await mutate('associate_existing_item', payload);
    expect(result).toMatchObject({ itemId: target, created: false, associated: true, relationshipUsable: false });
    expect(await snapshot([...OLD_TABLES, 'catalog.new_item_decision', 'catalog.new_item_source_claim', ...A_TABLES])).toEqual(before);
    const origin = (await owner.query('SELECT * FROM catalog.item_observation_origin WHERE id=$1', [result.originId])).rows[0];
    expect(origin.creation_observation_id).toBe(old.observations[0].id); expect(origin.observation_id).toBe(obsId);
    save('C08-product-endpoint-proof-positive-and-negative.json', { created, result, origin, proof, wrongOriginRejectedByActualEndpointGuard: true });
  });
  it('C08 approved run-local baseline endpoint proof uses real published anchor then restores exact fixed helper', async () => {
    const fixedPointer = '/master_rows/117';
    const live = (await owner.query(`SELECT current_setting('data_directory') data_directory,current_database() database,inet_server_port() port,(SELECT run_id FROM p0_02_meta.platform_instance LIMIT 1) run_id`)).rows[0];
    const marker = JSON.parse(fs.readFileSync(path.join(runRoot, 'instance/new-item-manifest.json'), 'utf8'));
    expect(['127.0.0.1', 'localhost', '::1']).toContain(instance.host);
    expect(live).toMatchObject({ database: instance.dbName, port: instance.port, run_id: instance.runId });
    expect(path.resolve(live.data_directory)).toBe(path.resolve(instance.dataDir));
    expect(marker).toMatchObject({ runId: instance.runId, database: instance.dbName, dataDir: instance.dataDir, nonceConsumed: true });
    const pidLines = fs.readFileSync(path.join(instance.dataDir, 'postmaster.pid'), 'utf8').split(/\r?\n/);
    expect(path.resolve(pidLines[1])).toBe(path.resolve(instance.dataDir)); expect(Number(pidLines[3])).toBe(instance.port);
    const active = (await owner.query(`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND usename='ice_p0_02_app_runner' AND state<>'idle'`)).rows;
    expect(active).toHaveLength(0);
    const anchor = (await owner.query(`SELECT a.*,b.bundle_sha256 FROM catalog.baseline_item_anchor a JOIN catalog.baseline_release b ON b.id=a.release_id WHERE a.json_pointer=$1`, [fixedPointer])).rows[0];
    expect(anchor.item_id).toBe(original122); expect(anchor.bundle_sha256).toBe(baseline.bundleSha256);
    const original = fixtureManifest.captures.find((row) => row.approvedFixtureId === 'a-main')!;
    const raw = fs.readFileSync(path.join(fixturesRoot, original.rawFile));
    expect(createHash('sha256').update(raw).digest('hex')).toBe(original.bytesSha256);
    const row = (original.observations as JsonObject[])[0];
    const proof = { proofKey: 'run-local-baseline-fixed-proof', semantics: 'same_catalog_item',
      from: { kind: 'product_observation', captureKey: 'run-local-baseline-fixed', recordPointer: row.recordPointer, bytesSha256: original.bytesSha256, payloadSha256: row.payloadSha256 },
      to: { kind: 'baseline_anchor', releaseId: anchor.release_id, artifactId: anchor.artifact_id, jsonPointer: fixedPointer, bundleSha256: anchor.bundle_sha256, payloadSha256: anchor.payload_sha256 } };
    const fixture = { ...original, approvedFixtureId: 'run-local-baseline-fixed', captureKey: 'run-local-baseline-fixed', associationProofs: [proof] };
    const localManifest = { manifestId: 'run-local-baseline-fixed-manifest', fictional: true, approval: 'APPROVED_TEST_FIXTURE_EXCEPTION', captures: [fixture] };
    save('C08-run-local-baseline-manifest.json', localManifest);
    fs.writeFileSync(path.join(evidence, 'C08-run-local-original-raw.json'), raw, { flag: 'wx' });
    const localSha = createHash('sha256').update(fs.readFileSync(path.join(evidence, 'C08-run-local-baseline-manifest.json'))).digest('hex');
    const p = await fixturePayload('a-main');
    Object.assign(p, { approvedFixtureId: fixture.approvedFixtureId, captureKey: fixture.captureKey, associationProofs: [proof], fixtureManifestId: localManifest.manifestId, fixtureManifestSha256: localSha });
    p.adoptionDigest = envelopeDigest(p);
    const pin = { ...p }; delete pin.storageHandle;
    const describeHelper = async () => (await owner.query(`SELECT pg_get_functiondef(p.oid) definition,p.prosrc,p.provolatile,p.proisstrict,p.prosecdef,p.proleakproof,p.proparallel,p.procost,p.prorows,p.proconfig,p.proacl::text,pg_get_userbyid(p.proowner) owner,
      coalesce((SELECT bool_or(a.grantee=0 AND a.privilege_type='EXECUTE') FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a),false) public_execute FROM pg_proc p WHERE p.oid='catalog.new_item_fixture_pin(text)'::regprocedure`)).rows[0];
    const before = await describeHelper(); save('C08-helper-before.json', { ...before, sha256: hash(before) });
    expect(before.public_execute).toBe(false);
    const match = String(before.prosrc).match(/\$pins\$([\s\S]*?)\$pins\$/); expect(match).not.toBeNull();
    const map = JSON.parse(match![1]); expect(map['run-local-baseline-fixed']).toBeUndefined();
    const added = { ...map, 'run-local-baseline-fixed': pin };
    const body = String(before.prosrc).replace(match![0], `$pins$${JSON.stringify(added)}$pins$`);
    const temporaryDefinition = String(before.definition).replace(String(before.prosrc), body);
    expect(temporaryDefinition).not.toBe(before.definition);
    await expect(tx(ADMIN, (c) => c.query(`SELECT catalog.new_item_fixture_pin('a-main')`))).rejects.toMatchObject({ code: '42501' });
    let installed = false;
    try {
      await owner.query(temporaryDefinition); installed = true;
      const temporary = await describeHelper();
      expect({ ...temporary, definition: null, prosrc: null }).toEqual({ ...before, definition: null, prosrc: null });
      const actual = JSON.parse(String(temporary.prosrc).match(/\$pins\$([\s\S]*?)\$pins\$/)![1]);
      const removed = { ...actual }; delete removed['run-local-baseline-fixed']; expect(removed).toEqual(map); expect(Object.keys(actual)).toHaveLength(Object.keys(map).length + 1);
      save('C08-helper-temporary.json', { ...temporary, sha256: hash(temporary), originalMapUnchanged: true });
      await expect(tx(ADMIN, (c) => c.query(`SELECT catalog.new_item_fixture_pin('run-local-baseline-fixed')`))).rejects.toMatchObject({ code: '42501' });
      for (const [label, edited] of [
        ['time', { ...p, collectedAt: '2026-10-20T12:34:56.123457Z' }],
        ['endpoint', { ...p, associationProofs: [{ ...proof, to: { ...proof.to, jsonPointer: '/master_rows/0' } }] }],
      ] as const) {
        const tampered = { ...edited, adoptionDigest: envelopeDigest(edited) };
        await rejectUnchanged(`C08-run-local-pin-${label}`, () => mutate('import_product_capture', tampered), { code: '22023', message: 'PRODUCT_CAPTURE_PIN_CONFLICT' });
      }
      const imported = await mutate('import_product_capture', p);
      const oid = (await owner.query(`SELECT o.id FROM catalog.product_observation o JOIN catalog.product_capture c ON c.id=o.capture_id WHERE c.approved_fixture_id='run-local-baseline-fixed'`)).rows[0].id;
      await classify(oid, 'external_sku');
      const ref = { captureId: imported.captureId, proofKey: proof.proofKey };
      const wrong = await catalogAssociation(oid, original122, { kind: 'baseline_anchor', releaseId: anchor.release_id, artifactId: anchor.artifact_id, jsonPointer: '/master_rows/0' }, ref);
      await rejectUnchanged('C08-baseline-actual-endpoint-not-pin', () => mutate('associate_existing_item', wrong), { code: '22023', message: 'ASSOCIATION_PROOF_INVALID' });
      const payload = await catalogAssociation(oid, original122, { kind: 'baseline_anchor', releaseId: anchor.release_id, artifactId: anchor.artifact_id, jsonPointer: fixedPointer }, ref);
      const beforeAssociation = await snapshot([...OLD_TABLES, 'catalog.new_item_decision', 'catalog.new_item_source_claim', ...A_TABLES]);
      const result = await mutate('associate_existing_item', payload);
      expect(result).toMatchObject({ itemId: original122, created: false, associated: true, relationshipUsable: false });
      expect(await snapshot([...OLD_TABLES, 'catalog.new_item_decision', 'catalog.new_item_source_claim', ...A_TABLES])).toEqual(beforeAssociation);
      const origin = (await owner.query('SELECT * FROM catalog.item_observation_origin WHERE id=$1', [result.originId])).rows[0];
      expect(origin).toMatchObject({ baseline_release_id: anchor.release_id, baseline_artifact_id: anchor.artifact_id, baseline_json_pointer: fixedPointer, creation_decision_id: null, item_id: original122 });
      save('C08-baseline-endpoint-real-app.json', { live, marker: { runId: marker.runId, dataDir: marker.dataDir, port: marker.port }, fixedPointer, anchor, localSha, fullEnvelope: pin, imported, origin, result, onlyOriginAndReceiptAddedByAssociation: true });
    } finally {
      try {
        if (installed) await owner.query(before.definition);
        const restored = await describeHelper(); expect(restored).toEqual(before);
        expect(JSON.parse(String(restored.prosrc).match(/\$pins\$([\s\S]*?)\$pins\$/)![1])).toEqual(map);
        await expect(tx(ADMIN, (c) => c.query(`SELECT catalog.new_item_fixture_pin('a-main')`))).rejects.toMatchObject({ code: '42501' });
        save('C08-helper-restored.json', { ...restored, sha256: hash(restored), exactDefinitionOwnerAclAttributesRestored: true });
      } catch (error) { fixtureRestoreFailed = true; save('C08-helper-RESTORE-FAILED.json', { message: String(error), stopFurtherInstanceTests: true }); throw error; }
    }
  });

  it('C09 no-ID origin later attaches a verified independent same-source identity to the same UUID', async () => {
    const old = await importCapture('a-attach-old'), oid = old.observations[0].id;
    await classify(oid); expect((await observation(oid)).currentSource).toBeNull();
    const created = await mutate('confirm_new_item', await confirmation(oid)), itemId = String(created.itemId);
    const origin = (await observation(oid)).origin!;
    const proofCapture = await importCapture('a-attach-proof');
    const proof = (proofCapture.payload.associationProofs as JsonObject[]).find((p) => p.semantics === 'same_source_record')!;
    expect(proof).toBeDefined();
    const o = await observation(oid), src = o.currentSource!; expect(src).not.toBeNull();
    const support = (await owner.query(`SELECT io.*,l.record_id FROM catalog.identity_observation io JOIN LATERAL(SELECT record_id FROM catalog.observation_record_link WHERE observation_key='identity:'||io.id::text ORDER BY link_revision DESC LIMIT 1) l ON true WHERE io.scope_id=$1 AND l.record_id=$2`, [A, src.recordId])).rows[0];
    const payload = { originId: origin.originId, observationId: oid, itemId, expectedItemRevision: 1,
      sourceRecordId: src.recordId, expectedRecordRevision: src.revision, expectedClaimId: src.claimId,
      supportIdentityObservationId: support.id, expectedSourceDisposition: o.sourceDisposition.sha256,
      associationProofRef: { captureId: proofCapture.result.captureId, proofKey: proof.proofKey }, privateReason: 'Explicit verified late identity attachment' };
    await rejectUnchanged('C09-no-proof-same-scope-insufficient', () => mutate('attach_source_identity', { ...payload, associationProofRef: null }), { code: '22023', message: 'ASSOCIATION_PROOF_REQUIRED' });
    await rejectUnchanged('C09-wrong-support-member', () => mutate('attach_source_identity', { ...payload, supportIdentityObservationId: randomUUID() }), { code: '40001', message: 'SOURCE_DISPOSITION_CONFLICT' });
    await rejectUnchanged('C09-stale-record-revision', () => mutate('attach_source_identity', { ...payload, expectedRecordRevision: src.revision + 1 }), { code: '40001', message: 'SOURCE_DISPOSITION_CONFLICT' });
    await rejectUnchanged('C09-claim-not-current', () => mutate('attach_source_identity', { ...payload, expectedClaimId: randomUUID() }), { code: '40001', message: 'SOURCE_DISPOSITION_CONFLICT' });
    await rejectUnchanged('C09-different-record-cannot-replace-source', () => mutate('attach_source_identity', { ...payload, sourceRecordId: reliableRecord }), { code: '40001', message: 'SOURCE_DISPOSITION_CONFLICT' });
    const before = await snapshot([...OLD_TABLES, 'catalog.new_item_decision', ...A_TABLES]);
    const result = await mutate('attach_source_identity', payload);
    expect(result).toMatchObject({ itemId, revision: 1, associated: true, created: false, relationshipUsable: false });
    expect(await snapshot([...OLD_TABLES, 'catalog.new_item_decision', ...A_TABLES])).toEqual(before);
    const afterOrigin = (await owner.query('SELECT * FROM catalog.item_observation_origin WHERE id=$1', [result.originId])).rows[0];
    const slot = (await owner.query('SELECT * FROM catalog.new_item_source_claim WHERE source_record_id=$1', [src.recordId])).rows[0];
    expect(afterOrigin).toMatchObject({ origin_kind: 'source_attached', observation_id: oid, item_id: itemId, basis_origin_id: origin.originId, source_record_id: src.recordId });
    expect(slot).toMatchObject({ item_id: itemId, origin_id: afterOrigin.id, creation_decision_id: created.creationDecisionId });
    save('C09-late-identity-proof-real-app.json', { created, originalOrigin: origin, proof, support, result, afterOrigin, slot, adoptedUUIDUnchanged: true });
  });

  it('C01 unresolved scope saves only its own frozen product observation and preserves unknown identity', async () => {
    const u = fixtureManifest.captures.find((row) => row.approvedFixtureId === 'u-main')!;
    const payload = await fixturePayload('u-main');
    const cross: JsonObject = { ...payload, bytesSha256: (await fixturePayload('b-main')).bytesSha256 };
    cross.adoptionDigest = envelopeDigest(cross);
    await rejectUnchanged('C01-unresolved-cannot-use-B-bytes', () => mutate('import_product_capture', cross, u.scopeId), { code: '22023', message: 'PRODUCT_CAPTURE_PIN_CONFLICT' });
    const before = await snapshot(['catalog.source_record', 'catalog.identity_claim', 'catalog.new_item_source_claim', ...OLD_TABLES]);
    const imported = await importCapture('u-main');
    expect(imported.observations).toHaveLength(1);
    const o = await observation(imported.observations[0].id, u.scopeId);
    expect(o.currentSource).toBeNull(); expect(o.classification).toBeNull(); expect(o.origin).toBeNull();
    const scope = (await owner.query('SELECT * FROM catalog.source_scope WHERE id=$1', [u.scopeId])).rows[0];
    expect(scope.scope_state).toBe('unresolved');
    expect(o.fields.nameCn.raw).toBe('ICEOS N1C 虚构未核实范围资料');
    for (const key of ['barcode', 'sku']) { expect(o.fields[key].raw).toBeNull(); expect(o.fields[key].state).not.toBe('observed'); }
    expect(await snapshot(['catalog.source_record', 'catalog.identity_claim', 'catalog.new_item_source_claim', ...OLD_TABLES])).toEqual(before);
    const original = JSON.parse(fs.readFileSync(path.join(fixturesRoot, u.rawFile), 'utf8'));
    expect(original.scopeId).toBe(u.scopeId);
    save('C01-unresolved-real-app-observation.json', { scope, imported: imported.result, observation: o, sourceRawScope: original.scopeId, noRecordClaimSlotItemOrInventoryCreated: true });
  });

  it('C13 concurrent different observations for one reliable source create only one item and require explicit reuse', async () => {
    const captures = await Promise.all([importCapture('a-race-first'), importCapture('a-race-repeat')]);
    for (const capture of captures) await classify(capture.observations[0].id);
    const ids = captures.map((c) => c.observations[0].id), previews = await Promise.all(ids.map((id) => confirmation(id)));
    const sourceIds = await Promise.all(ids.map(async (id) => (await observation(id)).currentSource!.recordId));
    expect(sourceIds[0]).toBe(sourceIds[1]);
    const beforeCount = (await owner.query('SELECT count(*)::int n FROM catalog.catalog_item')).rows[0].n;
    const blocker = await owner.connect(); let waiting = 0; let outcomes: PromiseSettledResult<JsonObject>[] = [];
    await blocker.query('SELECT pg_advisory_lock(hashtextextended($1,301))', [A]);
    const requests = ids.map(() => randomUUID());
    const settled = Promise.allSettled(previews.map((p, index) => mutate('confirm_new_item', p, A, ADMIN, requests[index])));
    try {
      for (let n = 0; n < 100; n++) {
        waiting = (await owner.query(`SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND usename='ice_p0_02_app_runner' AND wait_event_type='Lock' AND query LIKE 'SELECT catalog.new_item_mutate%'`)).rows[0].n;
        if (waiting === 2) break; await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(waiting).toBe(2);
    } finally { await blocker.query('SELECT pg_advisory_unlock(hashtextextended($1,301))', [A]); blocker.release(); outcomes = await settled; }
    const success = outcomes.find((r) => r.status === 'fulfilled')!;
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await owner.query('SELECT count(*)::int n FROM catalog.catalog_item')).rows[0].n).toBe(beforeCount + 1);
    expect((await owner.query('SELECT count(*)::int n FROM catalog.new_item_source_claim WHERE source_record_id=$1', [sourceIds[0]])).rows[0].n).toBe(1);
    expect(success.status).toBe('fulfilled'); if (success.status !== 'fulfilled') throw new Error('RACE_NO_SUCCESS');
    const losingId = ids[outcomes.findIndex((r) => r.status === 'rejected')];
    const losing = await observation(losingId); expect(losing.sourceSlotPreview?.slot.itemId).toBe(success.value.itemId);
    await rejectUnchanged('C13-loser-cannot-retry-create', () => confirmation(losingId).then((p) => mutate('confirm_new_item', p)), { code: '23505', message: 'SOURCE_ALREADY_CLAIMED' });
    const preview = losing.sourceSlotPreview!;
    const result = await mutate('associate_existing_item', { observationId: losingId, expectedClassificationRevision: losing.classification!.revision,
      expectedSourceDisposition: preview.sourceDispositionSha256, previewId: preview.previewId, basis: { kind: 'source_slot' }, privateReason: 'Explicit reuse after losing concurrent creation' });
    expect(result).toMatchObject({ itemId: success.value.itemId, created: false, associated: true });
    save('C13-concurrent-same-source-one-UUID.json', { waiting, requests, sourceIds, outcomes: outcomes.map((r) => r.status === 'fulfilled' ? r : { status: r.status, code: r.reason.code, message: r.reason.message }), explicitReuse: result });
  });

  it('C04 composite foreign keys and immutable origin XOR are enforced in PostgreSQL, not only DTOs', async () => {
    const probe = async (label: string, sql: string, values: unknown[], code: string) => {
      const before = await snapshot(), c = await owner.connect(); let result;
      try {
        await c.query('BEGIN');
        result = await c.query(sql, values).then(() => c.query('SET CONSTRAINTS ALL IMMEDIATE'))
          .then(() => ({ accepted: true, code: '', message: '' }), (e) => ({ accepted: false, code: String(e.code), message: String(e.message), constraint: String(e.constraint) }));
        expect(result.accepted).toBe(false); expect(result.code).toBe(code);
      } finally { await c.query('ROLLBACK'); c.release(); }
      expect(await snapshot()).toEqual(before);
      save(`C04-constraint-${label}.json`, { result, expectedCode: code, fullStateBeforeSha256: hash(before), noPersistentFixtureRows: true });
    };
    await probe('both-origins-null', `INSERT INTO catalog.catalog_item(id,first_release_id,new_product_confirmed,confirmation_ref,creation_decision_id) VALUES($1,NULL,true,'ISOLATED-XOR-NULL',NULL)`, [randomUUID()], '23514');
    const release = (await owner.query('SELECT first_release_id FROM catalog.catalog_item WHERE id=$1', [original122])).rows[0].first_release_id;
    await probe('both-origins-present', `INSERT INTO catalog.catalog_item(id,first_release_id,new_product_confirmed,confirmation_ref,creation_decision_id) VALUES($1,$2,true,'ISOLATED-XOR-BOTH',$3)`, [randomUUID(), release, randomUUID()], '23514');
    await probe('cross-scope-product-member', `INSERT INTO catalog.product_observation SELECT (jsonb_populate_record(NULL::catalog.product_observation,to_jsonb(o)||jsonb_build_object('id',$1::text,'scope_id',$2::text,'record_pointer','/rows/900'))).* FROM catalog.product_observation o WHERE id=$3`, [randomUUID(), B, mainObservation], '23503');
    await probe('immutable-item-origin-update', `UPDATE catalog.catalog_item SET creation_decision_id=$2 WHERE id=$1`, [mainItem, randomUUID()], '42501');
    await probe('decision-item-pair', `INSERT INTO catalog.catalog_item(id,first_release_id,new_product_confirmed,confirmation_ref,creation_decision_id) VALUES($1,NULL,true,'ISOLATED-BAD-DECISION-PAIR',$2)`, [randomUUID(), randomUUID()], '23503');
    for (const table of C_TABLES) {
      for (const sql of [`INSERT INTO ${table} DEFAULT VALUES`, `UPDATE ${table} SET ${table === 'catalog.new_item_request' ? 'reason=reason' : table === 'catalog.new_item_source_claim' ? 'scope_id=scope_id' : 'scope_id=scope_id'}`, `DELETE FROM ${table}`]) {
        await expect(tx(ADMIN, (c) => c.query(sql))).rejects.toMatchObject({ code: '42501' });
      }
    }
  });

  it('C16 every revision UPDATE and receipt failure rolls back the whole scoped transaction', async () => {
    const revision = (await owner.query('SELECT revision FROM catalog.item_current WHERE item_id=$1', [mainItem])).rows[0].revision;
    const patch = { itemId: mainItem, expectedRevision: revision, fields: { factory: { state: 'observed', meaning: 'value', raw: 'FAILED-WRITE-MUST-NOT-PERSIST', evidenceRef: 'private-failed-write' } }, privateReason: 'Isolated write-point failure fixture' };
    for (const [table, operation] of [['catalog.item_revision', 'INSERT'], ['catalog.item_current', 'UPDATE'], ['catalog.new_item_request', 'INSERT']]) {
      await inject(table, operation, () => mutate('append_nonprice_revision', patch));
    }
    const uncoded = (await owner.query(`SELECT d.item_id,c.revision FROM catalog.new_item_decision d JOIN catalog.item_current c ON c.item_id=d.item_id WHERE NOT EXISTS(SELECT 1 FROM catalog.catalog_item_code k WHERE k.item_id=d.item_id) ORDER BY d.recorded_at LIMIT 1`)).rows[0];
    for (const [table, operation] of [['catalog.catalog_item_code', 'INSERT'], ['catalog.item_revision', 'INSERT'], ['catalog.item_current', 'UPDATE'], ['catalog.new_item_request', 'INSERT']]) {
      await inject(table, operation, () => mutate('assign_initial_code', { itemId: uncoded.item_id, expectedRevision: uncoded.revision, code: 'FIX-WRITE-FAIL-ONLY', privateReason: 'Isolated code write-point failure fixture' }));
    }
    save('C16-revision-and-code-write-failure-points.json', { revision, uncoded, allFullStateSnapshotsEqual: true, injectedOnlyInOwnedFreshInstance: true });
  });

  it('C17 current permission is rechecked before an old successful receipt is returned', async () => {
    const intent = newItemIntent(identity(), A, 'confirm_new_item', mainConfirmation);
    const original = await newItemRepository.receipt(identity(), mainRequest, A, 'confirm_new_item', intent);
    const grant = (await owner.query('SELECT * FROM catalog.source_scope_grant WHERE scope_id=$1 AND profile_id=$2', [A, ADMIN])).rows[0];
    const before = await snapshot();
    try {
      for (const column of ['can_read', 'can_manage', 'can_publish_catalog']) {
        await owner.query(`UPDATE catalog.source_scope_grant SET ${column}=false WHERE scope_id=$1 AND profile_id=$2`, [A, ADMIN]);
        await expect(newItemRepository.receipt(identity(), mainRequest, A, 'confirm_new_item', intent)).rejects.toMatchObject({ code: '42501' });
        await owner.query(`UPDATE catalog.source_scope_grant SET ${column}=$3 WHERE scope_id=$1 AND profile_id=$2`, [A, ADMIN, grant[column]]);
      }
    } finally {
      await owner.query('UPDATE catalog.source_scope_grant SET can_read=$3,can_manage=$4,can_publish_catalog=$5 WHERE scope_id=$1 AND profile_id=$2', [A, ADMIN, grant.can_read, grant.can_manage, grant.can_publish_catalog]);
    }
    expect(await newItemRepository.receipt(identity(), mainRequest, A, 'confirm_new_item', intent)).toEqual(original);
    expect(await snapshot()).toEqual(before);
    save('C17-receipt-current-permission-rechecked.json', { requestId: mainRequest, actor: ADMIN, scopeId: A, original, revokedCapabilities: ['read', 'manage', 'publish'], noCachedSuccessWhileRevoked: true });
  });

  it('C11/C14/C15 real historical target guards, fail-closed provider and shared308 lock are live', async () => {
    const providerFact = async () => (await owner.query(`SELECT pg_get_functiondef(p.oid) definition,p.prosrc,p.provolatile,p.proisstrict,p.prosecdef,p.proleakproof,p.proparallel,p.procost,p.prorows,p.proconfig,p.proacl::text,pg_get_userbyid(p.proowner) owner FROM pg_proc p WHERE p.oid='catalog.intake_target_history(uuid,uuid)'::regprocedure`)).rows[0];
    const providerBefore = await providerFact();
    const current = await observation(reliableRepeat), preview = current.sourceSlotPreview!;
    expect(preview).not.toBeNull();
    const prior = (await owner.query(`SELECT r.* FROM catalog.item_observation_origin o JOIN catalog.new_item_request r ON r.request_id=o.request_id WHERE o.observation_id=$1 AND o.association_basis_kind='source_slot'`, [reliableRepeat])).rows[0];
    const frozenBasis = prior.private_field_evidence.source_slot_basis;
    const base: JsonObject = { observationId: reliableRepeat, expectedClassificationRevision: frozenBasis.classification.revision,
      expectedSourceDisposition: frozenBasis.guard.sha256, previewId: frozenBasis.previewId, basis: { kind: 'source_slot' }, privateReason: prior.reason };
    const installShim = async (c: PoolClient, value: unknown) => c.query(`CREATE OR REPLACE FUNCTION catalog.intake_target_history(p_scope uuid,p_record uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $shim$ BEGIN PERFORM catalog.new_item_authorize(p_scope,'read'); RETURN $provider$${JSON.stringify(value)}$provider$::jsonb; END $shim$`);
    const refresh = async (c: PoolClient, payload: JsonObject) => {
      await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`, [ADMIN]);
      const w = (await c.query(`SELECT catalog.new_item_read($1,$2,'safe') result`, [A, reliableRepeat])).rows[0].result;
      const o = w.observations[0], p = o.sourceSlotPreview; expect(p).not.toBeNull();
      // An existing association reuses its strict immutable original business intent.
      // The SQL no-op branch independently checks CURRENT provider/frozen history.
      // Updating the original preview would test an intent conflict before that guard.
      if (!o.origin) Object.assign(payload, { expectedClassificationRevision: p.classificationRevision, expectedSourceDisposition: p.sourceDispositionSha256, previewId: p.previewId });
      else expect(payload).toEqual(base);
      return o;
    };
    const bNames = ['catalog.catalog_target_decision_revision', 'catalog.catalog_target_decision_current', 'catalog.target_decision_origin', 'catalog_private.target_decision_context'];
    const unlinkedCapture = await importCapture('a-bs-candidate'), unlinkedObservation = unlinkedCapture.observations[0].id;
    await classify(unlinkedObservation, 'new_item');
    expect((await observation(unlinkedObservation)).currentSource).toBeNull();
    const unlinkedConfirmation = await confirmation(unlinkedObservation);
    const presence = async () => Promise.all(bNames.map(async (name) => (await owner.query('SELECT to_regclass($1) relation', [name])).rows[0].relation));
    expect(await presence()).toEqual([null, null, null, null]);
    expect(current.sourceDisposition.b).toEqual({ version: 'intake-target-history-v1', bState: 'not_installed', historyState: 'unknown_not_installed', entries: [] });
    for (const name of bNames) {
      try { await rollbackProbe(`C15-partial-${name.replaceAll('.', '-')}`, async (c) => { await c.query(`CREATE TABLE ${name}(fixture_only boolean)`); }, 'associate_existing_item', { ...base }, { code: '23505', message: 'B_PROVIDER_REQUIRED' }); }
      finally { expect(await presence()).toEqual([null, null, null, null]); expect(await providerFact()).toEqual(providerBefore); }
      try { await rollbackProbe(`C15-partial-unknown-source-${name.replaceAll('.', '-')}`, async (c) => { await c.query(`CREATE TABLE ${name}(fixture_only boolean)`); }, 'confirm_new_item', { ...unlinkedConfirmation }, { code: '23505', message: 'B_PROVIDER_REQUIRED' }); }
      finally { expect(await presence()).toEqual([null, null, null, null]); expect(await providerFact()).toEqual(providerBefore); }
    }
    const stub = { version: 'intake-target-history-v1', bState: 'not_installed', historyState: 'unknown_not_installed', entries: [] };
    const malformed = [{ ...stub, version: 'wrong-version' }, { ...stub, bState: 'unexpected' },
      { version: stub.version, historyState: stub.historyState, entries: [] }, { ...stub, entries: {} },
      { ...stub, entries: [{ itemId: original122, status: 'confirmed' }] },
      { ...stub, bState: 'installed', entries: [null] }, { ...stub, bState: 'installed', entries: [{ itemId: original122, status: 'unsupported' }] },
      { ...stub, bState: 'installed', entries: [{ itemId: 'not-a-uuid', status: 'confirmed' }] }];
    for (const [index, value] of malformed.entries()) {
      try { await rollbackProbe(`C15-malformed-${index}`, (c) => installShim(c, value).then(() => undefined), 'associate_existing_item', { ...base }, { code: '23505', message: 'B_PROVIDER_REQUIRED' }); }
      finally { expect(await providerFact()).toEqual(providerBefore); }
    }
    for (const [status, target] of [['needs_review', reliableItem], ['suspended', reliableItem], ['withdrawn', reliableItem], ['confirmed', original122], ['withdrawn', null], ['confirmed', null]] as const) {
      const payload = { ...base }, response = { version: 'intake-target-history-v1', bState: 'installed', historyState: 'has_history', entries: [{ itemId: target, status, revision: 1, current: false }] };
      try {
        await rollbackProbe(`C14-${status}-${target ?? 'null'}`, async (c) => {
          await installShim(c, response); const o = await refresh(c, payload);
          expect(o.sourceDisposition.b.entries).toEqual(response.entries);
        }, 'associate_existing_item', payload, { code: '23505', message: 'SOURCE_DISPOSITION_CONFLICT' });
      } finally { expect(await providerFact()).toEqual(providerBefore); }
    }
    const safeBefore = await snapshot(), sameTargetClient = await owner.connect();
    try {
      await sameTargetClient.query('BEGIN');
      await installShim(sameTargetClient, { version: 'intake-target-history-v1', bState: 'installed', historyState: 'has_history', entries: [{ itemId: reliableItem, status: 'confirmed', revision: 1, current: false }] });
      await refresh(sameTargetClient, { ...base });
      const before = await snapshot(undefined, sameTargetClient);
      await sameTargetClient.query('SET LOCAL ROLE ice_p0_02_app_runner');
      const rid = randomUUID();
      const lawful = (await sameTargetClient.query('SELECT catalog.new_item_mutate($1,$2,$3,$4,$5::jsonb) result', [rid, A, 'associate_existing_item', hash(['iceos-new-item-request-v1', ADMIN, A, 'associate_existing_item', base]), JSON.stringify(base)])).rows[0].result;
      expect(lawful).toMatchObject({ itemId: reliableItem, associated: true, created: false });
      await sameTargetClient.query('RESET ROLE');
      const after = await snapshot(undefined, sameTargetClient);
      const beforeWithoutReceipt = { ...before, 'catalog.new_item_request': [] }, afterWithoutReceipt = { ...after, 'catalog.new_item_request': [] };
      expect(afterWithoutReceipt).toEqual(beforeWithoutReceipt);
      save('C14-lawful-same-target-provider-real-app.json', { result: lawful, onlyNoopReceiptAdded: true, actualAppRole: true, rollbackFixtureOnly: true });
    } finally { await sameTargetClient.query('ROLLBACK'); sameTargetClient.release(); }
    expect(await snapshot()).toEqual(safeBefore); expect(await providerFact()).toEqual(providerBefore);
    const actual = (await owner.query(`SELECT d.id,d.observation_id,d.review_state,d.selected_item_id,d.selected_jushuitan_ref FROM catalog.decision_evidence d WHERE d.entry_kind='candidate_snapshot' AND d.observation_id IS NOT NULL ORDER BY d.id`)).rows;
    const states = new Map<string, typeof actual[number]>();
    for (const row of actual) if (row.selected_item_id !== reliableItem && !states.has(row.review_state)) states.set(row.review_state, row);
    expect(states.has('manual_selected')).toBe(true);
    const source = (await owner.query(`SELECT r.current_contract_id,l.proof_id FROM catalog.source_record r JOIN catalog.observation_record_link l ON l.record_id=r.id WHERE r.id=$1 ORDER BY l.link_revision DESC LIMIT 1`, [reliableRecord])).rows[0];
    for (const [state, decision] of states) {
      const payload = { ...base };
      await rollbackProbe(`C11-real-frozen-${state}`, async (c) => {
        for (const [revision, status] of [[1, 'linked'], [2, 'revoked']] as const) await c.query(`INSERT INTO catalog.observation_record_link(observation_key,link_revision,previous_revision,scope_id,origin_kind,frozen_observation_id,identity_observation_id,record_id,contract_id,proof_id,status,frozen_decision_ids,reason,actor_id) VALUES($1,$2,$3,$4,'frozen',$5,NULL,$6,$7,$8,$9,$10,'ISOLATED historical guard only; always rollback',$11)`,
          [`frozen:${decision.observation_id}`, revision, revision === 1 ? null : 1, A, decision.observation_id, reliableRecord, source.current_contract_id, source.proof_id, status, [decision.id], ADMIN]);
        const o = await refresh(c, payload);
        expect(o.sourceDisposition.frozenDecisions).toContainEqual({ decisionId: decision.id, itemId: decision.selected_item_id, jushuitanRef: decision.selected_jushuitan_ref, reviewState: decision.review_state });
        expect((await c.query(`SELECT status FROM catalog.observation_record_link WHERE observation_key=$1 ORDER BY link_revision DESC LIMIT 1`, [`frozen:${decision.observation_id}`])).rows[0].status).toBe('revoked');
      }, 'associate_existing_item', payload, { code: '23505', message: 'SOURCE_DISPOSITION_CONFLICT' });
    }
    const lockClient = await owner.connect(), client = await app.connect(); let waitingProof: unknown, result: unknown;
    try {
      await lockClient.query('BEGIN'); await lockClient.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`, [ADMIN]);
      await lockClient.query('SELECT catalog.lock_source_disposition($1)', [reliableRecord]);
      const blocker = (await lockClient.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      await client.query('BEGIN'); await client.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`, [ADMIN]);
      const pid = (await client.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      const o = await observation(reliableRepeat), payload = { observationId: reliableRepeat, expectedClassificationRevision: o.classification!.revision,
        classification: 'external_sku', reviewState: 'proposed', proposedItemId: null, expectedItemRevision: null, proposedFieldKeys: [], expectedSourceSnapshot: sourceSnapshot(o), privateReason: 'Isolated shared308 lock test' };
      const request = randomUUID();
      const pending = client.query('SELECT catalog.new_item_mutate($1,$2,$3,$4,$5::jsonb) result', [request, A, 'classify_observation', hash(['iceos-new-item-request-v1', ADMIN, A, 'classify_observation', payload]), JSON.stringify(payload)]);
      const settled = pending.then((r) => ({ result: r.rows[0].result, error: null }), (e) => ({ result: null, error: e }));
      try {
        for (let n = 0; n < 100; n++) {
          const locks = (await owner.query(`SELECT pg_blocking_pids($1) blockers,EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted) waiting`, [pid])).rows[0];
          if (locks.waiting && locks.blockers.includes(blocker)) { waitingProof = { pid, blocker, ...locks }; break; }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(waitingProof).toBeDefined();
      } finally { await lockClient.query('ROLLBACK'); result = await settled; }
      expect((result as { error: unknown }).error).toBeNull(); await client.query('COMMIT');
    } finally { await lockClient.query('ROLLBACK'); await client.query('ROLLBACK'); lockClient.release(); client.release(); }
    expect(await providerFact()).toEqual(providerBefore); expect(await presence()).toEqual([null, null, null, null]);
    save('C11-C14-C15-provider-history-and-shared308.json', { providerBefore, providerBeforeSha256: hash(providerBefore), restoredSha256: hash(await providerFact()), actualFrozenStatesTested: [...states.keys()], waitingProof, result, BImplementationInstalled: false, rollbackFixturesOnly: true });
  });

  it('C12 version suspicion remains a historical guard after reclassification; no silent merge or duplicate code', async () => {
    const capture = await importCapture('a-version'), oid = capture.observations[0].id;
    const prior = await observation(oid);
    if (!prior.classification) await classify(oid, 'suspected_version');
    else if (prior.classification.classification !== 'suspected_version') await classify(oid, 'suspected_version');
    await classify(oid, 'new_item');
    const o = await observation(oid);
    expect(o.classificationHistory.some((row) => row.classification === 'suspected_version')).toBe(true);
    await rejectUnchanged('C12-reclass-does-not-clear-risk', () => confirmation(oid).then((p) => mutate('confirm_new_item', p)), { code: '23505', message: 'NEW_ITEM_REVIEW_REQUIRED' });
    const target = (await owner.query(`SELECT d.item_id,c.revision FROM catalog.new_item_decision d JOIN catalog.item_current c ON c.item_id=d.item_id WHERE d.item_id<>$1 ORDER BY d.recorded_at LIMIT 1`, [mainItem])).rows[0];
    await rejectUnchanged('C12-business-code-must-be-unique', () => mutate('assign_initial_code', { itemId: target.item_id, expectedRevision: target.revision, code: 'FIX-C127-001', privateReason: 'Isolated duplicate-code negative' }), { code: '23505' });
    save('C12-version-history-preserved.json', { observation: oid, history: o.classificationHistory, sameBarcodeNotIdentity: true, original127: mainItem, sourceDisposition: o.sourceDisposition });
  });

  it('C21 final exact baseline, 548 targets, all historical facts, WM prices and old public tables stay unchanged', async () => {
    expect(await snapshot(['public.product', 'public.product_variant', 'public.inventory'])).toEqual(initialPublic);
    expect(await snapshot(['catalog.decision_evidence', 'catalog.source_observation'])).toEqual(initialDecisions);
    expect((await owner.query('SELECT * FROM catalog.baseline_item_anchor ORDER BY json_pointer')).rows).toEqual(originalAnchors);
    const old122 = await catalogRepository.get(identity(), original122, 1);
    expect(old122?.iceCode).toBeNull();
    const money = await catalogRepository.amounts(identity(), wmId);
    expect(money?.cost.raw).toBe('5.18'); expect(money?.operatingPrice.raw).toBe('5.68');
    expect((await owner.query('SELECT financial_revision FROM catalog.item_current WHERE item_id=$1', [mainItem])).rows[0].financial_revision).toBeNull();
    save('C21-final-baseline-protection.json', { anchors: originalAnchors, baselineHistorySha256: hash(initialDecisions), publicThreeSha256: hash(initialPublic), old122, mainItem, WM0072: money, all548And6190And1417Unchanged: true, relationshipUsable: false, independentAcceptanceClaimed: false });
  });
});


