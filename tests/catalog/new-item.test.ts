import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { promises as fs, type Stats } from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '@/features/catalog/source-identity/key-codec';
import { PRODUCT_FIXTURE_PINS, assertProductTimes, isCanonicalUtcMicroseconds,
  parseProductFixtureManifest, prepareProductFixture, productCaptureAdoptionDigest } from '@/features/catalog/new-item/fixture-adapter';
import { appendNewItemRevisionSchema, associateExistingItemSchema, attachSourceIdentitySchema, classifyProductObservationSchema,
  confirmNewItemSchema, importProductCaptureSchema, prepareProductCaptureSchema, readNewItemSchema } from '@/features/catalog/new-item/schema';
import { confirmationPreview, projectAdoptedFields, projectSafeObservationFields } from '@/features/catalog/new-item/field-projection';
import type { CatalogItemDto, FieldObservation } from '@/features/catalog/types';
import type { NewItemWorkspaceDto, PreparedProductCapture, ProductObservationDto } from '@/features/catalog/new-item/types';
import { newItemIntent, newItemRepository } from '@/features/catalog/new-item/repository';
import * as authorization from '@/features/catalog/new-item/authorization';
import * as service from '@/features/catalog/new-item/service';
import * as evidenceStore from '@/features/catalog/evidence-store';
import { SOURCE_FIXTURE_PINS } from '@/features/catalog/source-identity/fixture-adapter';

const db = vi.hoisted(() => ({ run: vi.fn() }));
const server = vi.hoisted(() => ({ actor: vi.fn(), independent: vi.fn(() => false), revalidate: vi.fn() }));
vi.mock('@/lib/database/app-db', () => ({ withAppDb: db.run }));
vi.mock('@/lib/auth', () => ({ requireActiveAdmin: server.actor }));
vi.mock('@/lib/database/runtime', () => ({ isIndependentPlatformRuntime: server.independent }));
vi.mock('next/cache', () => ({ revalidatePath: server.revalidate }));

const scopeA = 'cccccccc-aaaa-4ccc-8aaa-cccccccccca1', scopeB = 'cccccccc-bbbb-4ccc-8bbb-ccccccccccb2';
const uuid = '11111111-1111-4111-8111-111111111199', uuid2 = '22222222-2222-4222-8222-222222222299';
const identity = { profileUserId: '11111111-1111-4111-8111-111111111101' };
const money = 'PRIVATE_AMOUNT_SENTINEL_9988.76', digest = 'a'.repeat(64);
const observed = (raw: string, evidenceRef = 'PRIVATE_SOURCE_REFERENCE'): FieldObservation => ({ state: 'observed', meaning: 'value', raw, evidenceRef });
const nonread = (): FieldObservation => ({ state: 'not_read', raw: null, reason: 'PRIVATE_REASON', evidenceRef: 'PRIVATE_REF' });
const observation = (): ProductObservationDto => ({ observationId: uuid, captureId: uuid2, recordPointer: '/rows/0', payloadSha256: digest,
  fields: { nameCn: observed('虚构新品'), specification: nonread(), factory: observed('0') }, position: { row: 1 },
  classification: { revision: 1, classification: 'new_item', reviewState: 'proposed', proposedItemId: null, expectedItemRevision: null },
  classificationHistory: [], currentSource: null, sourceDisposition: { sha256: digest }, sourceSlotPreview: null, origin: null });
const workspace = (): NewItemWorkspaceDto => ({ scope: { scopeId: scopeA, displayName: '虚构范围', system: 'bigseller', entityKind: 'product_record',
  scopeState: 'identity_ready', verificationEnvironment: 'fixture' }, permissions: { read: true, manage: true, publish: true, evidence: true, amount: true },
  captures: [], observations: [observation()], origins: [] });
const common = { requestId: uuid, scopeId: scopeA };
const associate = () => ({ ...common, observationId: uuid2, expectedClassificationRevision: 1, expectedSourceDisposition: digest,
  previewId: digest, privateReason: '明确复用', basis: { kind: 'source_slot' as const } });
const classification = () => ({ ...common, observationId: uuid2, expectedClassificationRevision: 0, classification: 'new_item' as const,
  reviewState: 'proposed' as const, proposedItemId: null, expectedItemRevision: null, proposedFieldKeys: [], expectedSourceSnapshot: null, privateReason: '明确分类' });
const fixtureFile = (name: string) => readFile(path.join(process.cwd(), 'tests/catalog/fixtures', name));
async function isolatedRuntimeFiles() {
  const sourceRoot = process.cwd(), runId = 'run-20261021T000000Z-abcdef12', runRoot = path.join(sourceRoot, '.local/catalog', runId), instanceRoot = path.join(runRoot, 'instance');
  const marker = Buffer.from(JSON.stringify({ runId, host: '127.0.0.1', port: 45999, dbName: 'fictional_gate_only', dataDir: path.join(instanceRoot, 'pgdata') }));
  const baseEnv = Buffer.from('{"fixture":"base-environment"}'), aEnv = Buffer.from('{"fixture":"source-identity-environment"}');
  const sqlPaths = ['db/catalog/001_catalog.sql', 'db/catalog/002_catalog_security.sql', 'db/catalog/003_source_identity.sql',
    'db/catalog/004_source_identity_security.sql', 'db/catalog/007_new_item_intake.sql', 'db/catalog/008_new_item_intake_security.sql'];
  const files = new Map<string, Buffer>(), sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const pins = await Promise.all(sqlPaths.map(async (relative) => { const bytes = await readFile(path.join(sourceRoot, relative)); files.set(path.join(sourceRoot, relative), bytes); return { path: relative, sha256: sha(bytes) }; }));
  const shared = { fixtureMode: 'fixture', nonceConsumed: true, nonceSha256: digest, runId, host: '127.0.0.1', port: 45999,
    database: 'fictional_gate_only', dataDir: path.join(instanceRoot, 'pgdata'), primaryMarkerSha256: sha(marker) };
  const aManifest = Buffer.from(JSON.stringify({ ...shared, label: 'catalog-source-identity-fixture-v1', baseEnvSha256: sha(baseEnv),
    fixturePins: SOURCE_FIXTURE_PINS, baseDdl: pins.slice(0, 2), sql: pins.slice(2, 4) }));
  const cManifest = Buffer.from(JSON.stringify({ ...shared, label: 'catalog-new-item-fixture-v1', baseEnvSha256: sha(aEnv),
    sourceIdentityManifestSha256: sha(aManifest), fixturePins: PRODUCT_FIXTURE_PINS, baseDdl: pins.slice(0, 4), sql: pins.slice(4) }));
  for (const [name, bytes] of [['catalog-instance.json', marker], ['env.catalog.json', baseEnv], ['env.catalog-source-identity.json', aEnv],
    ['source-identity-manifest.json', aManifest], ['new-item-manifest.json', cManifest]] as const) files.set(path.join(instanceRoot, name), bytes);
  for (const [name, value] of Object.entries({ CATALOG_SOURCE_ROOT: sourceRoot, CATALOG_RUN_ID: runId, CATALOG_RUN_ROOT: runRoot,
    CATALOG_EVIDENCE_ROOT: path.join(runRoot, 'private-evidence'), CATALOG_SOURCE_IDENTITY_ENABLED: 'true', CATALOG_SOURCE_IDENTITY_FIXTURE_RUN_ID: runId,
    CATALOG_SOURCE_IDENTITY_MANIFEST: path.join(instanceRoot, 'source-identity-manifest.json'), CATALOG_NEW_ITEM_ENABLED: 'true',
    CATALOG_NEW_ITEM_FIXTURE_RUN_ID: runId, CATALOG_NEW_ITEM_MANIFEST: path.join(instanceRoot, 'new-item-manifest.json') })) vi.stubEnv(name, value);
  const actualRead = fs.readFile.bind(fs), actualStat = fs.lstat.bind(fs);
  vi.spyOn(fs, 'readFile').mockImplementation((async (file: Parameters<typeof fs.readFile>[0], options?: unknown) => {
    const bytes = files.get(path.resolve(String(file)));
    if (bytes) return options === 'utf8' ? bytes.toString('utf8') : bytes;
    return actualRead(file, options as Parameters<typeof fs.readFile>[1]);
  }) as typeof fs.readFile);
  vi.spyOn(fs, 'lstat').mockImplementation((async (file: Parameters<typeof fs.lstat>[0]) => {
    const target = path.resolve(String(file));
    return target === runRoot || target.startsWith(runRoot + path.sep) ? { isSymbolicLink: () => false } as Stats : actualStat(file);
  }) as typeof fs.lstat);
  server.independent.mockReturnValue(true);
  return { files, instanceRoot };
}
beforeEach(() => { db.run.mockReset(); server.actor.mockReset(); server.independent.mockReturnValue(false); server.revalidate.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('new-item DTO boundaries', () => {
  it('imports only an approved ID plus frozen preview; rejects caller paths, scope, actor and prepared payload', () => {
    const valid = { requestId: uuid, approvedFixtureId: 'a-main', previewId: digest };
    expect(importProductCaptureSchema.parse(valid)).toEqual(valid);
    for (const extra of [{ scopeId: scopeB }, { actorId: uuid2 }, { storageHandle: 'aa/private' }, { payload: {} }, { sourceUrl: 'https://fixture.invalid' }]) {
      expect(importProductCaptureSchema.safeParse({ ...valid, ...extra }).success).toBe(false);
    }
    for (const approvedFixtureId of ['../a-main', 'https://example.test', 'A-MAIN', 'a/main']) expect(prepareProductCaptureSchema.safeParse({ approvedFixtureId }).success).toBe(false);
  });
  it('source_slot cannot carry a target, proof or source UUID while the proof branch requires its exact endpoints and CAS', () => {
    expect(associateExistingItemSchema.parse(associate()).basis).toEqual({ kind: 'source_slot' });
    for (const extra of [{ targetItemId: uuid }, { associationProofRef: { captureId: uuid, proofKey: 'made-up' } }, { sourceRecordId: uuid }]) {
      expect(associateExistingItemSchema.safeParse({ ...associate(), basis: { kind: 'source_slot', ...extra } }).success).toBe(false);
    }
    const proof = { kind: 'catalog_proof', basisAnchorOrOrigin: { kind: 'origin', originId: uuid }, associationProofRef: { captureId: uuid, proofKey: 'approved' }, targetItemId: uuid, expectedItemRevision: 1 };
    expect(associateExistingItemSchema.safeParse({ ...associate(), basis: proof }).success).toBe(true);
    const { expectedItemRevision: _revision, ...withoutCas } = proof; void _revision;
    expect(associateExistingItemSchema.safeParse({ ...associate(), basis: withoutCas }).success).toBe(false);
  });
  it('retains all four classifications and requires item-update target and version together', () => {
    for (const state of ['new_item', 'external_sku', 'suspected_version']) expect(classifyProductObservationSchema.safeParse({ ...classification(), classification: state }).success).toBe(true);
    expect(classifyProductObservationSchema.safeParse({ ...classification(), classification: 'item_update' }).success).toBe(false);
    expect(classifyProductObservationSchema.safeParse({ ...classification(), classification: 'item_update', proposedItemId: uuid, expectedItemRevision: 2 }).success).toBe(true);
    expect(classifyProductObservationSchema.safeParse({ ...classification(), proposedItemId: uuid }).success).toBe(false);
    expect(classifyProductObservationSchema.safeParse({ ...classification(), sourceRecordId: uuid }).success).toBe(false);
  });
  it('accepts missing code without inferring an SKU; rejects prices, images, duplicate adoption and arbitrary read projections', () => {
    const preview = confirmationPreview(scopeA, observation(), ['nameCn'], null);
    expect(confirmNewItemSchema.parse({ ...preview, requestId: uuid, privateReason: '确认' }).initialCode).toBeNull();
    expect(confirmNewItemSchema.safeParse({ ...preview, requestId: uuid, privateReason: '确认', adoptedFieldKeys: ['nameCn', 'nameCn'] }).success).toBe(false);
    for (const fields of [{ cost: observed('0') }, { imageRef: observed('https://fixture.invalid/private') }, {}]) {
      expect(appendNewItemRevisionSchema.safeParse({ ...common, itemId: uuid2, expectedRevision: 1, fields, privateReason: '修订' }).success).toBe(false);
    }
    expect(readNewItemSchema.safeParse({ scopeId: scopeA, projection: 'raw' }).success).toBe(false);
  });
  it('requires explicit original/current identity CAS for attach and rejects field-similarity claims', () => {
    const attach = { ...common, originId: uuid, observationId: uuid, itemId: uuid, expectedItemRevision: 1, sourceRecordId: uuid,
      expectedRecordRevision: 1, expectedClaimId: uuid, supportIdentityObservationId: uuid, expectedSourceDisposition: digest, associationProofRef: null, privateReason: '直接成员' };
    expect(attachSourceIdentitySchema.safeParse(attach).success).toBe(true);
    expect(attachSourceIdentitySchema.safeParse({ ...attach, verified: true }).success).toBe(false);
    const { expectedClaimId: _claim, ...missing } = attach; void _claim;
    expect(attachSourceIdentitySchema.safeParse(missing).success).toBe(false);
  });
});

describe('frozen bytes, projection and 20-member capture envelope', () => {
  it('pins all five approved files separately; imports never accept the bootstrap as product evidence', async () => {
    expect(Object.keys(PRODUCT_FIXTURE_PINS)).toHaveLength(5);
    for (const [name, pin] of Object.entries(PRODUCT_FIXTURE_PINS)) expect(createHash('sha256').update(await fixtureFile(name)).digest('hex')).toBe(pin);
    await expect(prepareProductFixture('new-item-bootstrap')).rejects.toThrow('PRODUCT_CAPTURE_PIN_CONFLICT');
    expect(() => parseProductFixtureManifest(Buffer.from('{}'))).toThrow('PRODUCT_CAPTURE_PIN_CONFLICT');
  });
  it('keeps the unresolved source in its own single-scope raw bytes without borrowing B proof or manufacturing identity', async () => {
    const { payload, bytes } = await prepareProductFixture('u-main');
    const raw = JSON.parse(bytes.toString()); expect(raw.scopeId).toBe('cccccccc-cccc-4ccc-8ccc-ccccccccccc3');
    expect(payload.scopeId).toBe(raw.scopeId); expect(payload.bytesSha256).toBe(PRODUCT_FIXTURE_PINS['new-item-scope-unresolved.json']);
    expect(payload.bytesSha256).not.toBe(PRODUCT_FIXTURE_PINS['new-item-scope-b.json']);
    expect(payload.associationProofs).toEqual([]); expect(payload.observations[0].fields.vendorRecordId.state).toBe('not_read');
    expect(payload.observations[0]).not.toHaveProperty('identity_observation_id');
  });
  it('preserves partial coverage and private raw amounts but creates no runtime IDs in the approved projection', async () => {
    const { payload, bytes } = await prepareProductFixture('a-main');
    expect(payload.coverage).toMatchObject({ complete: false, singleScope: true, images: 'references_only' });
    expect(bytes.toString()).toContain('N1C_PRIVATE_AMOUNT_17.231');
    expect(JSON.stringify(payload)).not.toContain('N1C_PRIVATE_AMOUNT_17.231');
    expect(payload.observations).toHaveLength(1); expect(payload).not.toHaveProperty('captureId');
    expect(payload.observations[0]).not.toHaveProperty('observationId');
    expect(payload.observations[0].fields.barcode).toMatchObject({ state: 'not_read', raw: null });
  });
  it('pins every observation payload and the whole approved projection, including proof endpoints', async () => {
    const bytes = await fixtureFile('new-item-fixture-manifest.json'), raw = JSON.parse(bytes.toString());
    expect(parseProductFixtureManifest(bytes).captures.length).toBeGreaterThanOrEqual(17);
    raw.captures[0].observations[0].fields.nameCn.raw = '改名';
    expect(() => parseProductFixtureManifest(Buffer.from(JSON.stringify(raw)), false)).toThrow('PRODUCT_CAPTURE_PIN_CONFLICT');
    const changed = JSON.parse(bytes.toString()); changed.captures[0].observations[0].observationId = uuid;
    expect(() => parseProductFixtureManifest(Buffer.from(JSON.stringify(changed)), false)).toThrow();
  });
  it('reliable-source repeat has no hidden extra proof; cross-batch no-ID association and later attach have distinct frozen proof semantics', async () => {
    const one = await prepareProductFixture('a-r1-first'), repeat = await prepareProductFixture('a-r1-repeat');
    expect(one.payload.associationProofs).toEqual([]); expect(repeat.payload.associationProofs).toEqual([]);
    expect(one.payload.observations[0].recordPointer).not.toBe(repeat.payload.observations[0].recordPointer);
    expect(one.payload.observations[0].fields.vendorRecordId).toMatchObject({ raw: 'N1C-STABLE-001' });
    expect(repeat.payload.observations[0].fields.vendorRecordId).toMatchObject({ raw: 'N1C-STABLE-001' });
    const association = await prepareProductFixture('a-proof-new'), attach = await prepareProductFixture('a-attach-proof');
    expect(association.payload.associationProofs[0].semantics).toBe('same_catalog_item');
    expect(attach.payload.associationProofs[0].semantics).toBe('same_source_record');
    expect(attach.payload.associationProofs[0].to.kind).toBe('identity_observation');
  });
  it('uses the full 20-member ordered envelope, independent of runtime DB IDs', async () => {
    const { payload: p } = await prepareProductFixture('a-main');
    const vector = ['iceos-product-capture-v2', p.approvedFixtureId, p.fixtureManifestId, p.fixtureManifestSha256, p.scopeId, p.captureKey,
      p.bytesSha256, p.sizeBytes, p.format, p.parserId, p.parserVersion, p.schemaVersion, p.coverage, p.projectionSha256, p.associationProofs,
      p.sourceAvailability, p.sourceEffectiveAt, p.documentAvailability, p.documentModifiedAt, p.collectedAt];
    expect(vector).toHaveLength(20);
    const independent = createHash('sha256').update(canonicalJson(vector)).digest('hex');
    expect(productCaptureAdoptionDigest(p)).toBe(independent); expect(p.adoptionDigest).toBe(independent);
    for (const patch of [{ approvedFixtureId: 'other' }, { fixtureManifestId: 'another' }, { fixtureManifestSha256: 'b'.repeat(64) },
      { captureKey: 'other' }, { collectedAt: '2026-10-20T14:00:01.654322Z' }, { sourceAvailability: 'known', sourceEffectiveAt: '2026-10-20T13:00:00.000001Z' },
      { documentModifiedAt: '2026-10-20T14:00:00.123457Z' }]) expect(productCaptureAdoptionDigest({ ...p, ...patch } as PreparedProductCapture)).not.toBe(independent);
  });
  it('requires real UTC six-microsecond dates and does not normalize invalid dates or availability/null pairs', async () => {
    expect(isCanonicalUtcMicroseconds('2026-10-20T14:00:01.654321Z')).toBe(true);
    expect(isCanonicalUtcMicroseconds('2024-02-29T00:00:00.000001Z')).toBe(true);
    for (const invalid of ['2026-02-29T00:00:00.000000Z', '2026-10-20T24:00:00.000000Z', '2026-10-20T14:00:01.123Z',
      '2026-10-20T14:00:01.123456+00:00', '2026-10-20T14:00:60.123456Z', 'infinity', null]) expect(isCanonicalUtcMicroseconds(invalid)).toBe(false);
    const { payload } = await prepareProductFixture('a-main');
    expect(() => assertProductTimes({ ...payload, sourceAvailability: 'known' })).toThrow('PRODUCT_CAPTURE_ENVELOPE_INVALID');
    expect(() => assertProductTimes({ ...payload, sourceEffectiveAt: payload.collectedAt })).toThrow('PRODUCT_CAPTURE_ENVELOPE_INVALID');
    expect(() => assertProductTimes({ ...payload, documentAvailability: 'not_observed' })).toThrow('PRODUCT_CAPTURE_ENVELOPE_INVALID');
  });
  it('uses the exact frozen known source time from raw evidence and keeps unobserved document time null', async () => {
    const { payload, bytes } = await prepareProductFixture('a-states'), raw = JSON.parse(bytes.toString());
    expect(payload.sourceAvailability).toBe('known'); expect(payload.sourceEffectiveAt).toBe('2026-10-20T13:59:59.000123Z');
    expect(raw.fixtureSourceTimes['a-states']).toBe(payload.sourceEffectiveAt);
    expect(payload.documentAvailability).toBe('not_observed'); expect(payload.documentModifiedAt).toBeNull();
  });
});

describe('safe and public field projection', () => {
  it('keeps zero, explicit empty, explicit null, no-text, not-read and parse-failed distinct', async () => {
    const { payload } = await prepareProductFixture('a-states'), fields = projectSafeObservationFields(payload.observations[0].fields, uuid);
    expect(fields.factory).toMatchObject({ state: 'observed', meaning: 'value', raw: '0' });
    expect(fields.barcode).toMatchObject({ state: 'observed', meaning: 'explicit_empty', raw: '' });
    expect(fields.specification).toMatchObject({ state: 'observed', meaning: 'explicit_null', raw: null });
    expect(fields.englishName.state).toBe('no_text'); expect(fields.sku.state).toBe('not_read'); expect(fields.packaging.state).toBe('parse_failed');
  });
  it('removes a monetary free-reason sentinel for EVERY state without changing private source objects', () => {
    const states = [observed('安全值'), { state: 'observed', meaning: 'explicit_empty', raw: '', evidenceRef: 'private' },
      { state: 'observed', meaning: 'explicit_null', raw: null, evidenceRef: 'private' }, { state: 'no_text', raw: null, evidenceRef: 'private' },
      { state: 'not_read', raw: null, evidenceRef: 'private' }, { state: 'parse_failed', raw: null, evidenceRef: 'private' }];
    for (const state of states) {
      const privateField = { ...state, reason: money, freeNote: money } as unknown as FieldObservation, input = { nameCn: privateField };
      const before = JSON.stringify(input), safe = projectSafeObservationFields(input, uuid), published = projectAdoptedFields(input, ['nameCn'], 'opaque-token');
      expect(JSON.stringify(safe)).not.toContain(money); expect(JSON.stringify(published)).not.toContain(money);
      expect(safe.nameCn.state).toBe(privateField.state); expect(published.nameCn.state).toBe(privateField.state);
      expect(JSON.stringify(input)).toBe(before);
    }
  });
  it('does not publish source references, account hints, unadopted fields or private image URLs', () => {
    const privateFields = { nameCn: observed('安全名称'), factory: observed('尚未采用'), imageRef: observed(`https://fixture.invalid/${money}`),
      privateReason: observed(money), cost: observed(money) };
    const safe = projectSafeObservationFields(privateFields, uuid), published = projectAdoptedFields(privateFields, ['nameCn'], 'opaque-token');
    expect(safe).not.toHaveProperty('cost'); expect(safe).not.toHaveProperty('privateReason');
    expect(JSON.stringify(safe)).not.toMatch(/PRIVATE_SOURCE_REFERENCE|https:\/\/|PRIVATE_AMOUNT_SENTINEL/);
    expect(published.factory).toMatchObject({ state: 'not_read', reason: 'FIELD_NOT_ADOPTED' });
    expect(published.imageRef).toMatchObject({ state: 'not_read', reason: 'IMAGE_NOT_PUBLISHED' });
    expect(published.nameCn.evidenceRef).toBe('catalog-pub:opaque-token#nameCn');
  });
  it('binds confirmation preview to current source, classification, disposition, adopted safe fields and code', () => {
    const o = observation(), original = confirmationPreview(scopeA, o, ['nameCn', 'factory'], null);
    expect(original.previewId).toBe(confirmationPreview(scopeA, o, ['factory', 'nameCn'], null).previewId);
    expect(confirmationPreview(scopeA, o, ['nameCn'], null).previewId).not.toBe(original.previewId);
    expect(confirmationPreview(scopeA, { ...o, currentSource: { recordId: uuid, revision: 2, claimId: uuid2 } }, ['nameCn', 'factory'], null).previewId).not.toBe(original.previewId);
    expect(confirmationPreview(scopeA, { ...o, sourceDisposition: { sha256: 'b'.repeat(64) } }, ['nameCn', 'factory'], null).previewId).not.toBe(original.previewId);
    expect(confirmationPreview(scopeA, o, ['nameCn', 'factory'], 'MANUAL-TEST').previewId).not.toBe(original.previewId);
    expect(() => confirmationPreview(scopeA, o, ['barcode'], null)).toThrow('NEW_ITEM_REVIEW_REQUIRED');
    expect(() => confirmationPreview(scopeA, { ...o, classification: null }, ['nameCn'], null)).toThrow('CLASSIFICATION_CONFLICT');
  });
});

describe('independent C request ledger and uncertain commit', () => {
  it('binds full intent to actor, scope, action and every payload/CAS field', () => {
    const payload = { itemId: uuid, expectedRevision: 1, code: 'TEST', privateReason: '原意图' };
    const first = newItemIntent(identity, scopeA, 'assign_initial_code', payload);
    expect(newItemIntent(identity, scopeA, 'assign_initial_code', { ...payload })).toBe(first);
    expect(newItemIntent({ profileUserId: uuid2 }, scopeA, 'assign_initial_code', payload)).not.toBe(first);
    expect(newItemIntent(identity, scopeB, 'assign_initial_code', payload)).not.toBe(first);
    expect(newItemIntent(identity, scopeA, 'append_nonprice_revision', payload)).not.toBe(first);
    expect(newItemIntent(identity, scopeA, 'assign_initial_code', { ...payload, expectedRevision: 2 })).not.toBe(first);
    expect(newItemIntent(identity, scopeA, 'assign_initial_code', { ...payload, privateReason: '改意图' })).not.toBe(first);
  });
  it('recovers a committed result after the outer COMMIT acknowledgment disappears, using only its exact current-authorized C receipt', async () => {
    const result = { itemId: uuid, revision: 1, created: true, relationshipUsable: false }, queries: { sql: string; args: unknown[] }[] = [];
    db.run.mockImplementationOnce(async (_actor, operation) => { await operation({ query: async (sql: string, args: unknown[]) => { queries.push({ sql, args }); return { rows: [{ result }] }; } }); throw Object.assign(new Error('lost commit ACK'), { code: 'ECONNRESET' }); });
    db.run.mockImplementationOnce(async (_actor, operation) => operation({ query: async (sql: string, args: unknown[]) => { queries.push({ sql, args }); return { rows: [{ result }] }; } }));
    await expect(newItemRepository.mutate(identity, uuid2, scopeA, 'confirm_new_item', { fixed: 'payload' })).resolves.toEqual(result);
    expect(queries.map((entry) => entry.sql)).toEqual(['SELECT catalog.new_item_mutate($1,$2,$3,$4,$5::jsonb) AS result', 'SELECT catalog.new_item_receipt($1,$2,$3,$4) AS result']);
    expect(queries[1].args).toEqual(queries[0].args.slice(0, 4));
    expect(db.run.mock.calls.every(([actor]) => actor === identity)).toBe(true);
  });
  it('preserves unknown when receipt permission is revoked after a transport failure and never falls back to global audit', async () => {
    db.run.mockRejectedValueOnce(Object.assign(new Error('database shutdown'), { code: '57P01' })).mockRejectedValueOnce(Object.assign(new Error('denied'), { code: '42501' }));
    await expect(newItemRepository.mutate(identity, uuid, scopeA, 'assign_initial_code', {})).rejects.toThrow('REQUEST_OUTCOME_UNKNOWN');
    expect(db.run).toHaveBeenCalledTimes(2);
  });
  it('does not relabel a known domain conflict as unknown just because the own receipt is empty', async () => {
    db.run.mockRejectedValueOnce(Object.assign(new Error('SOURCE_DISPOSITION_CONFLICT'), { code: '40001' }));
    db.run.mockImplementationOnce(async (_actor, operation) => operation({ query: async () => ({ rows: [{ result: null }] }) }));
    await expect(newItemRepository.mutate(identity, uuid, scopeA, 'confirm_new_item', {})).rejects.toThrow('SOURCE_DISPOSITION_CONFLICT');
  });
});

describe('server authorization, import and recovery boundaries', () => {
  it('admits the exact C→A environment→base environment chain without a SQL query', async () => {
    await isolatedRuntimeFiles(); await expect(authorization.assertNewItemFixtureRuntime()).resolves.toBeUndefined();
    expect(db.run).not.toHaveBeenCalled(); expect(server.actor).not.toHaveBeenCalled();
  });
  it('rejects a changed A environment at C admission and a changed original base environment at prior A admission', async () => {
    const fixture = await isolatedRuntimeFiles(), aFile = path.join(fixture.instanceRoot, 'env.catalog-source-identity.json'), original = fixture.files.get(aFile)!;
    fixture.files.set(aFile, Buffer.from('{"fixture":"changed-A-environment"}'));
    await expect(authorization.assertNewItemFixtureRuntime()).rejects.toThrow('NEW_ITEM_FIXTURE_RUNTIME_DENIED');
    fixture.files.set(aFile, original); fixture.files.set(path.join(fixture.instanceRoot, 'env.catalog.json'), Buffer.from('{"fixture":"changed-base-environment"}'));
    await expect(authorization.assertNewItemFixtureRuntime()).rejects.toThrow('IDENTITY_FIXTURE_RUNTIME_DENIED');
    expect(db.run).not.toHaveBeenCalled(); expect(server.actor).not.toHaveBeenCalled();
  });
  it('does not query any C table or read private state while the module is disabled', async () => {
    vi.stubEnv('CATALOG_NEW_ITEM_ENABLED', 'false'); server.independent.mockReturnValue(true);
    expect(await service.getNewItemWorkspace()).toEqual({ enabled: false, scopes: [], scopeId: null, workspace: null, fixtures: [], catalogProofOptions: [], attachOptions: [] });
    expect(await service.getNewItemWriteContext(uuid)).toBeNull(); expect(db.run).not.toHaveBeenCalled(); expect(server.actor).not.toHaveBeenCalled();
  });
  it('denies incompatible old runtime before authentication or SQL even when a caller forges the new enable flag', async () => {
    vi.stubEnv('CATALOG_NEW_ITEM_ENABLED', 'true'); vi.stubEnv('CATALOG_RUN_ID', 'run-20261020T000000Z-aaaaaaaa'); vi.stubEnv('CATALOG_NEW_ITEM_FIXTURE_RUN_ID', 'run-20261020T000000Z-aaaaaaaa');
    await expect(authorization.requireNewItemActor()).rejects.toThrow('NEW_ITEM_MODULE_DISABLED');
    expect(db.run).not.toHaveBeenCalled(); expect(server.actor).not.toHaveBeenCalled();
  });
  it('re-reads and compares the frozen import preview before storing bytes or mutating the database', async () => {
    vi.spyOn(authorization, 'requireNewItemActor').mockResolvedValue(identity); vi.spyOn(newItemRepository, 'read').mockResolvedValue(workspace());
    const store = vi.spyOn(evidenceStore, 'storePrivateArtifact'), mutate = vi.spyOn(newItemRepository, 'mutate');
    await expect(service.importProductCapture({ requestId: uuid, approvedFixtureId: 'a-main', previewId: 'b'.repeat(64) })).rejects.toThrow('PRODUCT_CAPTURE_PIN_CONFLICT');
    expect(store).not.toHaveBeenCalled(); expect(mutate).not.toHaveBeenCalled();
  });
  it('a read-only scope cannot import, and a manager without publish cannot prepare a new item', async () => {
    vi.spyOn(authorization, 'requireNewItemActor').mockResolvedValue(identity); const w = workspace(); w.permissions.manage = false;
    vi.spyOn(newItemRepository, 'read').mockResolvedValue(w); const store = vi.spyOn(evidenceStore, 'storePrivateArtifact');
    await expect(service.prepareProductCapture({ approvedFixtureId: 'a-main' })).rejects.toThrow('NEW_ITEM_FORBIDDEN');
    w.permissions.manage = true; w.permissions.publish = false;
    await expect(service.prepareNewItemConfirmation({ scopeId: scopeA, observationId: uuid, adoptedFieldKeys: ['nameCn'], initialCode: null })).rejects.toThrow('NEW_ITEM_FORBIDDEN');
    expect(store).not.toHaveBeenCalled();
  });
  it('independent import recovery reconstructs the same intent from fixed bytes without storing bytes or executing another write', async () => {
    vi.spyOn(authorization, 'requireNewItemActor').mockResolvedValue(identity); vi.spyOn(newItemRepository, 'read').mockResolvedValue(workspace());
    const { payload } = await prepareProductFixture('a-main'), store = vi.spyOn(evidenceStore, 'storePrivateArtifact'), mutate = vi.spyOn(newItemRepository, 'mutate');
    const receipt = vi.spyOn(newItemRepository, 'receipt').mockResolvedValue(null);
    const input = { requestId: uuid, approvedFixtureId: 'a-main', previewId: payload.adoptionDigest };
    expect(await service.recoverNewItemRequest({ action: 'import_product_capture', input })).toBeNull();
    const expected = { ...payload, storageHandle: `${payload.bytesSha256.slice(0, 2)}/${payload.bytesSha256}` };
    expect(receipt).toHaveBeenCalledWith(identity, uuid, scopeA, 'import_product_capture', newItemIntent(identity, scopeA, 'import_product_capture', expected));
    expect(store).not.toHaveBeenCalled(); expect(mutate).not.toHaveBeenCalled();
    await expect(service.recoverNewItemRequest({ action: 'import_product_capture', input, intent: digest })).rejects.toThrow();
  });
  it('raw denial happens before filesystem access while safe export has a separate read-only RPC with no raw dependency', async () => {
    vi.spyOn(authorization, 'requireNewItemActor').mockResolvedValue(identity);
    vi.spyOn(newItemRepository, 'evidence').mockRejectedValue(new Error('NEW_ITEM_FORBIDDEN'));
    const read = vi.spyOn(evidenceStore, 'readPrivateArtifact');
    await expect(service.getProductEvidence(uuid)).rejects.toThrow('NEW_ITEM_FORBIDDEN'); expect(read).not.toHaveBeenCalled();
    const safe = { projection: 'safe', scopeId: scopeA, observations: [] };
    vi.spyOn(newItemRepository, 'evidenceExport').mockResolvedValue(safe);
    await expect(service.getProductEvidenceExport(uuid)).resolves.toEqual(safe); expect(read).not.toHaveBeenCalled();
  });
  it('sensitive history calls only the scoped sensitive RPC and fails closed on current permission denial', async () => {
    vi.spyOn(authorization, 'requireNewItemActor').mockResolvedValue(identity);
    const history = vi.spyOn(newItemRepository, 'history').mockRejectedValue(new Error('NEW_ITEM_FORBIDDEN'));
    await expect(service.readNewItemSensitiveHistory({ scopeId: scopeA, projection: 'sensitive_history' })).rejects.toThrow('NEW_ITEM_FORBIDDEN');
    expect(history).toHaveBeenCalledWith(identity, scopeA, null);
    await expect(service.readNewItemSensitiveHistory({ scopeId: scopeA, projection: 'safe' })).rejects.toThrow('NEW_ITEM_FORBIDDEN');
    expect(history).toHaveBeenCalledTimes(1);
  });
  it('does not treat a price/image patch as an ordinary shared non-price revision', async () => {
    vi.spyOn(authorization, 'requireNewItemActor').mockResolvedValue(identity); const mutate = vi.spyOn(newItemRepository, 'mutate');
    const patch = { ...common, itemId: uuid2, expectedRevision: 1, privateReason: '修订' };
    await expect(service.appendNewItemRevision({ ...patch, fields: { imageRef: observed('private') } })).rejects.toThrow('IMAGE_PUBLICATION_NOT_IMPLEMENTED');
    await expect(service.appendNewItemRevision({ ...patch, fields: { cost: observed('0') } })).rejects.toThrow(); expect(mutate).not.toHaveBeenCalled();
  });
  it('candidate systems progress independently and only use currently readable scopes with actual external SKU values', async () => {
    vi.spyOn(authorization, 'newItemEnabled').mockReturnValue(true); vi.spyOn(authorization, 'requireNewItemActor').mockResolvedValue(identity);
    const w = workspace(), candidate = observation(); candidate.fields = { nameCn: observed('虚构新品'), sku: observed('EXTERNAL-SKU') }; w.observations = [candidate];
    vi.spyOn(newItemRepository, 'scopes').mockResolvedValue([w.scope]); vi.spyOn(newItemRepository, 'read').mockResolvedValue(w);
    const item: CatalogItemDto = { itemId: uuid2, revision: 1, iceCode: null, codeState: 'awaiting_code', newProductConfirmed: true, nameCn: '虚构新品',
      specification: nonread(), barcodeRefs: [], fields: {}, humanChoices: { bigseller: 0, jushuitan: 0 }, sourceRecordId: null, sourceIdentityVerified: false, relationshipUsable: false, provenanceRefs: [] };
    let panel = await service.getNewItemDetailPanel(item); expect(panel.candidates.bigseller).toHaveLength(1); expect(panel.candidates.jushuitan).toEqual([]);
    w.scope.system = 'jushuitan'; panel = await service.getNewItemDetailPanel(item); expect(panel.candidates.jushuitan).toHaveLength(1); expect(panel.candidates.bigseller).toEqual([]);
    candidate.fields.sku = nonread(); panel = await service.getNewItemDetailPanel(item); expect(panel.candidates.jushuitan).toEqual([]);
    expect(panel.canWrite).toBe(false);
  });
});

describe('safe Action responses', () => {
  it('keeps a known committed result successful even if UI cache invalidation fails', async () => {
    const actions = await import('@/features/catalog/new-item/actions'), result = { itemId: uuid, revision: 2, relationshipUsable: false as const };
    vi.spyOn(service, 'assignNewItemCode').mockResolvedValue(result); server.revalidate.mockImplementation(() => { throw new Error('cache unavailable'); });
    expect(await actions.assignNewItemCodeAction({})).toEqual({ success: true, data: result });
  });
  it('uses static safe codes/messages, marks unknown explicitly and never echoes SQL financial detail', async () => {
    const actions = await import('@/features/catalog/new-item/actions'), operation = vi.spyOn(service, 'confirmNewItem');
    operation.mockRejectedValueOnce(new Error(`SQL DETAIL ${money} /private/handle`));
    const denied = await actions.confirmNewItemAction({}); expect(denied.success).toBe(false); expect(JSON.stringify(denied)).not.toMatch(/PRIVATE_AMOUNT|SQL DETAIL|private\/handle/);
    operation.mockRejectedValueOnce(new Error('SOURCE_DISPOSITION_CONFLICT'));
    expect(await actions.confirmNewItemAction({})).toMatchObject({ success: false, code: 'SOURCE_DISPOSITION_CONFLICT' });
    operation.mockRejectedValueOnce(new Error('REQUEST_OUTCOME_UNKNOWN'));
    expect(await actions.confirmNewItemAction({})).toMatchObject({ success: false, outcome: 'unknown', code: 'REQUEST_OUTCOME_UNKNOWN' });
  });
});
