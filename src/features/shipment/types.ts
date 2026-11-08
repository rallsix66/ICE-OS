/**
 * 货票与在途 v1：来源读取、解析结果与页面 DTO 的类型合同。
 *
 * - 外部数据（飞书表格）只在服务端入口解析校验一次，转成本文件的明确类型后内部直接使用；
 * - 解析结果（ParsedShipmentSnapshot）由服务端补上「身份匹配结论」后成为 IngestShipmentSnapshot，
 *   是服务端 → 数据库函数的唯一入参，不传未校验的原始行；
 * - 页面 DTO 不包含数据库行、凭据或原始 20 列网格（原始网格只作为证据存库）。
 *
 * 口径（用户 2026-11-01 第二次确认，见 docs/tasks/shipment-in-transit-v1.md §1.4）：
 * - G 列「物流情况」= 运输进度，独立展示，**不参与**到货/上架判断；
 * - H 列「预计到货时间」= 到货/分批/上架说明，到货判断只看这一列；
 * - 内部身份是数据库 UUID，不随采购单号/运单号变化；编号变化按 §1.3 匹配规则延续原记录。
 */

export const SHIPMENT_SOURCE_KEY = 'feishu_logistics_sheet';

/**
 * 票级业务状态分类（5 类）：到货/分批/上架三类必须分开。
 * - in_transit：只有运输进度，没有任何已到货信息
 * - partial：H 列写明分批/部分/某个商品或某张运单已到（不等于整票已到）
 * - arrived_pending_shelving：H 列写明整票已到但未上架（待上架尚未结束本包在途）
 * - arrived：H 列写明整票已到货并已上架（结束在途）
 * - unknown：两列都没有可判断状态的内容
 */
export type ShipmentStatusClass =
  | 'in_transit'
  | 'partial'
  | 'arrived_pending_shelving'
  | 'arrived'
  | 'unknown';

/**
 * 到货依据：说明「累计到货」这个数字从哪里来，避免把整票状态伪装成逐条到货数量。
 * - status_in_transit_zero：只有运输进度，累计到货按 0 计（在途未到）
 * - status_awaiting_shelving_zero：整票已到但尚未上架，按「未结束在途」计，累计到货按 0
 * - status_arrived_full：整票「已到货上架」（用户口径），累计到货 = 发货量
 * - source_quantity：来源直接给出逐条累计到货数量（本版来源没有，保留给后续列）
 * - pending：数量未知（部分到货/状态未提供），显示「未提供」并标待核
 * - manual_correction：该明细的累计到货/剩余由管理员「修正在途」人工指定（不是原表判断；
 *   原表判断值另存 source_received_quantity/source_receipt_basis 供「恢复按原表判断」）
 */
export type ShipmentReceiptBasis =
  | 'status_in_transit_zero'
  | 'status_awaiting_shelving_zero'
  | 'status_arrived_full'
  | 'source_quantity'
  | 'pending'
  | 'manual_correction';

/**
 * 人工「修正在途」的状态（第八轮）：
 * - in_transit：运输中，累计到货 0，剩余=发货量
 * - arrived_pending_shelving：已到货待上架，仍计在途，累计到货 0，剩余=发货量
 * - fully_shelved：全部已上架，累计到货=发货量，剩余 0
 * - partial_shelved：分批上架，人工填「累计已上架」（累计数、替换不累加），剩余=发货量−累计
 * - unknown：人工恢复/指定为状态未知，累计到货与剩余都未知（不写 0）
 */
export type ShipmentManualStatus =
  | 'in_transit'
  | 'arrived_pending_shelving'
  | 'fully_shelved'
  | 'partial_shelved'
  | 'unknown';

export type ShipmentAssociationStatus = 'auto' | 'manual' | 'none';

export type ShipmentRemainingState = 'known' | 'pending';

/**
 * 票身份状态：
 * - confirmed：本次读取的编号/内容能唯一对上原记录（或确实是新票）
 * - pending：来源编号变化但无法唯一确认与原票的关系；明确标「身份待核」，不猜着合并
 */
export type ShipmentIdentityStatus = 'confirmed' | 'pending';

/* ------------------------------------------------------------------ *
 * 来源读取 + 解析（服务端内部）
 * ------------------------------------------------------------------ */

export interface ShipmentSourceMergedRange {
  startRow: number;
  endRow: number;
  startColumn: number;
  endColumn: number;
}

export interface ShipmentSourceHeader {
  /** Excel 列字母，如 A。 */
  column: string;
  /** 原表表头原文。 */
  header: string;
  /** 映射到的字段键；未识别为 null。 */
  field: string | null;
}

export interface ShipmentSourceCollection {
  sourceKey: string;
  /** 用户提供的 wiki 链接（不含凭据）。 */
  url: string;
  docTitle: string | null;
  /** 解析后的 spreadsheet token。 */
  docToken: string;
  /** 来源文档最后编辑时间（ISO）；来源未给则为 null。 */
  documentEditedAt: string | null;
  sheetId: string;
  sheetTitle: string;
  /** 工作表 revision（飞书返回的版本号）。 */
  revision: number;
  readStartedAt: string;
  readFinishedAt: string;
  readBy: string | null;
  /** 网格总行数（表信息 row_count）。 */
  gridRows: number;
  /** 实际读到的行数（含表头）。 */
  readRows: number;
  /** 最后一行非空数据所在行号（1 基）；没有数据时为表头行。 */
  lastNonEmptyRow: number;
  headers: ShipmentSourceHeader[];
  merges: ShipmentSourceMergedRange[];
  /** 读取到的原始值网格的内容哈希（不含读取时间，便于判断“内容是否变化”）。 */
  rawContentHash: string;
  /**
   * 未加「分组解释」盐的内容哈希（第十二轮）：人工分组覆盖新增/撤销后，
   * 用这个基础哈希 + 当前覆盖重新算 rawContentHash，保证同一份来源内容会被重新解释一次。
   */
  baseContentHash?: string;
}

export interface ParsedShipmentItem {
  /** 明细稳定键：<规范化品名>#<同票内出现序号>。 */
  itemKey: string;
  productNameRaw: string;
  productNameNorm: string;
  /** 发货数量（来源「数量」列；正整数）。 */
  shippedQuantity: number;
  /**
   * 来源直接给出的逐条累计到货数量；本版来源没有这一列时为 null。
   * 非 null 时按来源数量口径计算剩余在途，不累加。
   */
  sourceReceivedQuantity: number | null;
  /**
   * 来源 H 列「按商品点名」的到货/上架结论（第八轮，仅当 H 行形如「某商品：已到货上架」且
   * 唯一命中该明细时填写）：status_arrived_full=该商品已到货上架（到货=发货量），
   * status_awaiting_shelving_zero=该商品已到但待上架（到货=0，未结束在途）。
   * 为 null 时沿用票级到货依据。**不解析自由文本数字**。
   */
  sourceReceiptBasis: ShipmentReceiptBasis | null;
  /** 来源行号（1 基）。 */
  sourceRow: number;
  /** 该明细行自己的备注（非首行另写的票级内容等）。 */
  sourceNote: string | null;
}

export interface ParsedShipmentTicket {
  /** 票稳定键（本次来源的编号派生键）：PO:<采购单号> | WB:<首张运单号> | FB:<国家>|<报关方式>|<品名集合>。 */
  ticketKey: string;
  /** 展示用票号（采购单号 || 第一张运单号 || 无单号·市场·行N）。 */
  ticketNo: string;
  sourceRowStart: number;
  sourceRowEnd: number;
  market: string | null;
  customsMethod: string | null;
  waybillsText: string | null;
  purchaseOrder: string | null;
  /** G 列「物流情况」原文：只表示运输进度。 */
  transportText: string | null;
  /** H 列「预计到货时间」原文：到货/分批/上架说明。 */
  arrivalText: string | null;
  vessel: string | null;
  dispatchedText: string | null;
  statusClass: ShipmentStatusClass;
  receivedBasis: ShipmentReceiptBasis;
  items: ParsedShipmentItem[];
}

export interface ParsedShipmentSnapshot {
  sourceKey: string;
  collection: ShipmentSourceCollection;
  tickets: ParsedShipmentTicket[];
  /** 原始证据：读到的二维网格与合并区（只存库，不发布到页面）。 */
  raw: {
    values: Array<Array<string | number | null>>;
    merges: ShipmentSourceMergedRange[];
  };
}

/**
 * 身份匹配结论（服务端在写入前计算，见 docs/tasks/shipment-in-transit-v1.md §1.3）。
 * - matchedShipmentId：可唯一确认时沿用原票 UUID；无法确认/确实新票时为 null；
 * - identityStatus='pending'：来源编号变化但无法唯一确认，页面标「身份待核」，不合并。
 */
export interface IngestShipmentTicket extends ParsedShipmentTicket {
  matchedShipmentId: string | null;
  identityStatus: ShipmentIdentityStatus;
  identityNote: string | null;
}

export interface IngestShipmentSnapshot {
  sourceKey: string;
  collection: ShipmentSourceCollection;
  tickets: IngestShipmentTicket[];
  raw: ParsedShipmentSnapshot['raw'];
}

/** 身份匹配用的现有票索引行（只读 RPC 返回，服务端匹配用）。 */
export interface ShipmentIdentityIndexRow {
  shipmentId: string;
  ticketKey: string;
  purchaseOrder: string | null;
  waybillsText: string | null;
  market: string | null;
  customsMethod: string | null;
  /** 该票当前明细的规范化品名（去重、排序）。 */
  productNameNorms: string[];
  /**
   * 该票当前身份状态：pending = 已有「身份待核」记录。
   * 匹配到 pending 记录自身只能说明继续更新这一行，**不能**说明它与原候选票的关系已核清；
   * 服务端必须原样保留 pending 与原说明，不能借普通刷新自动改成 confirmed。
   */
  identityStatus: ShipmentIdentityStatus;
  identityNote: string | null;
}

/** 解析入口的明确失败原因（页面对应中文文案，不把堆栈带给用户）。 */
export type ShipmentSourceErrorCode =
  | 'SOURCE_CLI_MISSING'
  | 'SOURCE_CLI_FAILED'
  | 'SOURCE_CLI_TIMEOUT'
  | 'SOURCE_CLI_BAD_JSON'
  | 'SOURCE_DOC_UNRESOLVED'
  | 'SOURCE_SHEET_MISSING'
  | 'SOURCE_HEADER_MISMATCH'
  | 'SOURCE_GRID_INVALID'
  | 'SOURCE_EMPTY'
  | 'SOURCE_REVISION_MISSING';

export class ShipmentSourceError extends Error {
  readonly code: ShipmentSourceErrorCode;
  readonly detail: string | null;

  constructor(code: ShipmentSourceErrorCode, detail: string | null = null) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'ShipmentSourceError';
    this.code = code;
    this.detail = detail;
  }
}

/* ------------------------------------------------------------------ *
 * 页面 DTO
 * ------------------------------------------------------------------ */

export interface ShipmentSnapshotBriefDto {
  snapshotId: string;
  readAt: string;
  documentEditedAt: string | null;
  revision: number | null;
  ticketCount: number;
  itemCount: number;
}

export interface ShipmentReadAttemptDto {
  snapshotId: string;
  readAt: string;
  status: 'success' | 'failed';
  errorCode: string | null;
  errorMessage: string | null;
}

/**
 * 定时自动读取状态（第六轮）：页面状态条显示后台是否运行、读取间隔、最近一次结果与
 * 下次计划时间；失败原因用实际 errorCode/errorMessage，不写“未知错误”。
 *
 * - workerOnline：后台进程心跳在 90 秒内（数据库心跳，不是浏览器是否打开）；
 * - running：手动刷新或定时读取正在占用来源读取租约（同一来源不并发读两轮）；
 * - lastResult/lastError*：最近一次自动读取的结果，失败不清除上次成功数据。
 */
export interface ShipmentAutoReaderStatusDto {
  enabled: boolean;
  intervalMinutes: number;
  nextRunAt: string | null;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastResult: 'success' | 'unchanged' | 'failed' | null;
  lastReadAt: string | null;
  lastTicketCount: number | null;
  lastItemCount: number | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  heartbeatAt: string | null;
  runnerPid: number | null;
  workerOnline: boolean;
  running: boolean;
  leaseOwner: string | null;
}

export interface ShipmentSourceStatusDto {
  sourceKey: string;
  docTitle: string | null;
  sheetTitle: string | null;
  lastSuccess: ShipmentSnapshotBriefDto | null;
  lastAttempt: ShipmentReadAttemptDto | null;
  /** 自动读取状态；027 未安装/读取失败时为 null（页面显示“状态读取失败”）。 */
  autoReader: ShipmentAutoReaderStatusDto | null;
}

export interface ShipmentListRowDto {
  shipmentId: string;
  /** 目的市场（来源「国家」）。 */
  market: string | null;
  /** 采购单号；来源未填时为 null（页面显示「未提供」，不用运单号顶替）。 */
  purchaseOrder: string | null;
  /** 运单号原文（可能多张）。 */
  waybillsText: string | null;
  /** 展示用票号：采购单号 || 第一张运单号 || 无单号·市场·行N（列表不再用它当「货票号」列）。 */
  ticketNo: string;
  itemCount: number;
  /** 商品摘要：只要商品名称，不带数量；最多 3 条。 */
  productSummary: string[];
  statusClass: ShipmentStatusClass;
  /** 含人工修正后的有效货票状态（无人工修正时=statusClass）。 */
  effectiveStatusClass: ShipmentStatusClass;
  /** 当前明细中人工修正过的条数 / 需要复核的条数。 */
  manualCorrectionCount: number;
  manualReviewCount: number;
  /** G 列运输进度原文（独立展示，不参与到货判断）。 */
  transportText: string | null;
  /** H 列到货/上架说明原文。 */
  arrivalText: string | null;
  /** 是否有明细数量未知（部分到货/状态未提供）。 */
  quantityPending: boolean;
  /** 身份结论：confirmed / pending（编号变化无法唯一确认时标待核）。 */
  identityStatus: ShipmentIdentityStatus;
  /** 身份待核说明（为什么无法确认，页面原样展示）。 */
  identityNote: string | null;
  /** 本次（最近一次成功读取）来源是否仍包含该票；false = 本次来源未见（历史行）。 */
  presentInLatestRead: boolean;
  /** 该票最后一次出现在来源里的时间（本次未见时保留原时间）。 */
  lastSeenAt: string;
}

export interface ShipmentListCountsDto {
  total: number;
  inTransit: number;
  partial: number;
  arrivedPendingShelving: number;
  arrived: number;
  unknown: number;
}

export interface ShipmentMarketCountDto {
  market: string | null;
  count: number;
}

export interface ShipmentListDto {
  total: number;
  offset: number;
  limit: number;
  rows: ShipmentListRowDto[];
  counts: ShipmentListCountsDto;
  markets: ShipmentMarketCountDto[];
  /** 是否把「本次来源未见」的历史票也包含在列表与计数里。 */
  includeAbsent: boolean;
  /** 当前来源里本次未见（已退出当前列表）的票数 / 明细分；与筛选无关。 */
  absentTickets: number;
  absentItems: number;
  /** 最近一次成功读取时间（历史行「本次来源未见」以此为参照）。 */
  latestReadAt: string | null;
  sourceStatus: ShipmentSourceStatusDto;
}

/**
 * 明细绑定的商品卡片（第四轮）：身份 + 规格/单位 + 单位成本。
 *
 * 口径（用户 2026-11-02 批准）：
 * - 全部字段按绑定的商品 ID 从商品库现有读取链取得；**不新建价格通道**、不猜数据；
 * - 规格：商品库「规格」字段优先，字段缺失时才从标准名称提取（见 catalog/specification.ts）；
 *   没有可用规格时 specificationText 为 ''，页面显示「规格待补」，不编造；
 * - 单位：商品库「单位」字段的有效值；没有时为 null，页面显示「单位 待确认」（不当作有单位）；
 * - 单位成本：与商品库列表同一函数、同一文本（如 `¥2.11`）；缺价时 label 固定「成本待补充」，
 *   amountCny 为 null，绝不写 0。
 */
export interface ShipmentLinkedProductDto {
  itemId: string;
  iceCode: string | null;
  nameCn: string | null;
  /** 展示用规格文本；没有可用规格时为 ''。 */
  specificationText: string;
  /** field = 商品库规格字段；name = 从标准名称提取；none = 两者都没有。 */
  specificationSource: 'field' | 'name' | 'none';
  /** 商品库计数单位（支/瓶/盒…）的有效值；没有时为 null。 */
  unitText: string | null;
  /**
   * 商品库「装箱数量」（件/箱）的有效值（正整数）；未登记时为 null。
   * **只取商品库 cartonQuantity 字段，不从规格/名称/体积推算**；
   * 页面在「分批上架」按箱填写时用它做「箱数 × 装箱数 = 商品数量」换算。
   */
  cartonQuantity: number | null;
  /**
   * 单位成本（采用进货价，不含运费口径）：
   * - priced：amountCny 为原始数值字符串，label 与商品库列表同文本（如 `¥2.11`）；
   * - missing：amountCny 为 null，label 固定「成本待补充」，reason 为短因（缺价/读取失败）。
   */
  unitCost: {
    state: 'priced' | 'missing';
    amountCny: string | null;
    label: string;
    reason: string | null;
  };
}

export interface ShipmentDetailItemDto {
  itemId: string;
  itemKey: string;
  productNameRaw: string;
  productNameNorm: string;
  shippedQuantity: number;
  receivedQuantity: number | null;
  receiptBasis: ShipmentReceiptBasis;
  remainingQuantity: number | null;
  remainingState: ShipmentRemainingState;
  /** 来源没有单位列；永远显示“来源未提供”，不得换算。 */
  unitText: string | null;
  /** 来源没有 SKU 列；永远显示“来源未提供”。 */
  sourceSku: string | null;
  sourceNote: string | null;
  product: ShipmentLinkedProductDto | null;
  associationStatus: ShipmentAssociationStatus;
  associationMethod: string | null;
  associatedAt: string | null;
  revision: number;
  /** 人工修正状态；null = 按原表判断。数量字段（receivedQuantity/remainingQuantity）为生效值。 */
  manualStatus: ShipmentManualStatus | null;
  /** 分批上架时人工填写的累计已上架数量；其它人工状态为 null。 */
  manualShelvedQuantity: number | null;
  /** 保存人工修正时的发货量（旧发货量）；原表发货量变化后用于显示“旧 → 新”与判断数量冲突。 */
  manualShippedQuantity: number | null;
  /** 人工确认时已上架的数量（全部已上架=旧发货量、分批=累计已上架、待上架/运输中=0、未知=null）。 */
  previousConfirmedShelvedQuantity: number | null;
  /** 原表发货量与人工确认的数量矛盾（待复核期间不计入市场货值）。 */
  manualConflict: boolean;
  manualActorName: string | null;
  manualAt: string | null;
  /** 人工修正版本（乐观并发；每次 apply/restore +1）。0 = 从未人工修正。 */
  manualRevision: number;
  /** 原表出现新的相关到货信息，提示复核；人工结果仍生效。 */
  manualReviewNeeded: boolean;
  manualReviewNote: string | null;
  /** 原表判断的累计到货（无人工修正时与 receivedQuantity 相同；恢复用，不直接展示）。 */
  sourceReceivedQuantity: number | null;
  /** 原表判断依据（不含 manual_correction）。 */
  sourceReceiptBasis: ShipmentReceiptBasis;
}

/** 本次来源未见的历史明细（只读；保留原数量、关联与最后出现时间）。 */
export interface ShipmentMissingItemDto {
  itemId: string;
  itemKey: string;
  productNameRaw: string;
  shippedQuantity: number;
  receivedQuantity: number | null;
  receiptBasis: ShipmentReceiptBasis;
  remainingQuantity: number | null;
  remainingState: ShipmentRemainingState;
  sourceNote: string | null;
  product: ShipmentLinkedProductDto | null;
  associationStatus: ShipmentAssociationStatus;
  lastSeenAt: string;
}

export interface ShipmentRevisionDto {
  revision: number;
  recordedAt: string;
  changedFields: string[];
  snapshotId: string;
}

/** 一条人工「修正在途」的追加历史（不可变；apply/restore）。 */
export interface ShipmentManualRevisionDto {
  itemId: string;
  productNameRaw: string;
  revision: number;
  action: 'apply' | 'restore';
  manualStatus: ShipmentManualStatus | null;
  manualShelvedQuantity: number | null;
  previousManualStatus: ShipmentManualStatus | null;
  previousManualShelvedQuantity: number | null;
  /** 本次生效的累计到货/剩余在途（未知为 null，不写 0）。 */
  receivedQuantity: number | null;
  remainingQuantity: number | null;
  actorName: string;
  note: string | null;
  recordedAt: string;
}

/** 单票在途货值（第十三轮）：逐条用当前有效剩余数量 × 商品库采用进货价（不含运费）。 */
export interface ShipmentTicketValueDto {
  /** 已能算出的货值；没有一条能算出时为 null（页面显示「暂无法计算」，不写 0）。 */
  totalValueCny: string | null;
  /** 已计入货值的明细条数（全部上架、剩余 0 的明细也算已计入，货值为 0）。 */
  pricedItemCount: number;
  /** 算不出货值的明细条数（数量待核 / 待复核 / 未关联 / 缺单价）。 */
  excludedItemCount: number;
  itemCount: number;
}

export interface ShipmentDetailDto {
  shipment: {
    shipmentId: string;
    ticketNo: string;
    ticketKey: string;
    market: string | null;
    customsMethod: string | null;
    waybillsText: string | null;
    purchaseOrder: string | null;
    statusClass: ShipmentStatusClass;
    /** 含人工修正后的有效货票状态（读时按当前明细的生效累计到货推导；无人工修正时=statusClass）。 */
    effectiveStatusClass: ShipmentStatusClass;
    /** 当前明细中人工修正过的条数 / 需要复核的条数。 */
    manualCorrectionCount: number;
    manualReviewCount: number;
    /** G 列运输进度原文。 */
    transportText: string | null;
    /** H 列到货/上架说明原文。 */
    arrivalText: string | null;
    vessel: string | null;
    dispatchedText: string | null;
    itemCount: number;
    quantityPending: boolean;
    identityStatus: ShipmentIdentityStatus;
    identityNote: string | null;
    presentInLatestRead: boolean;
    sourceRowStart: number;
    sourceRowEnd: number;
    firstSeenAt: string;
    lastSeenAt: string;
    revision: number;
  };
  items: ShipmentDetailItemDto[];
  /** 本次来源未见的历史明细：列表/搜索/相关货票不再命中，但历史事实与原时间保留。 */
  missingItems: ShipmentMissingItemDto[];
  revisions: ShipmentRevisionDto[];
  /** 该票逐明细的人工「修正在途」追加历史（倒序，最多 30 条）。 */
  manualRevisions: ShipmentManualRevisionDto[];
  latestReadAt: string | null;
  sourceStatus: ShipmentSourceStatusDto;
  /** 本票在途货值；读取层按同一份商品卡片与剩余数量计算（缺省表示未计算）。 */
  ticketValue?: ShipmentTicketValueDto;
}

/* ------------------------------------------------------------------ *
 * 在途汇总（第七轮）
 * ------------------------------------------------------------------ */

/**
 * 未计入货值的明细原因（每条明细只归一个原因，计数可相加）：
 * - unbound：明细没有绑定 ICE 商品，无法确定商品与单价；
 * - quantity_pending：分批到货/状态未提供，来源没有逐商品累计到货量，剩余在途未知；
 * - price_missing：剩余数量已知，但绑定商品没有可用的采用进货价。
 * - review_pending：原表改了发货量，与人工确认的已上架数量矛盾，等待重新确认（不计数量与金额）；
 *   它优先于上面三个原因，避免把矛盾数量当成普通待核/缺价。
 */
export type ShipmentSummaryExclusion =
  | 'unbound'
  | 'quantity_pending'
  | 'price_missing'
  | 'review_pending';

/** 组成市场汇总的一条当前明细（属最近一次成功读取的当前快照）。 */
export interface ShipmentSummaryItemDto {
  itemId: string;
  shipmentId: string;
  ticketNo: string;
  purchaseOrder: string | null;
  waybillsText: string | null;
  productNameRaw: string;
  /** 绑定商品卡片；未关联为 null。金额沿用商品库现有采用进货价口径。 */
  product: ShipmentLinkedProductDto | null;
  shippedQuantity: number;
  receivedQuantity: number | null;
  receiptBasis: ShipmentReceiptBasis;
  /** 保存人工修正时的发货量；没有人工修正为 null。 */
  manualShippedQuantity: number | null;
  /** 原表发货量与人工确认矛盾（待复核，尚未计入货值）。 */
  manualConflict: boolean;
  remainingQuantity: number | null;
  remainingState: ShipmentRemainingState;
  /** 剩余数量是否已计入商品合计（只有明确数量才计入）。 */
  quantityIncluded: boolean;
  /** 该条估算货值（精确十进制字符串）；null = 金额未计入，不是 0。 */
  valueCny: string | null;
  /** 未计入货值的原因；null = 已计入金额。 */
  exclusion: ShipmentSummaryExclusion | null;
  /** 原因短文案（数量待核 / 缺单价 / 未关联商品）。 */
  exclusionReason: string | null;
}

/** 同一商品在当前市场下的在途汇总（数量按同一商品、同一计数单位合计）。 */
export interface ShipmentSummaryProductDto {
  productId: string;
  iceCode: string | null;
  nameCn: string | null;
  specificationText: string;
  specificationSource: 'field' | 'name' | 'none';
  /** 商品库计数单位；未标注为 null（页面显示「单位待确认」，不混加不同商品）。 */
  unitText: string | null;
  unitCost: ShipmentLinkedProductDto['unitCost'];
  /** 已知剩余在途数量合计；只有数量明确的明细计入。 */
  remainingQuantity: number;
  /** 数量已计入的明细条数（含剩余为 0 的已上架明细）。 */
  quantityKnownItemCount: number;
  /** 数量待核、未计入数量与金额的明细条数。 */
  quantityPendingCount: number;
  /** 原表发货量与人工确认矛盾、等待重新确认的明细条数（不计数量与金额）。 */
  reviewPendingCount: number;
  /** 已计入金额的明细条数。 */
  pricedItemCount: number;
  /** 数量已计入但缺单价、金额未计入的明细条数。 */
  unpricedItemCount: number;
  itemCount: number;
  ticketCount: number;
  /** 估算货值（精确十进制字符串）；null = 没有已计价明细。 */
  valueCny: string | null;
  /** 组成该商品的全部当前明细（含数量待核/缺单价行，可点回原票）。 */
  items: ShipmentSummaryItemDto[];
}

export interface ShipmentSummaryExcludedCountsDto {
  unbound: number;
  /** 注意：这里是「以数量待核为主要原因」的条数；与 unbound 不重复计数。 */
  quantityPending: number;
  priceMissing: number;
  /** 原表发货量与人工确认矛盾、等待重新确认的条数。 */
  reviewPending: number;
}

/**
 * 在途市场汇总（第七轮）：
 * - 范围 = 所选市场的全部当前明细（最近一次成功读取），与分页/状态筛选无关；
 * - 已从来源移除的明细不进入；整票已上架（剩余 0）仍计入，未知值不写 0；
 * - 货值 = 剩余在途数量 × 商品库已采用的进货价（不含运费，沿用现有金额权限）；
 * - 已能算出的货值与「还有多少条没算进去」一起返回。
 */
export interface ShipmentMarketSummaryDto {
  /** 来源市场原值；null = 来源未提供国家。 */
  market: string | null;
  unknownMarket: boolean;
  latestReadAt: string | null;
  snapshotId: string | null;
  /** 当前市场的票数 / 明细条数（不受列表筛选与分页影响）。 */
  ticketCount: number;
  itemCount: number;
  products: ShipmentSummaryProductDto[];
  /** 已能算出的货值合计；null = 没有任何已计价明细（页面显示「暂无可计算货值」）。 */
  totalValueCny: string | null;
  /** 已计入金额的明细条数。 */
  pricedItemCount: number;
  /** 数量已计入但缺单价的明细条数（金额未计入）。 */
  unpricedItemCount: number;
  /** 数量待核的明细条数。 */
  quantityPendingCount: number;
  /** 原表发货量与人工确认矛盾、等待重新确认的明细条数。 */
  reviewPendingCount: number;
  /** 未绑定商品的明细条数。 */
  unboundItemCount: number;
  /** 未计入货值的明细条数合计（= 四个原因之和）。 */
  excludedItemCount: number;
  excludedByReason: ShipmentSummaryExcludedCountsDto;
  /** 未计入货值的明细清单（可点回原票查看）。 */
  excludedItems: ShipmentSummaryItemDto[];
}

export interface ProductShipmentLinkRowDto {
  shipmentId: string;
  ticketNo: string;
  market: string | null;
  purchaseOrder: string | null;
  waybillsText: string | null;
  statusClass: ShipmentStatusClass;
  transportText: string | null;
  arrivalText: string | null;
  shippedQuantity: number;
  receivedQuantity: number | null;
  remainingQuantity: number | null;
  remainingState: ShipmentRemainingState;
  itemCount: number;
}

export interface ProductShipmentLinksDto {
  total: number;
  rows: ProductShipmentLinkRowDto[];
}

/* ------------------------------------------------------------------ *
 * 商品详情「关联货票」/ 概览「在途库存」（第十轮）
 * ------------------------------------------------------------------ */

/**
 * 该商品在某一票上的在途数量（只属于当前商品，不受同票其它商品影响）。
 * 一票只返回一行：同票多个运单按整票计一次；同票同商品多条明细逐条计算后合成（R11）：
 * 数量明确的明细照常计入，只有未知/冲突的明细排除；全部明细都待核才是「待核」。
 */
export interface ProductShipmentTransitTicketDto {
  shipmentId: string;
  ticketNo: string;
  /** 来源采购单号；无号票为 null（仍可用 shipmentId 打开原票）。 */
  purchaseOrder: string | null;
  /** 来源国家原值；null = 市场未提供。 */
  market: string | null;
  /** 运单号原文（可能一行多个）。 */
  waybillsText: string | null;
  /** 运单条数（只用于说明“多个运单只算一票”，不参与数量计算）。 */
  waybillCount: number;
  /** 原表票级状态。 */
  statusClass: ShipmentStatusClass;
  /** 含人工修正的有效票级状态（与物流在途页一致）。 */
  effectiveStatusClass: ShipmentStatusClass;
  /** G 列物流情况原文（只展示这一列；不影响到货/上架判断）。 */
  transportText: string | null;
  /** H 列到货/上架说明原文（用于到货/上架判断与票级状态，不在「物流情况」列展示）。 */
  arrivalText: string | null;
  /** 当前商品在该票的发货量（同票同商品多条明细相加）。 */
  shippedQuantity: number;
  /** 当前采用累计已上架：只加数量明确的明细；一条明确的都没有才为 null。 */
  receivedQuantity: number | null;
  /** 剩余在途：只加数量明确的明细的剩余；一条明确的都没有才为 null（不写 0）。 */
  remainingQuantity: number | null;
  /** 票级是否至少有一条明细数量明确（全待核时为 pending，页面显示「待核」）。 */
  remainingState: ShipmentRemainingState;
  /** 原表发货量与人工确认矛盾（待复核）的明细条数（只排除这些条，不拖累同票其它明细）。 */
  manualConflict: boolean;
  /** 该票当前商品明细有人工修正。 */
  manualCorrected: boolean;
  /** 该票当前商品明细条数。 */
  itemCount: number;
  /** 该票当前全部商品明细条数（同票多款只取本品）。 */
  ticketItemCount: number;
  /** 该票当前商品明细中数量待核（未知/超收/冲突）的条数。 */
  pendingItemCount: number;
  /** 该票当前商品明细中待复核（发货量冲突）的条数。 */
  conflictItemCount: number;
}

/** 按市场分组的在途小计（页签「各市场小计和组成采购单」）。 */
export interface ProductShipmentTransitMarketDto {
  market: string | null;
  ticketCount: number;
  /** 该市场已知剩余在途小计（只含数量明确的票）。 */
  knownRemaining: number;
  /** 该市场数量待核/待复核的明细条数。 */
  pendingItemCount: number;
  /** 该市场待复核（发货量冲突）的明细条数。 */
  conflictItemCount: number;
  /** 组成该市场的采购单号（去重、按票顺序；无号票不计）。 */
  purchaseOrders: string[];
}

/**
 * 商品详情在途总览：只统计最近一次成功读取里仍在来源中的当前明细，
 * 数量直接沿用物流在途页最终采用值（人工修正已写入 received_quantity；冲突明细排除）。
 */
export interface ProductShipmentTransitDto {
  productId: string;
  /** 最近一次成功读取时间 / 快照 ID（两个页面核对同一次读取用）。 */
  latestReadAt: string | null;
  snapshotId: string | null;
  ticketCount: number;
  /** 已知剩余在途合计（只含数量明确且无冲突的票）。 */
  knownRemaining: number;
  /** 数量待核/待复核的当前商品明细条数。 */
  pendingItemCount: number;
  /** 待复核（发货量冲突）的当前商品明细条数。 */
  conflictItemCount: number;
  /** 所有在途票的数量都未知/冲突（卡片显示「待核」而不是 0）。 */
  allPending: boolean;
  tickets: ProductShipmentTransitTicketDto[];
  markets: ProductShipmentTransitMarketDto[];
}

export interface ProductSearchRowDto {
  itemId: string;
  iceCode: string | null;
  nameCn: string;
  /** 商品库独立规格列原文（可空）；候选显示时与名称提取合并为同一解析结果。 */
  specification: string | null;
  identifiers: string[];
}

/* ------------------------------------------------------------------ *
 * 动作结果
 * ------------------------------------------------------------------ */

export interface ShipmentRefreshResultDto {
  ok: boolean;
  readAt: string;
  /** 本次读取落库的快照 id（失败/未落库时为 null）；用于自动读取状态回写。 */
  snapshotId?: string | null;
  /** 本次读取的票/明细数（失败时为 0，但不影响已保存数据）。 */
  ticketCount: number;
  itemCount: number;
  createdTickets: number;
  updatedTickets: number;
  unchangedTickets: number;
  createdItems: number;
  updatedItems: number;
  revisionsAdded: number;
  associationsPreserved: number;
  /** 本次读取后已退出当前列表（来源未见）的票数/明细数；不等于到货，不改原数量。 */
  absentTickets: number;
  absentItems: number;
  /** 本次入库后采用「已确认对应」的明细条数（同一事务内完成，0 表示没有可采用的）。 */
  adoptedAssociations?: number;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface ShipmentAssociationResultDto {
  ok: boolean;
  itemId: string;
  productId: string | null;
  associationStatus: ShipmentAssociationStatus;
  revision: number;
  errorCode: string | null;
  errorMessage: string | null;
  /** 勾选「后续沿用」时是否保存了通用对应（清除关联/未勾选/市场未知时为 false）。 */
  mappingSaved?: boolean;
  /** 保存对应后本次自动采用到其他未关联明细的条数。 */
  adoptedCount?: number;
  /** 未保存通用对应的原因（例如市场未提供）。 */
  mappingNote?: string | null;
}

/* ------------------------------------------------------------------ *
 * 人工「修正在途」动作（第八轮）
 * ------------------------------------------------------------------ */

export interface ShipmentManualApplyInputDto {
  itemId: string;
  /** true = 恢复按原表判断（此时 status/cumulativeShelved 忽略）。 */
  restore?: boolean;
  status?: ShipmentManualStatus;
  /** 分批上架时的累计已上架（商品数量，非负整数）；其它状态为 null。 */
  cumulativeShelved?: number | null;
  /** 当前明细的人工修正版本（乐观并发）；首次修正传 0。 */
  expectedManualRevision: number;
}

export interface ShipmentManualResultDto {
  ok: boolean;
  itemId: string;
  /** null = 已恢复按原表判断 / 未人工修正。 */
  manualStatus: ShipmentManualStatus | null;
  manualShelvedQuantity: number | null;
  /** 本次生效的累计到货/剩余在途（未知为 null，不写 0）。 */
  receivedQuantity: number | null;
  remainingQuantity: number | null;
  receiptBasis: ShipmentReceiptBasis;
  manualRevision: number;
  manualActorName: string | null;
  manualAt: string | null;
  reviewNeeded: boolean;
  errorCode: string | null;
  errorMessage: string | null;
}

/* ------------------------------------------------------------------ *
 * 第十二轮：拆票 / 合票复核（来源分组变化的人工判断）
 * ------------------------------------------------------------------ */

export type ShipmentGroupingReviewKind = 'split' | 'merge';

/**
 * 复核结论：
 * - split_confirmed：确实拆开（接受本次两票）
 * - keep_one：仍是一票（把本次两票按一票处理）
 * - merge_confirmed：确实合成一票（接受本次一票）
 * - keep_separate：仍然分开（把本次一票按原两票处理）
 * - restored：恢复按飞书判断（撤销此前的人工覆盖）
 */
export type ShipmentGroupingDecision =
  | 'split_confirmed'
  | 'keep_one'
  | 'merge_confirmed'
  | 'keep_separate'
  | 'restored';

/** 复核对照的一侧（上次怎么分 / 本次怎么分）中的一张票。 */
export interface ShipmentGroupingReviewTicketSide {
  ticketKey: string;
  ticketNo: string;
  market: string | null;
  waybillsText: string | null;
  purchaseOrder: string | null;
  sourceRowStart: number | null;
  sourceRowEnd: number | null;
  items: Array<{
    productNameRaw: string;
    productNameNorm: string;
    shippedQuantity: number;
    /**
     * 检测时该明细已绑定的商品；人工确认后据此只给「能明确对应」的新明细沿用绑定。
     * 原始分组（上面 parsed）没有绑定信息，所以为 null。
     */
    productId?: string | null;
  }>;
}

export interface ShipmentGroupingReviewEvidenceDto {
  kind: ShipmentGroupingReviewKind;
  previous: { snapshotId: string | null; tickets: ShipmentGroupingReviewTicketSide[] };
  current: { snapshotId: string | null; tickets: ShipmentGroupingReviewTicketSide[] };
  /** 触发复核的商品（规范化品名原文），用于对照列出。 */
  affectedProducts: string[];
}

export interface ShipmentGroupingReviewDto {
  id: string;
  kind: ShipmentGroupingReviewKind;
  status: 'pending' | 'resolved';
  decision: ShipmentGroupingDecision | null;
  signature: string;
  evidence: ShipmentGroupingReviewEvidenceDto;
  createdAt: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
}

/** 人工决定如何覆盖飞书分组（复核拒绝当前分组时写入，后续每次读取都按它解释）。 */
export type ShipmentGroupingOverrideSpec =
  | {
    kind: 'merge';
    /** 保留的票键（同一次读取里的 ticketKey）。 */
    targetKey: string;
    /** 并入 targetKey 的其它票键。 */
    absorbedKeys: string[];
  }
  | {
    kind: 'split';
    /** 被拆开的来源票键。 */
    sourceKey: string;
    groups: Array<{
      ticketKey: string;
      ticketNo: string;
      market: string | null;
      customsMethod: string | null;
      waybillsText: string | null;
      purchaseOrder: string | null;
      products: Array<{ productNameNorm: string; shippedQuantity: number }>;
    }>;
  };

export interface ShipmentGroupingOverrideDto {
  id: string;
  reviewId: string;
  kind: ShipmentGroupingReviewKind;
  signature: string;
  spec: ShipmentGroupingOverrideSpec;
  active: boolean;
  createdAt: string | null;
}

/** 读取时的分组上下文：上次成功读取的当前分组 + 生效中的人工覆盖 + 已有复核签名。 */
export interface ShipmentGroupingStateTicket {
  shipmentId: string;
  ticketKey: string;
  ticketNo: string;
  market: string | null;
  waybillsText: string | null;
  purchaseOrder: string | null;
  sourceRowStart: number | null;
  sourceRowEnd: number | null;
  items: Array<{
    itemId: string;
    /** 该原明细已绑定的商品；未关联为 null。只用于「明确对应」的绑定沿用。 */
    productId: string | null;
    productNameRaw: string;
    productNameNorm: string;
    shippedQuantity: number;
  }>;
}

export interface ShipmentGroupingContextDto {
  snapshotId: string | null;
  tickets: ShipmentGroupingStateTicket[];
  overrides: ShipmentGroupingOverrideDto[];
  /**
   * 历史复核签名（兼容字段）。
   * 第十三轮起检测只对照「上一次成功读取」，不再用历史签名压掉后续再次出现的同一拆法；
   * 同一来源 + 同一上次快照的重复登记由数据库唯一索引保证。
   */
  reviewSignatures: string[];
}

export interface ShipmentGroupingResolveResultDto {
  ok: boolean;
  reviewId: string;
  decision: ShipmentGroupingDecision | null;
  /** 本次决定后重新读取/入库得到的快照（没有入库时为 null）。 */
  snapshotId?: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

/** 页面「待复核」与生效中人工分组的读取结果。 */
export interface ShipmentGroupingActiveOverrideDto {
  id: string;
  reviewId: string;
  kind: ShipmentGroupingReviewKind;
  reviewKind: ShipmentGroupingReviewKind;
  decision: ShipmentGroupingDecision | null;
  signature: string;
  createdAt: string | null;
  /** 第十四轮：用于页面「已有人工决定」显示可识别信息（取自该复核 evidence 的当前/上次票）。 */
  market: string | null;
  /** 票号：采购单号 → 运单号（首张）→ 票键，保证可识别。 */
  ticketNo: string | null;
  waybillsText: string | null;
}

export interface ShipmentGroupingReviewsDto {
  pending: ShipmentGroupingReviewDto[];
  activeOverrides: ShipmentGroupingActiveOverrideDto[];
}

/** 货值汇总「全部市场」的一行（按市场分开合计，不把不同商品数量混加）。 */
export interface ShipmentValueMarketRowDto {
  market: string | null;
  unknownMarket: boolean;
  ticketCount: number;
  itemCount: number;
  /** 已能算出的在途货值（只加数量明确且有采用进货价的明细）。 */
  totalValueCny: string | null;
  pricedItemCount: number;
  excludedItemCount: number;
  unboundItemCount: number;
  quantityPendingCount: number;
  reviewPendingCount: number;
  priceMissingItemCount: number;
}

/** 货值汇总「全部市场」视图。 */
export interface ShipmentValueOverviewDto {
  latestReadAt: string | null;
  snapshotId: string | null;
  marketCount: number;
  ticketCount: number;
  itemCount: number;
  totalValueCny: string | null;
  pricedItemCount: number;
  excludedItemCount: number;
  markets: ShipmentValueMarketRowDto[];
}
