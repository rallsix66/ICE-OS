'use server';

import { revalidatePath } from 'next/cache';
import type { ActionResult } from '@/types/common';
import { appendCatalogNonPriceRevision, assignCatalogInitialCode, getCatalogAmounts, importCatalogFrozenObservations,
  prepareCatalogBaseline, publishCatalogBaseline, recoverCatalogNewItemRequest } from './service';

/** Never echo PostgreSQL details, Zod input values, paths or financial source data. */
async function perform<T>(fn: () => Promise<T>, mutation = false): Promise<ActionResult<T> & { outcome?: 'unknown' }> {
  try {
    const data = await fn();
    // A committed operation stays successful if optional cache invalidation
    // fails. These pages are dynamic and the caller refreshes after success.
    if (mutation) {
      try { revalidatePath('/dashboard/catalog', 'layout'); } catch { /* preserve the known committed result */ }
    }
    return { success: true, data };
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const known: Record<string, string> = {
      CATALOG_REVISION_CONFLICT: '资料版本已变化，本次操作冲突；请刷新后核对。',
      CATALOG_REQUEST_CONFLICT: '请求编号已用于另一项操作，请核对原请求。',
      CATALOG_CODE_IMMUTABLE: '这份资料已有首次货号，首包不允许改号或重新分配。',
      CATALOG_BASELINE_CONFLICT: '冻结基线与已承接内容冲突，未覆盖当前资料。',
      CATALOG_SNAPSHOT_CONFLICT: '冻结观测内容冲突，未覆盖已有观测。',
      CATALOG_PREVIEW_CHANGED: '预览内容已变化，请重新准备固定基线预览。',
      CATALOG_REQUEST_OUTCOME_UNKNOWN: '提交结果暂未确认。请保留原请求编号核对状态，勿创建新请求重复操作。',
      REQUEST_OUTCOME_UNKNOWN: '提交结果暂未确认。请保留原请求编号并独立核对，勿创建新请求重复操作。',
      NEW_ITEM_SCOPED_ACTION_REQUIRED: '这份资料需要当前来源范围的发布权限，本次操作未执行。',
      NEW_ITEM_REVISION_CONFLICT: '资料版本已变化，本次操作冲突；请刷新后核对。',
      IMAGE_PUBLICATION_NOT_IMPLEMENTED: '本包不发布新品图片引用，原图片证据受限保留。',
      CATALOG_FORBIDDEN: '当前账户无权访问商品资料。',
      CATALOG_UNAVAILABLE: '商品资料仅在独立本地平台模式中可用。',
      '未登录或账户已停用': '请使用启用的管理员账户访问商品资料。',
      '无权限：需要管理员角色': '当前账户无权访问商品资料。',
    };
    const constraint = typeof error === 'object' && error !== null && 'constraint' in error ? String(error.constraint) : '';
    const duplicateCode = constraint === 'catalog_item_code_ice_code_key' || constraint === 'catalog_item_code_pkey';
    return { success: false, ...(['CATALOG_REQUEST_OUTCOME_UNKNOWN', 'REQUEST_OUTCOME_UNKNOWN'].includes(message) ? { outcome: 'unknown' as const } : {}),
      error: duplicateCode ? '货号或首次分配声明已被使用，本次操作冲突。' :
      known[message] ?? '商品资料操作未完成。请确认权限、当前版本及请求状态后重试。' };
  }
}

export async function prepareBaselineAction() { return perform(prepareCatalogBaseline); }
export async function publishBaselineAction(input: unknown) { return perform(() => publishCatalogBaseline(input), true); }
export async function importFrozenObservationsAction(input: unknown) { return perform(() => importCatalogFrozenObservations(input), true); }
export async function assignInitialCodeAction(input: unknown) { return perform(() => assignCatalogInitialCode(input), true); }
export async function appendNonPriceRevisionAction(input: unknown) { return perform(() => appendCatalogNonPriceRevision(input), true); }
export async function getCatalogAmountsAction(itemId: string) { return perform(() => getCatalogAmounts(itemId)); }
export async function recoverCatalogNewItemRequestAction(input: { kind: 'initial_code' | 'nonprice_revision'; input: unknown }) {
  return perform(() => recoverCatalogNewItemRequest(input));
}
