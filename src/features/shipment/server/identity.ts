import type {
  ParsedShipmentTicket,
  ShipmentIdentityIndexRow,
  ShipmentIdentityStatus,
} from '../types';
import { shipmentFallbackSignature, splitWaybills } from './parse';

/**
 * 票身份延续匹配（合同 §1.3，纯函数、无 DB）。
 *
 * 内部身份是数据库 UUID；本次读取先把每张来源票匹配到已有票：
 *   P1 采购单号（去空格、大小写不敏感）唯一；
 *   P2 运单号任一 token 唯一（多运单票按任一重叠）；
 *   P3 原票既无采购单号也无运单号（弱身份票），且 市场 + 报关方式 + 规范化品名集合 完全一致。
 * 不能唯一确认（候选 >1、编号指向不同票、同一原票被两张票指向）时 matchedShipmentId=null 且
 * identityStatus='pending'，由页面标「身份待核」——不猜着合并，也不静默重复。
 *
 * 三遍顺序（与合同一致，已匹配的原票会被消费，同一原票不会被两张票同时匹配）：
 *   1) 强匹配（P1/P2 候选并集唯一）；
 *   2) 未匹配的弱身份 incoming ↔ 未消费的弱身份 existing（按弱签名唯一）；
 *   3) 带编号的未匹配 incoming ↔ 未消费的弱身份 existing（补采购单号/补运单号，按弱签名唯一）；
 *   4) 其余：只有“双方都没有运单号、且弱签名一致但采购单号对不上”这种弱证据场景才标待核，
 *      完全没有候选的才是确实新票（不能因为同市场同商品就怀疑每一张新票）。
 *
 * 待核状态只能被真正解决身份疑问的依据解除：命中已有待核记录自身时原样保留 pending 与候选说明
 * （普通刷新 / G、H 或数量变化都不算依据）。本轮不新增自动解除路径，也不新增人工核对工作流。
 */

export interface ShipmentIdentityPlanEntry {
  matchedShipmentId: string | null;
  identityStatus: ShipmentIdentityStatus;
  identityNote: string | null;
}

const NOTE_MAX_LENGTH = 500;

interface IdentityCandidate {
  row: ShipmentIdentityIndexRow;
  purchaseOrder: string;
  waybillTokens: string[];
  weak: boolean;
  signature: string;
}

function normalizePurchaseOrder(value: string | null): string {
  return (value ?? '').trim().toUpperCase();
}

function waybillTokens(value: string | null): string[] {
  return splitWaybills(value).tokens.map((token) => token.trim().toUpperCase());
}

function ticketSignature(ticket: ParsedShipmentTicket): string {
  return shipmentFallbackSignature(
    ticket.market,
    ticket.customsMethod,
    ticket.items.map((item) => item.productNameNorm),
  );
}

/** 候选的可读描述（写进 identityNote 供人工核对）。 */
function describeCandidate(candidate: IdentityCandidate): string {
  const label = candidate.row.purchaseOrder?.trim()
    || candidate.row.waybillsText?.trim()
    || candidate.row.ticketKey;
  const market = candidate.row.market?.trim();
  return market ? `${label}（${market}）` : label;
}

function pendingNote(prefix: string, candidates: IdentityCandidate[]): string {
  return `${prefix}：${candidates.map(describeCandidate).join('；')}`.slice(0, NOTE_MAX_LENGTH);
}

export function planShipmentIdentities(
  existing: ShipmentIdentityIndexRow[],
  tickets: ParsedShipmentTicket[],
): ShipmentIdentityPlanEntry[] {
  const rows: IdentityCandidate[] = existing.map((row) => {
    const purchaseOrder = normalizePurchaseOrder(row.purchaseOrder);
    const tokens = waybillTokens(row.waybillsText);
    return {
      row,
      purchaseOrder,
      waybillTokens: tokens,
      weak: purchaseOrder === '' && tokens.length === 0,
      signature: shipmentFallbackSignature(row.market, row.customsMethod, row.productNameNorms),
    };
  });
  const consumed = new Set<string>();
  const plan: Array<ShipmentIdentityPlanEntry | null> = tickets.map(() => null);

  const assign = (index: number, candidate: IdentityCandidate): void => {
    // 命中已有票只说明“继续更新这一行”，不等于它与原候选票的关系已核清：
    // 已有待核记录必须原样保留 pending 与原候选说明，普通刷新 / G/H / 数量更新都不能自动解除。
    const keepPending = candidate.row.identityStatus === 'pending';
    plan[index] = {
      matchedShipmentId: candidate.row.shipmentId,
      identityStatus: keepPending ? 'pending' : 'confirmed',
      identityNote: keepPending ? (candidate.row.identityNote ?? null) : null,
    };
    consumed.add(candidate.row.shipmentId);
  };
  const markPending = (index: number, note: string): void => {
    plan[index] = {
      matchedShipmentId: null,
      identityStatus: 'pending',
      identityNote: note.slice(0, NOTE_MAX_LENGTH),
    };
  };
  /** 候选唯一且未被本次其它票消费才能确认；否则标待核（不猜）。 */
  const resolveUnique = (index: number, candidates: IdentityCandidate[], ambiguousPrefix: string): void => {
    if (candidates.length > 1) {
      markPending(index, pendingNote(ambiguousPrefix, candidates));
      return;
    }
    const [candidate] = candidates;
    if (consumed.has(candidate.row.shipmentId)) {
      markPending(index, pendingNote('该特征对应的原票已被本次另一张票匹配，无法唯一确认', candidates));
      return;
    }
    assign(index, candidate);
  };

  // 1) 强匹配：P1（采购单号）/ P2（运单 token）候选并集唯一。
  tickets.forEach((ticket, index) => {
    const purchaseOrder = normalizePurchaseOrder(ticket.purchaseOrder);
    const tokens = waybillTokens(ticket.waybillsText);
    if (purchaseOrder === '' && tokens.length === 0) return;
    const candidates = rows.filter((candidate) => (
      (purchaseOrder !== '' && candidate.purchaseOrder === purchaseOrder)
      || (tokens.length > 0 && candidate.waybillTokens.some((token) => tokens.includes(token)))
    ));
    if (candidates.length === 0) return;
    resolveUnique(index, candidates, '来源编号同时指向多张原票，无法唯一确认');
  });

  // 2) 弱身份 incoming ↔ 弱身份 existing（按签名唯一）。
  tickets.forEach((ticket, index) => {
    if (plan[index] !== null) return;
    if (normalizePurchaseOrder(ticket.purchaseOrder) !== '' || waybillTokens(ticket.waybillsText).length > 0) return;
    const signature = ticketSignature(ticket);
    const candidates = rows.filter((candidate) => candidate.weak && candidate.signature === signature);
    if (candidates.length === 0) return;
    resolveUnique(index, candidates, '来源里有多张无编号原票与本次该票一致，无法唯一确认');
  });

  // 3) 带编号的未匹配 incoming ↔ 未消费的弱身份 existing（补采购单号 / 补运单号）。
  //    已在本轮被消费的弱身份原票说明“原票仍以自己的无编号行出现”，不能再当补号目标。
  tickets.forEach((ticket, index) => {
    if (plan[index] !== null) return;
    if (normalizePurchaseOrder(ticket.purchaseOrder) === '' && waybillTokens(ticket.waybillsText).length === 0) return;
    const signature = ticketSignature(ticket);
    const candidates = rows.filter((candidate) => candidate.weak
      && candidate.signature === signature
      && !consumed.has(candidate.row.shipmentId));
    if (candidates.length === 0) return;
    resolveUnique(index, candidates, '有多张无编号原票与本次该票的市场/报关方式/品名一致，无法唯一确认');
  });

  // 4) 其余：只有“双方都没有运单号 + 弱签名一致 + 采购单号对不上”才标待核；没有候选就是新票。
  //    同样排除本次已消费的原票：老票本次仍在（已被匹配）时，同品名的新编号票是新票，不是改号。
  tickets.forEach((ticket, index) => {
    if (plan[index] !== null) return;
    const incomingHasWaybill = waybillTokens(ticket.waybillsText).length > 0;
    const signature = ticketSignature(ticket);
    const candidates = incomingHasWaybill
      ? []
      : rows.filter((candidate) => candidate.waybillTokens.length === 0
        && candidate.signature === signature
        && !consumed.has(candidate.row.shipmentId));
    if (candidates.length === 0) {
      plan[index] = { matchedShipmentId: null, identityStatus: 'confirmed', identityNote: null };
      return;
    }
    markPending(index, pendingNote(
      '采购单号变化且双方都没有运单号，只能靠弱信号（市场/报关方式/品名）确认，无法唯一判定是否同一票；已保留原票并新建本票',
      candidates,
    ));
  });

  return plan as ShipmentIdentityPlanEntry[];
}
