/**
 * 原请求失败收尾（v4-final R2）的客户端可见语义：纯逻辑、无服务端依赖。
 *
 * 服务端用 `catalog.settle_inventory_pending_action(...)` 结案（单事务 FOR UPDATE，核
 * actor/action/intent/完整 payload；已有成功回执不结案），返回 `InventorySettlement`。
 * 页面只能按这里的结果决定是否解除本地未知记录与新写锁：
 * - `ok:true` 且非 unlockFailed：业务成功，锁已确认解除；
 * - `settled`：原请求确定失败且服务端已确认结案；
 * - `no_pending`：服务端没有登记过该请求（无需解除，本地记录可以先清）；
 * - `settle_failed` / `not_original` / `outcomeUnknown`：一律保留本地记录与锁。
 */
import type { InventoryActionOutcome, InventorySettlement } from './types';

/** 服务端 settle RPC 的原始返回（结构是动态 jsonb，页面/测试只在纯逻辑层解释）。 */
export interface SettleRpcResponse {
  ok?: unknown;
  settled?: unknown;
  reason?: unknown;
}

export interface SettleDecision {
  settlement: InventorySettlement;
  /** 服务端返回的 reason（小写规范化），便于提示与证据；异常/畸形为 null。 */
  reason: string | null;
}

/**
 * settle RPC 响应 → 页面语义。异常/畸形响应必须落到 `settle_failed`（不能当已结案）。
 * 已存在的成功回执（HAS_RECEIPT）也不能改判：原请求必须继续按“核对”处理。
 */
export function mapSettleRpcResponse(response: unknown): SettleDecision {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    return { settlement: 'settle_failed', reason: null };
  }
  const record = response as SettleRpcResponse;
  const reason = typeof record.reason === 'string' && record.reason.trim()
    ? record.reason.trim().toUpperCase()
    : null;
  if (record.ok === true && record.settled === true) {
    return { settlement: reason === 'NO_PENDING' ? 'no_pending' : 'settled', reason };
  }
  if (record.ok === false) {
    if (reason === 'HAS_RECEIPT' || reason === 'NOT_ORIGINAL' || reason === 'FORBIDDEN'
      || reason === 'NOT_PENDING') {
      return { settlement: 'not_original', reason };
    }
    // 未知/非法请求等无法确认结案的分支：保持原请求，按“结案失败”处理。
    return { settlement: 'settle_failed', reason };
  }
  return { settlement: 'settle_failed', reason };
}

/** 页面是否可以在本次结果后清除本地未知记录/重置核对状态/刷新（即锁已确认解除）。 */
export function settlementReleasesLock(
  outcome: Pick<InventoryActionOutcome, 'ok' | 'unlockFailed' | 'settlement'>,
): boolean {
  if (outcome.unlockFailed) return false;
  if (outcome.ok) return true;
  return outcome.settlement === 'settled' || outcome.settlement === 'no_pending';
}

/** `settle_failed` / 结果未知都要回到“先核对”（保留记录与锁，不允许直接重发）。 */
export function settlementResetsToReconcile(
  outcome: Pick<InventoryActionOutcome, 'outcomeUnknown' | 'settlement'>,
): boolean {
  return outcome.outcomeUnknown === true || outcome.settlement === 'settle_failed';
}

/** 结果提示语气：只有真正解除锁的成功才是 ok；结案未确认是 warn；其余拒绝是 error。 */
export function settlementTone(
  outcome: Pick<InventoryActionOutcome, 'ok' | 'unlockFailed' | 'settlement' | 'outcomeUnknown'>,
): 'ok' | 'warn' | 'error' {
  if (settlementReleasesLock(outcome)) return outcome.ok ? 'ok' : 'warn';
  return settlementResetsToReconcile(outcome) ? 'warn' : 'error';
}

/** 结案结果的中文说明（追加在动作原始消息之后；未结案/成功不追加）。 */
export function settlementMessageSuffix(settlement: InventorySettlement | undefined): string | null {
  if (settlement === 'settled') {
    return '原请求已确认结案（服务端已解除原锁）：本地恢复记录已清除，可按提示修正设置/对应后重新操作。';
  }
  if (settlement === 'no_pending') {
    return '服务端没有登记过这次原请求（无需解除原锁）：本地恢复记录已清除，可以重新操作。';
  }
  if (settlement === 'settle_failed') {
    return '原请求结案未确认（服务端异常或连接中断）：原请求仍保留、新写继续锁定，请稍后继续核对，不要直接重发。';
  }
  if (settlement === 'not_original') {
    return '本次调用被拒绝：action/intent/完整参数与原请求不一致，原请求保持原样（仍按原请求核对/重试），不能用改过的参数解除原锁。';
  }
  return null;
}
