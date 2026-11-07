import {
  SHIPMENT_SOURCE_KEY,
  ShipmentSourceError,
  type IngestShipmentSnapshot,
  type IngestShipmentTicket,
  type ShipmentGroupingContextDto,
  type ShipmentIdentityIndexRow,
  type ShipmentRefreshResultDto,
} from '../types';
import { planShipmentIdentities } from './identity';
import { normalizeRefreshResult, type ShipmentSnapshotRawDto } from './normalize';
import { parseShipmentSnapshot } from './parse';
import {
  applyGroupingInterpretationHash,
  applyGroupingOverrides,
  attachEvidenceBindings,
  buildRawGroupingState,
  detectGroupingChanges,
  type ParsedGroupingReview,
} from '../grouping';

/**
 * 一次「读取来源 → 解析 → 采购单身份匹配 → 入库」的完整流程。
 *
 * 手动刷新（Next 服务端动作，管理员 JWT）和后台定时读取（本机 Node 进程，受限 sync
 * 数据库运行角色）共用本函数：两边只注入各自的「读取来源 / 身份索引 / 入库 / 失败登记」
 * 实现，不复制解析、身份匹配或入库口径。数据库侧的入库函数负责持久化并同时采用已确认
 * 商品对应（见 027），所以本函数不另做关联写入。
 *
 * 第十四轮口径：
 * - 普通同步**不再**沿用绑定（商品绑定只在用户保存拆合票复核决定后，按明确对应补写）；
 * - 拆/合票检测对照「相邻两次成功读取的飞书原始分组」：上一次由上一成功快照 raw 服务端重新解析，
 *   本次用人工覆盖**之前**的 parsed.tickets；人工覆盖只控制展示/计价与重新入库，不遮住来源变化；
 * - 同内容连续同步：相邻两次原始分组相同 → 不产生复核；数据库再按（来源+签名+上次快照）去重。
 *
 * 失败语义：读取/解析/匹配/入库任一失败 → 记一次 failed 快照并返回 ok:false；
 * 上一份成功数据与原来源时间由数据库保留，绝不在页面写 0 或伪造空数据。
 */

export interface RawShipmentSourceReadInput {
  collection: IngestShipmentSnapshot['collection'];
  values: Array<Array<string | number | null>>;
  merges: IngestShipmentSnapshot['raw']['merges'];
}

export interface ShipmentRefreshFailureInput {
  readAt: string;
  errorCode: string;
  errorMessage: string;
}

export interface ShipmentRefreshDeps {
  /** 本次读取的操作者（管理员 profile id）；后台定时读取为 null，不冒充人工操作者。 */
  readBy: string | null;
  /** 真实读取飞书来源（失败抛 ShipmentSourceError）。 */
  readSource(): Promise<RawShipmentSourceReadInput>;
  /** 现有票身份索引（含本次来源未见的历史行）。 */
  identityIndex(): Promise<ShipmentIdentityIndexRow[]>;
  /**
   * 上一次成功读取的当前分组 + 生效中的人工分组覆盖。
   * 覆盖参与解析后的分组解释与内容哈希盐（人工决定后要重新入库一次）。
   */
  grouping(): Promise<ShipmentGroupingContextDto>;
  /**
   * 上一次成功读取的飞书原始网格（026 snapshot.raw）：拆/合票检测以它为上一侧分组。
   * 必须在本次入库前读取；没有成功快照时为 null（首次读取不产生复核）。
   */
  previousSnapshotRaw(): Promise<ShipmentSnapshotRawDto | null>;
  /** 单事务入库并采用已确认对应；返回 026/027 的 jsonb 结果。 */
  ingest(snapshot: IngestShipmentSnapshot): Promise<unknown>;
  /** 登记本次检测到的拆票/合票复核（同一签名只记一次）。 */
  recordGroupingReviews(
    reviews: Array<ParsedGroupingReview & { fromSnapshotId: string | null; toSnapshotId: string }>,
  ): Promise<unknown>;
  /** 登记一次读取失败（只写 failed 快照，不动业务数据）。 */
  recordFailure(input: ShipmentRefreshFailureInput): Promise<void>;
  /** 便于测试注入固定时间。 */
  now?(): Date;
}

export type ShipmentRefreshOutcome = ShipmentRefreshResultDto;

function emptyResult(readAt: string): ShipmentRefreshResultDto {
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

/** 失败原因归类：来源错误用其明确 errorCode，其它异常保留稳定错误码前缀，不吞原始信息。 */
export function describeShipmentFailure(error: unknown): { errorCode: string; errorMessage: string } {
  if (error instanceof ShipmentSourceError) {
    return { errorCode: error.code, errorMessage: error.detail ?? error.message };
  }
  const message = error instanceof Error ? error.message : String(error);
  const head = message.split(':', 1)[0]?.trim() ?? '';
  return {
    errorCode: /^[A-Z][A-Z0-9_]{3,63}$/.test(head) ? head : 'SHIPMENT_INGEST_FAILED',
    errorMessage: message.slice(0, 500),
  };
}

export async function runShipmentRefresh(deps: ShipmentRefreshDeps): Promise<ShipmentRefreshOutcome> {
  const now = deps.now ? deps.now() : new Date();
  const readAt = now.toISOString();
  const empty = emptyResult(readAt);
  try {
    // 外部数据只在入口解析一次：source 负责读取校验，parse 负责表头/分组/到货口径。
    const read = await deps.readSource();
    const parsed = parseShipmentSnapshot(read);
    // 身份索引、人工覆盖、上一成功原始网格并行读取（都只读；上一快照必须在入库前取）。
    const [existing, grouping, previousRaw] = await Promise.all([
      deps.identityIndex(),
      deps.grouping(),
      deps.previousSnapshotRaw(),
    ]);
    // 人工分组覆盖：把本次解析结果按用户已确认的口径重新解释（一票/分开）。
    const ticketsAfterOverride = applyGroupingOverrides(parsed.tickets, grouping.overrides);
    // 拆票/合票检测（第十四轮）：两侧都用飞书原始分组；本次是覆盖之前的结果。
    let reviews: ParsedGroupingReview[] = [];
    let previousSnapshotId: string | null = null;
    if (previousRaw !== null && previousRaw.snapshotId) {
      previousSnapshotId = previousRaw.snapshotId;
      const previousParsed = parseShipmentSnapshot({
        collection: previousRaw.collection as unknown as IngestShipmentSnapshot['collection'],
        values: previousRaw.values,
        merges: previousRaw.merges,
      });
      const previousGrouping = buildRawGroupingState(previousParsed.tickets, existing);
      // 身份匹配照旧：在原始（未覆盖）票上做匹配，供检测判断「哪张票延续了哪张原票」。
      const rawIdentities = planShipmentIdentities(existing, parsed.tickets);
      reviews = detectGroupingChanges(
        previousGrouping,
        parsed.tickets,
        rawIdentities.map((identity) => identity.matchedShipmentId),
      ).map((review) => attachEvidenceBindings(review, grouping.tickets));
    }
    // 入库用的身份延续：按人工覆盖后的票匹配（与既有入库/展示口径一致）。
    const identities = planShipmentIdentities(existing, ticketsAfterOverride);
    const tickets: IngestShipmentTicket[] = ticketsAfterOverride.map((ticket, index) => ({
      ...ticket,
      matchedShipmentId: identities[index].matchedShipmentId,
      identityStatus: identities[index].identityStatus,
      identityNote: identities[index].identityNote,
    }));
    // 内容哈希加入「分组解释」盐：人工覆盖新增/撤销后，同一份来源内容会重新入库一次。
    const baseContentHash = read.collection.rawContentHash;
    const snapshot: IngestShipmentSnapshot = {
      sourceKey: parsed.sourceKey,
      collection: {
        ...parsed.collection,
        readBy: deps.readBy,
        baseContentHash,
        rawContentHash: applyGroupingInterpretationHash(baseContentHash, grouping.overrides),
      },
      tickets,
      raw: parsed.raw,
    };
    const raw = await deps.ingest(snapshot);
    const result: ShipmentRefreshResultDto = { ...empty, ...normalizeRefreshResult(raw) };
    // 普通同步只登记复核：不再自动沿用绑定（绑定沿用只发生在用户保存复核决定之后）。
    if (result.snapshotId && reviews.length > 0) {
      await deps.recordGroupingReviews(reviews.map((review) => ({
        ...review,
        evidence: {
          ...review.evidence,
          previous: { ...review.evidence.previous, snapshotId: previousSnapshotId },
          current: { ...review.evidence.current, snapshotId: result.snapshotId ?? null },
        },
        fromSnapshotId: previousSnapshotId,
        toSnapshotId: result.snapshotId as string,
      })));
    }
    return result;
  } catch (error) {
    const failure = describeShipmentFailure(error);
    await deps.recordFailure({ readAt, ...failure });
    return { ...empty, ok: false, errorCode: failure.errorCode, errorMessage: failure.errorMessage };
  }
}

/** 本包的固定来源键（页面对应一个飞书物流表）。 */
export const SHIPMENT_REFRESH_SOURCE_KEY = SHIPMENT_SOURCE_KEY;
