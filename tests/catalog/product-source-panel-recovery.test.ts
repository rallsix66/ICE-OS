/**
 * Targeted page recovery contract:
 * unknown action result keeps the original requestId/operation and locks new
 * operations; retrying the SAME request then finding the original receipt
 * releases the panel. Confirmed failures release immediately.
 */
import { describe, expect, it } from 'vitest';
import {
  actionFailureOutcome,
  isOutcomeUnknownError,
  isPanelLocked,
  pendingRequestLabel,
  resolveSubmitOutcome,
  type PendingRequest,
} from '../../src/features/catalog/product-source/panel-recovery';

const APPLY: PendingRequest = {
  kind: 'apply',
  requestId: '11111111-1111-4111-8111-111111111301',
  snapshotKey: 'snapshot-key-ui-unknown',
};

describe('product source panel recovery state', () => {
  it('keeps the original request and locks new operations when the outcome is unknown', () => {
    const next = resolveSubmitOutcome(APPLY, {
      success: false,
      error: '提交结果暂未确认。请保留原请求编号核对状态，勿创建新请求重复操作。',
      outcomeUnknown: true,
    });

    expect(next.pending).toBe(APPLY);
    expect(next.pending?.requestId).toBe(APPLY.requestId);
    expect(next.refresh).toBe(false);
    expect(next.message).toContain('已保留原请求');
    expect(next.message).toContain('核对/重试原请求');
    expect(isPanelLocked(false, next.pending)).toBe(true);
  });

  it('releases the panel for a confirmed failure', () => {
    const next = resolveSubmitOutcome(APPLY, {
      success: false,
      error: '该快照早于最近成功批次，已拒绝，未覆盖新结果。',
    });

    expect(next.pending).toBeNull();
    expect(next.refresh).toBe(false);
    expect(next.message).toContain('早于最近成功批次');
    expect(isPanelLocked(false, next.pending)).toBe(false);
  });

  it('clears the retained request after the same original request returns a receipt', () => {
    const unknown = resolveSubmitOutcome(APPLY, { success: false, outcomeUnknown: true });
    expect(isPanelLocked(false, unknown.pending)).toBe(true);

    // The UI retry path reuses the retained requestId/snapshotKey and gets the receipt.
    const retained = unknown.pending as Extract<PendingRequest, { kind: 'apply' }>;
    expect(retained.requestId).toBe(APPLY.requestId);
    expect(retained.snapshotKey).toBe((APPLY as Extract<PendingRequest, { kind: 'apply' }>).snapshotKey);
    const recovered = resolveSubmitOutcome(retained, {
      success: true,
      data: { message: '已核对到原请求回执（部分完成）：已更新 1；未重复修订。' },
    });

    expect(recovered.pending).toBeNull();
    expect(recovered.refresh).toBe(true);
    expect(recovered.message).toContain('原请求回执');
    expect(isPanelLocked(false, recovered.pending)).toBe(false);
  });

  it('classifies only the uncertain-commit sentinel as outcome unknown', () => {
    expect(isOutcomeUnknownError(new Error('CATALOG_REQUEST_OUTCOME_UNKNOWN'))).toBe(true);
    expect(isOutcomeUnknownError(new Error('CATALOG_PLAN_STALE'))).toBe(false);
    expect(isOutcomeUnknownError(new Error('CATALOG_REQUEST_CONFLICT'))).toBe(false);
    expect(isOutcomeUnknownError('CATALOG_REQUEST_OUTCOME_UNKNOWN')).toBe(false);

    const unknown = actionFailureOutcome(new Error('CATALOG_REQUEST_OUTCOME_UNKNOWN'), '提交结果暂未确认。');
    expect(unknown.outcomeUnknown).toBe(true);
    expect(unknown.success).toBe(false);
    const known = actionFailureOutcome(new Error('CATALOG_PLAN_STALE'), '计划已过期。');
    expect(known.outcomeUnknown).toBeUndefined();
    expect(known.success).toBe(false);
  });

  it('keeps the operation label for the retained request', () => {
    expect(pendingRequestLabel(APPLY)).toBe('应用本批来源批次');
    expect(pendingRequestLabel({ kind: 'retry', requestId: 'id', snapshotKey: 'key' })).toBe('核对/重试原请求');
  });
});
