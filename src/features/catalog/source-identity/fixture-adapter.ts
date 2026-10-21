import 'server-only';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { catalogSourceRoot, sha256, storePrivateArtifact } from '../evidence-store';
import { canonicalJson, captureAdoptionDigest, digest } from './key-codec';
import { identityContextSchema, observationFieldSchema, opaqueIdSchema } from './schema';
import type { ObservationField, PreparedIdentityCapture, PreparedIdentityObservation } from './types';

export const SOURCE_FIXTURE_DIRECTORY = 'tests/catalog/fixtures/source-identity';
export const FIXTURE_SCOPE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
export const FIXTURE_SCOPE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
export const SOURCE_FIXTURE_PINS = Object.freeze({
  'scope-grants.fixture.json': '379b1118ea2f68fda23ea8abee5b6f7bba5d8183f8991407a0b210cd084768f3',
  'products-v1.json': '4ca41781c8bcb3ed7ff2563cc414c1d9f120c63bc5977ebabe82c67c20c9cebb',
  'products-reordered-v2.json': '3f160b341941d2255412592b458931d6631483a6020b0030dee2dd729f836ae9',
  'products-conflicts-v3.json': 'f93833e1374b0b7c10bd29e9a377f2efd759b29ed041e9a39ce480c6b15af0a9',
});
export const SOURCE_FIXTURE_MANIFEST = Object.freeze({
  'products-v1': { file: 'products-v1.json', scopeId: FIXTURE_SCOPE_A, accountId: 'FIXTURE-ACCOUNT-A', datasetId: 'FIXTURE-PRODUCTS-A',
    contractId: 'cccccccc-aaaa-4ccc-8aaa-ccccccccccc1', contractRevision: 1, captureKey: 'fixture-capture-products-v1', evidenceId: 'dddddddd-aaaa-4ddd-8aaa-ddddddddddd1' },
  'products-reordered-v2': { file: 'products-reordered-v2.json', scopeId: FIXTURE_SCOPE_A, accountId: 'FIXTURE-ACCOUNT-A', datasetId: 'FIXTURE-PRODUCTS-A',
    contractId: 'cccccccc-aaaa-4ccc-8aaa-ccccccccccc1', contractRevision: 1, captureKey: 'fixture-capture-products-reordered-v2', evidenceId: 'dddddddd-aaaa-4ddd-8aaa-ddddddddddd2' },
  'products-conflicts-v3': { file: 'products-conflicts-v3.json', scopeId: FIXTURE_SCOPE_B, accountId: 'FIXTURE-ACCOUNT-B', datasetId: 'FIXTURE-PRODUCTS-B',
    contractId: 'cccccccc-bbbb-4ccc-8bbb-ccccccccccc2', contractRevision: 1, captureKey: 'fixture-capture-products-conflicts-v3', evidenceId: 'dddddddd-bbbb-4ddd-8bbb-ddddddddddd3' },
});
export type SourceFixtureId = keyof typeof SOURCE_FIXTURE_MANIFEST;
export function sourceFixtureManifest(fixtureId: string) {
  if (!Object.hasOwn(SOURCE_FIXTURE_MANIFEST, fixtureId)) throw new Error('IDENTITY_FIXTURE_NOT_ALLOWED');
  return SOURCE_FIXTURE_MANIFEST[fixtureId as SourceFixtureId];
}
const proofSchema = z.object({ uniqueness: z.boolean(), stability: z.boolean(), keyChange: z.boolean(), reuse: z.boolean(), oldObservationCompatible: z.boolean() }).strict();
const recordSchema = z.object({ vendorRecordId: z.unknown(), sku: z.unknown(), name: z.unknown(), barcode: z.unknown(),
  marketContext: identityContextSchema, warehouseContext: identityContextSchema, sourceEffectiveAt: z.null(), costPriceRaw: z.string() }).strict();
const productSchema = z.object({ schema: z.literal('iceos-single-scope-products-v1'), environment: z.literal('fixture'),
  scopeId: z.string().uuid(), accountId: opaqueIdSchema, datasetId: opaqueIdSchema, proof: proofSchema,
  coverage: z.object({ complete: z.boolean(), meaning: z.string().min(1) }).strict(), sourceUpdatedAt: z.null(), documentModifiedAt: z.null(), records: z.array(recordSchema).min(1) }).strict();

function technicalUuid(value: string): string {
  const hex = digest(value).slice(0, 32).split(''); hex[12] = '5'; hex[16] = ((parseInt(hex[16], 16) & 3) | 8).toString(16);
  const raw = hex.join(''); return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
}
function observation(value: unknown, evidenceRef: string): ObservationField {
  const field: ObservationField = value === undefined ? { state: 'not_observed', value: null, reason: 'FIELD_NOT_OBSERVED', evidenceRef }
    : value === null || value === '' ? { state: 'empty', value: null, evidenceRef }
    : typeof value === 'string' && value.trim() === value && value.trim().length > 0 ? { state: 'value', value, evidenceRef }
    : { state: 'parse_failed', value: null, reason: 'SOURCE_IDENTIFIER_TYPE_INVALID', evidenceRef };
  return observationFieldSchema.parse(field);
}

/** Whole input must be one permitted scope. Row-level account overrides are forbidden. */
export function parseSourceFixtureBytes(fixtureId: string, bytes: Uint8Array, requirePin = true) {
  const manifest = sourceFixtureManifest(fixtureId);
  if (requirePin && sha256(bytes) !== SOURCE_FIXTURE_PINS[manifest.file as keyof typeof SOURCE_FIXTURE_PINS]) throw new Error('IDENTITY_FIXTURE_PIN_MISMATCH');
  const source = productSchema.parse(JSON.parse(Buffer.from(bytes).toString('utf8')));
  if (source.scopeId !== manifest.scopeId || source.accountId !== manifest.accountId || source.datasetId !== manifest.datasetId) throw new Error('IDENTITY_MIXED_SCOPE_FIXTURE_DENIED');
  const observations: PreparedIdentityObservation[] = source.records.map((row, index) => {
    const recordPointer = `/records/${index}`, ref = `${manifest.evidenceId}#${recordPointer}`;
    const fields = Object.fromEntries(['vendorRecordId', 'sku', 'name', 'barcode'].map((key) => [key, observation(row[key as keyof typeof row], `${ref}/${key}`)]));
    for (const context of [row.marketContext, row.warehouseContext]) if (context.state === 'known' && context.raw !== context.canonical) throw new Error('IDENTITY_CONTEXT_NORMALIZATION_DENIED');
    return { observationId: technicalUuid(`${manifest.scopeId}\n${manifest.captureKey}\n${recordPointer}`), recordPointer,
      fields, marketContext: row.marketContext, warehouseContext: row.warehouseContext, position: { file: manifest.file, row: index + 1 },
      payloadSha256: digest(canonicalJson(row)), sourceEffectiveAt: null, sourceAvailability: 'not_observed' };
  });
  const projectionSha256 = digest(canonicalJson(observations)), bytesSha256 = sha256(bytes), parserId = 'catalog-single-scope-fixture', parserVersion = '1';
  const coverage = { ...source.coverage, singleScope: true, recordCount: observations.length, verificationEnvironment: 'fixture', sourceUpdatedAt: null, documentModifiedAt: null };
  const adoptionDigest = captureAdoptionDigest({ bytesSha256, parserId, parserVersion, contractId: manifest.contractId,
    contractRevision: manifest.contractRevision, scopeId: manifest.scopeId, coverage, projectionSha256 });
  return { fixtureId: fixtureId as SourceFixtureId, scopeId: manifest.scopeId, proofSemantics: source.proof,
    capture: { captureKey: manifest.captureKey, evidenceId: manifest.evidenceId, manifestId: fixtureId,
      bytesSha256, size: bytes.byteLength, format: 'json', parserId, parserVersion, contractId: manifest.contractId,
      contractRevision: manifest.contractRevision, coverage, projectionSha256, adoptionDigest, observations, proofSemantics: source.proof } };
}

async function fixedBytes(file: keyof typeof SOURCE_FIXTURE_PINS) {
  const absolute = path.join(catalogSourceRoot(), SOURCE_FIXTURE_DIRECTORY, file);
  let current = catalogSourceRoot();
  for (const part of path.relative(current, absolute).split(path.sep)) {
    current = path.join(current, part);
    if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('IDENTITY_FIXTURE_LINK_DENIED');
  }
  const bytes = await fs.readFile(absolute);
  if (sha256(bytes) !== SOURCE_FIXTURE_PINS[file]) throw new Error('IDENTITY_FIXTURE_PIN_MISMATCH');
  return bytes;
}

export async function prepareSourceFixtureCapture(fixtureId: string): Promise<{ fixtureId: SourceFixtureId; scopeId: string; capture: PreparedIdentityCapture & { proofSemantics: z.infer<typeof proofSchema> } }> {
  const manifest = sourceFixtureManifest(fixtureId), bytes = await fixedBytes(manifest.file as keyof typeof SOURCE_FIXTURE_PINS);
  const parsed = parseSourceFixtureBytes(fixtureId, bytes);
  const stored = await storePrivateArtifact(manifest.file, bytes);
  return { fixtureId: parsed.fixtureId, scopeId: parsed.scopeId, capture: { ...parsed.capture, proofSemantics: parsed.proofSemantics, storageHandle: stored.storageHandle } };
}

/** Bootstrap-only trusted fixture configuration; never returned by an HTTP action. */
export async function prepareSourceIdentityBootstrap() {
  const config = JSON.parse((await fixedBytes('scope-grants.fixture.json')).toString('utf8')) as { actors: Record<string, unknown>[]; scopes: (Record<string, unknown> & { proofFixtureId: string })[] };
  const scopes = [];
  for (const scope of config.scopes) {
    const manifest = sourceFixtureManifest(scope.proofFixtureId), bytes = await fixedBytes(manifest.file as keyof typeof SOURCE_FIXTURE_PINS);
    parseSourceFixtureBytes(scope.proofFixtureId, bytes);
    if (scope.scopeId !== manifest.scopeId) throw new Error('IDENTITY_BOOTSTRAP_SCOPE_MISMATCH');
    const stored = await storePrivateArtifact(manifest.file, bytes);
    scopes.push({ ...scope, proofSha256: stored.sha256, proofSize: stored.size, proofHandle: stored.storageHandle });
  }
  return { actors: config.actors, scopes };
}
