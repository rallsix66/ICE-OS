import { createHash } from 'node:crypto';
import { z } from 'zod';
import { scopeValueSchema } from './schema';

const keyField = z.object({ name: z.string().min(1), value: z.string().min(1) }).strict();
export const identityInspectionSchema = z.object({
  mode: z.literal('observe_only'), namespace: z.string().min(1), dataset: z.string().min(1),
  entityKind: z.string().min(1), contractVersion: z.string().min(1),
  vendorRecordIdRaw: z.string().nullable(), businessKeyFields: z.array(keyField),
  scope: z.record(z.string(), scopeValueSchema), requiredScope: z.array(z.string()),
  evidence: z.object({ stableIdVerified: z.boolean(), businessKeyVerified: z.boolean(), evidenceRefs: z.array(z.string().min(1)) }).strict(),
}).strict();

export type IdentityInspectionInput = z.infer<typeof identityInspectionSchema>;

/** Inspection never registers a long-term source UUID or enables a relation. */
export function inspectIdentity(input: IdentityInspectionInput) {
  const value = identityInspectionSchema.parse(input);
  const reasons: string[] = [];
  const missingScope = value.requiredScope.filter((key) => !value.scope[key] || value.scope[key].state === 'unknown');
  if (missingScope.length) reasons.push(`UNVERIFIED_SCOPE:${missingScope.join(',')}`);
  const vendorId = value.vendorRecordIdRaw;
  const validVendorId = vendorId !== null && vendorId.trim().length > 0;
  const fields = value.businessKeyFields;
  const validFields = fields.length > 0 && fields.every((f) => f.value.trim().length > 0)
    && new Set(fields.map((f) => f.name)).size === fields.length;
  const strategy = validVendorId ? 'vendor_stable_id' : validFields ? 'scoped_business_key' : 'observation_only';
  const verified = strategy === 'vendor_stable_id' ? value.evidence.stableIdVerified : strategy === 'scoped_business_key' && value.evidence.businessKeyVerified;
  if (!verified) reasons.push('IDENTITY_EVIDENCE_UNVERIFIED');
  if (!value.evidence.evidenceRefs.length) reasons.push('IDENTITY_EVIDENCE_MISSING');
  if (strategy === 'observation_only') reasons.push('NO_USABLE_KEY_OBSERVED');
  const orderedFields = strategy === 'vendor_stable_id' ? [['vendorRecordIdRaw', vendorId]] : fields.map((f) => [f.name, f.value]);
  const relevantScope = [...value.requiredScope].sort().map((key) => {
    const scope = value.scope[key];
    return [key, scope?.state ?? 'unknown', scope?.state === 'known' ? scope.canonical : null];
  });
  const canonicalKey = strategy === 'observation_only' ? null : JSON.stringify([
    ['namespace', value.namespace], ['dataset', value.dataset], ['entityKind', value.entityKind],
    ['contractVersion', value.contractVersion], ['strategy', strategy], ['fields', orderedFields], ['scope', relevantScope],
  ]);
  return { mode: 'observe_only' as const, strategy, canonicalKey,
    keySha256: canonicalKey === null ? null : createHash('sha256').update(canonicalKey).digest('hex'),
    normalization: 'opaque-exact-v1' as const, eligibleForFutureRegistration: reasons.length === 0,
    reasons, evidenceRefs: value.evidence.evidenceRefs,
    sourceRecordId: null, sourceIdentityVerified: false as const, relationshipUsable: false as const };
}
