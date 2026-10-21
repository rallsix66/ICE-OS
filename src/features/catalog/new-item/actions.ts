'use server';

import { revalidatePath } from 'next/cache';
import type { ActionResult } from '@/types/common';
import { appendNewItemRevision, assignNewItemCode, associateExistingItem, attachSourceIdentity, classifyProductObservation, confirmNewItem,
  importProductCapture, prepareNewItemConfirmation, prepareProductCapture, prepareSourceSlotAssociation, recoverNewItemRequest,
  readNewItemSensitiveHistory, prepareCatalogProofAssociation, prepareAttachSourceIdentity } from './service';

async function perform<T>(operation: () => Promise<T>, mutation = false): Promise<ActionResult<T> & { outcome?: 'unknown'; code?: string }> {
  try {
    const data = await operation();
    if (mutation) { try { revalidatePath('/dashboard/catalog', 'layout'); } catch { /* committed result is authoritative */ } }
    return { success: true, data };
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const safe: Record<string, string> = {
      REQUEST_OUTCOME_UNKNOWN: '提交结果暂未确认，请保留原请求并独立核对，勿发起另一请求。',
      REQUEST_CONFLICT: '原请求已用于另一项意图，未重复执行。',
      NEW_ITEM_INTENT_CONFLICT: '该观测已有不同建档决定，请核对原记录。',
      NEW_ITEM_REVISION_CONFLICT: '商品资料版本已变化，请刷新后核对。',
      CLASSIFICATION_CONFLICT: '分类版本已变化，请刷新后核对。',
      SOURCE_DISPOSITION_CONFLICT: '来源或目标历史已变化，请重新准备预览。',
      SOURCE_ALREADY_CLAIMED: '该来源已有创建出处，请核对原商品。',
      NEW_ITEM_REVIEW_REQUIRED: '来源身份、版本风险或原决定仍需核对，未新增商品。',
      ASSOCIATION_PROOF_REQUIRED: '缺少覆盖本次两端的批准证据，未建立关联。',
      ASSOCIATION_PROOF_INVALID: '关联证据与本次两端不一致，未建立关联。',
      CROSS_SCOPE_ASSOCIATION_REQUIRED: '此项关联需要另行核实跨范围证据，本包未执行。',
      FROZEN_TARGET_PRESENT: '来源已有冻结人工决定，未通过新建覆盖。',
      B_TARGET_HISTORY_PRESENT: '来源已有目标或撤回历史，未通过新建覆盖。',
      B_PROVIDER_REQUIRED: '目标历史接口尚不完整，本次操作未执行。',
      PRODUCT_CAPTURE_ENVELOPE_INVALID: '商品观测封套或时间格式不合法，未导入。',
      PRODUCT_CAPTURE_PIN_CONFLICT: '固定资料、预览或受信封套不一致，未导入。',
      IMAGE_PUBLICATION_NOT_IMPLEMENTED: '本包不发布图片引用，原图片证据仍受限保留。',
      NEW_ITEM_MODULE_DISABLED: '持续新品模块尚未在本次隔离环境启用。',
      NEW_ITEM_FORBIDDEN: '当前账号没有本次来源或发布权限。',
      NEW_ITEM_SCOPED_ACTION_REQUIRED: '这份资料须通过当前来源范围授权操作。',
    };
    const known = Object.hasOwn(safe, message);
    return { success: false, ...(message === 'REQUEST_OUTCOME_UNKNOWN' ? { outcome: 'unknown' as const } : {}),
      code: known ? message : 'NEW_ITEM_OPERATION_DENIED', error: known ? safe[message] : '操作未完成，请核对当前权限、证据与资料版本。' };
  }
}
export async function prepareProductCaptureAction(input: unknown) { return perform(() => prepareProductCapture(input)); }
export async function importProductCaptureAction(input: unknown) { return perform(() => importProductCapture(input), true); }
export async function classifyProductObservationAction(input: unknown) { return perform(() => classifyProductObservation(input), true); }
export async function prepareNewItemConfirmationAction(input: unknown) { return perform(() => prepareNewItemConfirmation(input)); }
export async function confirmNewItemAction(input: unknown) { return perform(() => confirmNewItem(input), true); }
export async function prepareSourceSlotAssociationAction(input: unknown) { return perform(() => prepareSourceSlotAssociation(input)); }
export async function prepareCatalogProofAssociationAction(input: unknown) { return perform(() => prepareCatalogProofAssociation(input)); }
export async function prepareAttachSourceIdentityAction(input: unknown) { return perform(() => prepareAttachSourceIdentity(input)); }
export async function associateExistingItemAction(input: unknown) { return perform(() => associateExistingItem(input), true); }
export async function attachSourceIdentityAction(input: unknown) { return perform(() => attachSourceIdentity(input), true); }
export async function assignNewItemCodeAction(input: unknown) { return perform(() => assignNewItemCode(input), true); }
export async function appendNewItemRevisionAction(input: unknown) { return perform(() => appendNewItemRevision(input), true); }
export async function recoverNewItemRequestAction(input: unknown) { return perform(() => recoverNewItemRequest(input)); }
export async function readNewItemSensitiveHistoryAction(input: unknown) { return perform(() => readNewItemSensitiveHistory(input)); }
