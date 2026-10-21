import { createHash } from 'node:crypto';
import type { FieldObservation } from '../types';
import { canonicalJson } from '../source-identity/key-codec';
import { ADOPTABLE_FIELD_KEYS, type AdoptableFieldKey, type ConfirmationPreview, type ProductObservationDto } from './types';

export const hashCanonical = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex');
function safeField(source: FieldObservation, evidenceRef: string): FieldObservation {
  if (source.state === 'observed') {
    return source.meaning === 'explicit_null' ? { state: 'observed', meaning: 'explicit_null', raw: null, evidenceRef }
      : { state: 'observed', meaning: source.meaning, raw: source.raw, evidenceRef };
  }
  if (source.state === 'no_text') return { state: 'no_text', raw: null, evidenceRef };
  return { state: source.state, raw: null, reason: source.state === 'parse_failed' ? 'SOURCE_FIELD_PARSE_FAILED' : 'SOURCE_FIELD_NOT_READ', evidenceRef };
}
export function projectSafeObservationFields(fields: Record<string, FieldObservation>, observationId: string): Record<string, FieldObservation> {
  const allowed = new Set<string>([...ADOPTABLE_FIELD_KEYS, 'imageRef', 'vendorRecordId', 'sku', 'iceCode']);
  return Object.fromEntries(Object.entries(fields).filter(([key]) => allowed.has(key)).map(([key, source]) => {
    const evidenceRef = `scope-observation:${observationId}#${key}`;
    return [key, key === 'imageRef' ? { state: 'not_read', raw: null, reason: 'IMAGE_NOT_PUBLISHED', evidenceRef } : safeField(source, evidenceRef)];
  }));
}
/** Public values deliberately get a new publication reference and fixed status reasons. */
export function projectAdoptedFields(fields: Record<string, FieldObservation>, keys: readonly AdoptableFieldKey[], token: string): Record<string, FieldObservation> {
  const selected = new Set(keys);
  return Object.fromEntries([...ADOPTABLE_FIELD_KEYS, 'imageRef'].map((key) => {
    const evidenceRef = `catalog-pub:${token}#${key}`, source = fields[key];
    if (key === 'imageRef') return [key, { state: 'not_read', raw: null, reason: 'IMAGE_NOT_PUBLISHED', evidenceRef }];
    if (!selected.has(key as AdoptableFieldKey) || !source) return [key, { state: 'not_read', raw: null, reason: 'FIELD_NOT_ADOPTED', evidenceRef }];
    return [key, safeField(source, evidenceRef)];
  }));
}
export function confirmationPreview(scopeId: string, observation: ProductObservationDto, adoptedFieldKeys: AdoptableFieldKey[], initialCode: string | null): ConfirmationPreview {
  if (!observation.classification) throw new Error('CLASSIFICATION_CONFLICT');
  const keys = [...adoptedFieldKeys].sort(), current = observation.currentSource;
  const expectedSourceSnapshot = current ? { recordId: current.recordId, revision: current.revision, claimId: current.claimId } : null;
  const selected = Object.fromEntries(keys.map((key) => [key, observation.fields[key]]));
  if (Object.values(selected).some((value) => value === undefined)) throw new Error('NEW_ITEM_REVIEW_REQUIRED');
  return { scopeId, observationId: observation.observationId, expectedClassificationRevision: observation.classification.revision,
    expectedSourceSnapshot, expectedSourceDisposition: observation.sourceDisposition.sha256, adoptedFieldKeys: keys, initialCode,
    previewId: hashCanonical(['iceos-new-item-preview-v1', scopeId, observation.observationId, observation.payloadSha256,
      observation.classification.revision, expectedSourceSnapshot, observation.sourceDisposition.sha256, keys, selected, initialCode]) };
}
