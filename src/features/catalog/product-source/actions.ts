'use server';

import { revalidatePath } from 'next/cache';
import type { ActionResult } from '@/types/common';
import { actionFailureOutcome } from './panel-recovery';
import {
  applyProductSourceSnapshot,
  assignSourceCodeToItem,
  checkProductSourceRequestOutcome,
  getProductSourcePanel,
  refreshProductSourceSnapshot,
  resolveProductSourceIssueById,
  retryProductSourceSnapshot,
} from './service';

/** 不向页面回显 SQL 细节、路径、UUID 或价格。 */
const KNOWN_ERRORS: Record<string, string> = {
  CATALOG_FORBIDDEN: '当前账户无权处理商品来源更新。',
  CATALOG_UNAVAILABLE: '商品来源更新仅在独立本地平台模式中可用。',
  CATALOG_REVISION_CONFLICT: '商品资料版本已变化，本项未覆盖；请刷新后重新核对。',
  CATALOG_REQUEST_CONFLICT: '请求编号已用于另一项来源操作，请核对原请求。',
  CATALOG_REQUEST_OUTCOME_UNKNOWN: '提交结果暂未确认。请保留原请求编号核对状态，勿创建新请求重复操作。',
  CATALOG_PLAN_STALE: '生成本批计划后商品资料又被修改，本项未覆盖；请重新读取并核对。',
  CATALOG_SOURCE_RETRY_NOT_APPLICABLE: '最近批次不是“部分完成/失败”，当前没有可补做的失败商品。',
  CATALOG_SOURCE_RETRY_NOTHING: '没有可补做的失败商品项；请重新读取快照或核对原批次。',
  CATALOG_SOURCE_RETRY_NOT_FAILED: '补做请求包含原批次未失败的商品，已拒绝；成功商品不会重复修订。',
  CATALOG_SNAPSHOT_CONFLICT: '该来源快照与已保存内容冲突，未覆盖。',
  PRODUCT_SOURCE_SNAPSHOT_NOT_FOUND: '没有找到可读的来源快照文件，请重新采集本地快照。',
  FEISHU_API_NOT_CONFIGURED: '飞书 API 尚未开通；本包使用本地模拟读取。',
};

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (KNOWN_ERRORS[message]) return KNOWN_ERRORS[message];
  if (message === 'CATALOG_INVALID_INPUT' || message.startsWith('CATALOG_INVALID')) return '提交内容不完整或格式不正确，本次未处理。';
  if (message.includes('未登录') || message.includes('无权限') || message.includes('停用')) return '请使用启用的管理员账户处理来源更新。';
  return '来源更新操作未完成。请确认权限、当前版本及请求状态后重试。';
}

export type ProductSourceActionResult<T> = ActionResult<T> & {
  /**
   * Structured "submit outcome unknown" marker. It is true only for the
   * uncertain-commit sentinel, never for a confirmed failure; the page keeps
   * the original requestId and locks new operations until the receipt is found.
   */
  outcomeUnknown?: boolean;
};

async function perform<T>(fn: () => Promise<T>, mutation = false): Promise<ProductSourceActionResult<T>> {
  try {
    const data = await fn();
    if (mutation) {
      try { revalidatePath('/dashboard/catalog', 'layout'); } catch { /* committed result stays valid */ }
    }
    return { success: true, data };
  } catch (error) {
    return actionFailureOutcome(error, errorMessage(error));
  }
}

export async function getProductSourcePanelAction() {
  return perform(() => getProductSourcePanel());
}

export async function refreshProductSourceAction(input: unknown) {
  return perform(() => refreshProductSourceSnapshot(input));
}

export async function applyProductSourceAction(input: unknown) {
  return perform(() => applyProductSourceSnapshot(input), true);
}

export async function retryProductSourceAction(input: unknown) {
  return perform(() => retryProductSourceSnapshot(input), true);
}

export async function resolveProductSourceIssueAction(input: unknown) {
  return perform(() => resolveProductSourceIssueById(input), true);
}

export async function assignProductSourceCodeAction(input: unknown) {
  return perform(() => assignSourceCodeToItem(input), true);
}

export async function checkProductSourceOutcomeAction(requestId: string) {
  return perform(() => checkProductSourceRequestOutcome(requestId));
}
