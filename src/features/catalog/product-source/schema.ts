import { z } from 'zod';

const requestId = z.string().uuid();
const snapshotKey = z.string().min(8).max(200);
const issueId = z.string().uuid();
const decisionId = z.string().uuid();
/** 页面可选的说明；空串由数据库按 null 处理。 */
const optionalNote = z.string().max(1000).optional();
const decisionReason = z.string().trim().min(1).max(500);

/** 页面只能提交动作参数；来源键/账号/权限全部由服务端决定，避免跨来源请求。 */
export const applyProductSourceSchema = z.object({
  requestId,
  snapshotKey,
}).strict();

export const retryProductSourceSchema = z.object({
  requestId,
  snapshotKey,
}).strict();

export const resolveProductSourceIssueSchema = z.object({
  requestId,
  issueId,
  resolution: z.enum(['resolved', 'ignored']),
  note: z.string().min(1).max(500),
}).strict();

export const assignProductSourceCodeSchema = z.object({
  requestId,
  itemId: z.string().uuid(),
  expectedRevision: z.number().int().positive(),
  code: z.string().min(1).max(50).refine((value) => value.trim() === value && value.trim().length > 0, '商品编号不得含边缘空白'),
  reason: z.string().min(1).max(500),
}).strict();

export const sourceRequestIdSchema = z.object({ requestId }).strict();

/** 字段级“暂不处理”：登记后本字段的同类事项不再催办，保留现有资料值。 */
export const deferProductSourceFieldSchema = z.object({
  requestId,
  issueId,
  reason: decisionReason,
  note: optionalNote,
}).strict();

/** 字段级“人工口径”：用人工确认的来源值参与后续读取/应用。 */
export const overrideProductSourceFieldSchema = z.object({
  requestId,
  issueId,
  value: z.string().trim().min(1).max(200),
  reason: decisionReason,
  note: optionalNote,
}).strict();

/** 恢复字段级人工决定（下次读取/应用重新提示）。 */
export const restoreProductSourceFieldDecisionSchema = z.object({
  requestId,
  decisionId,
  note: optionalNote,
}).strict();

/** 同号多行人工选择：以指定来源行为准（服务端按内容指纹保存，不依赖行号）。 */
export const decideDuplicateSourceRowSchema = z.object({
  requestId,
  issueId,
  chosenRowNumber: z.number().int().positive(),
  note: optionalNote,
}).strict();

/** 撤销同号多行人工选择（下次读取/应用重新提示）。 */
export const restoreDuplicateSourceDecisionSchema = z.object({
  requestId,
  decisionId,
  note: optionalNote,
}).strict();

export type ApplyProductSourceInput = z.infer<typeof applyProductSourceSchema>;
export type RetryProductSourceInput = z.infer<typeof retryProductSourceSchema>;
export type ResolveProductSourceIssueInput = z.infer<typeof resolveProductSourceIssueSchema>;
export type AssignProductSourceCodeInput = z.infer<typeof assignProductSourceCodeSchema>;
export type DeferProductSourceFieldInput = z.infer<typeof deferProductSourceFieldSchema>;
export type OverrideProductSourceFieldInput = z.infer<typeof overrideProductSourceFieldSchema>;
export type RestoreProductSourceFieldDecisionInput = z.infer<typeof restoreProductSourceFieldDecisionSchema>;
export type DecideDuplicateSourceRowInput = z.infer<typeof decideDuplicateSourceRowSchema>;
export type RestoreDuplicateSourceDecisionInput = z.infer<typeof restoreDuplicateSourceDecisionSchema>;
