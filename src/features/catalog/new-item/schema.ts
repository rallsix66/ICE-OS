import { z } from 'zod';
import { fieldObservationSchema, initialCodeSchema } from '../schema';
import { ADOPTABLE_FIELD_KEYS, NEW_ITEM_ACTIONS } from './types';

export const uuidSchema = z.string().uuid().refine((value) => value === value.toLowerCase(), 'UUID_CANONICAL_REQUIRED');
export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const privateReason = z.string().min(1).max(1000), positive = z.number().int().positive();
const scope = { requestId: uuidSchema, scopeId: uuidSchema };
export const sourceSnapshotSchema = z.object({ recordId: uuidSchema, revision: positive, claimId: uuidSchema }).strict().nullable();
export const approvedFixtureIdSchema = z.string().regex(/^[a-z0-9-]+$/).max(100);
export const prepareProductCaptureSchema = z.object({ approvedFixtureId: approvedFixtureIdSchema }).strict();
export const importProductCaptureSchema = z.object({ requestId: uuidSchema, approvedFixtureId: approvedFixtureIdSchema, previewId: digestSchema }).strict();
export const adoptedFieldKeysSchema = z.array(z.enum(ADOPTABLE_FIELD_KEYS)).min(1).max(ADOPTABLE_FIELD_KEYS.length)
  .refine((keys) => new Set(keys).size === keys.length, 'DUPLICATE_ADOPTED_FIELD');
export const classifyProductObservationSchema = z.object({ ...scope, observationId: uuidSchema, expectedClassificationRevision: z.number().int().nonnegative(),
  classification: z.enum(['new_item', 'item_update', 'external_sku', 'suspected_version']), reviewState: z.enum(['proposed', 'needs_review']),
  proposedItemId: uuidSchema.nullable(), expectedItemRevision: positive.nullable(), proposedFieldKeys: z.array(z.enum(ADOPTABLE_FIELD_KEYS)),
  expectedSourceSnapshot: sourceSnapshotSchema, privateReason }).strict().superRefine((value, ctx) => {
  if ((value.proposedItemId === null) !== (value.expectedItemRevision === null)) ctx.addIssue({ code: 'custom', message: 'ITEM_REVISION_REQUIRED' });
  if (value.classification === 'item_update' && !value.proposedItemId) ctx.addIssue({ code: 'custom', message: 'ITEM_UPDATE_TARGET_REQUIRED' });
});
export const prepareNewItemConfirmationSchema = z.object({ scopeId: uuidSchema, observationId: uuidSchema,
  adoptedFieldKeys: adoptedFieldKeysSchema, initialCode: initialCodeSchema.nullable() }).strict();
export const confirmNewItemSchema = z.object({ ...scope, observationId: uuidSchema, expectedClassificationRevision: positive,
  expectedSourceSnapshot: sourceSnapshotSchema, expectedSourceDisposition: digestSchema, previewId: digestSchema,
  adoptedFieldKeys: adoptedFieldKeysSchema, initialCode: initialCodeSchema.nullable(), privateReason }).strict();
export const associationProofRefSchema = z.object({ captureId: uuidSchema, proofKey: z.string().min(1).max(200) }).strict();
const anchor = z.object({ kind: z.literal('baseline_anchor'), releaseId: uuidSchema, artifactId: uuidSchema, jsonPointer: z.string().min(1) }).strict();
const origin = z.object({ kind: z.literal('origin'), originId: uuidSchema }).strict();
export const associateExistingItemSchema = z.object({ ...scope, observationId: uuidSchema, expectedClassificationRevision: positive,
  expectedSourceDisposition: digestSchema, previewId: digestSchema, privateReason,
  basis: z.discriminatedUnion('kind', [z.object({ kind: z.literal('source_slot') }).strict(),
    z.object({ kind: z.literal('catalog_proof'), basisAnchorOrOrigin: z.union([anchor, origin]), associationProofRef: associationProofRefSchema,
      targetItemId: uuidSchema, expectedItemRevision: positive }).strict()]) }).strict();
export const attachSourceIdentitySchema = z.object({ ...scope, originId: uuidSchema, observationId: uuidSchema, itemId: uuidSchema,
  expectedItemRevision: positive, sourceRecordId: uuidSchema, expectedRecordRevision: positive, expectedClaimId: uuidSchema,
  supportIdentityObservationId: uuidSchema, expectedSourceDisposition: digestSchema,
  associationProofRef: associationProofRefSchema.nullable(), privateReason }).strict();
export const assignNewItemCodeSchema = z.object({ ...scope, itemId: uuidSchema, expectedRevision: positive, code: initialCodeSchema, privateReason }).strict();
export const newItemFieldPatchSchema = z.object(Object.fromEntries(ADOPTABLE_FIELD_KEYS.map((key) => [key, fieldObservationSchema.optional()])) as Record<typeof ADOPTABLE_FIELD_KEYS[number], z.ZodOptional<typeof fieldObservationSchema>>)
  .strict().refine((value) => Object.keys(value).length > 0, 'FIELD_PATCH_REQUIRED');
export const appendNewItemRevisionSchema = z.object({ ...scope, itemId: uuidSchema, expectedRevision: positive, fields: newItemFieldPatchSchema, privateReason }).strict();
export const newItemReceiptSchema = z.object({ ...scope, action: z.enum(NEW_ITEM_ACTIONS), intent: digestSchema }).strict();
export const readNewItemSchema = z.object({ scopeId: uuidSchema, observationId: uuidSchema.nullable().default(null),
  projection: z.enum(['safe', 'sensitive_history']).default('safe') }).strict();
export const prepareSourceSlotSchema = z.object({ scopeId: uuidSchema, observationId: uuidSchema }).strict();
export const prepareCatalogProofSchema = z.object({ scopeId: uuidSchema, observationId: uuidSchema, associationProofRef: associationProofRefSchema }).strict();
export const prepareAttachIdentitySchema = z.object({ scopeId: uuidSchema, observationId: uuidSchema, associationProofRef: associationProofRefSchema }).strict();
export type ClassifyProductObservationInput = z.infer<typeof classifyProductObservationSchema>;
export type ConfirmNewItemInput = z.infer<typeof confirmNewItemSchema>;
export type AssociateExistingItemInput = z.infer<typeof associateExistingItemSchema>;
export type AttachSourceIdentityInput = z.infer<typeof attachSourceIdentitySchema>;
export type AssignNewItemCodeInput = z.infer<typeof assignNewItemCodeSchema>;
export type AppendNewItemRevisionInput = z.infer<typeof appendNewItemRevisionSchema>;
