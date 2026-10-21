import { z } from 'zod';

const evidenceRef = z.string().min(1).max(500);
// Nested strict union forbids cross-state fields and distinguishes actual zero.
export const fieldObservationSchema = z.union([
  z.object({ state: z.literal('observed'), meaning: z.literal('value'), raw: z.string().min(1), evidenceRef }).strict(),
  z.object({ state: z.literal('observed'), meaning: z.literal('explicit_empty'), raw: z.literal(''), evidenceRef }).strict(),
  z.object({ state: z.literal('observed'), meaning: z.literal('explicit_null'), raw: z.null(), evidenceRef }).strict(),
  z.object({ state: z.literal('no_text'), raw: z.null(), evidenceRef }).strict(),
  z.object({ state: z.literal('not_read'), raw: z.null(), reason: z.string().min(1), evidenceRef }).strict(),
  z.object({ state: z.literal('parse_failed'), raw: z.null(), reason: z.string().min(1), evidenceRef }).strict(),
]);
export const scopeValueSchema = z.union([
  z.object({ state: z.literal('known'), raw: z.string().min(1), canonical: z.string().min(1), evidenceRef }).strict(),
  z.object({ state: z.literal('unknown'), raw: z.null(), reason: z.string().min(1) }).strict(),
  z.object({ state: z.literal('not_applicable'), raw: z.null(), evidenceRef }).strict(),
]);
export const requestIdSchema = z.string().uuid();
export const initialCodeSchema = z.string().min(1).max(50).refine((s) => s.trim() === s && s.trim().length > 0, '货号不得含边缘空白');
export const assignInitialCodeSchema = z.object({ itemId: z.string().uuid(), expectedRevision: z.number().int().positive(),
  requestId: requestIdSchema, code: initialCodeSchema, reason: z.string().min(1).max(1000) }).strict();
export const nonPriceFieldsSchema = z.object({
  nameCn: fieldObservationSchema.optional(), specification: fieldObservationSchema.optional(),
  factory: fieldObservationSchema.optional(), imageRef: fieldObservationSchema.optional(),
  barcode: fieldObservationSchema.optional(), packaging: fieldObservationSchema.optional(),
  cartonQuantity: fieldObservationSchema.optional(), englishName: fieldObservationSchema.optional(),
}).strict().refine((v) => Object.keys(v).length > 0, '至少一个非价格字段');
export const appendNonPriceRevisionSchema = z.object({ itemId: z.string().uuid(), expectedRevision: z.number().int().positive(),
  requestId: requestIdSchema, reason: z.string().min(1).max(1000), fields: nonPriceFieldsSchema }).strict();

export const publishBaselineSchema = z.object({ requestId: requestIdSchema, previewId: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const importFrozenObservationsSchema = z.object({ requestId: requestIdSchema, approvedSnapshotId: z.literal('feishu-partial-20261020-v2') }).strict();
