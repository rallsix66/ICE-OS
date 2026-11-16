import type {
  ShipmentGroupingActiveOverrideDto,
  ShipmentGroupingDecision,
  ShipmentGroupingReviewDto,
} from './types';

export interface GroupingReviewSummary {
  /** 一句话：市场 + 采购单/运单 + 上次几票/本次几票。 */
  text: string;
  market: string;
  ticketReference: string;
  previousCount: number;
  currentCount: number;
}

function unique(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = (value ?? '').trim();
    if (trimmed) seen.add(trimmed);
  }
  return [...seen];
}

/**
 * 复核的一句话业务摘要：只取复核数据里真实出现的市场、采购单/运单和两侧票数。
 * 不推测分组原因，不把票键/UUID 上屏。
 */
export function groupingReviewSummary(review: Pick<ShipmentGroupingReviewDto, 'evidence'>): GroupingReviewSummary {
  const previous = review.evidence.previous.tickets;
  const current = review.evidence.current.tickets;
  const all = [...current, ...previous];
  const market = unique(all.map((ticket) => ticket.market))[0] ?? '市场未提供';
  const purchaseOrders = unique(all.map((ticket) => ticket.purchaseOrder));
  const waybills = unique(all.map((ticket) => ticket.waybillsText));
  const ticketReference = purchaseOrders.length > 0
    ? `采购单 ${purchaseOrders.join('、')}${waybills.length > 0 ? `（运单 ${waybills.join('、')}）` : ''}`
    : waybills.length > 0
      ? `运单 ${waybills.join('、')}`
      : unique(all.map((ticket) => ticket.ticketNo)).length > 0
        ? `票号 ${unique(all.map((ticket) => ticket.ticketNo)).join('、')}`
        : '单号未提供';
  return {
    text: `${market} · ${ticketReference} · 上次 ${previous.length} 票，本次 ${current.length} 票。`,
    market,
    ticketReference,
    previousCount: previous.length,
    currentCount: current.length,
  };
}

export const GROUPING_DECISION_LABELS: Readonly<Record<ShipmentGroupingDecision, string>> = {
  split_confirmed: '确实拆开',
  keep_one: '仍是一票',
  merge_confirmed: '确实合成一票',
  keep_separate: '仍然分开',
  restored: '恢复按飞书判断',
};

/**
 * 保存成功后告诉用户实际采用了哪个决定。
 *
 * 只写实际决定本身，不写死票数结论（「本次按两票处理」曾写死，和「仍然分开 / 仍是一票」
 * 两种结果都对不上，本轮去掉）。
 */
export function decisionSavedText(decision: ShipmentGroupingDecision | null): string {
  if (!decision) return '决定已保存';
  if (decision === 'restored') return '已恢复按飞书判断';
  return `已保存决定：${GROUPING_DECISION_LABELS[decision]}`;
}

/**
 * 「已有人工决定」行标题：优先用真实 decision 映射（仍是一票 / 仍然分开），
 * 历史数据没有 decision 时按复核类型回退到「按一票处理 / 按分开处理」。
 */
export function groupingOverrideTitle(
  override: Pick<ShipmentGroupingActiveOverrideDto, 'decision' | 'reviewKind'>,
): string {
  if (override.decision) return GROUPING_DECISION_LABELS[override.decision];
  return override.reviewKind === 'split' ? '按一票处理' : '按分开处理';
}

function textOrNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * 保存「仍然分开 / 仍是一票」后，在同一弹窗立即生成「已有人工决定」行（纯函数）。
 *
 * 与数据库 `read_shipment_grouping_reviews().activeOverrides` 的取数口径保持一致：
 * 先取本次票（current.tickets[0]），没有再用上次票（previous.tickets[0]）：
 * - market：current.market → previous.market；
 * - ticketNo：采购单号 → 首张运单号 → 票键（current 优先，其次 previous）；
 * - waybillsText：current.waybillsText → previous.waybillsText。
 *
 * 接受飞书原分组（确实拆开 / 确实合成一票）不写覆盖，返回 null（不新增人工决定行）；
 * 与 `buildGroupingOverrideForDecision` 一致：拆票「仍是一票」需要本次至少两票，
 * 合票「仍然分开」需要上次至少两票，否则不写覆盖。
 */
export function buildLocalOverride(
  review: Pick<ShipmentGroupingReviewDto, 'id' | 'kind' | 'signature' | 'evidence'>,
  decision: ShipmentGroupingDecision,
  now: string | Date = new Date(),
): ShipmentGroupingActiveOverrideDto | null {
  if (decision !== 'keep_one' && decision !== 'keep_separate') return null;
  if (review.kind === 'split') {
    if (decision !== 'keep_one' || review.evidence.current.tickets.length < 2) return null;
  } else if (decision !== 'keep_separate' || review.evidence.previous.tickets.length < 2) {
    return null;
  }
  const current = review.evidence.current.tickets[0] ?? null;
  const previous = review.evidence.previous.tickets[0] ?? null;
  return {
    id: `local:${review.id}`,
    reviewId: review.id,
    kind: review.kind === 'split' ? 'merge' : 'split',
    reviewKind: review.kind,
    decision,
    signature: review.signature,
    createdAt: typeof now === 'string' ? now : now.toISOString(),
    market: textOrNull(current?.market) ?? textOrNull(previous?.market),
    ticketNo: textOrNull(current?.ticketNo)
      ?? textOrNull(current?.purchaseOrder)
      ?? textOrNull(current?.ticketKey)
      ?? textOrNull(previous?.ticketNo)
      ?? textOrNull(previous?.purchaseOrder)
      ?? textOrNull(previous?.ticketKey),
    waybillsText: textOrNull(current?.waybillsText) ?? textOrNull(previous?.waybillsText),
  };
}

/**
 * 合并服务端读取的生效人工决定与本次会话内刚保存的本地行：按 reviewId 去重（服务端行优先），
 * 已被「恢复按飞书判断」的 reviewId 立刻隐藏，最后按时间倒序（与数据库返回顺序一致）。
 */
export function mergeActiveOverrides(
  serverOverrides: readonly ShipmentGroupingActiveOverrideDto[],
  localOverrides: readonly ShipmentGroupingActiveOverrideDto[],
  restoredReviewIds: readonly string[] = [],
): ShipmentGroupingActiveOverrideDto[] {
  const restored = new Set(restoredReviewIds);
  const byReview = new Map<string, ShipmentGroupingActiveOverrideDto>();
  for (const override of serverOverrides) {
    if (restored.has(override.reviewId)) continue;
    byReview.set(override.reviewId, override);
  }
  for (const override of localOverrides) {
    if (restored.has(override.reviewId) || byReview.has(override.reviewId)) continue;
    byReview.set(override.reviewId, override);
  }
  return [...byReview.values()].sort((left, right) => (right.createdAt ?? '').localeCompare(left.createdAt ?? ''));
}
