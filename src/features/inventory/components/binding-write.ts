'use client';

import type { InventoryActionOutcome } from '../types';
import { settlementReleasesLock, settlementTone } from '../settlement';
import { clearLocalUnknownRequest } from '../client-pending';
import { registerOriginalRequest } from './pending-recovery';

/**
 * 详情内绑定编辑（UI-1/UI-2）的统一写入口：
 * 先登记原请求 → 服务端确认登记 → 执行原动作 → 按 settlement 语义解除本地记录。
 *
 * 与既有对应维护页共用同一套 pending/请求/审计机制，不另建写锁：
 * - 登记确定失败：不执行，保留页面选择，展示原因；
 * - 登记未知：保留本地记录并提示刷新核对（reload=true），绝不自动重发；
 * - 业务结果未知：保留本地记录/锁，提示从“原请求待核对”恢复；
 * - 确定失败：按服务端结案结果决定是否解除本地锁，失败时保留选择供修改。
 */
export type BindingWriteTone = 'ok' | 'warn' | 'error';

export interface BindingWriteResult {
  tone: BindingWriteTone;
  message: string;
  /** true = 需要整页重载进入恢复入口（登记未知/连接中断）；调用方不要再自动重发。 */
  reload: boolean;
}

export interface BindingWriteInput {
  /** 调用方生成的 requestId（同一次保存从生成到结束只用一个）。 */
  requestId: string;
  /** 'confirm_inventory_mapping' | 'replace_inventory_mapping'。 */
  action: string;
  /** 与服务端按同一 payload 重算一致的 intent。 */
  intent: string;
  /** 写入 pending 登记的完整 payload（与服务端重算 intent 的内容一致）。 */
  payload: Record<string, unknown>;
  /** 服务端读取/登记回执给出的身份，客户端不自报。 */
  viewer: { actorId: string; accountId: string | null } | null;
  execute: () => Promise<InventoryActionOutcome>;
}

export async function executeBindingWrite(input: BindingWriteInput): Promise<BindingWriteResult> {
  const registration = await registerOriginalRequest({
    requestId: input.requestId,
    action: input.action,
    intent: input.intent,
    payload: input.payload,
    viewer: input.viewer
      ? { actorId: input.viewer.actorId, accountId: input.viewer.accountId ?? '' }
      : null,
  });
  if (!registration.registered) {
    return {
      tone: registration.unknown ? 'warn' : 'error',
      message: registration.message,
      reload: registration.unknown,
    };
  }
  try {
    const result = await input.execute();
    if (result.outcomeUnknown) {
      const tone = settlementTone(result);
      return {
        tone: tone === 'ok' ? 'warn' : tone,
        message: result.message,
        reload: false,
      };
    }
    // R1：请求成功不等于该条真正生效。批量确认对版本冲突/单位冲突可返回 ok:true + applied:0 + skipped；
    // 单条编辑必须按结构化业务结果判定，不能把“0 条采用”显示成成功。
    // 服务端已结案（没有可恢复的未知结果），所以先按 settlement 清本地未知记录，避免留下假锁。
    if (settlementReleasesLock(result)) clearLocalUnknownRequest(input.requestId);
    if (result.ok && result.applied === 0) {
      return { tone: 'error', message: result.message, reload: false };
    }
    return { tone: settlementTone(result), message: result.message, reload: false };
  } catch {
    return {
      tone: 'warn',
      message: '提交结果暂未确认（连接中断）。已保留本次选择与原请求；刷新页面后从“原请求待核对”入口核对，不要重复提交。',
      reload: true,
    };
  }
}
