import 'server-only';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { catalogSourceRoot, sha256 } from '../evidence-store';
import { fieldObservationSchema, scopeValueSchema } from '../schema';
import { digestSchema, uuidSchema } from './schema';
import { hashCanonical } from './field-projection';
import type { AssociationProof, JsonValue, PreparedProductCapture, ProductCaptureEnvelope } from './types';

export const PRODUCT_FIXTURE_DIRECTORY = 'tests/catalog/fixtures';
export const PRODUCT_FIXTURE_PINS = Object.freeze({
  'new-item-bootstrap.json': '2e20c4e9875dd9621cbed23be35e75951ccd936ff94b02ed431d88df3cb30fa5',
  'new-item-scope-a.json': 'd68c9c629d24220ba6d4e81a3198b6f14dd0639ae4a5447fee4366dbc8f68782',
  'new-item-scope-b.json': '98760817ef167db1702dff0069572b6c818ff684869d2cbd51f171d783f03ab2',
  'new-item-scope-unresolved.json': '5e283e90bb4b6681d8a476b84658628e7bd9fea97c68b88f062cc556cff02ae9',
  'new-item-fixture-manifest.json': '427bd68ddc3fbc38597999cd336fea3ba78ddaa014322968ec90bbe6dbd0cdb5',
});
const fieldNames = new Set(['nameCn', 'englishName', 'specification', 'barcode', 'factory', 'packaging', 'cartonQuantity', 'imageRef', 'vendorRecordId', 'sku', 'iceCode']);
const ref = z.string().min(1).max(500), jsonRecord = z.record(z.string(), z.unknown());
const productEndpoint = z.object({ kind: z.literal('product_observation'), captureKey: ref, recordPointer: ref, bytesSha256: digestSchema, payloadSha256: digestSchema }).strict();
const baselineEndpoint = z.object({ kind: z.literal('baseline_anchor'), releaseId: uuidSchema, artifactId: uuidSchema, jsonPointer: ref, bundleSha256: digestSchema, payloadSha256: digestSchema }).strict();
const identityEndpoint = z.object({ kind: z.literal('identity_observation'), evidenceId: uuidSchema, recordPointer: ref, bytesSha256: digestSchema, payloadSha256: digestSchema }).strict();
const proofSchema = z.object({ proofKey: z.string().min(1).max(200), semantics: z.enum(['same_catalog_item', 'same_source_record']),
  from: productEndpoint, to: z.union([productEndpoint, baselineEndpoint, identityEndpoint]) }).strict().superRefine((value, ctx) => {
  if ((value.semantics === 'same_source_record') !== (value.to.kind === 'identity_observation')) ctx.addIssue({ code: 'custom', message: 'ASSOCIATION_PROOF_INVALID' });
});
const observationSchema = z.object({ recordPointer: ref, position: jsonRecord,
  fields: z.record(z.string(), fieldObservationSchema).refine((fields) => Object.keys(fields).every((key) => fieldNames.has(key)), 'PRODUCT_FIELD_NOT_ALLOWED'),
  marketContext: scopeValueSchema, warehouseContext: scopeValueSchema, rawRef: ref, payloadSha256: digestSchema }).strict();
const captureSchema = z.object({ approvedFixtureId: z.string().regex(/^[a-z0-9-]+$/), scopeId: uuidSchema, captureKey: ref,
  rawFile: z.enum(['new-item-scope-a.json', 'new-item-scope-b.json', 'new-item-scope-unresolved.json']), bytesSha256: digestSchema, sizeBytes: z.number().int().nonnegative(),
  format: z.literal('json'), parserId: z.literal('iceos-product-fixture'), parserVersion: z.literal('v1'), schemaVersion: z.literal('product-observation-v1'),
  coverage: z.object({ complete: z.boolean(), singleScope: z.literal(true), rowPointers: z.array(ref), hidden: ref, filters: ref, images: ref }).strict(),
  observations: z.array(observationSchema), projectionSha256: digestSchema, associationProofs: z.array(proofSchema),
  sourceAvailability: z.enum(['known', 'not_observed']), sourceEffectiveAt: z.string().nullable(),
  documentAvailability: z.enum(['known', 'not_observed']), documentModifiedAt: z.string().nullable(), collectedAt: z.string() }).strict();
const manifestSchema = z.object({ manifestId: ref, fictional: z.literal(true), captures: z.array(captureSchema).min(1) }).strict();
export type ProductFixtureManifest = z.infer<typeof manifestSchema>;

/** Preserve all six digits; Date is used only to validate the integral second. */
export function isCanonicalUtcMicroseconds(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$/.test(value) || value.startsWith('0000-')) return false;
  const whole = value.slice(0, 19), timestamp = Date.parse(`${whole}Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 19) === whole;
}
export function assertProductTimes(envelope: Pick<ProductCaptureEnvelope, 'sourceAvailability' | 'sourceEffectiveAt' | 'documentAvailability' | 'documentModifiedAt' | 'collectedAt'>): void {
  for (const [availability, value] of [[envelope.sourceAvailability, envelope.sourceEffectiveAt], [envelope.documentAvailability, envelope.documentModifiedAt]]) {
    if (!['known', 'not_observed'].includes(String(availability)) || (availability === 'known' ? !isCanonicalUtcMicroseconds(value) : value !== null)) throw new Error('PRODUCT_CAPTURE_ENVELOPE_INVALID');
  }
  if (!isCanonicalUtcMicroseconds(envelope.collectedAt)) throw new Error('PRODUCT_CAPTURE_ENVELOPE_INVALID');
}
export function productCaptureAdoptionDigest(envelope: ProductCaptureEnvelope): string {
  assertProductTimes(envelope);
  return hashCanonical(['iceos-product-capture-v2', envelope.approvedFixtureId, envelope.fixtureManifestId, envelope.fixtureManifestSha256,
    envelope.scopeId, envelope.captureKey, envelope.bytesSha256, envelope.sizeBytes, envelope.format, envelope.parserId, envelope.parserVersion,
    envelope.schemaVersion, envelope.coverage, envelope.projectionSha256, envelope.associationProofs,
    envelope.sourceAvailability, envelope.sourceEffectiveAt, envelope.documentAvailability, envelope.documentModifiedAt, envelope.collectedAt]);
}
export function parseProductFixtureManifest(bytes: Uint8Array, requirePin = true): ProductFixtureManifest {
  if (requirePin && sha256(bytes) !== PRODUCT_FIXTURE_PINS['new-item-fixture-manifest.json']) throw new Error('PRODUCT_CAPTURE_PIN_CONFLICT');
  const manifest = manifestSchema.parse(JSON.parse(Buffer.from(bytes).toString('utf8')));
  if (new Set(manifest.captures.map((entry) => entry.approvedFixtureId)).size !== manifest.captures.length) throw new Error('PRODUCT_CAPTURE_PIN_CONFLICT');
  for (const capture of manifest.captures) {
    assertProductTimes(capture);
    if (new Set(capture.associationProofs.map((proof) => proof.proofKey)).size !== capture.associationProofs.length) throw new Error('ASSOCIATION_PROOF_INVALID');
    if (capture.associationProofs.map((proof) => proof.proofKey).join('|') !== [...capture.associationProofs].sort((a, b) => a.proofKey.localeCompare(b.proofKey)).map((proof) => proof.proofKey).join('|')) throw new Error('ASSOCIATION_PROOF_INVALID');
    if (hashCanonical(capture.observations) !== capture.projectionSha256) throw new Error('PRODUCT_CAPTURE_PIN_CONFLICT');
    for (const observation of capture.observations) {
      const { payloadSha256, ...source } = observation;
      if (hashCanonical(source) !== payloadSha256) throw new Error('PRODUCT_CAPTURE_PIN_CONFLICT');
    }
  }
  return manifest;
}
async function fixedFile(name: keyof typeof PRODUCT_FIXTURE_PINS): Promise<Buffer> {
  const root = catalogSourceRoot(), target = path.join(root, PRODUCT_FIXTURE_DIRECTORY, name);
  let current = root;
  for (const part of path.relative(root, target).split(path.sep)) {
    current = path.join(current, part); if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('PRODUCT_CAPTURE_PIN_CONFLICT');
  }
  const bytes = await fs.readFile(target);
  if (sha256(bytes) !== PRODUCT_FIXTURE_PINS[name]) throw new Error('PRODUCT_CAPTURE_PIN_CONFLICT');
  return bytes;
}
export async function loadProductFixtureManifest() { return parseProductFixtureManifest(await fixedFile('new-item-fixture-manifest.json')); }
export async function listProductFixtures() {
  const manifest = await loadProductFixtureManifest();
  return manifest.captures.map((capture) => ({ approvedFixtureId: capture.approvedFixtureId, scopeId: capture.scopeId, label: `虚构 ${capture.approvedFixtureId}` }));
}
export async function prepareProductFixture(approvedFixtureId: string): Promise<{ payload: PreparedProductCapture; bytes: Buffer }> {
  const manifestBytes = await fixedFile('new-item-fixture-manifest.json'), manifest = parseProductFixtureManifest(manifestBytes);
  const capture = manifest.captures.find((entry) => entry.approvedFixtureId === approvedFixtureId);
  if (!capture) throw new Error('PRODUCT_CAPTURE_PIN_CONFLICT');
  const bytes = await fixedFile(capture.rawFile), raw = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
  if (raw.fictional !== true || raw.scopeId !== capture.scopeId || sha256(bytes) !== capture.bytesSha256 || bytes.byteLength !== capture.sizeBytes || !Array.isArray(raw.rows)) throw new Error('PRODUCT_CAPTURE_PIN_CONFLICT');
  if (capture.sourceAvailability === 'known') {
    const times = raw.fixtureSourceTimes;
    if (!times || typeof times !== 'object' || Array.isArray(times)
      || (times as Record<string, unknown>)[capture.approvedFixtureId] !== capture.sourceEffectiveAt) throw new Error('PRODUCT_CAPTURE_PIN_CONFLICT');
  }
  for (const row of raw.rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some((key) => key !== 'rowKey' && !fieldNames.has(key))) throw new Error('PRODUCT_CAPTURE_PIN_CONFLICT');
  }
  const { rawFile: _rawFile, ...metadata } = capture;
  void _rawFile;
  const envelope = { ...metadata, coverage: capture.coverage as { [key: string]: JsonValue }, associationProofs: capture.associationProofs as AssociationProof[],
    observations: capture.observations as PreparedProductCapture['observations'], fixtureManifestId: manifest.manifestId, fixtureManifestSha256: sha256(manifestBytes) };
  const adoptionDigest = productCaptureAdoptionDigest(envelope);
  return { payload: { ...envelope, adoptionDigest }, bytes };
}
