'use server';

import { randomUUID } from 'node:crypto';

import { revalidatePath } from 'next/cache';

import { callAppRpc, type DbIdentity } from '@/lib/database/app-db';
import { requireActiveAdmin } from '@/lib/auth';
import {
  SHIPMENT_SOURCE_KEY,
  type IngestShipmentSnapshot,
  type ProductSearchRowDto,
  type ProductShipmentTransitDto,
  type ShipmentAssociationResultDto,
  type ShipmentGroupingDecision,
  type ShipmentGroupingResolveResultDto,
  type ShipmentGroupingReviewDto,
  type ShipmentManualApplyInputDto,
  type ShipmentManualResultDto,
  type ShipmentManualStatus,
  type ShipmentRefreshResultDto,
  type ShipmentSourceCollection,
} from '../types';
import { readShipmentSource } from './source';
import {
  getLatestShipmentSnapshotRaw,
  getProductShipmentInTransit,
  getShipmentGroupingContext,
  getShipmentGroupingReview,
  getShipmentIdentityIndex,
  getShipmentLiveStamp,
  requireShipmentAdmin,
  searchProductsForShipment as searchProductsRead,
} from './reads';
import { runShipmentRefresh } from './refresh-pipeline';
import { planShipmentIdentities } from './identity';
import { parseShipmentSnapshot } from './parse';
import {
  applyGroupingInterpretationHash,
  applyGroupingOverrides,
  buildAssociationCarryoverPlan,
  buildEvidenceGroupingState,
  buildGroupingOverrideForDecision,
  groupingReviewTicketKeys,
} from '../grouping';
import { normalizeAssociationResult, normalizeGroupingResolve, normalizeManualResult, normalizeRefreshResult } from './normalize';

/**
 * /dashboard/in-transit 的服务端动作（页面主动刷新 + 明细商品关联）。
 *
 * - 刷新：与后台定时任务共用同一套读取/解析/身份匹配/入库流程（refresh-pipeline.ts）。
 *   手动刷新也先抢占来源读取租约：后台正在读时返回「正在读取」，不并发读同一来源；
 *   失败只写失败快照，旧数据与原来源时间保持不变，页面给「重试」入口。
 * - 关联：服务端校验入参 + 版本校验 RPC；勾选「后续沿用」时同事务保存已确认对应并立即采用；
 *   业务拒绝返回结构化 errorCode，不抛中文文案。
 */

const IN_TRANSIT_PATH = '/dashboard/in-transit';
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function emptyRefreshResult(readAt: string): ShipmentRefreshResultDto {
  return {
    ok: false,
    readAt,
    ticketCount: 0,
    itemCount: 0,
    createdTickets: 0,
    updatedTickets: 0,
    unchangedTickets: 0,
    createdItems: 0,
    updatedItems: 0,
    revisionsAdded: 0,
    associationsPreserved: 0,
    absentTickets: 0,
    absentItems: 0,
    adoptedAssociations: 0,
    errorCode: null,
    errorMessage: null,
  };
}

/**
 * 刷新来源：成功入库并返回本次计数；失败写失败快照并返回 ok:false（旧数据保留）。
 * 与后台定时读取共用读取租约，后台正在读时直接返回「正在读取」，不启动第二轮。
 */
export async function refreshShipmentSource(): Promise<ShipmentRefreshResultDto> {
  const identity = await requireShipmentAdmin();
  const owner = `manual:${identity.profileUserId}:${randomUUID()}`;
  const lease = await callAppRpc<{ claimed?: unknown; busy?: unknown }>(
    identity,
    'catalog.begin_shipment_manual_refresh',
    [owner],
  );
  if (lease.claimed !== true) {
    return {
      ...emptyRefreshResult(new Date().toISOString()),
      errorCode: 'SHIPMENT_SOURCE_BUSY',
      errorMessage: '来源正在读取（自动或手动），请稍后重试',
    };
  }
  try {
    const result = await runShipmentRefresh({
      readBy: identity.profileUserId,
      readSource: readShipmentSource,
      identityIndex: getShipmentIdentityIndex,
      grouping: getShipmentGroupingContext,
      ingest: (snapshot: IngestShipmentSnapshot) => callAppRpc<unknown>(
        identity,
        'catalog.ingest_shipment_snapshot_with_mappings',
        [JSON.stringify(snapshot)],
      ),
      // 第十四轮：普通同步不再自动沿用商品绑定；只读上一成功读取的原始网格供拆/合票检测。
      previousSnapshotRaw: getLatestShipmentSnapshotRaw,
      recordGroupingReviews: async (reviews) => {
        await callAppRpc<unknown>(identity, 'catalog.record_shipment_grouping_reviews', [
          JSON.stringify(reviews.map((review) => ({
            kind: review.kind,
            signature: review.signature,
            evidence: review.evidence,
            fromSnapshotId: review.fromSnapshotId,
            toSnapshotId: review.toSnapshotId,
          }))),
        ]);
      },
      recordFailure: async (failure) => {
        await callAppRpc<unknown>(identity, 'catalog.record_shipment_read_failure', [JSON.stringify({
          sourceKey: SHIPMENT_SOURCE_KEY,
          readAt: failure.readAt,
          errorCode: failure.errorCode,
          errorMessage: failure.errorMessage,
        })]);
      },
    });
    revalidatePath(IN_TRANSIT_PATH);
    return result;
  } finally {
    try {
      await callAppRpc<unknown>(identity, 'catalog.end_shipment_manual_refresh', [owner]);
    } catch {
      // 释放失败不改变本次读取结果：租约 15 分钟后自动过期，不会永久锁住来源。
    }
  }
}

export interface AssociateShipmentItemInput {
  itemId: string;
  /** null = 清除关联。 */
  productId: string | null;
  expectedRevision: number;
  reason: string | null;
  /** 勾选「后续同来源、同品名、同市场沿用此对应」；默认不勾选 = 只改这一条。 */
  rememberMapping?: boolean;
}

/** 设置/清除明细的商品关联；版本冲突等业务拒绝以结构化 errorCode 返回，不抛异常。 */
export async function associateShipmentItem(
  input: AssociateShipmentItemInput,
): Promise<ShipmentAssociationResultDto> {
  const identity = await requireShipmentAdmin();
  const itemId = typeof input.itemId === 'string' ? input.itemId.trim() : '';
  const productId = typeof input.productId === 'string' ? input.productId.trim() : null;
  const expectedRevision = Math.trunc(Number(input.expectedRevision));
  const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 500) : '';
  const remember = input.rememberMapping === true;
  if (!UUID_PATTERN.test(itemId) || (productId !== null && !UUID_PATTERN.test(productId))
    || !Number.isSafeInteger(expectedRevision) || expectedRevision <= 0) {
    return {
      ok: false,
      itemId,
      productId,
      associationStatus: 'none',
      revision: 0,
      errorCode: 'SHIPMENT_INVALID_INPUT',
      errorMessage: '关联参数不完整或格式错误',
    };
  }
  // 勾选沿用且确实选了商品：同事务保存关联 + 通用对应 + 立即采用；否则只改这一条。
  const rememberEffective = remember && productId !== null;
  const raw = rememberEffective
    ? await callAppRpc<unknown>(identity, 'catalog.save_shipment_item_association_with_mapping', [
      itemId,
      productId,
      expectedRevision,
      reason === '' ? null : reason,
      true,
    ])
    : await callAppRpc<unknown>(identity, 'catalog.update_shipment_item_association', [
      itemId,
      productId,
      expectedRevision,
      reason === '' ? null : reason,
    ]);
  revalidatePath(IN_TRANSIT_PATH);
  return normalizeAssociationResult(raw);
}

/** 关联编辑下拉/搜索：只读的商品主档搜索（与 reads.getShipmentList 同一鉴权）。 */
export async function searchProductsForShipment(
  q: string,
  limit = 10,
): Promise<ProductSearchRowDto[]> {
  return searchProductsRead(typeof q === 'string' ? q : '', limit);
}

/**
 * 已打开页面的自动更新探测（第七轮）：只读系统已保存的读取结果时间戳，
 * 供客户端判断是否需要 router.refresh()；不读取飞书、不写库。
 */
export async function pollShipmentLiveStamp(): Promise<string> {
  return getShipmentLiveStamp();
}

/* ------------------------------------------------------------------ *
 * 人工「修正在途」（第八轮，029）
 *
 * - 只改该明细的生效累计到货/依据（manual_correction）+ 人工字段，原表判断另存 source_*，
 *   可「恢复按原表判断」；不改票 status_class、不改 item.revision、不写回飞书；
 * - 修改人取服务端 requireActiveAdmin().displayName（可信边界），actor_id 由数据库函数内
 *   require_admin() 取，禁止从客户端传 actor；
 * - 业务拒绝（版本冲突/明细不在当前来源/累计超出）返回 ok:false + errorCode，不抛中文文案。
 * ------------------------------------------------------------------ */

const MANUAL_STATUSES: ShipmentManualStatus[] = [
  'in_transit', 'arrived_pending_shelving', 'fully_shelved', 'partial_shelved', 'unknown',
];

function manualRejected(itemId: string, errorCode: string, errorMessage: string): ShipmentManualResultDto {
  return {
    ok: false,
    itemId,
    manualStatus: null,
    manualShelvedQuantity: null,
    receivedQuantity: null,
    remainingQuantity: null,
    receiptBasis: 'pending',
    manualRevision: 0,
    manualActorName: null,
    manualAt: null,
    reviewNeeded: false,
    errorCode,
    errorMessage,
  };
}

/** 人工修正在途：状态 + 分批累计已上架（累计数，替换不累加）。 */
export async function applyShipmentItemManualCorrection(
  input: ShipmentManualApplyInputDto,
): Promise<ShipmentManualResultDto> {
  const actor = await requireActiveAdmin();
  const identity: DbIdentity = { profileUserId: actor.id };
  const itemId = typeof input?.itemId === 'string' ? input.itemId.trim() : '';
  const expected = Math.trunc(Number(input?.expectedManualRevision));
  if (!UUID_PATTERN.test(itemId) || !Number.isSafeInteger(expected) || expected < 0) {
    return manualRejected(itemId, 'SHIPMENT_INVALID_INPUT', '人工修正参数不完整或格式错误');
  }
  const status = typeof input.status === 'string' ? input.status.trim() : '';
  if (!MANUAL_STATUSES.includes(status as ShipmentManualStatus)) {
    return manualRejected(itemId, 'SHIPMENT_INVALID_INPUT', '人工修正状态无效');
  }
  const cumulative = input.cumulativeShelved === null || input.cumulativeShelved === undefined
    ? null
    : Math.trunc(Number(input.cumulativeShelved));
  if (status === 'partial_shelved') {
    if (cumulative === null || !Number.isSafeInteger(cumulative) || cumulative < 0) {
      return manualRejected(itemId, 'SHIPMENT_INVALID_INPUT', '分批上架必须填写累计已上架数量');
    }
  } else if (cumulative !== null) {
    return manualRejected(itemId, 'SHIPMENT_INVALID_INPUT', '只有分批上架才能填写累计已上架');
  }
  const raw = await callAppRpc<unknown>(identity, 'catalog.apply_shipment_item_manual_correction', [
    itemId, status, cumulative, expected, actor.displayName,
  ]);
  revalidatePath(IN_TRANSIT_PATH);
  return normalizeManualResult(raw);
}

export interface RestoreShipmentItemSourceInput {
  itemId: string;
  /** 当前明细的人工修正版本（乐观并发）。 */
  expectedManualRevision: number;
  /**
   * 前端「修正在途」弹窗复用同一份输入结构时会一并传 restore/status/cumulativeShelved；
   * 恢复动作只认 itemId + expectedManualRevision，其余字段忽略（不作为业务输入）。
   */
  restore?: boolean;
  status?: ShipmentManualStatus;
  cumulativeShelved?: number | null;
}

/** 恢复按原表判断：生效值回到 source_*，人工字段清空（历史保留）。 */
export async function restoreShipmentItemSourceJudgement(
  input: RestoreShipmentItemSourceInput,
): Promise<ShipmentManualResultDto> {
  const actor = await requireActiveAdmin();
  const identity: DbIdentity = { profileUserId: actor.id };
  const itemId = typeof input?.itemId === 'string' ? input.itemId.trim() : '';
  const expected = Math.trunc(Number(input?.expectedManualRevision));
  if (!UUID_PATTERN.test(itemId) || !Number.isSafeInteger(expected) || expected < 0) {
    return manualRejected(itemId, 'SHIPMENT_INVALID_INPUT', '恢复参数不完整或格式错误');
  }
  const raw = await callAppRpc<unknown>(identity, 'catalog.restore_shipment_item_source_judgement', [
    itemId, expected, actor.displayName,
  ]);
  revalidatePath(IN_TRANSIT_PATH);
  return normalizeManualResult(raw);
}

export type ProductShipmentTransitActionResult =
  | { success: true; data: ProductShipmentTransitDto }
  | { success: false; error: string };

/**
 * 商品详情「关联货票」/「在途库存」读取（第十轮，只读）：按商品 ID 取最近成功读取的当前明细，
 * 与物流在途页共用同一数量口径（人工修正已生效；冲突待复核不计入）。
 * 权限/读取失败分开返回，页面显示“不是 0”，不伪造空数据。
 */
export async function fetchProductShipmentTransitAction(
  itemId: string,
): Promise<ProductShipmentTransitActionResult> {
  const id = typeof itemId === 'string' ? itemId.trim() : '';
  if (!UUID_PATTERN.test(id)) {
    return { success: false, error: '商品标识无效，无法读取在途数据。' };
  }
  try {
    return { success: true, data: await getProductShipmentInTransit(id) };
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const forbidden = message.includes('无权限') || message.includes('未登录');
    return {
      success: false,
      error: forbidden
        ? '当前账户无权读取在途数据；没有权限不等于没有在途。'
        : '在途数据读取失败（网络或传输异常），可重试。',
    };
  }
}

/* ------------------------------------------------------------------ *
 * 第十二轮：拆票 / 合票复核
 *
 * - 复核结论只允许两种：接受飞书当前分组（split_confirmed / merge_confirmed），
 *   或按上次分组人工覆盖（keep_one / keep_separate，写一条分组覆盖）；
 * - 写入覆盖后立即用「最新成功快照的原始网格」按当前覆盖重新解释一次，
 *   让列表/详情/货值马上反映人工决定，并把原明细的商品绑定沿用到新明细；
 * - 「恢复按飞书判断」停用覆盖后同样重新解释一次，不改写历史。
 * ------------------------------------------------------------------ */

const GROUPING_DECISIONS: ShipmentGroupingDecision[] = [
  'split_confirmed', 'keep_one', 'merge_confirmed', 'keep_separate',
];

function groupingRejected(
  reviewId: string,
  errorCode: string,
  errorMessage: string,
): ShipmentGroupingResolveResultDto {
  return { ok: false, reviewId, decision: null, snapshotId: null, errorCode, errorMessage };
}

/**
 * 用最新成功快照重新解释一次分组（人工覆盖新增/撤销后调用）。
 * 读取时间沿用原快照，不把“人工重新解释”冒充成一次新的来源读取。
 *
 * 第十四轮：这里的绑定沿用**只针对本次复核涉及、能明确对应的原明细**（行范围重叠 +
 * 品名/数量一致 + 商品唯一），并记录管理员确认人与依据；普通同步不调用。
 */
async function reingestShipmentGrouping(
  identity: DbIdentity,
  review: ShipmentGroupingReviewDto,
  decision: ShipmentGroupingDecision,
): Promise<string | null> {
  const raw = await getLatestShipmentSnapshotRaw();
  if (!raw) return null;
  const context = await getShipmentGroupingContext();
  const collection = raw.collection as unknown as ShipmentSourceCollection;
  const parsed = parseShipmentSnapshot({
    collection,
    values: raw.values,
    merges: raw.merges,
  });
  const tickets = applyGroupingOverrides(parsed.tickets, context.overrides);
  // 绑定沿用的来源是复核登记时「拆开之前」的票与明细绑定（evidence 上次一侧），
  // 不是当前已经拆开/合并后的分组——当前分组里被拆出去的新明细本来就没带原绑定。
  const evidenceTickets = buildEvidenceGroupingState(review);
  const carryoverPlan = buildAssociationCarryoverPlan(
    context.tickets,
    tickets,
    groupingReviewTicketKeys(review),
    evidenceTickets,
  );
  const existing = await getShipmentIdentityIndex();
  const identities = planShipmentIdentities(existing, tickets);
  const baseContentHash = typeof collection.baseContentHash === 'string'
    ? collection.baseContentHash
    : collection.rawContentHash;
  if (!/^[a-f0-9]{64}$/.test(baseContentHash)) {
    throw new Error('SHIPMENT_GROUPING_SNAPSHOT_HASH');
  }
  const snapshot: IngestShipmentSnapshot = {
    sourceKey: parsed.sourceKey,
    collection: {
      ...parsed.collection,
      readBy: identity.profileUserId,
      baseContentHash,
      rawContentHash: applyGroupingInterpretationHash(baseContentHash, context.overrides),
    },
    tickets: tickets.map((ticket, index) => ({
      ...ticket,
      matchedShipmentId: identities[index].matchedShipmentId,
      identityStatus: identities[index].identityStatus,
      identityNote: identities[index].identityNote,
    })),
    raw: parsed.raw,
  };
  const result = normalizeRefreshResult(await callAppRpc<unknown>(
    identity,
    'catalog.ingest_shipment_snapshot_with_mappings',
    [JSON.stringify(snapshot)],
  ));
  if (result.ok !== true || !result.snapshotId) {
    throw new Error(result.errorMessage ?? 'SHIPMENT_GROUPING_REINGEST_FAILED');
  }
  if (carryoverPlan.length > 0) {
    await callAppRpc<unknown>(identity, 'catalog.apply_shipment_item_association_carryover_manual', [
      result.snapshotId,
      JSON.stringify(carryoverPlan),
      review.id,
      decision,
    ]);
  }
  return result.snapshotId;
}

export interface ResolveShipmentGroupingReviewInput {
  reviewId: string;
  decision: ShipmentGroupingDecision;
  note?: string | null;
}

/** 保存拆票/合票复核结论；拒绝当前分组时写覆盖并立即重新解释。 */
export async function resolveShipmentGroupingReview(
  input: ResolveShipmentGroupingReviewInput,
): Promise<ShipmentGroupingResolveResultDto> {
  const identity = await requireShipmentAdmin();
  const reviewId = typeof input?.reviewId === 'string' ? input.reviewId.trim() : '';
  const decision = typeof input?.decision === 'string'
    ? input.decision.trim() as ShipmentGroupingDecision
    : '' as ShipmentGroupingDecision;
  if (!UUID_PATTERN.test(reviewId) || !GROUPING_DECISIONS.includes(decision)) {
    return groupingRejected(reviewId, 'SHIPMENT_INVALID_INPUT', '复核参数不完整或格式错误');
  }
  const review = await getShipmentGroupingReview(reviewId);
  if (!review || review.status !== 'pending') {
    return groupingRejected(reviewId, 'SHIPMENT_REVIEW_NOT_FOUND', '这条复核已处理或不存在，请刷新后重试');
  }
  if (review.kind === 'split' && !['split_confirmed', 'keep_one'].includes(decision)) {
    return groupingRejected(reviewId, 'SHIPMENT_INVALID_INPUT', '拆票复核只能用「仍是一票 / 确实拆开」');
  }
  if (review.kind === 'merge' && !['merge_confirmed', 'keep_separate'].includes(decision)) {
    return groupingRejected(reviewId, 'SHIPMENT_INVALID_INPUT', '合票复核只能用「确实合成一票 / 仍然分开」');
  }
  const override = buildGroupingOverrideForDecision(review, decision);
  const note = typeof input?.note === 'string' ? input.note.trim().slice(0, 500) : null;
  const result = normalizeGroupingResolve(await callAppRpc<unknown>(
    identity,
    'catalog.resolve_shipment_grouping_review',
    [reviewId, decision, override === null ? null : JSON.stringify(override), note],
  ));
  if (!result.ok) return result;
  // 接受飞书原始分组（确实拆开 / 确实合成一票）：停用本复核涉及票的生效人工覆盖，
  // 让下一次解释真正按飞书分组走，而不是被更早的人工覆盖继续压着。
  if (override === null) {
    await callAppRpc<unknown>(identity, 'catalog.deactivate_shipment_grouping_overrides', [
      reviewId,
      JSON.stringify([...groupingReviewTicketKeys(review)]),
    ]);
  }
  let snapshotId: string | null = null;
  try {
    snapshotId = await reingestShipmentGrouping(identity, review, decision);
  } catch (error) {
    return {
      ...result,
      ok: false,
      snapshotId: null,
      errorCode: 'SHIPMENT_GROUPING_REINGEST_FAILED',
      errorMessage: error instanceof Error ? error.message.slice(0, 300) : '分组重新入库失败',
    };
  }
  revalidatePath(IN_TRANSIT_PATH);
  return { ...result, snapshotId };
}

/** 恢复按飞书判断：停用该次复核写入的人工分组，并用当前覆盖重新解释一次。 */
export async function restoreShipmentGroupingJudgement(
  reviewId: string,
  note?: string | null,
): Promise<ShipmentGroupingResolveResultDto> {
  const identity = await requireShipmentAdmin();
  const id = typeof reviewId === 'string' ? reviewId.trim() : '';
  if (!UUID_PATTERN.test(id)) {
    return groupingRejected(id, 'SHIPMENT_INVALID_INPUT', '复核参数不完整或格式错误');
  }
  // 恢复针对恢复前用过的复核（可能是 resolved）：需要它的 evidence 来限定绑定沿用范围。
  const review = await getShipmentGroupingReview(id);
  if (!review) {
    return groupingRejected(id, 'SHIPMENT_REVIEW_NOT_FOUND', '这条复核不存在，请刷新后重试');
  }
  const result = normalizeGroupingResolve(await callAppRpc<unknown>(
    identity,
    'catalog.restore_shipment_grouping_judgement',
    [id, typeof note === 'string' ? note.trim().slice(0, 500) : null],
  ));
  if (!result.ok) return result;
  let snapshotId: string | null = null;
  try {
    snapshotId = await reingestShipmentGrouping(identity, review, 'restored');
  } catch (error) {
    return {
      ...result,
      ok: false,
      snapshotId: null,
      errorCode: 'SHIPMENT_GROUPING_REINGEST_FAILED',
      errorMessage: error instanceof Error ? error.message.slice(0, 300) : '分组重新入库失败',
    };
  }
  revalidatePath(IN_TRANSIT_PATH);
  return { ...result, decision: 'restored', snapshotId };
}

