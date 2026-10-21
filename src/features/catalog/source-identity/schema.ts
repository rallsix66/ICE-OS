import { z } from 'zod';

export const opaqueIdSchema = z.string().min(1).max(500).refine((s) => s.trim() === s && s.trim().length > 0, 'INVALID_OPAQUE_ID');
const uuid = z.string().uuid(), reason = z.string().min(1).max(1000), ref = z.string().min(1).max(500);
export const observationFieldSchema = z.union([
  z.object({ state: z.literal('value'), value: opaqueIdSchema, evidenceRef: ref }).strict(),
  z.object({ state: z.literal('empty'), value: z.null(), evidenceRef: ref }).strict(),
  z.object({ state: z.literal('not_observed'), value: z.null(), reason, evidenceRef: ref }).strict(),
  z.object({ state: z.literal('parse_failed'), value: z.null(), reason, evidenceRef: ref }).strict(),
]);
export const identityContextSchema = z.union([
  z.object({ state: z.literal('known'), raw: opaqueIdSchema, canonical: opaqueIdSchema, evidenceRef: ref }).strict(),
  z.object({ state: z.literal('unknown'), raw: z.null(), reason }).strict(),
  z.object({ state: z.literal('not_applicable'), raw: z.null(), evidenceRef: ref }).strict(),
]);
export const scopeIdentitySchema = z.object({ system: z.enum(['bigseller', 'jushuitan', 'feishu']),
  entityKind: z.enum(['product_record', 'sku_record']), accountKind: z.enum(['account', 'tenant_account', 'fixture_account']),
  accountParts: z.array(opaqueIdSchema), resourceKind: z.enum(['sheet_tab', 'api_collection', 'fixture_dataset']),
  resourceParts: z.array(opaqueIdSchema), marketRole: z.enum(['identity', 'context']), marketIdentity: opaqueIdSchema.nullable(),
  warehouseRole: z.enum(['identity', 'context']), warehouseIdentity: opaqueIdSchema.nullable(),
}).strict().superRefine((v, c) => {
  if (v.accountParts.length !== (v.accountKind === 'tenant_account' ? 2 : 1)) c.addIssue({ code: 'custom', message: 'ACCOUNT_PARTS_INVALID' });
  if (v.resourceParts.length !== (v.resourceKind === 'sheet_tab' ? 2 : 1)) c.addIssue({ code: 'custom', message: 'RESOURCE_PARTS_INVALID' });
  for (const [role, value] of [[v.marketRole, v.marketIdentity], [v.warehouseRole, v.warehouseIdentity]]) {
    if ((role === 'identity') !== (value !== null)) c.addIssue({ code: 'custom', message: 'IDENTITY_ROLE_VALUE_INVALID' });
  }
});
export const expectedMatchSchema = z.union([z.object({ kind: z.literal('none') }).strict(),
  z.object({ kind: z.literal('record'), recordId: uuid, revision: z.number().int().positive() }).strict()]);
export const registerSourceIdentitySchema = z.object({ requestId: uuid, scopeId: uuid, contractId: uuid, observationId: uuid, proofId: uuid,
  expectedMatch: expectedMatchSchema, reason }).strict();
export const reviseSourceIdentitySchema = z.object({ requestId: uuid, scopeId: uuid, recordId: uuid, expectedRecordRevision: z.number().int().positive(),
  command: z.enum(['open_review', 'suspend', 'revoke', 'reverify']), proofId: uuid, reason,
  contractId: uuid.optional(), observationId: uuid.optional(), expectedClaimId: uuid.optional(),
}).strict().superRefine((v, c) => { if (v.command === 'reverify' && (!v.contractId || !v.observationId || !v.expectedClaimId)) c.addIssue({ code: 'custom', message: 'REVERIFY_INPUT_REQUIRED' }); });
export const linkSourceObservationSchema = z.object({ requestId: uuid, scopeId: uuid, operation: z.enum(['link', 'revoke']), recordId: uuid,
  expectedRecordRevision: z.number().int().positive(), expectedLinkRevision: z.number().int().nonnegative(),
  expectedPreviousRecordRevision: z.number().int().positive().optional(), origin: z.object({ kind: z.enum(['frozen', 'identity']), id: uuid }).strict(), proofId: uuid, reason }).strict();
export const prepareSourceFixtureCaptureSchema = z.object({ fixtureId: z.string().regex(/^[a-z0-9-]+$/) }).strict();
export const importSourceFixtureCaptureSchema = z.object({ fixtureId: z.string().regex(/^[a-z0-9-]+$/), previewId: z.string().regex(/^[a-f0-9]{64}$/), requestId: uuid }).strict();
export const sourceIdentityRequestSchema = z.object({ requestId: uuid, scopeId: uuid, action: z.enum(['import_capture', 'register', 'revise', 'link']), intent: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
