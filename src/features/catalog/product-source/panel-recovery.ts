/**
 * Pure UI recovery state machine for the product-source panel.
 *
 * Kept outside the React component so the action→component→original-request
 * contract can be tested without a browser or a database:
 * - a structured `outcomeUnknown` result keeps the pending request (and its
 *   requestId/operation) and therefore keeps the panel locked;
 * - a known failure clears the pending request and releases the panel;
 * - success clears the pending request and asks the page to refresh.
 */

/** UI-only action descriptors. They are never rendered or persisted. */
export type PendingRequest =
  | { kind: 'refresh'; requestId: string }
  | { kind: 'apply'; requestId: string; snapshotKey: string }
  | { kind: 'retry'; requestId: string; snapshotKey: string }
  | {
      kind: 'resolve';
      requestId: string;
      issueId: string;
      resolution: 'resolved' | 'ignored';
      note: string;
    };

/** Structured result returned by the product-source server actions. */
export interface ProductSourceActionOutcome {
  success: boolean;
  error?: string;
  /** true only when the submit outcome is unknown (not a confirmed failure). */
  outcomeUnknown?: boolean;
  data?: { message: string };
}

export interface SubmitResolution {
  /** Non-null means the original request must be kept and new actions stay locked. */
  pending: PendingRequest | null;
  message: string;
  /** true only for a confirmed successful result. */
  refresh: boolean;
}

const OUTCOME_UNKNOWN_MESSAGE = 'CATALOG_REQUEST_OUTCOME_UNKNOWN';

/** Exact sentinel raised by the repository when the commit outcome is unknown. */
export function isOutcomeUnknownError(error: unknown): boolean {
  return error instanceof Error && error.message === OUTCOME_UNKNOWN_MESSAGE;
}

/**
 * Action-layer mapping: only the uncertain-commit sentinel becomes a structured
 * `outcomeUnknown`; confirmed failures keep the normal error-only shape.
 */
export interface ActionFailureOutcome {
  success: false;
  error: string;
  outcomeUnknown?: true;
}

/**
 * Action-layer mapping: only the uncertain-commit sentinel becomes a structured
 * `outcomeUnknown`; confirmed failures keep the normal error-only shape.
 */
export function actionFailureOutcome(error: unknown, message: string): ActionFailureOutcome {
  return {
    success: false,
    error: message,
    ...(isOutcomeUnknownError(error) ? { outcomeUnknown: true } : {}),
  };
}

export function pendingRequestLabel(request: PendingRequest): string {
  switch (request.kind) {
    case 'refresh':
      return '读取最新快照预览';
    case 'apply':
      return '应用本批来源批次';
    case 'retry':
      return '核对/重试原请求';
    case 'resolve':
      return '处理待核对事项';
    default:
      return '来源操作';
  }
}

/** Decide the next component state from one action result. */
export function resolveSubmitOutcome(
  current: PendingRequest,
  result: ProductSourceActionOutcome,
): SubmitResolution {
  if (result.success) {
    return {
      pending: null,
      message: result.data?.message ?? '本次操作已完成。',
      refresh: true,
    };
  }
  if (result.outcomeUnknown) {
    return {
      pending: current,
      message: `提交结果暂未确认。已保留原请求（${pendingRequestLabel(current)}），请使用“核对/重试原请求”，不要发起新操作。`,
      refresh: false,
    };
  }
  return {
    pending: null,
    message: result.error ?? '本次操作未完成；未改写任何商品资料。',
    refresh: false,
  };
}

/** Busy or a retained unknown request keeps every new mutating action locked. */
export function isPanelLocked(busy: boolean, pending: PendingRequest | null): boolean {
  return busy || pending !== null;
}
