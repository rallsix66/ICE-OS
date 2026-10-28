import { z } from 'zod';

const requestId = z.string().uuid();
const snapshotKey = z.string().min(8).max(200);
const issueId = z.string().uuid();

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

export type ApplyProductSourceInput = z.infer<typeof applyProductSourceSchema>;
export type RetryProductSourceInput = z.infer<typeof retryProductSourceSchema>;
export type ResolveProductSourceIssueInput = z.infer<typeof resolveProductSourceIssueSchema>;
export type AssignProductSourceCodeInput = z.infer<typeof assignProductSourceCodeSchema>;
