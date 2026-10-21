import { createHash } from 'node:crypto';
import { opaqueIdSchema, scopeIdentitySchema } from './schema';
import type { EntityKind, IdentityStrategy, ObservationField, ScopeIdentityInput } from './types';

export const KEY_MAX_BYTES = 1800;
export const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('INVALID_CANONICAL_TYPE');
  return encoded;
}
export function encodeScope(input: ScopeIdentityInput) {
  const s = scopeIdentitySchema.parse(input);
  const canonical = canonicalJson(['iceos-source-scope-v1', s.system, s.entityKind,
    ['account', s.accountKind, s.accountParts], ['resource', s.resourceKind, s.resourceParts],
    ['market', s.marketRole, s.marketIdentity], ['warehouse', s.warehouseRole, s.warehouseIdentity]]);
  if (Buffer.byteLength(canonical, 'utf8') > KEY_MAX_BYTES) throw new Error('SCOPE_KEY_TOO_LONG');
  return { canonical, sha256: digest(canonical) };
}
export function encodeRecordKey(input: { scopeId: string; entityKind: EntityKind; contractRevision: number; strategy: IdentityStrategy;
  keyFields: string[]; fields: Record<string, ObservationField> }) {
  if (!/^[a-f0-9-]{36}$/i.test(input.scopeId) || !Number.isInteger(input.contractRevision) || input.contractRevision < 1
    || !input.keyFields.length || new Set(input.keyFields).size !== input.keyFields.length) throw new Error('INVALID_KEY_CONTRACT');
  const ordered = input.keyFields.map((key) => {
    opaqueIdSchema.parse(key); const field = input.fields[key];
    if (!field || field.state !== 'value') throw new Error('KEY_FIELD_NOT_OBSERVED');
    return [key, opaqueIdSchema.parse(field.value)];
  });
  const canonical = canonicalJson([input.scopeId.toLowerCase(), input.entityKind, input.contractRevision, input.strategy, ordered]);
  const domain = canonicalJson([input.scopeId.toLowerCase(), input.entityKind, input.strategy, [...ordered].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)]);
  if (Buffer.byteLength(canonical, 'utf8') > KEY_MAX_BYTES) throw new Error('IDENTITY_KEY_TOO_LONG');
  return { canonical, sha256: digest(canonical), domain, domainSha256: digest(domain), ordered };
}
export function captureAdoptionDigest(input: { bytesSha256: string; parserId: string; parserVersion: string; contractId: string;
  contractRevision: number; scopeId: string; coverage: unknown; projectionSha256: string }) {
  return digest(canonicalJson(['iceos-identity-capture-v1', input.bytesSha256, input.parserId, input.parserVersion,
    input.contractId.toLowerCase(), input.contractRevision, input.scopeId.toLowerCase(), input.coverage, input.projectionSha256]));
}
