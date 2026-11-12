'use server';

import { revalidatePath } from 'next/cache';
import type { ActionResult } from '@/types/common';
import { actionFailureOutcome } from './panel-recovery';
import {
  applyProductSourceSnapshot,
  assignSourceCodeToItem,
  checkProductSourceRequestOutcome,
  decideDuplicateSourceRow,
  deferProductSourceField,
  getProductSourcePanel,
  overrideProductSourceField,
  readProductSourceNow,
  refreshProductSourceSnapshot,
  resolveProductSourceIssueById,
  restoreDuplicateSourceDecision,
  restoreProductSourceFieldDecision,
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
  PRODUCT_SOURCE_SNAPSHOT_NOT_FOUND: '没有找到可读的来源快照文件，请先读取飞书来源。',
  CATALOG_SOURCE_ISSUE_NOT_OPEN: '该事项已被处理或已由新批次替代，请刷新。',
  CATALOG_SOURCE_ISSUE_NOT_ITEM: '该事项没有对应商品，不能按字段登记。',
  CATALOG_SOURCE_ISSUE_NOT_DUPLICATE: '该事项不是同号多行，不能做行选择。',
  CATALOG_SOURCE_ROW_NOT_FOUND: '来源行已变化，请刷新后重新选择。',
  CATALOG_SOURCE_ROW_CHANGED: '来源行内容已变化，请刷新后重新选择。',
  CATALOG_SOURCE_DECISION_NOT_ACTIVE: '该决定已恢复/失效，请刷新。',
  CATALOG_CODE_INVALID: '货号格式不正确（不能使用 TEST- 测试码）。',
  FEISHU_API_NOT_CONFIGURED: '飞书 API 尚未开通；本包使用本地模拟读取。',
  FEISHU_CLI_MISSING: '本机未找到可用的飞书 CLI（lark-cli），请确认已安装并完成授权后再读取。',
  FEISHU_CLI_FAILED: '飞书接口读取失败（授权、权限或网络异常）；本次没有生成新快照，商品资料未改动。',
  FEISHU_CLI_TIMEOUT: '飞书接口读取超时；本次没有生成新快照，商品资料未改动。',
  FEISHU_CLI_BAD_JSON: '飞书接口返回内容无法解析；本次没有生成新快照，商品资料未改动。',
  FEISHU_DOC_INVALID: '飞书文档节点与登记的电子表格不一致，请核对来源链接。',
  FEISHU_SHEET_MISSING: '未找到登记的工作表 Sheet1，读取已停止，商品资料未改动。',
  FEISHU_HEADER_INVALID: '来源表头与字段规则不一致，读取已停止，商品资料未改动；请核对表格列名。',
  FEISHU_GRID_INVALID: '来源读取范围不完整（行/列数与工作表不一致），本次没有应用。',
  FEISHU_READ_INCOMPLETE: '来源读取不完整（可能被截断），本次没有应用。',
  FEISHU_EMPTY_PAYLOAD: '来源没有有效业务行，本次没有应用。',
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

/** 手动真实读取飞书来源（只读飞书 + 只生成待应用快照，不写商品）。 */
export async function readProductSourceNowAction() {
  return perform(() => readProductSourceNow());
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

/** 字段级“暂不处理此字段”（后续批次不再催办，可恢复）。 */
export async function deferProductSourceFieldAction(input: unknown) {
  return perform(() => deferProductSourceField(input), true);
}

/** 字段级“人工口径”（用人工确认的来源值，关闭本条事项）。 */
export async function overrideProductSourceFieldAction(input: unknown) {
  return perform(() => overrideProductSourceField(input), true);
}

/** 恢复字段级人工决定（下次读取/应用重新提示）。 */
export async function restoreProductSourceFieldAction(input: unknown) {
  return perform(() => restoreProductSourceFieldDecision(input), true);
}

/** 同号多行人工选择：以指定来源行为准。 */
export async function decideDuplicateSourceRowAction(input: unknown) {
  return perform(() => decideDuplicateSourceRow(input), true);
}

/** 撤销同号多行人工选择（下次读取/应用重新提示）。 */
export async function restoreDuplicateSourceDecisionAction(input: unknown) {
  return perform(() => restoreDuplicateSourceDecision(input), true);
}

export async function checkProductSourceOutcomeAction(requestId: string) {
  return perform(() => checkProductSourceRequestOutcome(requestId));
}
