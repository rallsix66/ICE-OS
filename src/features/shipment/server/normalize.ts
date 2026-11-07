import type {
  ProductSearchRowDto,
  ProductShipmentLinkRowDto,
  ProductShipmentLinksDto,
  ShipmentAssociationResultDto,
  ShipmentAssociationStatus,
  ShipmentAutoReaderStatusDto,
  ShipmentDetailDto,
  ShipmentDetailItemDto,
  ShipmentGroupingContextDto,
  ShipmentGroupingDecision,
  ShipmentGroupingOverrideDto,
  ShipmentGroupingOverrideSpec,
  ShipmentGroupingResolveResultDto,
  ShipmentGroupingReviewDto,
  ShipmentGroupingReviewEvidenceDto,
  ShipmentGroupingReviewKind,
  ShipmentGroupingReviewTicketSide,
  ShipmentGroupingReviewsDto,
  ShipmentGroupingStateTicket,
  ShipmentIdentityIndexRow,
  ShipmentIdentityStatus,
  ShipmentLinkedProductDto,
  ShipmentListCountsDto,
  ShipmentListDto,
  ShipmentListRowDto,
  ShipmentManualResultDto,
  ShipmentManualRevisionDto,
  ShipmentManualStatus,
  ShipmentMarketCountDto,
  ShipmentMissingItemDto,
  ShipmentReadAttemptDto,
  ShipmentReceiptBasis,
  ShipmentRefreshResultDto,
  ShipmentRemainingState,
  ShipmentRevisionDto,
  ShipmentSnapshotBriefDto,
  ShipmentSourceMergedRange,
  ShipmentSourceStatusDto,
  ShipmentStatusClass,
} from '../types';
import type { ShipmentMarketSummarySource, ShipmentMarketSummarySourceItem } from '../summary';
import type { ProductTransitItemRow, ProductTransitSource, ProductTransitTicketRow } from '../product-transit';

/**
 * 数据库 RPC 结果 → 页面 DTO 的归一化（纯函数，无 DB / 无环境变量）。
 *
 * 026 的函数直接按 DTO 键名输出 camelCase，这里只做类型收窄与兜底：
 * 未知值一律保留 null/空集合，不把缺失写成 0，不臆断状态分类。
 */

type Raw = Record<string, unknown>;

function record(value: unknown): Raw {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Raw : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function intOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Math.trunc(Number(value));
  }
  return null;
}

function intOr(value: unknown, fallback: number): number {
  return intOrNull(value) ?? fallback;
}

function boolean(value: unknown): boolean {
  return value === true;
}

const STATUS_CLASSES: ShipmentStatusClass[] = [
  'in_transit', 'partial', 'arrived_pending_shelving', 'arrived', 'unknown',
];
const RECEIPT_BASES: ShipmentReceiptBasis[] = [
  'status_in_transit_zero', 'status_awaiting_shelving_zero', 'status_arrived_full',
  'source_quantity', 'pending', 'manual_correction',
];
const MANUAL_STATUSES: ShipmentManualStatus[] = [
  'in_transit', 'arrived_pending_shelving', 'fully_shelved', 'partial_shelved', 'unknown',
];
const ASSOCIATION_STATUSES: ShipmentAssociationStatus[] = ['auto', 'manual', 'none'];

function statusClass(value: unknown): ShipmentStatusClass {
  return STATUS_CLASSES.includes(value as ShipmentStatusClass)
    ? value as ShipmentStatusClass
    : 'unknown';
}

function receiptBasis(value: unknown): ShipmentReceiptBasis {
  return RECEIPT_BASES.includes(value as ShipmentReceiptBasis)
    ? value as ShipmentReceiptBasis
    : 'pending';
}

function associationStatus(value: unknown): ShipmentAssociationStatus {
  return ASSOCIATION_STATUSES.includes(value as ShipmentAssociationStatus)
    ? value as ShipmentAssociationStatus
    : 'none';
}

function identityStatus(value: unknown): ShipmentIdentityStatus {
  return value === 'pending' ? 'pending' : 'confirmed';
}

function remainingState(value: unknown): ShipmentRemainingState {
  return value === 'known' ? 'known' : 'pending';
}

/** 人工修正状态：只接受 5 个明确值，其它一律 null（= 按原表判断）。 */
function manualStatus(value: unknown): ShipmentManualStatus | null {
  return MANUAL_STATUSES.includes(value as ShipmentManualStatus)
    ? value as ShipmentManualStatus
    : null;
}

/** 原表到货依据：不允许 manual_correction（那是生效依据，不是原表判断）。 */
function sourceReceiptBasis(value: unknown, fallback: ShipmentReceiptBasis): ShipmentReceiptBasis {
  const parsed = receiptBasis(value);
  if (parsed === 'manual_correction') return fallback === 'manual_correction' ? 'pending' : fallback;
  return parsed;
}

/**
 * 关联商品身份（占位）。
 *
 * 详情 DTO 的 product 卡片需要规格/单位/单位成本字段，但这里只做 RPC → DTO 归一化、
 * 不读商品库；真正取值由 reads.ts 的 getShipmentDetail 用 buildShipmentProductCard 覆盖。
 * 因此这里先给「尚未读取」占位（empty/none/missing），不允许出现在最终页面（Lead 已批准）。
 */
function linkedProduct(value: unknown): ShipmentLinkedProductDto | null {
  if (!value || typeof value !== 'object') return null;
  const raw = record(value);
  const itemId = text(raw.itemId);
  if (itemId === '') return null;
  return {
    itemId,
    iceCode: textOrNull(raw.iceCode),
    nameCn: textOrNull(raw.nameCn),
    specificationText: '',
    specificationSource: 'none',
    unitText: null,
    cartonQuantity: null,
    unitCost: { state: 'missing', amountCny: null, label: '成本待补充', reason: '商品资料尚未读取' },
  };
}

function snapshotBrief(value: unknown): ShipmentSnapshotBriefDto | null {
  if (!value || typeof value !== 'object') return null;
  const raw = record(value);
  const snapshotId = text(raw.snapshotId);
  if (snapshotId === '') return null;
  return {
    snapshotId,
    readAt: text(raw.readAt),
    documentEditedAt: textOrNull(raw.documentEditedAt),
    revision: intOrNull(raw.revision),
    ticketCount: intOr(raw.ticketCount, 0),
    itemCount: intOr(raw.itemCount, 0),
  };
}

function readAttempt(value: unknown): ShipmentReadAttemptDto | null {
  if (!value || typeof value !== 'object') return null;
  const raw = record(value);
  const snapshotId = text(raw.snapshotId);
  if (snapshotId === '') return null;
  return {
    snapshotId,
    readAt: text(raw.readAt),
    status: text(raw.status) === 'failed' ? 'failed' : 'success',
    errorCode: textOrNull(raw.errorCode),
    errorMessage: textOrNull(raw.errorMessage),
  };
}

export function normalizeSourceStatus(value: unknown): ShipmentSourceStatusDto {
  const raw = record(value);
  return {
    sourceKey: text(raw.sourceKey),
    docTitle: textOrNull(raw.docTitle),
    sheetTitle: textOrNull(raw.sheetTitle),
    lastSuccess: snapshotBrief(raw.lastSuccess),
    lastAttempt: readAttempt(raw.lastAttempt),
    autoReader: normalizeAutoReaderStatus(raw.autoReader),
  };
}

/** 自动读取状态：结构不对/未安装 027 时返回 null，页面显示“状态读取失败”，不伪造运行状态。 */
export function normalizeAutoReaderStatus(value: unknown): ShipmentAutoReaderStatusDto | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = record(value);
  const interval = intOrNull(raw.intervalMinutes);
  if (typeof raw.enabled !== 'boolean' || interval === null) return null;
  const result = textOrNull(raw.lastResult);
  return {
    enabled: raw.enabled,
    intervalMinutes: interval,
    nextRunAt: textOrNull(raw.nextRunAt),
    lastStartedAt: textOrNull(raw.lastStartedAt),
    lastFinishedAt: textOrNull(raw.lastFinishedAt),
    lastResult: result === 'success' || result === 'unchanged' || result === 'failed' ? result : null,
    lastReadAt: textOrNull(raw.lastReadAt),
    lastTicketCount: intOrNull(raw.lastTicketCount),
    lastItemCount: intOrNull(raw.lastItemCount),
    lastErrorCode: textOrNull(raw.lastErrorCode),
    lastErrorMessage: textOrNull(raw.lastErrorMessage),
    heartbeatAt: textOrNull(raw.heartbeatAt),
    runnerPid: intOrNull(raw.runnerPid),
    workerOnline: boolean(raw.workerOnline),
    running: boolean(raw.running),
    leaseOwner: textOrNull(raw.leaseOwner),
  };
}

function listRow(value: unknown): ShipmentListRowDto {
  const raw = record(value);
  return {
    shipmentId: text(raw.shipmentId),
    market: textOrNull(raw.market),
    purchaseOrder: textOrNull(raw.purchaseOrder),
    waybillsText: textOrNull(raw.waybillsText),
    ticketNo: text(raw.ticketNo),
    itemCount: intOr(raw.itemCount, 0),
    productSummary: array(raw.productSummary).map(text).filter((name) => name !== ''),
    statusClass: statusClass(raw.statusClass),
    // 含人工修正后的有效货票状态（无人工修正时=statusClass）；合并 manual index 后覆盖。
    effectiveStatusClass: statusClass(raw.effectiveStatusClass === undefined
      ? raw.statusClass : raw.effectiveStatusClass),
    manualCorrectionCount: intOr(raw.manualCorrectionCount, 0),
    manualReviewCount: intOr(raw.manualReviewCount, 0),
    transportText: textOrNull(raw.transportText),
    arrivalText: textOrNull(raw.arrivalText),
    quantityPending: boolean(raw.quantityPending),
    identityStatus: identityStatus(raw.identityStatus),
    identityNote: textOrNull(raw.identityNote),
    presentInLatestRead: boolean(raw.presentInLatestRead),
    lastSeenAt: text(raw.lastSeenAt),
  };
}

function listCounts(value: unknown): ShipmentListCountsDto {
  const raw = record(value);
  return {
    total: intOr(raw.total, 0),
    inTransit: intOr(raw.inTransit, 0),
    partial: intOr(raw.partial, 0),
    arrivedPendingShelving: intOr(raw.arrivedPendingShelving, 0),
    arrived: intOr(raw.arrived, 0),
    unknown: intOr(raw.unknown, 0),
  };
}

function marketCounts(value: unknown): ShipmentMarketCountDto[] {
  return array(value).map((entry) => {
    const raw = record(entry);
    return { market: textOrNull(raw.market), count: intOr(raw.count, 0) };
  });
}

export function normalizeList(value: unknown): ShipmentListDto {
  const raw = record(value);
  return {
    total: intOr(raw.total, 0),
    offset: intOr(raw.offset, 0),
    limit: intOr(raw.limit, 0),
    rows: array(raw.rows).map(listRow).filter((row) => row.shipmentId !== ''),
    counts: listCounts(raw.counts),
    markets: marketCounts(raw.markets),
    includeAbsent: boolean(raw.includeAbsent),
    absentTickets: intOr(raw.absentTickets, 0),
    absentItems: intOr(raw.absentItems, 0),
    latestReadAt: textOrNull(raw.latestReadAt),
    sourceStatus: normalizeSourceStatus(raw.sourceStatus),
  };
}

function detailItem(value: unknown): ShipmentDetailItemDto {
  const raw = record(value);
  const effectiveBasis = receiptBasis(raw.receiptBasis);
  const manual = manualStatus(raw.manualStatus);
  return {
    itemId: text(raw.itemId),
    itemKey: text(raw.itemKey),
    productNameRaw: text(raw.productNameRaw),
    productNameNorm: text(raw.productNameNorm),
    shippedQuantity: intOr(raw.shippedQuantity, 0),
    receivedQuantity: intOrNull(raw.receivedQuantity),
    receiptBasis: effectiveBasis,
    remainingQuantity: intOrNull(raw.remainingQuantity),
    remainingState: remainingState(raw.remainingState),
    unitText: textOrNull(raw.unitText),
    sourceSku: textOrNull(raw.sourceSku),
    sourceNote: textOrNull(raw.sourceNote),
    product: linkedProduct(raw.product),
    associationStatus: associationStatus(raw.associationStatus),
    associationMethod: textOrNull(raw.associationMethod),
    associatedAt: textOrNull(raw.associatedAt),
    revision: intOr(raw.revision, 1),
    // 026 的详情不返回人工字段：这里给“按原表判断”的默认值，由 reads 用 manual index 合并覆盖。
    manualStatus: manual,
    manualShelvedQuantity: intOrNull(raw.manualShelvedQuantity),
    manualShippedQuantity: intOrNull(raw.manualShippedQuantity),
    previousConfirmedShelvedQuantity: intOrNull(raw.previousConfirmedShelvedQuantity),
    manualConflict: boolean(raw.manualConflict),
    manualActorName: textOrNull(raw.manualActorName),
    manualAt: textOrNull(raw.manualAt),
    manualRevision: intOr(raw.manualRevision, 0),
    manualReviewNeeded: boolean(raw.manualReviewNeeded),
    manualReviewNote: textOrNull(raw.manualReviewNote),
    // 无人工修正时 029 保证 source_* 与生效值一致，所以缺字段时用生效值兜底。
    sourceReceivedQuantity: raw.sourceReceivedQuantity === undefined
      ? (manual === null ? intOrNull(raw.receivedQuantity) : null)
      : intOrNull(raw.sourceReceivedQuantity),
    sourceReceiptBasis: sourceReceiptBasis(
      raw.sourceReceiptBasis === undefined ? raw.receiptBasis : raw.sourceReceiptBasis,
      effectiveBasis,
    ),
  };
}

function missingItem(value: unknown): ShipmentMissingItemDto {
  const raw = record(value);
  return {
    itemId: text(raw.itemId),
    itemKey: text(raw.itemKey),
    productNameRaw: text(raw.productNameRaw),
    shippedQuantity: intOr(raw.shippedQuantity, 0),
    receivedQuantity: intOrNull(raw.receivedQuantity),
    receiptBasis: receiptBasis(raw.receiptBasis),
    remainingQuantity: intOrNull(raw.remainingQuantity),
    remainingState: remainingState(raw.remainingState),
    sourceNote: textOrNull(raw.sourceNote),
    product: linkedProduct(raw.product),
    associationStatus: associationStatus(raw.associationStatus),
    lastSeenAt: text(raw.lastSeenAt),
  };
}

function revisionRow(value: unknown): ShipmentRevisionDto {
  const raw = record(value);
  return {
    revision: intOr(raw.revision, 1),
    recordedAt: text(raw.recordedAt),
    changedFields: array(raw.changedFields).map(text).filter((field) => field !== ''),
    snapshotId: text(raw.snapshotId),
  };
}

/** 详情：票不存在时 RPC 返回 NULL，这里返回 null 由页面按空态处理。 */
export function normalizeDetail(value: unknown): ShipmentDetailDto | null {
  if (!value || typeof value !== 'object') return null;
  const raw = record(value);
  const shipment = record(raw.shipment);
  const shipmentId = text(shipment.shipmentId);
  if (shipmentId === '') return null;
  return {
    shipment: {
      shipmentId,
      ticketNo: text(shipment.ticketNo),
      ticketKey: text(shipment.ticketKey),
      market: textOrNull(shipment.market),
      customsMethod: textOrNull(shipment.customsMethod),
      waybillsText: textOrNull(shipment.waybillsText),
      purchaseOrder: textOrNull(shipment.purchaseOrder),
      statusClass: statusClass(shipment.statusClass),
      effectiveStatusClass: statusClass(shipment.effectiveStatusClass === undefined
        ? shipment.statusClass : shipment.effectiveStatusClass),
      manualCorrectionCount: intOr(shipment.manualCorrectionCount, 0),
      manualReviewCount: intOr(shipment.manualReviewCount, 0),
      transportText: textOrNull(shipment.transportText),
      arrivalText: textOrNull(shipment.arrivalText),
      vessel: textOrNull(shipment.vessel),
      dispatchedText: textOrNull(shipment.dispatchedText),
      itemCount: intOr(shipment.itemCount, 0),
      quantityPending: boolean(shipment.quantityPending),
      identityStatus: identityStatus(shipment.identityStatus),
      identityNote: textOrNull(shipment.identityNote),
      presentInLatestRead: boolean(shipment.presentInLatestRead),
      sourceRowStart: intOr(shipment.sourceRowStart, 0),
      sourceRowEnd: intOr(shipment.sourceRowEnd, 0),
      firstSeenAt: text(shipment.firstSeenAt),
      lastSeenAt: text(shipment.lastSeenAt),
      revision: intOr(shipment.revision, 1),
    },
    items: array(raw.items).map(detailItem).filter((item) => item.itemId !== ''),
    missingItems: array(raw.missingItems).map(missingItem).filter((item) => item.itemId !== ''),
    revisions: array(raw.revisions).map(revisionRow),
    manualRevisions: array(raw.manualRevisions).map(manualRevisionRow),
    latestReadAt: textOrNull(raw.latestReadAt),
    sourceStatus: normalizeSourceStatus(raw.sourceStatus),
  };
}

/** 028 市场汇总：只做结构收窄；合计与货值由 summary.ts 按 026 口径计算。 */
export function normalizeMarketSummary(value: unknown): ShipmentMarketSummarySource {
  const raw = record(value);
  return {
    market: textOrNull(raw.market),
    unknownMarket: boolean(raw.unknownMarket),
    latestReadAt: textOrNull(raw.latestReadAt),
    snapshotId: textOrNull(raw.snapshotId),
    ticketCount: intOr(raw.ticketCount, 0),
    itemCount: intOr(raw.itemCount, 0),
    items: array(raw.items).map((entry): ShipmentMarketSummarySourceItem => {
      const row = record(entry);
      return {
        itemId: text(row.itemId),
        shipmentId: text(row.shipmentId),
        ticketNo: text(row.ticketNo),
        purchaseOrder: textOrNull(row.purchaseOrder),
        waybillsText: textOrNull(row.waybillsText),
        market: textOrNull(row.market),
        statusClass: statusClass(row.statusClass),
        productId: textOrNull(row.productId),
        productNameRaw: text(row.productNameRaw),
        associationStatus: associationStatus(row.associationStatus),
        shippedQuantity: intOr(row.shippedQuantity, 0),
        receivedQuantity: intOrNull(row.receivedQuantity),
        receiptBasis: receiptBasis(row.receiptBasis),
        manualShippedQuantity: intOrNull(row.manualShippedQuantity),
        manualConflict: boolean(row.manualConflict),
        remainingQuantity: intOrNull(row.remainingQuantity),
        remainingState: remainingState(row.remainingState),
      };
    }).filter((item) => item.itemId !== '' && item.shipmentId !== ''),
  };
}

/** 031/032 商品在途总览：结构收窄；剩余/待核/合计/市场分组由 product-transit.ts 计算。 */
export function normalizeProductTransit(value: unknown): ProductTransitSource {
  const raw = record(value);
  return {
    productId: text(raw.productId),
    latestReadAt: textOrNull(raw.latestReadAt),
    snapshotId: textOrNull(raw.snapshotId),
    tickets: array(raw.tickets).map((entry): ProductTransitTicketRow => {
      const row = record(entry);
      return {
        shipmentId: text(row.shipmentId),
        ticketNo: text(row.ticketNo),
        purchaseOrder: textOrNull(row.purchaseOrder),
        market: textOrNull(row.market),
        waybillsText: textOrNull(row.waybillsText),
        statusClass: statusClass(row.statusClass),
        effectiveStatusClass: statusClass(row.effectiveStatusClass === undefined
          ? row.statusClass : row.effectiveStatusClass),
        transportText: textOrNull(row.transportText),
        arrivalText: textOrNull(row.arrivalText),
        ticketItemCount: intOr(row.ticketItemCount, 0),
        // 032：同票同商品逐条明细；缺字段时按空数组处理，由 product-transit 判为待核（不写 0）。
        items: array(row.items).map((item): ProductTransitItemRow => {
          const rawItem = record(item);
          return {
            itemId: text(rawItem.itemId),
            shippedQuantity: intOr(rawItem.shippedQuantity, 0),
            receivedQuantity: intOrNull(rawItem.receivedQuantity),
            manualConflict: boolean(rawItem.manualConflict),
            manualCorrected: boolean(rawItem.manualCorrected),
          };
        }).filter((item) => item.itemId !== ''),
      };
    }).filter((row) => row.shipmentId !== ''),
  };
}

export function normalizeProductLinks(value: unknown): ProductShipmentLinksDto {  const raw = record(value);
  return {
    total: intOr(raw.total, 0),
    rows: array(raw.rows).map((entry): ProductShipmentLinkRowDto => {
      const row = record(entry);
      return {
        shipmentId: text(row.shipmentId),
        ticketNo: text(row.ticketNo),
        market: textOrNull(row.market),
        purchaseOrder: textOrNull(row.purchaseOrder),
        waybillsText: textOrNull(row.waybillsText),
        statusClass: statusClass(row.statusClass),
        transportText: textOrNull(row.transportText),
        arrivalText: textOrNull(row.arrivalText),
        shippedQuantity: intOr(row.shippedQuantity, 0),
        receivedQuantity: intOrNull(row.receivedQuantity),
        remainingQuantity: intOrNull(row.remainingQuantity),
        remainingState: remainingState(row.remainingState),
        itemCount: intOr(row.itemCount, 0),
      };
    }).filter((row) => row.shipmentId !== ''),
  };
}

/** 身份索引：现有票（含历史行）的编号/市场/规范品名集合/身份状态，供 identity.ts 匹配。 */
export function normalizeIdentityIndex(value: unknown): ShipmentIdentityIndexRow[] {
  return array(value).map((entry): ShipmentIdentityIndexRow => {
    const raw = record(entry);
    return {
      shipmentId: text(raw.shipmentId),
      ticketKey: text(raw.ticketKey),
      purchaseOrder: textOrNull(raw.purchaseOrder),
      waybillsText: textOrNull(raw.waybillsText),
      market: textOrNull(raw.market),
      customsMethod: textOrNull(raw.customsMethod),
      productNameNorms: array(raw.productNameNorms).map(text).filter((name) => name !== ''),
      identityStatus: identityStatus(raw.identityStatus),
      identityNote: textOrNull(raw.identityNote),
    };
  }).filter((row) => row.shipmentId !== '');
}

/* ------------------------------------------------------------------ *
 * 第八轮：人工「修正在途」归一化 + 合并
 * （026 的详情/列表不返回人工字段，由 029 的 manual index/history 在服务端合并）
 * ------------------------------------------------------------------ */

export interface ShipmentManualShipmentState {
  shipmentId: string;
  effectiveStatusClass: ShipmentStatusClass;
  manualCorrectionCount: number;
  manualReviewCount: number;
  manualConflictCount: number;
}

export interface ShipmentManualItemState {
  itemId: string;
  shipmentId: string;
  manualStatus: ShipmentManualStatus | null;
  manualShelvedQuantity: number | null;
  manualShippedQuantity: number | null;
  previousConfirmedShelvedQuantity: number | null;
  manualConflict: boolean;
  manualActorName: string | null;
  manualAt: string | null;
  manualRevision: number;
  manualReviewNeeded: boolean;
  manualReviewNote: string | null;
  sourceReceivedQuantity: number | null;
  sourceReceiptBasis: ShipmentReceiptBasis;
}

export interface ShipmentManualIndex {
  shipments: ShipmentManualShipmentState[];
  items: ShipmentManualItemState[];
}

function manualRevisionRow(value: unknown): ShipmentManualRevisionDto {
  const raw = record(value);
  const action = text(raw.action) === 'restore' ? 'restore' : 'apply';
  return {
    itemId: text(raw.itemId),
    productNameRaw: text(raw.productNameRaw),
    revision: intOr(raw.revision, 1),
    action,
    manualStatus: manualStatus(raw.manualStatus),
    manualShelvedQuantity: intOrNull(raw.manualShelvedQuantity),
    previousManualStatus: manualStatus(raw.previousManualStatus),
    previousManualShelvedQuantity: intOrNull(raw.previousManualShelvedQuantity),
    receivedQuantity: intOrNull(raw.receivedQuantity),
    remainingQuantity: intOrNull(raw.remainingQuantity),
    actorName: text(raw.actorName),
    note: textOrNull(raw.note),
    recordedAt: text(raw.recordedAt),
  };
}

export function normalizeManualIndex(value: unknown): ShipmentManualIndex {
  const raw = record(value);
  return {
    shipments: array(raw.shipments).map((entry): ShipmentManualShipmentState => {
      const row = record(entry);
      return {
        shipmentId: text(row.shipmentId),
        effectiveStatusClass: statusClass(row.effectiveStatusClass),
        manualCorrectionCount: intOr(row.manualCorrectionCount, 0),
        manualReviewCount: intOr(row.manualReviewCount, 0),
        manualConflictCount: intOr(row.manualConflictCount, 0),
      };
    }).filter((row) => row.shipmentId !== ''),
    items: array(raw.items).map((entry): ShipmentManualItemState => {
      const row = record(entry);
      return {
        itemId: text(row.itemId),
        shipmentId: text(row.shipmentId),
        manualStatus: manualStatus(row.manualStatus),
        manualShelvedQuantity: intOrNull(row.manualShelvedQuantity),
        manualShippedQuantity: intOrNull(row.manualShippedQuantity),
        previousConfirmedShelvedQuantity: intOrNull(row.previousConfirmedShelvedQuantity),
        manualConflict: boolean(row.manualConflict),
        manualActorName: textOrNull(row.manualActorName),
        manualAt: textOrNull(row.manualAt),
        manualRevision: intOr(row.manualRevision, 0),
        manualReviewNeeded: boolean(row.manualReviewNeeded),
        manualReviewNote: textOrNull(row.manualReviewNote),
        sourceReceivedQuantity: intOrNull(row.sourceReceivedQuantity),
        sourceReceiptBasis: sourceReceiptBasis(row.sourceReceiptBasis, 'pending'),
      };
    }).filter((row) => row.itemId !== ''),
  };
}

export function normalizeManualHistory(value: unknown): ShipmentManualRevisionDto[] {
  return array(value).map(manualRevisionRow).filter((row) => row.itemId !== '');
}

export function normalizeManualResult(value: unknown): ShipmentManualResultDto {
  const raw = record(value);
  const received = intOrNull(raw.receivedQuantity);
  return {
    ok: boolean(raw.ok),
    itemId: text(raw.itemId),
    manualStatus: manualStatus(raw.manualStatus),
    manualShelvedQuantity: intOrNull(raw.manualShelvedQuantity),
    receivedQuantity: received,
    remainingQuantity: intOrNull(raw.remainingQuantity),
    receiptBasis: receiptBasis(raw.receiptBasis),
    manualRevision: intOr(raw.manualRevision, 0),
    manualActorName: textOrNull(raw.manualActorName),
    manualAt: textOrNull(raw.manualAt),
    reviewNeeded: boolean(raw.reviewNeeded),
    errorCode: textOrNull(raw.errorCode),
    errorMessage: textOrNull(raw.errorMessage),
  };
}

/**
 * 列表合并：把 manual index 的有效状态/计数按 shipmentId 合到列表行；
 * index 为 null（manual 读取失败）时保持原值，不整页失败。
 */
export function mergeManualListRows(
  rows: ShipmentListRowDto[],
  index: ShipmentManualIndex | null,
): ShipmentListRowDto[] {
  if (!index || index.shipments.length === 0) return rows;
  const byShipment = new Map(index.shipments.map((state) => [state.shipmentId, state]));
  return rows.map((row) => {
    const state = byShipment.get(row.shipmentId);
    return state
      ? {
        ...row,
        effectiveStatusClass: state.effectiveStatusClass,
        manualCorrectionCount: state.manualCorrectionCount,
        manualReviewCount: state.manualReviewCount,
      }
      : row;
  });
}

/**
 * 详情合并：票级有效状态/计数、逐明细人工字段与来源值、人工修正历史。
 * manual index/history 读取失败只降级这些字段（保留 026 主数据），不影响详情本身。
 */
export function mergeManualDetail(
  detail: ShipmentDetailDto,
  index: ShipmentManualIndex | null,
  history: ShipmentManualRevisionDto[] | null,
): ShipmentDetailDto {
  const shipmentState = index?.shipments.find((state) => state.shipmentId === detail.shipment.shipmentId) ?? null;
  const itemsById = new Map((index?.items ?? []).map((state) => [state.itemId, state]));
  return {
    ...detail,
    shipment: shipmentState
      ? {
        ...detail.shipment,
        effectiveStatusClass: shipmentState.effectiveStatusClass,
        manualCorrectionCount: shipmentState.manualCorrectionCount,
        manualReviewCount: shipmentState.manualReviewCount,
      }
      : detail.shipment,
    items: detail.items.map((item) => {
      const state = itemsById.get(item.itemId);
      return state
        ? {
          ...item,
          manualStatus: state.manualStatus,
          manualShelvedQuantity: state.manualShelvedQuantity,
          manualShippedQuantity: state.manualShippedQuantity,
          previousConfirmedShelvedQuantity: state.previousConfirmedShelvedQuantity,
          manualConflict: state.manualConflict,
          manualActorName: state.manualActorName,
          manualAt: state.manualAt,
          manualRevision: state.manualRevision,
          manualReviewNeeded: state.manualReviewNeeded,
          manualReviewNote: state.manualReviewNote,
          sourceReceivedQuantity: state.sourceReceivedQuantity,
          sourceReceiptBasis: state.sourceReceiptBasis,
        }
        : item;
    }),
    manualRevisions: history ?? detail.manualRevisions,
  };
}

export function normalizeProductSearch(value: unknown): ProductSearchRowDto[] {
  return array(value).map((entry): ProductSearchRowDto => {
    const row = record(entry);
    return {
      itemId: text(row.itemId),
      iceCode: textOrNull(row.iceCode),
      nameCn: text(row.nameCn),
      specification: textOrNull(row.specification),
      identifiers: array(row.identifiers).map(text).filter((part) => part !== ''),
    };
  }).filter((row) => row.itemId !== '');
}

export function normalizeRefreshResult(value: unknown): ShipmentRefreshResultDto {
  const raw = record(value);
  return {
    ok: boolean(raw.ok),
    readAt: text(raw.readAt),
    snapshotId: textOrNull(raw.snapshotId),
    ticketCount: intOr(raw.ticketCount, 0),
    itemCount: intOr(raw.itemCount, 0),
    createdTickets: intOr(raw.createdTickets, 0),
    updatedTickets: intOr(raw.updatedTickets, 0),
    unchangedTickets: intOr(raw.unchangedTickets, 0),
    createdItems: intOr(raw.createdItems, 0),
    updatedItems: intOr(raw.updatedItems, 0),
    revisionsAdded: intOr(raw.revisionsAdded, 0),
    associationsPreserved: intOr(raw.associationsPreserved, 0),
    absentTickets: intOr(raw.absentTickets, 0),
    absentItems: intOr(raw.absentItems, 0),
    adoptedAssociations: intOr(raw.adoptedAssociations, 0),
    errorCode: textOrNull(raw.errorCode),
    errorMessage: textOrNull(raw.errorMessage),
  };
}

export function normalizeAssociationResult(value: unknown): ShipmentAssociationResultDto {
  const raw = record(value);
  return {
    ok: boolean(raw.ok),
    itemId: text(raw.itemId),
    productId: textOrNull(raw.productId),
    associationStatus: associationStatus(raw.associationStatus),
    revision: intOr(raw.revision, 0),
    errorCode: textOrNull(raw.errorCode),
    errorMessage: textOrNull(raw.errorMessage),
    mappingSaved: boolean(raw.mappingSaved),
    adoptedCount: intOr(raw.adoptedCount, 0),
    mappingNote: textOrNull(raw.mappingNote),
  };
}

/* ------------------------------------------------------------------ *
 * 第十二轮：拆票 / 合票复核
 * ------------------------------------------------------------------ */

const GROUPING_REVIEW_KINDS: ShipmentGroupingReviewKind[] = ['split', 'merge'];
const GROUPING_DECISIONS: ShipmentGroupingDecision[] = [
  'split_confirmed', 'keep_one', 'merge_confirmed', 'keep_separate', 'restored',
];

function groupingKind(value: unknown): ShipmentGroupingReviewKind {
  const kind = text(value);
  return GROUPING_REVIEW_KINDS.includes(kind as ShipmentGroupingReviewKind)
    ? kind as ShipmentGroupingReviewKind
    : 'split';
}

function groupingDecision(value: unknown): ShipmentGroupingDecision | null {
  const decision = text(value);
  return GROUPING_DECISIONS.includes(decision as ShipmentGroupingDecision)
    ? decision as ShipmentGroupingDecision
    : null;
}

function groupingTicketSide(value: unknown): ShipmentGroupingReviewTicketSide {
  const raw = record(value);
  return {
    ticketKey: text(raw.ticketKey),
    ticketNo: text(raw.ticketNo),
    market: textOrNull(raw.market),
    waybillsText: textOrNull(raw.waybillsText),
    purchaseOrder: textOrNull(raw.purchaseOrder),
    sourceRowStart: intOrNull(raw.sourceRowStart),
    sourceRowEnd: intOrNull(raw.sourceRowEnd),
    items: array(raw.items).map((item) => {
      const row = record(item);
      return {
        productNameRaw: text(row.productNameRaw),
        productNameNorm: text(row.productNameNorm),
        shippedQuantity: intOr(row.shippedQuantity, 0),
        // 第十四轮：拆开之前的原明细绑定，保存决定后只沿用这些能明确对应的商品。
        productId: textOrNull(row.productId),
      };
    }).filter((item) => item.productNameRaw !== ''),
  };
}

function groupingEvidence(value: unknown): ShipmentGroupingReviewEvidenceDto {
  const raw = record(value);
  const previous = record(raw.previous);
  const current = record(raw.current);
  return {
    kind: groupingKind(raw.kind),
    previous: {
      snapshotId: textOrNull(previous.snapshotId),
      tickets: array(previous.tickets).map(groupingTicketSide).filter((ticket) => ticket.ticketKey !== ''),
    },
    current: {
      snapshotId: textOrNull(current.snapshotId),
      tickets: array(current.tickets).map(groupingTicketSide).filter((ticket) => ticket.ticketKey !== ''),
    },
    affectedProducts: array(raw.affectedProducts).map(text).filter(Boolean),
  };
}

function groupingReview(value: unknown): ShipmentGroupingReviewDto {
  const raw = record(value);
  return {
    id: text(raw.id),
    kind: groupingKind(raw.kind),
    status: text(raw.status) === 'resolved' ? 'resolved' : 'pending',
    decision: groupingDecision(raw.decision),
    signature: text(raw.signature),
    evidence: groupingEvidence(raw.evidence),
    createdAt: textOrNull(raw.createdAt),
    resolvedAt: textOrNull(raw.resolvedAt),
    resolutionNote: textOrNull(raw.resolutionNote),
  };
}

function groupingOverrideSpec(value: unknown): ShipmentGroupingOverrideSpec | null {
  const raw = record(value);
  const kind = text(raw.kind);
  if (kind === 'merge') {
    return {
      kind: 'merge',
      targetKey: text(raw.targetKey),
      absorbedKeys: array(raw.absorbedKeys).map(text).filter(Boolean),
    };
  }
  if (kind === 'split') {
    return {
      kind: 'split',
      sourceKey: text(raw.sourceKey),
      groups: array(raw.groups).map((group) => {
        const row = record(group);
        return {
          ticketKey: text(row.ticketKey),
          ticketNo: text(row.ticketNo),
          market: textOrNull(row.market),
          customsMethod: textOrNull(row.customsMethod),
          waybillsText: textOrNull(row.waybillsText),
          purchaseOrder: textOrNull(row.purchaseOrder),
          products: array(row.products).map((product) => {
            const entry = record(product);
            return {
              productNameNorm: text(entry.productNameNorm),
              shippedQuantity: intOr(entry.shippedQuantity, 0),
            };
          }).filter((product) => product.productNameNorm !== ''),
        };
      }).filter((group) => group.ticketKey !== ''),
    };
  }
  return null;
}

export function normalizeGroupingContext(value: unknown): ShipmentGroupingContextDto {
  const raw = record(value);
  const tickets: ShipmentGroupingStateTicket[] = array(raw.tickets).map((entry) => {
    const row = record(entry);
    return {
      shipmentId: text(row.shipmentId),
      ticketKey: text(row.ticketKey),
      ticketNo: text(row.ticketNo),
      market: textOrNull(row.market),
      waybillsText: textOrNull(row.waybillsText),
      purchaseOrder: textOrNull(row.purchaseOrder),
      sourceRowStart: intOrNull(row.sourceRowStart),
      sourceRowEnd: intOrNull(row.sourceRowEnd),
      items: array(row.items).map((item) => {
        const detail = record(item);
        return {
          itemId: text(detail.itemId),
          productId: textOrNull(detail.productId),
          productNameRaw: text(detail.productNameRaw),
          productNameNorm: text(detail.productNameNorm),
          shippedQuantity: intOr(detail.shippedQuantity, 0),
        };
      }).filter((item) => item.productNameNorm !== ''),
    };
  }).filter((ticket) => ticket.ticketKey !== '');
  const overrides: ShipmentGroupingOverrideDto[] = array(raw.overrides).flatMap((entry) => {
    const row = record(entry);
    const spec = groupingOverrideSpec(row.spec);
    if (spec === null) return [];
    return [{
      id: text(row.id),
      reviewId: text(row.reviewId),
      kind: groupingKind(row.kind),
      signature: text(row.signature),
      spec,
      active: row.active !== false,
      createdAt: textOrNull(row.createdAt),
    }];
  });
  return {
    snapshotId: textOrNull(raw.snapshotId),
    tickets,
    overrides,
    reviewSignatures: array(raw.reviewSignatures).map(text).filter(Boolean),
  };
}

export function normalizeGroupingReviews(value: unknown): ShipmentGroupingReviewsDto {
  const raw = record(value);
  return {
    pending: array(raw.pending).map(groupingReview).filter((review) => review.id !== ''),
    activeOverrides: array(raw.activeOverrides).map((entry) => {
      const row = record(entry);
      return {
        id: text(row.id),
        reviewId: text(row.reviewId),
        kind: groupingKind(row.kind),
        reviewKind: groupingKind(row.reviewKind),
        decision: groupingDecision(row.decision),
        signature: text(row.signature),
        createdAt: textOrNull(row.createdAt),
        // 第十四轮：页面「已有人工决定」显示市场/票号/运单号；缺失保持 null（不写假单号）。
        market: textOrNull(row.market),
        ticketNo: textOrNull(row.ticketNo),
        waybillsText: textOrNull(row.waybillsText),
      };
    }).filter((override) => override.id !== ''),
  };
}

/** 单条复核（含 evidence，任意状态）：人工决定/恢复时用于限定「本次复核涉及的票」。 */
export function normalizeGroupingReviewDetail(value: unknown): ShipmentGroupingReviewDto | null {
  if (!value || typeof value !== 'object') return null;
  const review = groupingReview(value);
  return review.id === '' ? null : review;
}

export function normalizeGroupingResolve(value: unknown): ShipmentGroupingResolveResultDto {
  const raw = record(value);
  return {
    ok: boolean(raw.ok),
    reviewId: text(raw.reviewId),
    decision: groupingDecision(raw.decision),
    snapshotId: textOrNull(raw.snapshotId),
    errorCode: textOrNull(raw.errorCode),
    errorMessage: textOrNull(raw.errorMessage),
  };
}

export interface ShipmentSnapshotRawDto {
  snapshotId: string | null;
  values: Array<Array<string | number | null>>;
  merges: ShipmentSourceMergedRange[];
  collection: Raw;
}

/** 最新成功快照的原始网格（人工决定后重新解释用）；没有快照/raw 返回 null。 */
export function normalizeSnapshotRaw(value: unknown): ShipmentSnapshotRawDto | null {
  if (value === null || value === undefined) return null;
  const raw = record(value);
  const values = array(raw.values).map((row) => array(row).map((cell) => {
    if (cell === null || cell === undefined) return null;
    if (typeof cell === 'number') return Number.isFinite(cell) ? cell : null;
    if (typeof cell === 'string') return cell;
    return String(cell);
  }));
  if (values.length === 0) return null;
  return {
    snapshotId: textOrNull(raw.snapshotId),
    values,
    merges: array(raw.merges).flatMap((entry) => {
      const merge = record(entry);
      const startRow = intOrNull(merge.startRow);
      const endRow = intOrNull(merge.endRow);
      const startColumn = intOrNull(merge.startColumn);
      const endColumn = intOrNull(merge.endColumn);
      if (startRow === null || endRow === null || startColumn === null || endColumn === null) return [];
      return [{ startRow, endRow, startColumn, endColumn }];
    }),
    collection: record(raw.collection),
  };
}

