import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { captureAdoptionDigest, digest, encodeRecordKey, encodeScope } from '@/features/catalog/source-identity/key-codec';
import { importSourceFixtureCaptureSchema, prepareSourceFixtureCaptureSchema, registerSourceIdentitySchema, observationFieldSchema,
  identityContextSchema, scopeIdentitySchema, reviseSourceIdentitySchema, linkSourceObservationSchema } from '@/features/catalog/source-identity/schema';
import { FIXTURE_SCOPE_A, FIXTURE_SCOPE_B, SOURCE_FIXTURE_DIRECTORY, SOURCE_FIXTURE_MANIFEST, SOURCE_FIXTURE_PINS,
  parseSourceFixtureBytes, sourceFixtureManifest } from '@/features/catalog/source-identity/fixture-adapter';
import type { ObservationField, ScopeIdentityInput } from '@/features/catalog/source-identity/types';
import type { IdentityWorkspaceDto } from '@/features/catalog/source-identity/types';

const db = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('@/lib/database/app-db', () => ({ withAppDb: db.run }));
const server = vi.hoisted(() => ({ actor: vi.fn(), independent: vi.fn(() => false) }));
vi.mock('@/lib/auth', () => ({ requireActiveAdmin: server.actor }));
vi.mock('@/lib/database/runtime', () => ({ isIndependentPlatformRuntime: server.independent }));

const identity = { profileUserId: '11111111-1111-4111-8111-111111111101' };
const uuid = '11111111-1111-4111-8111-111111111199';
const value = (raw: string): ObservationField => ({ state: 'value', value: raw, evidenceRef: 'fixture:field' });
const fileBytes = (name: string) => readFile(path.join(SOURCE_FIXTURE_DIRECTORY, name));
const scope = (): ScopeIdentityInput => ({ system: 'bigseller', entityKind: 'product_record', accountKind: 'fixture_account', accountParts: ['000Account'],
  resourceKind: 'fixture_dataset', resourceParts: ['Dataset-A'], marketRole: 'context', marketIdentity: null, warehouseRole: 'context', warehouseIdentity: null });
afterEach(() => vi.restoreAllMocks());

describe('fixed, single-scope fixture projection', () => {
  it('pins all four files while the grant configuration is not readable product evidence', async () => {
    for (const [name, sha] of Object.entries(SOURCE_FIXTURE_PINS)) expect(digest(await fileBytes(name))).toBe(sha);
    expect(() => sourceFixtureManifest('scope-grants.fixture')).toThrow('IDENTITY_FIXTURE_NOT_ALLOWED');
    for (const file of ['../products-v1', 'https://example.test', '/tmp/input', 'Products-v1']) expect(() => sourceFixtureManifest(file)).toThrow('IDENTITY_FIXTURE_NOT_ALLOWED');
  });
  it('previews one known scope and never routes a fixture by caller-supplied scope or capture key', async () => {
    const parsed = parseSourceFixtureBytes('products-v1', await fileBytes('products-v1.json'));
    expect(parsed.scopeId).toBe(FIXTURE_SCOPE_A); expect(parsed.capture.observations).toHaveLength(3);
    expect(parsed.capture.coverage).toMatchObject({ singleScope: true, verificationEnvironment: 'fixture' });
    expect(prepareSourceFixtureCaptureSchema.safeParse({ fixtureId: 'products-v1', scopeId: FIXTURE_SCOPE_B }).success).toBe(false);
    expect(importSourceFixtureCaptureSchema.safeParse({ fixtureId: 'products-v1', previewId: 'a'.repeat(64), requestId: uuid, captureKey: 'another' }).success).toBe(false);
    expect(importSourceFixtureCaptureSchema.safeParse({ fixtureId: 'products-v1', previewId: 'a'.repeat(64), requestId: uuid, actor: identity.profileUserId }).success).toBe(false);
  });
  it('keeps raw money private and strips it from every normalized observation', async () => {
    for (const [fixtureId, manifest] of Object.entries(SOURCE_FIXTURE_MANIFEST)) {
      const bytes = await fileBytes(manifest.file), parsed = parseSourceFixtureBytes(fixtureId, bytes);
      expect(bytes.toString()).toContain('costPriceRaw');
      expect(JSON.stringify(parsed.capture)).not.toMatch(/costPriceRaw|9988\.17|8877\.26|7766\.35|6655\.44|5544\.53/);
      for (const observation of parsed.capture.observations) expect(Object.keys(observation.fields)).toEqual(['vendorRecordId', 'sku', 'name', 'barcode']);
    }
  });
  it('includes pinned proof semantics in the actual capture payload used by import and later fresh-proof reverify', async () => {
    const fixtures = await import('@/features/catalog/source-identity/fixture-adapter');
    const store = await import('@/features/catalog/evidence-store');
    vi.spyOn(store, 'storePrivateArtifact').mockResolvedValue({ logicalName: 'products-reordered-v2.json', sha256: 'a'.repeat(64), size: 1,
      format: 'json', sensitivity: 'restricted', storageHandle: `aa/${'a'.repeat(64)}` });
    const prepared = await fixtures.prepareSourceFixtureCapture('products-reordered-v2');
    expect(prepared.capture.proofSemantics).toEqual({ uniqueness: true, stability: true, keyChange: true, reuse: true, oldObservationCompatible: true });
    expect(JSON.parse(JSON.stringify(prepared.capture)).proofSemantics.stability).toBe(true);
  });
  it('retains missing stable ID as an observation; does not manufacture a record or fake CN/warehouse', async () => {
    const parsed = parseSourceFixtureBytes('products-v1', await fileBytes('products-v1.json'));
    expect(parsed.capture.observations[2].fields.vendorRecordId).toMatchObject({ state: 'empty', value: null });
    for (const observation of parsed.capture.observations) expect(observation.marketContext).toMatchObject({ state: 'unknown', raw: null });
    expect(JSON.stringify(parsed.capture)).not.toMatch(/sourceRecordId|relationshipUsable|"CN"|inventory|quantity/);
  });
  it('retains observed string zero while invalid numeric IDs become failures rather than zero or missing', async () => {
    const raw = JSON.parse((await fileBytes('products-v1.json')).toString());
    raw.records[0].sku = '0'; raw.records[1].sku = 0;
    const projected = parseSourceFixtureBytes('products-v1', Buffer.from(JSON.stringify(raw)), false).capture.observations;
    expect(projected[0].fields.sku).toMatchObject({ state: 'value', value: '0' });
    expect(projected[1].fields.sku).toMatchObject({ state: 'parse_failed', value: null, reason: 'SOURCE_IDENTIFIER_TYPE_INVALID' });
    expect(projected[2].fields.vendorRecordId).toMatchObject({ state: 'empty', value: null });
  });
  it('retains row reorder, original positions and separate nonidentity context observations', async () => {
    const first = parseSourceFixtureBytes('products-v1', await fileBytes('products-v1.json'));
    const second = parseSourceFixtureBytes('products-reordered-v2', await fileBytes('products-reordered-v2.json'));
    expect(first.scopeId).toBe(second.scopeId); expect(first.capture.contractId).toBe(second.capture.contractId);
    const one = first.capture.observations.find((record) => record.fields.vendorRecordId.state === 'value' && record.fields.vendorRecordId.value === 'fixture-vendor-001')!;
    const two = second.capture.observations.find((record) => record.fields.vendorRecordId.state === 'value' && record.fields.vendorRecordId.value === 'fixture-vendor-001')!;
    expect(one.position.row).toBe(1); expect(two.position.row).toBe(2); expect(one.observationId).not.toBe(two.observationId);
    expect(one.warehouseContext.state).toBe('unknown'); expect(two.warehouseContext).toMatchObject({ state: 'known', raw: 'FIXTURE-WAREHOUSE-A' });
    const key = (fields: Record<string, ObservationField>) => encodeRecordKey({ scopeId: first.scopeId, entityKind: 'product_record', contractRevision: 1,
      strategy: 'vendor_stable_id', keyFields: ['vendorRecordId'], fields }).canonical;
    expect(key(one.fields)).toBe(key(two.fields)); expect(encodeScope(scope()).canonical).toBe(encodeScope(scope()).canonical);
  });
  it('keeps reliable business keys independent of same vendor ID in another account and does not deduplicate conflicts', async () => {
    const a = parseSourceFixtureBytes('products-v1', await fileBytes('products-v1.json'));
    const b = parseSourceFixtureBytes('products-conflicts-v3', await fileBytes('products-conflicts-v3.json'));
    expect(b.scopeId).toBe(FIXTURE_SCOPE_B); expect(a.scopeId).not.toBe(b.scopeId);
    expect(a.capture.observations[0].fields.sku).toMatchObject({ value: '780103214060' });
    expect(b.capture.observations[0].fields.sku).toMatchObject({ value: '780103214060' });
    expect(b.capture.observations.filter((record) => record.fields.sku.state === 'value' && record.fields.sku.value === 'FIXTURE-DUPLICATE-B')).toHaveLength(2);
    expect(new Set(b.capture.observations.map((record) => record.observationId)).size).toBe(3);
  });
  it('rejects changed pins and rejects a mixed-account/scope raw file as a whole', async () => {
    const bytes = await fileBytes('products-v1.json');
    expect(() => parseSourceFixtureBytes('products-v1', Buffer.from('{}'))).toThrow('IDENTITY_FIXTURE_PIN_MISMATCH');
    const wrongScope = JSON.parse(bytes.toString()); wrongScope.scopeId = FIXTURE_SCOPE_B;
    expect(() => parseSourceFixtureBytes('products-v1', Buffer.from(JSON.stringify(wrongScope)), false)).toThrow('IDENTITY_MIXED_SCOPE_FIXTURE_DENIED');
    const mixedRow = JSON.parse(bytes.toString()); mixedRow.records[0].accountId = 'FIXTURE-ACCOUNT-B';
    expect(() => parseSourceFixtureBytes('products-v1', Buffer.from(JSON.stringify(mixedRow)), false)).toThrow();
    const mixedContainer = JSON.parse(bytes.toString()); mixedContainer.scopes = [FIXTURE_SCOPE_A, FIXTURE_SCOPE_B];
    expect(() => parseSourceFixtureBytes('products-v1', Buffer.from(JSON.stringify(mixedContainer)), false)).toThrow();
  });
  it('binds a capture to bytes, parser, contract revision, scope, coverage and canonical projection', async () => {
    const parsed = parseSourceFixtureBytes('products-v1', await fileBytes('products-v1.json'));
    const capture = parsed.capture, inputs = { ...capture, scopeId: parsed.scopeId };
    expect(captureAdoptionDigest(inputs)).toBe(capture.adoptionDigest);
    for (const changed of [{ parserVersion: '2' }, { contractRevision: 2 }, { scopeId: FIXTURE_SCOPE_B }, { projectionSha256: 'f'.repeat(64) }, { coverage: { complete: false } }]) {
      expect(captureAdoptionDigest({ ...inputs, ...changed })).not.toBe(capture.adoptionDigest);
    }
  });
});

describe('opaque scope and record key contracts', () => {
  it('implements exactly seven scope tuple components independent of proof/contract/context updates', () => {
    const encoded = encodeScope(scope()), parts = JSON.parse(encoded.canonical);
    expect(parts).toEqual(['iceos-source-scope-v1', 'bigseller', 'product_record', ['account', 'fixture_account', ['000Account']],
      ['resource', 'fixture_dataset', ['Dataset-A']], ['market', 'context', null], ['warehouse', 'context', null]]);
    expect(parts).toHaveLength(7); expect(encoded.sha256).toBe(digest(encoded.canonical));
    expect(scopeIdentitySchema.safeParse({ ...scope(), proofId: uuid }).success).toBe(false);
    expect(scopeIdentitySchema.safeParse({ ...scope(), contractRevision: 2 }).success).toBe(false);
  });
  it('preserves leading zero, case and Unicode instead of trimming or normalizing identities', () => {
    const original = encodeScope(scope()).canonical;
    for (const account of ['Account', '000account', '０００Account']) expect(encodeScope({ ...scope(), accountParts: [account] }).canonical).not.toBe(original);
    expect(scopeIdentitySchema.safeParse({ ...scope(), accountParts: [' 000Account'] }).success).toBe(false);
    expect(scopeIdentitySchema.safeParse({ ...scope(), accountParts: [''] }).success).toBe(false);
    expect(scopeIdentitySchema.safeParse({ ...scope(), resourceParts: ['Dataset', 'wrong'] }).success).toBe(false);
  });
  it('requires identity values and never treats context as not-applicable or an unknown wildcard', () => {
    expect(scopeIdentitySchema.safeParse({ ...scope(), warehouseRole: 'identity', warehouseIdentity: null }).success).toBe(false);
    expect(scopeIdentitySchema.safeParse({ ...scope(), warehouseIdentity: 'W1' }).success).toBe(false);
    const w1 = encodeScope({ ...scope(), warehouseRole: 'identity', warehouseIdentity: 'W1' });
    const w2 = encodeScope({ ...scope(), warehouseRole: 'identity', warehouseIdentity: 'W2' }); expect(w1.canonical).not.toBe(w2.canonical);
    expect(identityContextSchema.safeParse({ state: 'unknown', raw: 'CN', reason: 'fake' }).success).toBe(false);
    expect(identityContextSchema.safeParse({ state: 'not_applicable', raw: null }).success).toBe(false);
  });
  it('uses contract key field order and a cross-revision reserved-key domain', () => {
    const fields = { sku: value('001A'), style: value('a:b') };
    const base = { scopeId: FIXTURE_SCOPE_A, entityKind: 'product_record' as const, contractRevision: 1,
      strategy: 'scoped_business_key' as const, keyFields: ['sku', 'style'], fields };
    const first = encodeRecordKey(base), reordered = encodeRecordKey({ ...base, contractRevision: 2, keyFields: ['style', 'sku'] });
    expect(first.canonical).not.toBe(reordered.canonical); expect(first.domain).toBe(reordered.domain);
    expect(encodeRecordKey({ ...base, fields: { style: fields.style, sku: fields.sku } }).canonical).toBe(first.canonical);
    expect(encodeRecordKey({ ...base, scopeId: FIXTURE_SCOPE_B }).canonical).not.toBe(first.canonical);
    expect(() => encodeRecordKey({ ...base, fields: { ...fields, sku: { state: 'empty', value: null, evidenceRef: 'fixture' } } })).toThrow('KEY_FIELD_NOT_OBSERVED');
  });
  it('rejects oversized canonical keys instead of truncating', () => {
    expect(() => encodeRecordKey({ scopeId: FIXTURE_SCOPE_A, entityKind: 'product_record', contractRevision: 1, strategy: 'scoped_business_key',
      keyFields: ['a', 'b', 'c', 'd'], fields: { a: value('a'.repeat(490)), b: value('b'.repeat(490)), c: value('c'.repeat(490)), d: value('d'.repeat(490)) } })).toThrow('IDENTITY_KEY_TOO_LONG');
  });
  it.each([
    { state: 'value', value: '0', evidenceRef: 'e' }, { state: 'empty', value: null, evidenceRef: 'e' },
    { state: 'not_observed', value: null, reason: 'NOT_READ', evidenceRef: 'e' }, { state: 'parse_failed', value: null, reason: 'TYPE_INVALID', evidenceRef: 'e' },
  ])('strictly preserves value/empty/not-observed/failure %#', (input) => expect(observationFieldSchema.parse(input)).toEqual(input));
  it.each([
    { state: 'value', value: '' }, { state: 'value', value: null }, { state: 'empty', value: '0' },
    { state: 'not_observed', value: '0', reason: 'x' }, { state: 'parse_failed', value: null }, { state: 'empty', value: null, raw: 'cost' },
  ])('rejects crossing field states %#', (input) => expect(observationFieldSchema.safeParse({ ...input, evidenceRef: 'e' }).success).toBe(false));
});

describe('controlled request schemas and scoped receipt recovery', () => {
  beforeEach(() => { db.run.mockReset(); server.actor.mockReset(); server.independent.mockReturnValue(false); });
  it('requires explicit CAS/fresh-proof fields and rejects injected actor/verified/prepared payload', () => {
    const register = { requestId: uuid, scopeId: FIXTURE_SCOPE_A, contractId: uuid, observationId: uuid, proofId: uuid, expectedMatch: { kind: 'none' }, reason: 'fixture' };
    expect(registerSourceIdentitySchema.parse(register)).toEqual(register);
    for (const extra of [{ actor: uuid }, { verified: true }, { relationshipUsable: true }, { canonicalKey: 'fake' }, { prepared: {} }]) expect(registerSourceIdentitySchema.safeParse({ ...register, ...extra }).success).toBe(false);
    expect(reviseSourceIdentitySchema.safeParse({ requestId: uuid, scopeId: FIXTURE_SCOPE_A, recordId: uuid, expectedRecordRevision: 1, command: 'reverify', proofId: uuid, reason: 'fixture' }).success).toBe(false);
    expect(linkSourceObservationSchema.safeParse({ requestId: uuid, scopeId: FIXTURE_SCOPE_A, recordId: uuid, operation: 'link', expectedRecordRevision: null,
      expectedLinkRevision: 0, origin: { kind: 'frozen', id: uuid }, proofId: uuid, reason: 'fixture' }).success).toBe(false);
  });
  it.each([undefined, null])('rejects absent/NULL lifecycle commands and link operations before transport (%s)', (operation) => {
    const common = { requestId: uuid, scopeId: FIXTURE_SCOPE_A, recordId: uuid, expectedRecordRevision: 4, proofId: uuid, reason: 'explicit correction' };
    expect(reviseSourceIdentitySchema.safeParse({ ...common, command: operation }).success).toBe(false);
    expect(linkSourceObservationSchema.safeParse({ ...common, operation, expectedLinkRevision: 1, origin: { kind: 'identity', id: uuid } }).success).toBe(false);
  });
  it('does not query any new table or auth profile while the N1 module is disabled', async () => {
    const { getSourceIdentityWorkspace, getSourceIdentityPanel } = await import('@/features/catalog/source-identity/service');
    expect(await getSourceIdentityWorkspace()).toMatchObject({ enabled: false, scopes: [], workspace: null });
    expect(await getSourceIdentityPanel(uuid)).toMatchObject({ enabled: false, realVerifiedCount: 0, sourceIdentity: [], formalRelationship: { usable: false } });
    expect(db.run).not.toHaveBeenCalled(); expect(server.actor).not.toHaveBeenCalled();
  });
  it('recovers a committed result only by the original scoped ledger, never replays mutation or old audit', async () => {
    const { sourceIdentityRepository, sourceIdentityIntent } = await import('@/features/catalog/source-identity/repository');
    const payload = { recordId: uuid, command: 'suspend' }, receipt = { requestId: uuid, scopeId: FIXTURE_SCOPE_A, action: 'revise', recordId: uuid,
      revision: 2, state: 'suspended', verificationEnvironment: 'fixture', relationshipUsable: false };
    const calls: { sql: string; values: unknown[] }[] = [];
    db.run.mockImplementationOnce(async (_actor, callback) => {
      await callback({ query: async (sql: string, values: unknown[]) => { calls.push({ sql, values }); return { rows: [{ result: receipt }] }; } });
      throw Object.assign(new Error('ACK lost after COMMIT'), { code: 'ECONNRESET' });
    }).mockImplementationOnce(async (_actor, callback) => callback({ query: async (sql: string, values: unknown[]) => { calls.push({ sql, values }); return { rows: [{ result: receipt }] }; } }));
    expect(await sourceIdentityRepository.mutate(identity, uuid, FIXTURE_SCOPE_A, 'revise', payload)).toEqual(receipt);
    expect(calls.map((call) => call.sql)).toEqual(['SELECT catalog.identity_mutate($1,$2,$3,$4,$5::jsonb) AS result', 'SELECT catalog.identity_receipt($1,$2,$3,$4) AS result']);
    expect(calls[1].values).toEqual([uuid, FIXTURE_SCOPE_A, 'revise', sourceIdentityIntent(identity, FIXTURE_SCOPE_A, 'revise', payload)]);
    expect(calls.some((call) => call.sql.includes('audit_event'))).toBe(false);
  });
  it('keeps an absent/unreadable receipt unknown, including current grant revocation', async () => {
    const { sourceIdentityRepository } = await import('@/features/catalog/source-identity/repository');
    db.run.mockRejectedValueOnce(Object.assign(new Error('commit acknowledgement lost'), { code: 'ECONNRESET' }))
      .mockRejectedValueOnce(Object.assign(new Error('current scope revoked'), { code: '42501' }));
    await expect(sourceIdentityRepository.mutate(identity, uuid, FIXTURE_SCOPE_A, 'register', {})).rejects.toThrow('IDENTITY_REQUEST_OUTCOME_UNKNOWN');
    expect(db.run).toHaveBeenCalledTimes(2);
  });
  it.each(['57P01', '57P02', '57P03'])('treats PostgreSQL shutdown code %s as uncertain after unreadable receipt', async (code) => {
    const { sourceIdentityRepository } = await import('@/features/catalog/source-identity/repository');
    db.run.mockRejectedValueOnce(Object.assign(new Error('connection closed'), { code }))
      .mockRejectedValueOnce(Object.assign(new Error('database unavailable'), { code }));
    await expect(sourceIdentityRepository.mutate(identity, uuid, FIXTURE_SCOPE_A, 'revise', {})).rejects.toThrow('IDENTITY_REQUEST_OUTCOME_UNKNOWN');
  });
  it('binds complete intent to actor, scope, action and exact input', async () => {
    const { sourceIdentityIntent } = await import('@/features/catalog/source-identity/repository');
    const first = sourceIdentityIntent(identity, FIXTURE_SCOPE_A, 'register', { key: '001', expectedMatch: { kind: 'none' } });
    expect(sourceIdentityIntent(identity, FIXTURE_SCOPE_A, 'register', { expectedMatch: { kind: 'none' }, key: '001' })).toBe(first);
    expect(sourceIdentityIntent({ profileUserId: uuid }, FIXTURE_SCOPE_A, 'register', { key: '001', expectedMatch: { kind: 'none' } })).not.toBe(first);
    expect(sourceIdentityIntent(identity, FIXTURE_SCOPE_B, 'register', { key: '001', expectedMatch: { kind: 'none' } })).not.toBe(first);
    expect(sourceIdentityIntent(identity, FIXTURE_SCOPE_A, 'revise', { key: '001', expectedMatch: { kind: 'none' } })).not.toBe(first);
  });
});

describe('safe source action responses', () => {
  it('does not let disabled module errors leak SQL, bytes, scope metadata or raw amounts', async () => {
    const { prepareSourceFixtureCaptureAction } = await import('@/features/catalog/source-identity/actions');
    const result = await prepareSourceFixtureCaptureAction({ fixtureId: 'products-v1' });
    expect(result).toEqual({ status: 'denied', code: 'IDENTITY_OPERATION_DENIED' });
    expect(JSON.stringify(result)).not.toMatch(/9988\.17|storageHandle|scopeId|SELECT|D:/);
  });
});

describe('scoped service entry boundaries', () => {
  const workspace = (): IdentityWorkspaceDto => ({ scope: { scopeId: FIXTURE_SCOPE_A, displayName: 'Fixture A', system: 'bigseller', entityKind: 'product_record', scopeState: 'identity_ready', verificationEnvironment: 'fixture' },
    permissions: { read: true, manage: true, evidence: false, amount: false }, contracts: [], proofs: [], observations: [], records: [], links: [], history: [], frozenHumanChoice: [],
    verificationEnvironment: 'fixture', catalogTargetDecision: 'not_implemented', formalRelationship: { usable: false, reason: 'N2_NOT_IMPLEMENTED' } });
  async function modules() {
    const [auth, repository, fixtures, service] = await Promise.all([import('@/features/catalog/source-identity/authorization'),
      import('@/features/catalog/source-identity/repository'), import('@/features/catalog/source-identity/fixture-adapter'), import('@/features/catalog/source-identity/service')]);
    vi.spyOn(auth, 'sourceIdentityEnabled').mockReturnValue(true); vi.spyOn(auth, 'requireSourceIdentityActor').mockResolvedValue(identity);
    return { repository: repository.sourceIdentityRepository, fixtures, service };
  }
  it('previews only after current manage authorization and rejects read-only scope before touching fixture bytes', async () => {
    const { repository, fixtures, service } = await modules();
    vi.spyOn(repository, 'workspace').mockResolvedValue({ ...workspace(), permissions: { read: true, manage: false, evidence: true, amount: true } });
    const prepare = vi.spyOn(fixtures, 'prepareSourceFixtureCapture');
    await expect(service.prepareSourceFixtureCapturePreview({ fixtureId: 'products-v1' })).rejects.toThrow('IDENTITY_FORBIDDEN');
    expect(prepare).not.toHaveBeenCalled();
  });
  it('rebuilds import intent from the fixed fixture and refuses a changed preview without writes', async () => {
    const { repository, fixtures, service } = await modules(); vi.spyOn(repository, 'workspace').mockResolvedValue(workspace());
    const parsed = parseSourceFixtureBytes('products-v1', await fileBytes('products-v1.json'));
    const capture = { ...parsed.capture, proofSemantics: parsed.proofSemantics, storageHandle: `aa/${'a'.repeat(64)}` };
    vi.spyOn(fixtures, 'prepareSourceFixtureCapture').mockResolvedValue({ fixtureId: 'products-v1', scopeId: FIXTURE_SCOPE_A, capture });
    const mutate = vi.spyOn(repository, 'mutate').mockResolvedValue({ requestId: uuid, scopeId: FIXTURE_SCOPE_A, action: 'import_capture', verificationEnvironment: 'fixture', relationshipUsable: false });
    await expect(service.importSourceFixtureCapture({ fixtureId: 'products-v1', previewId: 'b'.repeat(64), requestId: uuid })).rejects.toThrow('IDENTITY_PREVIEW_CHANGED');
    expect(mutate).not.toHaveBeenCalled();
    await service.importSourceFixtureCapture({ fixtureId: 'products-v1', previewId: capture.adoptionDigest, requestId: uuid });
    expect(mutate).toHaveBeenCalledWith(identity, uuid, FIXTURE_SCOPE_A, 'import_capture', capture);
  });
  it('forwards explicit link revocation for a suspended source without substituting its record, proof or CAS', async () => {
    const { repository, service } = await modules(), w = workspace();
    w.records = [{ recordId: uuid, scopeId: FIXTURE_SCOPE_A, entityKind: 'product_record', revision: 4, state: 'suspended', activeClaimId: uuid,
      currentContractId: uuid, verificationEnvironment: 'fixture', relationshipUsable: false }];
    vi.spyOn(repository, 'workspace').mockResolvedValue(w);
    const result = { requestId: uuid, scopeId: FIXTURE_SCOPE_A, action: 'link' as const, recordId: uuid, linkRevision: 2,
      verificationEnvironment: 'fixture' as const, relationshipUsable: false as const };
    const mutate = vi.spyOn(repository, 'mutate').mockResolvedValue(result);
    const payload = { operation: 'revoke' as const, recordId: uuid, expectedRecordRevision: 4, expectedLinkRevision: 1,
      origin: { kind: 'identity' as const, id: uuid }, proofId: uuid, reason: 'Revoke existing association while identity remains suspended' };
    expect(await service.linkSourceObservation({ requestId: uuid, scopeId: FIXTURE_SCOPE_A, ...payload })).toEqual(result);
    expect(mutate).toHaveBeenCalledExactlyOnceWith(identity, uuid, FIXTURE_SCOPE_A, 'link', payload);
  });
  it('returns a safe denial for stale-proof reverify without retrying or changing the original proof and expected version', async () => {
    const { repository } = await modules(); vi.spyOn(repository, 'workspace').mockResolvedValue(workspace());
    const mutate = vi.spyOn(repository, 'mutate').mockRejectedValue(Object.assign(new Error('IDENTITY_FRESH_PROOF_REQUIRED'), { code: '22023', detail: 'raw 9988.17 storageHandle D:/private' }));
    const { reviseSourceIdentityAction } = await import('@/features/catalog/source-identity/actions');
    const payload = { recordId: uuid, expectedRecordRevision: 6, command: 'reverify' as const, proofId: uuid,
      contractId: uuid, observationId: uuid, expectedClaimId: uuid, reason: 'Explicit stale proof attempt, not original request recovery' };
    const result = await reviseSourceIdentityAction({ requestId: uuid, scopeId: FIXTURE_SCOPE_A, ...payload });
    expect(result).toEqual({ status: 'denied', code: 'IDENTITY_OPERATION_DENIED' });
    expect(mutate).toHaveBeenCalledExactlyOnceWith(identity, uuid, FIXTURE_SCOPE_A, 'revise', payload);
    expect(JSON.stringify(result)).not.toMatch(/9988\.17|storageHandle|SELECT|D:|proofId|recordId|revision/);
  });
  it.each(['IDENTITY_PROOF_COVERAGE_REQUIRED', 'IDENTITY_FROZEN_SCOPE_CONTRADICTION'])('returns only the whitelisted residual conflict code %s', async (message) => {
    const { repository } = await modules(); vi.spyOn(repository, 'workspace').mockResolvedValue(workspace());
    const mutate = vi.spyOn(repository, 'mutate').mockRejectedValue(Object.assign(new Error(message), {
      code: '22023', detail: 'SELECT scope=PRIVATE-W1 raw 9988.17 storageHandle D:/private', hint: 'PRIVATE-ACCOUNT',
    }));
    const actions = await import('@/features/catalog/source-identity/actions');
    const result = message === 'IDENTITY_PROOF_COVERAGE_REQUIRED'
      ? await actions.reviseSourceIdentityAction({ requestId: uuid, scopeId: FIXTURE_SCOPE_A, recordId: uuid, expectedRecordRevision: 2,
        command: 'reverify', proofId: uuid, contractId: uuid, observationId: uuid, expectedClaimId: uuid, reason: 'Test proof coverage rejection' })
      : await actions.linkSourceObservationAction({ requestId: uuid, scopeId: FIXTURE_SCOPE_A, recordId: uuid, expectedRecordRevision: 1,
        operation: 'link', expectedLinkRevision: 0, origin: { kind: 'frozen', id: uuid }, proofId: uuid, reason: 'Test original scope rejection' });
    expect(result).toEqual({ status: 'conflict', code: message }); expect(mutate).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|9988\.17|storageHandle|SELECT|D:|scopeId|proofId|recordId/);
  });
  it('keeps read-only evidence export separate from raw amount/evidence permission and never falls back to legacy lookup', async () => {
    const { repository, service } = await modules();
    const safe = { evidence: { evidenceId: uuid, scopeId: FIXTURE_SCOPE_A, format: 'json' }, observations: [] };
    const exported = vi.spyOn(repository, 'evidenceExport').mockResolvedValue(safe), raw = vi.spyOn(repository, 'evidence');
    expect(await service.getSourceIdentityEvidenceExport(uuid)).toEqual(safe);
    expect(exported).toHaveBeenCalledWith(identity, uuid); expect(raw).not.toHaveBeenCalled();
    expect(JSON.stringify(safe)).not.toMatch(/storageHandle|9988\.17|rawPayload|session|D:/);
  });
  it('requires existing amount/evidence actions and scoped raw metadata before reading private bytes', async () => {
    const { repository, service } = await modules();
    const existingAuthorization = await import('@/features/catalog/authorization');
    const require = vi.spyOn(existingAuthorization, 'requireCatalogAdmin').mockResolvedValue(identity);
    const raw = vi.spyOn(repository, 'evidence').mockRejectedValue(Object.assign(new Error('not authorized'), { code: '42501' }));
    const store = await import('@/features/catalog/evidence-store'); const read = vi.spyOn(store, 'readPrivateArtifact');
    await expect(service.getSourceIdentityEvidence(uuid)).rejects.toThrow('not authorized');
    expect(require.mock.calls.map((call) => call[0])).toEqual(['evidence:read', 'amount:read']);
    expect(raw).toHaveBeenCalledWith(identity, uuid); expect(read).not.toHaveBeenCalled();
  });
  it('does not expose a related scope record or observation on an unrelated item panel', async () => {
    const { repository, service } = await modules(); const w = workspace();
    w.frozenHumanChoice = [{ decisionId: uuid, observationId: uuid, selectedItemId: uuid, selectedJushuitanRef: null, reviewState: 'manual_selected' }];
    vi.spyOn(repository, 'scopes').mockResolvedValue([w.scope]); vi.spyOn(repository, 'workspace').mockResolvedValue(w);
    expect(await service.getSourceIdentityPanel('22222222-2222-4222-8222-222222222222')).toMatchObject({ enabled: true, scopes: [], frozenHumanChoice: [], sourceIdentity: [], observations: [], links: [], realVerifiedCount: 0 });
  });
  it('derives current item attachment only from the latest linked head while retaining revoked link history', async () => {
    const { repository, service } = await modules(); const w = workspace();
    w.frozenHumanChoice = [{ decisionId: uuid, observationId: uuid, selectedItemId: uuid, selectedJushuitanRef: null, reviewState: 'manual_selected' }];
    w.records = [{ recordId: uuid, scopeId: FIXTURE_SCOPE_A, entityKind: 'product_record', revision: 1, state: 'active', activeClaimId: uuid,
      currentContractId: uuid, verificationEnvironment: 'fixture', relationshipUsable: false }];
    const link = { observationKey: `frozen:${uuid}`, linkRevision: 1, originKind: 'frozen' as const, originId: uuid, recordId: uuid,
      status: 'linked' as const, contractId: uuid, actorId: identity.profileUserId,
      proofId: uuid, reason: 'fixture link', recordedAt: '2026-10-20T00:00:00Z' };
    w.links = [link, { ...link, linkRevision: 2, status: 'revoked' }];
    vi.spyOn(repository, 'scopes').mockResolvedValue([w.scope]); vi.spyOn(repository, 'workspace').mockResolvedValue(w);
    const panel = await service.getSourceIdentityPanel(uuid);
    expect(panel.sourceIdentity).toEqual([]); expect(panel.links).toHaveLength(2); expect(panel.frozenHumanChoice).toHaveLength(1);
  });
});
