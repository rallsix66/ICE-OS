'use server';

import { revalidatePath } from 'next/cache';
import type { ActionResult } from '@/types/common';
import { appendCatalogNonPriceRevision, assignCatalogInitialCode, checkCatalogRequestOutcome, getCatalogAdminDecisionsPage,
  getCatalogAdminObservationsPage, getCatalogAmounts, getCatalogDetailArtifacts, getCatalogDetailAudit, getCatalogDetailCore,
  getCatalogDetailHistoryDisplay, getCatalogDetailRevision, getCatalogDetailView, getCatalogItemBsSample, getCatalogRevisionEvidence,
  importCatalogFrozenObservations, prepareCatalogBaseline, publishCatalogBaseline, recoverCatalogNewItemRequest } from './service';
import { getNewItemDetailPanel } from './new-item/service';
import { getCatalogSourceView } from './source-view';
import { getSourceIdentityPanel } from './source-identity/service';
import { classifyCatalogReadFailure } from './issues/entry-state';
import type { CatalogReadFailureKind } from './issues/entry-state';
import type { AttachmentSideKey, AttachmentSideStatus, DetailAttachmentSide, DetailAttachmentsState } from './components/detail-attachments';

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
      IMAGE_PUBLICATION_NOT_IMPLEMENTED: '本包不发布新品图片引用，原图片证明保留。',
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

export async function fetchCatalogDetailViewAction(itemId: string, warehouse?: string) {
  return perform(() => getCatalogDetailView(itemId, warehouse?.trim() || undefined));
}

/**
 * 历史版本等只读读取：失败必须分类后显式返回，**不得**静默回退当前资料。
 * 不存在/无权沿用同一安全文案（防枚举），网络失败单独提示可重试。
 */
async function performRead<T>(fn: () => Promise<T>): Promise<ActionResult<T> & { errorKind?: CatalogReadFailureKind }> {
  try {
    return { success: true, data: await fn() };
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const notFound = message === 'CATALOG_NOT_FOUND' || message === 'CATALOG_INVALID_INPUT' || message === 'CATALOG_FORBIDDEN';
    const kind = notFound ? 'forbidden' : classifyCatalogReadFailure(error);
    return {
      success: false,
      errorKind: kind,
      error: notFound
        ? '未找到该商品或该版本；历史版本不存在时不会回退到当前资料。'
        : kind === 'unavailable'
          ? '商品资料仅在独立本地平台模式中可用。'
          : kind === 'forbidden'
            ? '当前账户无权访问商品资料。'
            : '历史版本读取失败（网络或传输异常）；不会回退到当前资料，可重试。',
    };
  }
}

/** V3-01.3 历史记录日常投影（中文理由/时间/字段差异；不含 UUID、证据路径、内部英文 reason）。 */
export async function fetchCatalogDetailHistoryAction(itemId: string) {
  return perform(() => getCatalogDetailHistoryDisplay(itemId));
}

/** V3-01.2 历史版本核心（弹窗内只读查看，替代独立历史页）。 */
export async function fetchCatalogDetailRevisionAction(itemId: string, revision: number) {
  return performRead(() => getCatalogDetailRevision(itemId, revision));
}

/**
 * V3-01.4 授权原始证据：只在弹窗内“来源与证据”子视图按需读取（权限同 history:read）。
 */
export async function fetchCatalogRevisionEvidenceAction(itemId: string, revision: number) {
  return performRead(() => getCatalogRevisionEvidence(itemId, revision));
}

/**
 * V3-04.5 只读核对原请求回执：不重发、不写业务；no_receipt 不代表“未提交”。
 */
export async function checkCatalogRequestOutcomeAction(input: unknown) {
  return perform(() => checkCatalogRequestOutcome(input));
}

export async function fetchCatalogDetailAuditAction(itemId: string) {
  return perform(() => getCatalogDetailAudit(itemId));
}

/** V4-02：商品“数据来源”业务视图；历史 revision 只返回该版本保存事实，不自动读取当前来源。 */
export async function fetchCatalogSourceViewAction(itemId: string, revision = 0) {
  return performRead(() => getCatalogSourceView(itemId, revision));
}

export async function fetchCatalogDetailArtifactsAction() {
  return perform(() => getCatalogDetailArtifacts());
}

const ATTACHMENT_SIDE_MESSAGES = {
  disabled: '该模块当前未启用；既有冻结资料与人工选择保持，不当作 0 项。',
  forbidden: '账号没有这一侧的读取权限（服务端拒绝）；这不代表没有记录，也不等于模块未启用。',
  read_failed: '读取失败（网络或传输异常）；这不等于未启用，也不当作 0 项。可单独重试这一侧。',
  invalid: '商品标识无效，无法读取这一侧的附件。',
} as const;

function failureSide<Panel>(error: unknown, context: string): DetailAttachmentSide<Panel> {
  const kind = classifyCatalogReadFailure(error);
  if (kind === 'unavailable') {
    return { status: 'disabled', panel: null, recordCount: 0, reason: `${context}；该模块在当前环境未启用，不当作 0 项。` };
  }
  return {
    status: kind === 'forbidden' ? 'forbidden' : 'read_failed',
    panel: null,
    recordCount: 0,
    reason: kind === 'forbidden'
      ? `${context}；${ATTACHMENT_SIDE_MESSAGES.forbidden}`
      : `${context}；${ATTACHMENT_SIDE_MESSAGES.read_failed}`,
  };
}

function summarizeSides(identity: DetailAttachmentSide<unknown>, product: DetailAttachmentSide<unknown>): Pick<DetailAttachmentsState, 'summary' | 'failures'> {
  const sides: { side: AttachmentSideKey; status: AttachmentSideStatus }[] = [
    { side: 'identity', status: identity.status },
    { side: 'product', status: product.status },
  ];
  const failed = sides.filter((side): side is { side: AttachmentSideKey; status: Exclude<AttachmentSideStatus, 'ready' | 'empty' | 'disabled'> } =>
    side.status === 'read_failed' || side.status === 'forbidden' || side.status === 'invalid' || side.status === 'unknown');
  const resolved = sides.filter((side) => side.status === 'ready' || side.status === 'empty').length;
  const summary: DetailAttachmentsState['summary'] = resolved === sides.length
    ? 'ready'
    : resolved > 0
      ? 'partial'
      : failed.length === 0
        ? 'unavailable'
        : failed.length === sides.length && failed.every((side) => side.status === 'forbidden') ? 'forbidden' : 'failed';
  return { summary, failures: failed };
}

async function readIdentityAttachmentSide(itemId: string): Promise<DetailAttachmentSide<Awaited<ReturnType<typeof getSourceIdentityPanel>>>> {
  try {
    const panel = await getSourceIdentityPanel(itemId);
    if (panel.enabled === false) return { status: 'disabled', panel: null, recordCount: 0, reason: ATTACHMENT_SIDE_MESSAGES.disabled };
    const recordCount = panel.sourceIdentity.length + panel.links.length + panel.observations.length + panel.frozenHumanChoice.length;
    return recordCount === 0
      ? { status: 'empty', panel, recordCount, reason: null }
      : { status: 'ready', panel, recordCount, reason: null };
  } catch (error) {
    return failureSide(error, '来源身份附注未能读取');
  }
}

async function readProductAttachmentSide(itemId: string): Promise<DetailAttachmentSide<NonNullable<Awaited<ReturnType<typeof getNewItemDetailPanel>>>>> {
  let core: Awaited<ReturnType<typeof getCatalogDetailCore>>;
  try {
    core = await getCatalogDetailCore(itemId);
  } catch (error) {
    return failureSide(error, '商品资料核心未能读取，新品候选无法判断');
  }
  try {
    const panel = await getNewItemDetailPanel(core.item);
    if (!panel.enabled) return { status: 'disabled', panel: null, recordCount: 0, reason: ATTACHMENT_SIDE_MESSAGES.disabled };
    const recordCount = panel.candidates.bigseller.length + panel.candidates.jushuitan.length;
    return recordCount === 0
      ? { status: 'empty', panel, recordCount, reason: null }
      : { status: 'ready', panel, recordCount, reason: null };
  } catch (error) {
    return failureSide(error, '新品候选附注未能读取');
  }
}

/**
 * F07 / R6：弹窗按需读取与直链相同的来源/新品附件投影。
 * 逐侧返回显式状态（未启用 / 无权限 / 读取失败 / 真实空 / 可用），不再把失败 catch 成 null，
 * 也不把失败写成“未启用”；调用方据此保留已成功的一侧并独立重试失败侧。
 */
export async function fetchCatalogDetailAttachmentsAction(itemId: string): Promise<DetailAttachmentsState> {
  if (!/^[a-f\d-]{36}$/i.test(itemId)) {
    const invalid: DetailAttachmentSide<never> = { status: 'invalid', panel: null, recordCount: 0, reason: ATTACHMENT_SIDE_MESSAGES.invalid };
    return { identity: invalid, product: invalid, summary: 'failed', failures: [{ side: 'identity', status: 'invalid' }, { side: 'product', status: 'invalid' }] };
  }
  const identity = await readIdentityAttachmentSide(itemId);
  const product = await readProductAttachmentSide(itemId);
  return { identity, product, ...summarizeSides(identity, product) };
}

export async function fetchCatalogAdminDecisionsAction(offset: number, limit: number) {
  return perform(() => getCatalogAdminDecisionsPage(offset, limit));
}

export async function fetchCatalogAdminObservationsAction(offset: number, limit: number) {
  return perform(() => getCatalogAdminObservationsPage(offset, limit));
}

export async function fetchCatalogItemBsSampleAction(itemId: string, warehouse?: string) {
  return perform(() => getCatalogItemBsSample(itemId, warehouse?.trim() || undefined));
}
