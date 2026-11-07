import { createHash } from 'node:crypto';

import type {
  ParsedShipmentItem,
  ParsedShipmentTicket,
  ShipmentGroupingDecision,
  ShipmentGroupingOverrideDto,
  ShipmentGroupingOverrideSpec,
  ShipmentGroupingReviewDto,
  ShipmentGroupingReviewEvidenceDto,
  ShipmentGroupingReviewKind,
  ShipmentGroupingReviewTicketSide,
  ShipmentGroupingStateTicket,
  ShipmentIdentityIndexRow,
} from './types';

/**
 * 拆票/合票复核与人工分组覆盖（第十二轮；第十三轮把提醒范围收紧为「相邻两次成功读取」）。
 *
 * 口径（用户 2026-11-06 第十三轮确认）：
 * - 每次成功读取对照上一次成功读取的「商品分别在哪张票上」；
 * - 原来一票的商品分到多票 = 疑似拆票；原来多票的商品集中到一票 = 疑似合票；
 *   普通新增票、移动行号、只改物流进度都不提示；
 * - **归属一变就提醒**：即使第二张票以前出现过、同样的拆法以前确认过，只要相邻两次成功
 *   读取的分组不同就再次提醒；连续同步同一种分组（上一次读取已经相同）只提醒一次；
 * - 国家列拆成两个单元格但运单号单元格明确跨行、市场一致、没有不同采购单时，
 *   解析层直接读成一票（见 server/parse.ts），不进入人工复核；
 * - 人工判定与飞书不同时，把决定保存成「分组覆盖」，之后每次读取都按同一口径解释，
 *   避免下一条普通更新又把分组改回去；
 * - 人工确认拆合关系后，只让**能明确对应**的原明细带上原商品绑定（见 buildAssociationCarryoverPlan）。
 */

const SEPARATOR = '\u0000';

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** 生效中的人工分组覆盖 → 稳定签名；没有覆盖时返回 base（不改变正常读取的哈希）。 */
export function groupingInterpretationSignature(
  overrides: ReadonlyArray<Partial<ShipmentGroupingOverrideDto>
  & Pick<ShipmentGroupingOverrideDto, 'kind' | 'spec'>>,
): string {
  const active = overrides.filter((override) => override.active !== false);
  if (active.length === 0) return 'base';
  const stable = active
    .map((override) => JSON.stringify({ kind: override.kind, spec: override.spec }))
    .sort();
  return sha256(stable.join('\n'));
}

/**
 * 内容哈希加上「分组解释」盐：人工覆盖新增/撤销时来源内容没变，也要重新入库一次，
 * 否则「仍是一票 / 仍然分开」不会真的改变当前分组。
 */
export function applyGroupingInterpretationHash(
  baseContentHash: string,
  overrides: ReadonlyArray<Partial<ShipmentGroupingOverrideDto>
  & Pick<ShipmentGroupingOverrideDto, 'kind' | 'spec'>>,
): string {
  return sha256(`${baseContentHash}${SEPARATOR}grouping${SEPARATOR}${groupingInterpretationSignature(overrides)}`);
}

function recomputeItemKeys(items: readonly ParsedShipmentItem[]): ParsedShipmentItem[] {
  const occurrence = new Map<string, number>();
  return items.map((item) => {
    const index = occurrence.get(item.productNameNorm) ?? 0;
    occurrence.set(item.productNameNorm, index + 1);
    return { ...item, itemKey: `${item.productNameNorm}#${index}` };
  });
}

function applyMergeOverride(
  tickets: ParsedShipmentTicket[],
  spec: Extract<ShipmentGroupingOverrideSpec, { kind: 'merge' }>,
): ParsedShipmentTicket[] {
  const target = tickets.find((ticket) => ticket.ticketKey === spec.targetKey);
  if (!target) return tickets;
  const absorbed = spec.absorbedKeys
    .map((key) => tickets.find((ticket) => ticket.ticketKey === key))
    .filter((ticket): ticket is ParsedShipmentTicket => Boolean(ticket));
  if (absorbed.length === 0) return tickets;
  // 目标票的明细保持原顺序/原 itemKey；被并入的明细追加在后并重新编号，避免键冲突。
  const items = [...target.items, ...absorbed.flatMap((ticket) => ticket.items)];
  const merged: ParsedShipmentTicket = {
    ...target,
    items: recomputeItemKeys(items),
    sourceRowStart: Math.min(target.sourceRowStart, ...absorbed.map((ticket) => ticket.sourceRowStart)),
    sourceRowEnd: Math.max(target.sourceRowEnd, ...absorbed.map((ticket) => ticket.sourceRowEnd)),
  };
  const absorbedKeys = new Set(absorbed.map((ticket) => ticket.ticketKey));
  return tickets
    .filter((ticket) => !absorbedKeys.has(ticket.ticketKey))
    .map((ticket) => (ticket.ticketKey === target.ticketKey ? merged : ticket));
}

function applySplitOverride(
  tickets: ParsedShipmentTicket[],
  spec: Extract<ShipmentGroupingOverrideSpec, { kind: 'split' }>,
): ParsedShipmentTicket[] {
  const sourceIndex = tickets.findIndex((ticket) => ticket.ticketKey === spec.sourceKey);
  if (sourceIndex < 0) return tickets;
  const source = tickets[sourceIndex]!;
  const assigned = new Map<number, string>();
  spec.groups.forEach((group, groupIndex) => {
    const wanted = new Set(group.products.map((product) => (
      `${product.productNameNorm}${SEPARATOR}${product.shippedQuantity}`
    )));
    source.items.forEach((item, itemIndex) => {
      if (assigned.has(itemIndex)) return;
      if (wanted.has(`${item.productNameNorm}${SEPARATOR}${item.shippedQuantity}`)) {
        assigned.set(itemIndex, group.ticketKey === source.ticketKey ? source.ticketKey : `group:${groupIndex}`);
      }
    });
  });
  if (assigned.size === 0) return tickets;
  const kept: ParsedShipmentItem[] = [];
  const buckets = new Map<string, ParsedShipmentItem[]>();
  source.items.forEach((item, itemIndex) => {
    const target = assigned.get(itemIndex);
    if (target === undefined || target === source.ticketKey) {
      kept.push(item);
      return;
    }
    const bucket = buckets.get(target) ?? [];
    bucket.push(item);
    buckets.set(target, bucket);
  });
  const created: ParsedShipmentTicket[] = [];
  spec.groups.forEach((group, groupIndex) => {
    if (group.ticketKey === source.ticketKey) return;
    const moved = buckets.get(`group:${groupIndex}`);
    if (!moved || moved.length === 0) return;
    created.push({
      ticketKey: group.ticketKey,
      ticketNo: group.ticketNo,
      sourceRowStart: source.sourceRowStart,
      sourceRowEnd: source.sourceRowEnd,
      market: group.market ?? source.market,
      customsMethod: group.customsMethod ?? source.customsMethod,
      waybillsText: group.waybillsText,
      purchaseOrder: group.purchaseOrder,
      transportText: source.transportText,
      arrivalText: source.arrivalText,
      vessel: source.vessel,
      dispatchedText: source.dispatchedText,
      statusClass: source.statusClass,
      receivedBasis: source.receivedBasis,
      items: recomputeItemKeys(moved),
    });
  });
  if (created.length === 0) return tickets; // 没有实际拆分：保持原样，不写空票
  const sourceKept = kept.length > 0;
  const out = sourceKept
    ? tickets.map((ticket) => (
      ticket.ticketKey === source.ticketKey ? { ...source, items: recomputeItemKeys(kept) } : ticket
    ))
    : tickets.filter((ticket) => ticket.ticketKey !== source.ticketKey);
  const insertAt = out.findIndex((ticket) => ticket.ticketKey === source.ticketKey);
  out.splice(insertAt >= 0 ? insertAt + 1 : out.length, 0, ...created);
  return out;
}

/**
 * 按生效中的人工覆盖解释本次解析结果（合并 / 拆分）。
 * 覆盖只能作用在真实存在的票键上；来源已变化的覆盖自动跳过（不猜）。
 */
export function applyGroupingOverrides(
  tickets: readonly ParsedShipmentTicket[],
  overrides: readonly ShipmentGroupingOverrideDto[],
): ParsedShipmentTicket[] {
  let current = tickets.map((ticket) => ({ ...ticket, items: [...ticket.items] }));
  for (const override of [...overrides].sort((a, b) => (
    (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id)
  ))) {
    if (override.active === false) continue;
    if (override.spec.kind === 'merge') current = applyMergeOverride(current, override.spec);
    else current = applySplitOverride(current, override.spec);
  }
  return current;
}

export interface ParsedGroupingReview {
  kind: ShipmentGroupingReviewKind;
  signature: string;
  evidence: ShipmentGroupingReviewEvidenceDto;
}

function sideOfTicket(
  ticket: {
    ticketKey: string;
    ticketNo: string;
    market: string | null;
    waybillsText: string | null;
    purchaseOrder: string | null;
    sourceRowStart: number | null;
    sourceRowEnd: number | null;
    items: ReadonlyArray<{
      productNameRaw: string;
      productNameNorm: string;
      shippedQuantity: number;
      productId?: string | null;
    }>;
  },
): ShipmentGroupingReviewTicketSide {
  return {
    ticketKey: ticket.ticketKey,
    ticketNo: ticket.ticketNo,
    market: ticket.market,
    waybillsText: ticket.waybillsText,
    purchaseOrder: ticket.purchaseOrder,
    sourceRowStart: ticket.sourceRowStart,
    sourceRowEnd: ticket.sourceRowEnd,
    items: ticket.items.map((item) => ({
      productNameRaw: item.productNameRaw,
      productNameNorm: item.productNameNorm,
      shippedQuantity: item.shippedQuantity,
      productId: item.productId ?? null,
    })),
  };
}

function reviewSignature(
  kind: ShipmentGroupingReviewKind,
  previous: readonly ShipmentGroupingReviewTicketSide[],
  current: readonly ShipmentGroupingReviewTicketSide[],
): string {
  const assignments = new Map<string, { previous: Set<string>; current: Set<string> }>();
  for (const ticket of previous) {
    for (const item of ticket.items) {
      const entry = assignments.get(item.productNameNorm) ?? { previous: new Set(), current: new Set() };
      entry.previous.add(ticket.ticketKey);
      assignments.set(item.productNameNorm, entry);
    }
  }
  for (const ticket of current) {
    for (const item of ticket.items) {
      const entry = assignments.get(item.productNameNorm) ?? { previous: new Set(), current: new Set() };
      entry.current.add(ticket.ticketKey);
      assignments.set(item.productNameNorm, entry);
    }
  }
  return sha256(JSON.stringify({
    kind,
    previous: previous.map((ticket) => ticket.ticketKey).sort(),
    current: current.map((ticket) => ticket.ticketKey).sort(),
    assignments: [...assignments.entries()]
      .map(([product, entry]) => ({
        product,
        previous: [...entry.previous].sort(),
        current: [...entry.current].sort(),
      }))
      .sort((a, b) => a.product.localeCompare(b.product, 'zh-Hans-CN')),
  }));
}

interface ItemCounts {
  [key: string]: number;
}

function itemCountKey(item: { productNameNorm: string; shippedQuantity: number }): string {
  return `${item.productNameNorm}${SEPARATOR}${item.shippedQuantity}`;
}

function itemCounts(items: ReadonlyArray<{ productNameNorm: string; shippedQuantity: number }>): ItemCounts {
  const counts: ItemCounts = {};
  for (const item of items) {
    const key = itemCountKey(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/** a 的每种「品名+数量」是否都不超过 b（子多重集）。 */
function isSubMultiset(a: ItemCounts, b: ItemCounts): boolean {
  return Object.entries(a).every(([key, count]) => count <= (b[key] ?? 0));
}

function unionCounts(list: readonly ItemCounts[]): ItemCounts {
  const counts: ItemCounts = {};
  for (const entry of list) {
    for (const [key, count] of Object.entries(entry)) counts[key] = (counts[key] ?? 0) + count;
  }
  return counts;
}

function equalCounts(a: ItemCounts, b: ItemCounts): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if ((a[key] ?? 0) !== (b[key] ?? 0)) return false;
  }
  return true;
}

/**
 * 拆票/合票检测（第十三轮：按数据库里的原明细归属判断，并只对照上一次成功读取）。
 *
 * - 疑似拆票：本次某张票仍由原票 UUID 延续（身份匹配命中），但它原来的明细被分到了
 *   另一张/多张本次票（新建，或此前出现过、上一轮不在来源里的票），且这些票的
 *   「品名+数量」恰好覆盖原票的全部明细；其他票里同名同数量的商品不影响判断。
 * - 疑似合票：本次某张票由原票 UUID 延续，但上一轮另外一张/多张票本轮已不在来源里，
 *   它们的明细（品名+数量）全部出现在这张票里，且恰好组成这张票的明细。
 * - 身份无法唯一确认时不做判断，普通新增/移动行号/只改物流进度都不触发。
 * - 不使用历史签名压制：相邻两次分组不同就提醒；同样分组连续同步（上次已相同）不重复。
 */
export function detectGroupingChanges(
  previous: readonly ShipmentGroupingStateTicket[],
  current: readonly ParsedShipmentTicket[],
  matchedShipmentIds: ReadonlyArray<string | null> = [],
): ParsedGroupingReview[] {
  const results: ParsedGroupingReview[] = [];
  const seen = new Set<string>();
  const previousById = new Map(previous.map((ticket) => [ticket.shipmentId, ticket]));
  const matchedIds = current.map((_, index) => matchedShipmentIds[index] ?? null);
  const matched = new Set(matchedIds.filter((id): id is string => Boolean(id)));
  const affectedRaws = new Set<string>();
  const usedCurrent = new Set<number>();

  const push = (
    kind: ShipmentGroupingReviewKind,
    previousTickets: ShipmentGroupingReviewTicketSide[],
    currentTickets: ShipmentGroupingReviewTicketSide[],
  ): void => {
    const signature = reviewSignature(kind, previousTickets, currentTickets);
    if (seen.has(signature)) return;
    seen.add(signature);
    results.push({
      kind,
      signature,
      evidence: {
        kind,
        previous: { snapshotId: null, tickets: previousTickets },
        current: { snapshotId: null, tickets: currentTickets },
        affectedProducts: [...affectedRaws].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')),
      },
    });
  };

  const currentCounts = current.map((ticket) => itemCounts(ticket.items));

  // 疑似拆票：原票的明细被分给本次延续票之外的票（新建或上一轮不在来源里、本轮重新出现）。
  current.forEach((ticket, index) => {
    const matchedId = matchedIds[index] ?? null;
    if (!matchedId) return;
    const previousTicket = previousById.get(matchedId);
    if (!previousTicket) return;
    const previousCounts = itemCounts(previousTicket.items);
    const candidates = current
      .map((other, otherIndex) => ({ other, otherIndex }))
      .filter(({ otherIndex }) => {
        if (otherIndex === index) return true;
        if (usedCurrent.has(otherIndex)) return false;
        const otherMatched = matchedIds[otherIndex] ?? null;
        // 另一张仍在上一轮分组里的票不可能是这张票拆出来的；重新出现的历史票可以。
        if (otherMatched && previousById.has(otherMatched)) return false;
        return isSubMultiset(currentCounts[otherIndex]!, previousCounts);
      });
    if (candidates.length < 2) return;
    const combined = unionCounts(candidates.map(({ otherIndex }) => currentCounts[otherIndex]!));
    if (!equalCounts(combined, previousCounts)) return;
    candidates.forEach(({ otherIndex }) => usedCurrent.add(otherIndex));
    for (const item of previousTicket.items) affectedRaws.add(item.productNameRaw);
    push(
      'split',
      [sideOfTicket(previousTicket)],
      candidates
        .sort((a, b) => a.otherIndex - b.otherIndex)
        .map(({ other }) => sideOfTicket(other)),
    );
  });

  // 疑似合票：上一轮另外的票本轮已不在来源中，其明细全部集中到本次延续的这张票。
  current.forEach((ticket, index) => {
    if (usedCurrent.has(index)) return;
    const matchedId = matchedIds[index] ?? null;
    if (!matchedId) return;
    const previousTicket = previousById.get(matchedId);
    if (!previousTicket) return;
    const combinedCounts = currentCounts[index]!;
    const lost = previous.filter((entry) => entry.shipmentId !== matchedId
      && !matched.has(entry.shipmentId)
      && isSubMultiset(itemCounts(entry.items), combinedCounts));
    if (lost.length === 0) return;
    const combined = unionCounts([itemCounts(previousTicket.items), ...lost.map((entry) => itemCounts(entry.items))]);
    if (!equalCounts(combined, combinedCounts)) return;
    for (const entry of lost) {
      for (const item of entry.items) affectedRaws.add(item.productNameRaw);
    }
    push('merge', [previousTicket, ...lost].map(sideOfTicket), [sideOfTicket(ticket)]);
  });

  return results;
}

/**
 * 第十四轮：把「上一成功读取的飞书原始网格」解析结果转成检测用的分组状态。
 *
 * - 上一成功读取的分组必须来自 026 snapshot.raw 的服务端重新解析，**不是**被人工覆盖后的展示分组，
 *   否则人工覆盖会遮住后续来源变化；
 * - 原始解析结果没有数据库行信息：用现有身份索引按票键（ticketKey 在来源内唯一）找回 shipmentId；
 *   找不到的票（例如票键被人工覆盖改写）保守跳过——宁可少提醒，也不拿猜测的归属做判断；
 * - 原始分组不含当前商品绑定（itemId/productId），仅用于「商品分别在哪张票上」的对比。
 */
export function buildRawGroupingState(
  previous: readonly ParsedShipmentTicket[],
  identity: readonly ShipmentIdentityIndexRow[],
): ShipmentGroupingStateTicket[] {
  const shipmentIdByTicketKey = new Map<string, string>();
  for (const row of identity) {
    if (row.ticketKey && row.shipmentId) shipmentIdByTicketKey.set(row.ticketKey, row.shipmentId);
  }
  return previous.flatMap((ticket) => {
    const shipmentId = shipmentIdByTicketKey.get(ticket.ticketKey);
    if (!shipmentId) return [];
    return [{
      shipmentId,
      ticketKey: ticket.ticketKey,
      ticketNo: ticket.ticketNo,
      market: ticket.market,
      waybillsText: ticket.waybillsText,
      purchaseOrder: ticket.purchaseOrder,
      sourceRowStart: ticket.sourceRowStart,
      sourceRowEnd: ticket.sourceRowEnd,
      items: ticket.items.map((item) => ({
        itemId: '',
        productId: null,
        productNameRaw: item.productNameRaw,
        productNameNorm: item.productNameNorm,
        shippedQuantity: item.shippedQuantity,
      })),
    }];
  });
}

/** 复核 evidence 涉及的票键（前后两侧）：用于把绑定沿用限定在这次复核范围内。 */
export function groupingReviewTicketKeys(
  review: Pick<ShipmentGroupingReviewDto, 'evidence'>,
): Set<string> {
  const keys = new Set<string>();
  for (const side of [review.evidence.previous.tickets, review.evidence.current.tickets]) {
    for (const ticket of side) {
      if (ticket.ticketKey) keys.add(ticket.ticketKey);
    }
  }
  return keys;
}

/**
 * 第十四轮：把「这次读取之前数据库里的分组（含每条明细已绑定商品）」的绑定补进复核 evidence
 * 的「上次怎么分」一侧。
 *
 * 检测用的是「上一成功读取的原始网格」，那里没有绑定信息；而 evidence 又是保存决定后沿用绑定的
 * 唯一依据（当前分组在拆开之后已经丢了被拆出去明细的绑定）。所以登记复核时用读取前的分组状态
 * 把 productId 补上，并随 evidence 一起落库。
 */
export function attachEvidenceBindings(
  review: ParsedGroupingReview,
  previousState: readonly ShipmentGroupingStateTicket[],
): ParsedGroupingReview {
  // 读取前的分组可能已经把这一票拆过/合过（票键和 evidence 的对不上），所以优先按来源行范围
  // 找候选票，其次才按票键；明细按品名+数量逐条消耗，避免一条绑定被分给多条明细。
  const rangesOverlap = (ticket: {
    sourceRowStart: number | null; sourceRowEnd: number | null;
  }, entry: ShipmentGroupingStateTicket) => (
    ticket.sourceRowStart !== null && ticket.sourceRowEnd !== null
    && entry.sourceRowStart !== null && entry.sourceRowEnd !== null
    && entry.sourceRowStart <= ticket.sourceRowEnd
    && ticket.sourceRowStart <= entry.sourceRowEnd
  );
  const usedIds = new Set<string>();
  const tickets = review.evidence.previous.tickets.map((ticket) => {
    const candidates = previousState.filter((entry) => entry.ticketKey === ticket.ticketKey
      || rangesOverlap(ticket, entry));
    if (candidates.length === 0) return ticket;
    return {
      ...ticket,
      items: ticket.items.map((item) => {
        if (item.productId) return item;
        for (const candidate of candidates) {
          const match = candidate.items.find((entry) => !usedIds.has(entry.itemId)
            && entry.productNameNorm === item.productNameNorm
            && entry.shippedQuantity === item.shippedQuantity
            && Boolean(entry.productId));
          if (!match) continue;
          usedIds.add(match.itemId);
          return { ...item, productId: match.productId };
        }
        return item;
      }),
    };
  });
  return {
    ...review,
    evidence: {
      ...review.evidence,
      previous: { ...review.evidence.previous, tickets },
    },
  };
}

/**
 * 第十四轮：把复核 evidence 的「上次怎么分」还原成带原商品绑定的分组状态，
 * 作为保存决定后绑定沿用的来源。
 *
 * 为什么不用当前分组：检测到拆票时，当前分组已经是拆开后的结果，被拆出去的新票明细
 * 在入库时并没有带原绑定；只有复核登记时的 evidence（拆开之前的票 + 每条明细的 productId）
 * 还保留着原绑定，才是「明确对应」的可靠来源。
 */
export function buildEvidenceGroupingState(
  review: Pick<ShipmentGroupingReviewDto, 'evidence'>,
): ShipmentGroupingStateTicket[] {
  return review.evidence.previous.tickets.map((ticket) => ({
    shipmentId: `evidence:${ticket.ticketKey}`,
    ticketKey: ticket.ticketKey,
    ticketNo: ticket.ticketNo,
    market: ticket.market,
    waybillsText: ticket.waybillsText,
    purchaseOrder: ticket.purchaseOrder,
    sourceRowStart: ticket.sourceRowStart,
    sourceRowEnd: ticket.sourceRowEnd,
    items: ticket.items.map((item) => ({
      itemId: '',
      productId: item.productId ?? null,
      productNameRaw: item.productNameRaw,
      productNameNorm: item.productNameNorm,
      shippedQuantity: item.shippedQuantity,
    })),
  }));
}

export interface ShipmentAssociationCarryoverEntry {
  ticketKey: string;
  itemKey: string;
  productId: string;
}

/**
 * 人工确认拆合关系后的商品绑定沿用计划（第十三轮）。
 *
 * 只让「能明确对应」的原明细带上原商品绑定：
 * - 以来源行范围作为归属证据：当前票必须与上一轮某张票的行范围重叠（同一段来源区域），
 *   真正的新票（本次新加在其它行的采购单）没有重叠，不会仅凭同品名+数量继承绑定；
 * - 在重叠范围内按「规范化品名 + 发货量」配对；只有两侧数量一致、商品唯一时才沿用；
 *   有重名同量、多个商品或数量对不上的一律不猜；
 * - 返回的 ticketKey/itemKey 指向本次解析的票与明细，数据库只按这份明确计划补绑定。
 */
export function buildAssociationCarryoverPlan(
  previous: readonly ShipmentGroupingStateTicket[],
  current: readonly ParsedShipmentTicket[],
  scopePreviousTicketKeys?: ReadonlySet<string>,
  fallbackPrevious?: readonly ShipmentGroupingStateTicket[],
): ShipmentAssociationCarryoverEntry[] {
  const scope = (list: readonly ShipmentGroupingStateTicket[]) => (
    scopePreviousTicketKeys && scopePreviousTicketKeys.size > 0
      ? list.filter((entry) => scopePreviousTicketKeys.has(entry.ticketKey))
      : list
  );
  // 先按当前分组（最新一次读取后的绑定）对应；仍未覆盖的明细再用复核 evidence 里的
  // 「拆开之前」绑定补一次——两层都只认行范围重叠 + 品名/数量一致 + 商品唯一。
  const layers = fallbackPrevious && fallbackPrevious.length > 0
    ? [scope(previous), scope(fallbackPrevious)]
    : [scope(previous)];
  const plan: ShipmentAssociationCarryoverEntry[] = [];
  for (const ticket of current) {
    const start = ticket.sourceRowStart;
    const end = ticket.sourceRowEnd;
    if (start === null || end === null) continue;
    const plannedItemKeys = new Set<string>();
    for (const layer of layers) {
    const overlapping = layer.filter((entry) => (
      entry.sourceRowStart !== null
      && entry.sourceRowEnd !== null
      && entry.sourceRowStart <= end
      && start <= entry.sourceRowEnd
    ));
    if (overlapping.length === 0) continue;
    // 重叠范围内已绑定商品的原明细：按「品名+数量」统计候选。
    const candidates = new Map<string, { count: number; productIds: Set<string> }>();
    for (const entry of overlapping) {
      for (const item of entry.items) {
        if (!item.productId) continue;
        const key = itemCountKey(item);
        const bucket = candidates.get(key) ?? { count: 0, productIds: new Set<string>() };
        bucket.count += 1;
        bucket.productIds.add(item.productId);
        candidates.set(key, bucket);
      }
    }
    const currentByKey = new Map<string, ParsedShipmentItem[]>();
    for (const item of ticket.items) {
      const key = itemCountKey(item);
      const bucket = currentByKey.get(key) ?? [];
      bucket.push(item);
      currentByKey.set(key, bucket);
    }
    for (const [key, items] of currentByKey) {
      const bucket = candidates.get(key);
      if (!bucket || bucket.productIds.size !== 1) continue;
      // 两侧条数必须一致，避免把一条原明细的绑定分给多条新明细。
      if (bucket.count !== items.length) continue;
      const productId = [...bucket.productIds][0]!;
      for (const item of items) {
        if (plannedItemKeys.has(item.itemKey)) continue;
        plannedItemKeys.add(item.itemKey);
        plan.push({ ticketKey: ticket.ticketKey, itemKey: item.itemKey, productId });
      }
    }
    }
  }
  return plan;
}

/** 人工决定 → 需要写入的分组覆盖（接受飞书分组/恢复时返回 null）。 */
export function buildGroupingOverrideForDecision(
  review: Pick<ShipmentGroupingReviewDto, 'kind' | 'evidence'>,
  decision: ShipmentGroupingDecision,
): { kind: ShipmentGroupingReviewKind; spec: ShipmentGroupingOverrideSpec } | null {
  const { evidence } = review;
  if (review.kind === 'split' && decision === 'keep_one') {
    const [target, ...absorbed] = evidence.current.tickets;
    if (!target || absorbed.length === 0) return null;
    return {
      kind: 'merge',
      spec: {
        kind: 'merge',
        targetKey: target.ticketKey,
        absorbedKeys: absorbed.map((ticket) => ticket.ticketKey),
      },
    };
  }
  if (review.kind === 'merge' && decision === 'keep_separate') {
    const source = evidence.current.tickets[0];
    if (!source || evidence.previous.tickets.length < 2) return null;
    return {
      kind: 'split',
      spec: {
        kind: 'split',
        sourceKey: source.ticketKey,
        groups: evidence.previous.tickets.map((ticket) => ({
          ticketKey: ticket.ticketKey,
          ticketNo: ticket.ticketNo,
          market: ticket.market,
          customsMethod: null,
          waybillsText: ticket.waybillsText,
          purchaseOrder: ticket.purchaseOrder,
          products: ticket.items.map((item) => ({
            productNameNorm: item.productNameNorm,
            shippedQuantity: item.shippedQuantity,
          })),
        })),
      },
    };
  }
  return null;
}

/** 复核结论对应的动作文案（页面按钮用，短句，不解释机制）。 */
export const SHIPMENT_GROUPING_DECISION_LABEL: Record<ShipmentGroupingDecision, string> = {
  split_confirmed: '确实拆开',
  keep_one: '仍是一票',
  merge_confirmed: '确实合成一票',
  keep_separate: '仍然分开',
  restored: '恢复按飞书判断',
};
