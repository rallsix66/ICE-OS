/**
 * 商品库存与 BigSeller 自动同步 v1 —— 修复包 v2 的页面 DTO 类型。
 *
 * 唯一来源：`.local/inventory-sync-repair-20261026/contract.md` §1.3 / §1.4。
 * 约束：
 * - 这些是业务 DTO，不是数据库行；不导出任何数据库行、连接信息或金额字段。
 * - 列表（read_inventory_list）与详情（read_inventory_item）共用服务端 effective rows 读模型；
 *   页面只展示服务端给的合计/缺口，不自己另算数量口径。
 * - 服务端新增字段尚未全部定稿的部分，在 `normalize.ts` 做别名归一化；组件只用这里的规范字段。
 */

export interface InventoryAccountDto {
  /** 服务端绑定的来源账号 id（恢复记录归属校验用；不显示给用户）。 */
  accountId?: string | null;
  label: string;
  status: string;
  lastLoginOkAt: string | null;
  lastLoginCheckAt?: string | null;
  externalAccountCode?: string | null;
}

export interface InventoryWarehouseDto {
  id: string;
  externalId: string;
  name: string;
  /** confirmed / candidate / excluded */
  status: string;
  /** 有证据的市场代码（VN/TH/ID/PH/MY…）；NULL=待确认，不猜。 */
  market: string | null;
  marketEvidence?: unknown;
}

export interface InventoryScopeDto {
  id: string;
  version: number;
  /** 参与仓库 id（契约新增；旧字段缺失时为空）。 */
  warehouseIds: string[];
  labels: string[];
  warehouseCount: number;
  /** 明确空范围：持久停止发布，不回退旧范围。 */
  empty: boolean;
  lastAllSuccessAt: string | null;
}

export interface InventoryMarketOptionDto {
  market: string;
  warehouseNames: string[];
  warehouseCount: number;
}

export interface InventorySettingsDto {
  enabled: boolean;
  intervalMinutes: number;
  nextRunAt: string | null;
  configVersion: number;
  planAnchorAt: string | null;
  scopeId?: string | null;
  scopeWarehouseCount?: number;
  scopeEmpty?: boolean;
}

export interface InventoryWorkerDto {
  online: boolean;
  lastSeenAt: string | null;
  host: string | null;
  pid: number | null;
}

export interface InventoryWarehouseSummaryDto {
  published?: number;
  failed?: number;
  noRows?: number;
  blocked?: number;
}

export interface InventoryRunSummaryDto {
  id: string;
  status: string;
  triggerKind: string;
  plannedFor: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  warehouseSummary?: InventoryWarehouseSummaryDto | null;
  errorCode: string | null;
}

export interface InventoryWarehouseStateDto {
  warehouseId: string;
  name: string;
  /** 最近一次成功采集的观测时间（不是发布时刻）。 */
  lastSuccessAt: string | null;
  lastPublishAt: string | null;
  lastRunStatus: string | null;
  /** 现值来自历史成功批次（本次未成功）。 */
  stale: boolean;
  failed: boolean;
  lastErrorCode: string | null;
}

export interface InventoryDiscoveredWarehouseDto {
  externalId: string;
  name: string;
  status?: string | null;
}

/** 页面恢复入口：服务端未完成原请求。本人行带 payload/intent；他人行只有 foreign 忙碌信息。 */
export interface InventoryPendingActionDto {
  /** 他人 pending 不含 requestId（避免误用/接管）。 */
  requestId: string | null;
  action: string;
  createdAt: string | null;
  payload: Record<string, unknown>;
  /** 服务端持久 intent hash（本人行才有）。 */
  intent?: string | null;
  /** true = 同一账号下另一管理员的未完成请求：只能显示忙碌，不提供核对/重试。 */
  foreign?: boolean;
  /** 服务端记录的发起人/来源账号（本人行才有）：用于恢复状态绑定与旧记录归属核对。 */
  actorId?: string | null;
  accountId?: string | null;
  /** 是否为本人请求（服务端 mine 字段；foreign 行没有 requestId）。 */
  mine?: boolean;
  /** pending / completed / failed；页面恢复只处理 pending。 */
  status?: string | null;
}

export interface InventoryOverviewDto {
  account: InventoryAccountDto;
  warehouses: InventoryWarehouseDto[];
  scope: InventoryScopeDto;
  settings: InventorySettingsDto;
  worker: InventoryWorkerDto | null;
  lastRun: InventoryRunSummaryDto | null;
  runs: InventoryRunSummaryDto[];
  warehouseState: InventoryWarehouseStateDto[];
  scopeLastAllSuccessAt: string | null;
  unmappedCount: number;
  /** 未对应/待确认总数（含 candidate）；与 mappingQueueTotal 同源。 */
  mappingQueueTotal: number;
  /** 有证据的仓/市场关系；来自服务端，不按当前页商品生成。 */
  marketOptions: InventoryMarketOptionDto[];
  /** 最近未完成原请求（刷新后的恢复入口）；无则 null。 */
  pendingAction: InventoryPendingActionDto | null;
  /** 最近一次采集发现、进入待确认的新仓/改名仓。 */
  discoveredWarehouses: InventoryDiscoveredWarehouseDto[];
}

export interface InventoryRunHeaderColumnDto {
  index?: number;
  name: string;
}

export interface InventoryRunFileDto {
  sha256?: string | null;
  sha256Prefix?: string | null;
  rowCount?: number | null;
  blankRowCount?: number | null;
  downloadedAt?: string | null;
  sheetName?: string | null;
  header?: InventoryRunHeaderColumnDto[] | string[] | null;
}

export interface InventoryFileValidationDto {
  status: string;
  missingColumns?: string[];
  ambiguousColumns?: string[];
  duplicateColumns?: string[];
  /** 真实结构是 {on_hand:'现有库存', ...} 或已格式化的字符串。 */
  quantityHeader?: string | Record<string, string> | null;
  comboRowCount?: number;
  unattributableRowCount?: number;
  reason?: string | null;
}

export interface InventoryRunWarehouseDto {
  warehouseId: string;
  warehouseName?: string | null;
  name?: string | null;
  /** published | failed | no_rows | blocked | stale */
  status: string;
  rows?: number | null;
  adopted?: number | null;
  unmapped?: number | null;
  invalidRows?: number | null;
  duplicateSkuRows?: number | null;
  sourceRowCount?: number | null;
  observationAt?: string | null;
  batchId?: string | null;
  publishedAt?: string | null;
  errorCode?: string | null;
  reason?: string | null;
}

export interface InventoryRunIssueDto {
  excelRow: number;
  warehouseName?: string | null;
  externalSku?: string | null;
  parseStatus: string;
  reason?: string | null;
}

export interface InventoryRunLeaseDto {
  owner?: string | null;
  expiresAt?: string | null;
  heartbeatAt?: string | null;
}

export interface InventoryRunDetailDto {
  id: string;
  status: string;
  triggerKind: string;
  plannedFor: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  errorCode: string | null;
  errorDetail?: string | null;
  coveredSlots?: string[] | null;
  /** 本次观测时间 = export_finished_at（缺失时不伪造）。 */
  observationAt?: string | null;
  accountIdentity?: { status: string; label: string | null } | null;
  fileValidation?: InventoryFileValidationDto | null;
  warehouseDiscovery?: InventoryDiscoveredWarehouseDto[] | null;
  file?: InventoryRunFileDto | null;
  warehouses?: InventoryRunWarehouseDto[] | null;
  issues?: InventoryRunIssueDto[] | null;
  lease?: InventoryRunLeaseDto | null;
  summary?: Record<string, unknown> | null;
  requestId?: string | null;
}

/* ------------------------------------------------------------------ *
 * 商品对应复核（R2）
 * ------------------------------------------------------------------ */

export interface InventoryMappingWarehouseOptionDto {
  warehouseId: string;
  externalId: string;
  name: string;
  market: string | null;
  rowCount: number;
  lastSeenAt: string | null;
}

export interface InventoryMappingSuggestionDto {
  itemId: string;
  iceCode: string | null;
  nameCn: string | null;
  evidence: string | null;
  sourceSku?: string | null;
  sourceWarehouse?: string | null;
  /** 服务端证据来源（bs_sample_export / mapping_candidate）。 */
  source?: string | null;
}

export interface InventoryCurrentMappingDto {
  id: string;
  version: number;
  itemId: string;
  itemLabel?: string | null;
  unit: string;
  status: string;
}

/**
 * 待处理行 = 一个明确的 (来源 SKU × 仓库) 对（016 读模型就是按对返回）。
 * 页面行身份 = account + warehouseExternalId + externalSku；不默认全选、不扩展成全账号。
 */
export interface InventoryMappingQueueItemDto {
  externalSku: string;
  warehouseId: string;
  warehouseExternalId: string;
  warehouseName: string;
  market: string | null;
  rowCount: number;
  latestRunAt: string | null;
  suggestion: InventoryMappingSuggestionDto | null;
  candidateId: string | null;
  /** pending / confirmed / dismissed；非候选的 run 对为 null。 */
  candidateStatus?: string | null;
  /** 该 (仓,SKU) 最新对应状态：confirmed/disabled/recheck；无对应为 null。 */
  mappingStatus?: string | null;
  /** 已有对应时页面看到的版本；首次确认必须为 null。 */
  currentMapping: InventoryCurrentMappingDto | null;
  /** 验证数据标记（27 条脚本确认等）：业务包装单位待确认，不作为正式业务合计。 */
  verification?: boolean;
  unitUnconfirmed?: boolean;
  /** 对应原因（含“验证数据，业务包装单位待确认”等）。 */
  reason?: string | null;
}

export interface InventoryMappingQueueDto {
  items: InventoryMappingQueueItemDto[];
  total: number;
  offset: number;
  limit: number;
}

/** 手动选择目标商品时的搜索结果（来自 read_inventory_list，不新增 DB 函数）。 */
export interface InventoryTargetItemDto {
  itemId: string;
  iceCode: string | null;
  nameCn: string | null;
  gtin: string | null;
}

/* ------------------------------------------------------------------ *
 * 商品库存（R1）
 * ------------------------------------------------------------------ */

export interface InventoryListWarehouseRefDto {
  warehouseId: string;
  externalId?: string | null;
  name: string;
  /** 未对应缺口原因：有来源但未对应 / 没有该 SKU 的来源记录。 */
  reason?: 'unmapped_source' | 'no_source' | string | null;
  /** 该仓本次来源文件中出现的行数（unmapped_source 时>0）。 */
  sourceRowCount?: number | null;
  /** 该仓出现的来源 SKU（同仓部分 SKU 未对应时说明）。 */
  sourceSkus?: string[];
  /** 同仓已知编码的来源行（含 mapped 标记；mapped=false = 待确认归属）。 */
  pendingSourceRows?: InventoryPendingSourceRowDto[];
  /** unseen 时的上次已知数量（只展示，不计入本期合计）。 */
  lastKnownQty?: number | null;
  lastKnownAt?: string | null;
  lastSuccessAt?: string | null;
  lastErrorCode?: string | null;
}

/** 一条“账号已知编码”的当前来源行；只提示核对，不自动建立对应、不计入合计。 */
export interface InventoryPendingSourceRowDto {
  externalSku: string;
  /** 原文件行号（来源 Excel 行）。 */
  excelRow: number | null;
  /** 来源数量；0 是“来源 0、待确认归属”，null 是来源未提供数量。 */
  onHand: number | null;
  /** true = 本仓已有该 SKU 的 confirmed 对应；false = 待确认归属。 */
  mapped: boolean;
  mappingId?: string | null;
}

/**
 * 同仓还有来源待确认：该仓已有已采用 SKU，但同一账号已知编码在最新登记批次里还有未对应来源行。
 * 这些行只用于提示核对：不自动绑定、不计入合计、不确认业务单位。
 */
export interface InventoryPendingSourceWarehouseDto {
  warehouseId: string;
  externalId?: string | null;
  name: string;
  /** 该仓最新登记批次里属于本商品已知编码的 parse_status='ok' 源行数。 */
  sourceRowCount: number;
  /** mapped=false 的源行数（同仓部分未对应）。 */
  pendingSourceRowCount: number;
  /** 待确认归属的来源 SKU。 */
  pendingSkus: string[];
  /** 本仓已确认对应的 SKU（“对应已确认”，不等于“已计入合计”）。 */
  mappedSkus: string[];
  /** 本仓真正已计入当前合计的 SKU（来自当前有效库存行；只有它能写“已计入合计”）。 */
  adoptedSkus: string[];
  /** 该仓全部已知编码来源行（含已对应/未对应标记，带文件行号与数量）。 */
  pendingSourceRows?: InventoryPendingSourceRowDto[];
}

/**
 * 对应已确认、等待下一次完整同步采用：本仓有 confirmed 对应，但最新完整批次行尚未采用该 SKU。
 * 不计入合计，不补加数量，也不改历史。
 */
export interface InventoryPendingAdoptionWarehouseDto {
  warehouseId: string;
  externalId?: string | null;
  name: string;
  /** 本仓真正已计入当前合计的 SKU。 */
  adoptedSkus: string[];
  /** 本仓当前 confirmed 对应 SKU（adoptedSkus ∪ pendingAdoptionSkus）。 */
  mappedSkus: string[];
  /** = mappedSkus − adoptedSkus；等待下一次完整同步采用的 SKU。 */
  pendingAdoptionSkus: string[];
}

export interface InventoryCoverageDto {
  scopeWarehouses: number;
  coveredWarehouses: number;
}

export interface InventoryListUnitGroupDto {
  unit: string | null;
  knownSubtotal: number | null;
  rowCount: number;
}

export interface InventoryListItemDto {
  itemId: string;
  iceCode: string | null;
  nameCn: string | null;
  gtin: string | null;
  market: string | null;
  /** 单一单位组时的已知合计；多单位时 null（不能用单位换算凑数）。 */
  knownSubtotal: number | null;
  unitConflict: boolean;
  /** 同仓多个来源编码：逐行显示、合计待核对（不擅自相加）。 */
  hasPendingTotal?: boolean;
  knownSubtotalComplete?: boolean;
  pendingTotalWarehouses?: Array<{
    warehouseId: string;
    externalId?: string | null;
    name: string;
    unit?: string | null;
    rowCount?: number;
    rows?: Array<{ externalSku: string; onHand: number | null; excelRow?: number | null }>;
  }>;
  unitGroups: InventoryListUnitGroupDto[];
  /** 有已知当前值的仓。 */
  coveredWarehouseCount: number;
  scopeWarehouseCount: number;
  coverage?: InventoryCoverageDto;
  /** false = 还没有成功批次/该商品尚无当前值（不是 0 库存）。 */
  hasCurrentData?: boolean;
  notMappedWarehouses: InventoryListWarehouseRefDto[];
  unseenWarehouses: InventoryListWarehouseRefDto[];
  failedWarehouses: InventoryListWarehouseRefDto[];
  /** 同仓还有来源待确认（已有已采用 SKU 的仓里，其余未对应来源行）。 */
  pendingSourceWarehouses?: InventoryPendingSourceWarehouseDto[];
  hasPendingSourceWarehouses?: boolean;
  /** 对应已确认、但尚未被下一次完整批次采用（不计入合计）。 */
  pendingAdoptionWarehouses?: InventoryPendingAdoptionWarehouseDto[];
  hasPendingAdoptionWarehouses?: boolean;
  /** 已知市场集合；多个市场不是“待确认”。 */
  markets?: string[];
  /** 含 market 为 NULL 的参与仓（单独提示，不猜值）。 */
  hasUnknownMarket?: boolean;
  /** 该商品当前合计来自验证数据（业务包装单位待确认，不作为正式业务合计）。 */
  verificationOnly?: boolean;
  unitUnconfirmed?: boolean;
  /** 历史/批次行缺当时资料版本的数量（0=没有缺失；页面显示“当时资料版本缺失”）。 */
  itemRevisionMissing?: number;
  lastObservedAt: string | null;
  mapped: boolean;
  /** 单一单位组的总行数（服务端 unitGroups 汇总）。 */
  unitCount?: number;
}

export interface InventoryListScopeDto {
  warehouseCount: number;
  lastAllSuccessAt: string | null;
  empty?: boolean;
}

export interface InventoryListDto {
  total: number;
  offset: number;
  limit: number;
  items: InventoryListItemDto[];
  scope: InventoryListScopeDto;
  marketOptions?: InventoryMarketOptionDto[];
  domestic: string;
  inTransit: string;
}

export interface InventoryItemIdentityDto {
  id: string;
  iceCode: string | null;
  nameCn: string | null;
  gtin?: string | null;
}

/** 详情一行 = 一个仓 × 一个来源 SKU；无当前行的仓也返回一行（rows 为空）并带原因。 */
export type InventoryItemRowStatus = 'current' | 'stale' | 'unseen' | 'not_mapped' | 'failed';

export interface InventoryItemWarehouseDto {
  warehouseId: string;
  warehouseName: string;
  externalId?: string | null;
  market?: string | null;
  externalSku: string;
  unit: string | null;
  onHand: number | null;
  orderLocked: number | null;
  warehouseAvailable: number | null;
  activityReserved: number | null;
  inTransit: number | null;
  gtin: string | null;
  observedAt: string | null;
  batchId: string | null;
  excelRow?: number | null;
  itemRevision?: number | null;
  status: InventoryItemRowStatus;
  /** 无 current 行时的原因（unseen/unmapped_source/no_source/failed）。 */
  reason?: string | null;
  gapReason?: string | null;
  /** 该仓本次来源文件行数 / 出现的来源 SKU（同仓部分 SKU 未对应时说明）。 */
  sourceRowCount?: number | null;
  sourceSkus?: string[] | null;
  /** 同仓已知编码的全部来源行（含 mapped 标记、原文件行号与数量；只提示核对）。 */
  pendingSourceRows?: InventoryPendingSourceRowDto[];
  /** mapped=false 的来源行数（同仓部分未对应）。 */
  pendingSourceRowCount?: number | null;
  /** 待确认归属的来源 SKU。 */
  pendingSkus?: string[];
  /** 本仓当前 confirmed 对应 SKU（“对应已确认”，不等于“已计入合计”）。 */
  mappedSkus?: string[];
  /** 本仓真正已计入当前合计的 SKU（只来自当前有效库存行）。 */
  adoptedSkus?: string[];
  /** 对应已确认、但尚未被下一次完整批次采用（不计入合计）。 */
  pendingAdoptionSkus?: string[];
  /** unseen/stale 时的上次已知数量（只展示）。 */
  lastKnownQty?: number | null;
  lastKnownAt?: string | null;
  /** 该仓最近一次任务失败（现值来自历史成功批次）。 */
  failed?: boolean;
  lastSuccessAt?: string | null;
  lastObservationAt?: string | null;
  lastErrorCode?: string | null;
  stale?: boolean;
}

export interface InventoryItemTotalsDto {
  byUnit: InventoryListUnitGroupDto[];
  /** 单单位组的已知合计；多单位时 null。 */
  knownSubtotal: number | null;
  unitConflict: boolean;
}

export interface InventoryItemHistoryDto {
  batchId: string;
  warehouseName: string;
  runId: string;
  publishedAt: string;
  observationAt?: string | null;
  onHand: number | null;
  previousOnHand: number | null;
  externalSku: string;
  unit: string | null;
  itemRevision?: number | null;
  rowStatus: string;
}

export interface InventoryItemMappingDto {
  id: string;
  externalSku: string;
  warehouseId: string | null;
  warehouseExternalId?: string | null;
  warehouseName: string | null;
  version: number;
  unit: string | null;
  status: string;
  confirmedAt: string | null;
  itemRevision?: number | null;
  actorLabel?: string | null;
  reason?: string | null;
  accountLevel?: boolean;
  /** 验证数据（业务包装单位待确认）：不作为正式业务合计。 */
  verification?: boolean;
  unitUnconfirmed?: boolean;
}

export interface InventoryItemDetailDto {
  item: InventoryItemIdentityDto;
  /** filtered = 沿用列表仓库/市场筛选；all = 显式查看全仓。 */
  scopeMode: 'filtered' | 'all';
  /** 整个筛选范围所有仓（无 current 行也返回 rows:[] + reason）。 */
  warehouses: InventoryItemWarehouseDto[];
  totals: InventoryItemTotalsDto;
  coverage?: InventoryCoverageDto;
  /** 该商品来源覆盖的已知市场集合；hasUnknownMarket 单独提示未知仓。 */
  markets?: string[];
  hasUnknownMarket?: boolean;
  /** 同仓还有来源待确认（与列表同一 summary 口径）。 */
  pendingSourceWarehouses?: InventoryPendingSourceWarehouseDto[];
  hasPendingSourceWarehouses?: boolean;
  /** 对应已确认、等待下一次完整同步采用（与列表同一 summary 口径，不计入合计）。 */
  pendingAdoptionWarehouses?: InventoryPendingAdoptionWarehouseDto[];
  hasPendingAdoptionWarehouses?: boolean;
  verificationOnly?: boolean;
  unitUnconfirmed?: boolean;
  /** 历史行缺当时资料版本的数量（0=没有缺失）。 */
  itemRevisionMissing?: number;
  history: InventoryItemHistoryDto[];
  mapping: InventoryItemMappingDto[];
  scopedWarnings?: string[] | null;
}

/** 已确认对应维护（重核/停用/换绑）在列表行上的最小投影。 */
export interface ConfirmedMappingView {
  itemId: string;
  itemLabel: string;
  mappingId: string;
  externalSku: string;
  warehouseId: string | null;
  warehouseName: string | null;
  version: number;
  unit: string | null;
  status: string;
  confirmedAt: string | null;
  reason?: string | null;
}

/* ------------------------------------------------------------------ *
 * 动作（R5）
 * ------------------------------------------------------------------ */

export type InventoryPendingPhase = 'none' | 'pending' | 'found' | 'not_found' | 'query_failed';

/**
 * 原请求的结案状态（v4-final R2）。页面只能用它与 ok/unlockFailed 一起决定是否解除本地锁：
 * - `settled`：原请求确定失败且服务端已确认结案（同 actor/action/intent/完整参数）；
 * - `no_pending`：服务端既无 pending 也无业务回执行（请求从未登记），无需解除；
 * - `settle_failed`：确定失败但结案未确认（异常/连接/服务端拒绝），原请求仍保留；
 * - `not_original`：本次调用的 action/intent/完整参数与原请求不符，原请求保持原样。
 */
export type InventorySettlement = 'settled' | 'settle_failed' | 'not_original' | 'no_pending';

export interface InventoryActionOutcome {
  ok: boolean;
  deduped: boolean;
  runId: string | null;
  errorCode: string | null;
  message: string;
  requestId?: string;
  /** true = 提交结果暂未确认：服务端已登记 pending，必须先核对，不能当确定失败。 */
  outcomeUnknown?: boolean;
  /** 业务已生效但 pending 解除失败：原请求仍保留，不能提示已解锁。 */
  unlockFailed?: boolean;
  /** 空范围（停止发布）等业务状态。 */
  scopeEmpty?: boolean;
  /** 失败收尾时服务端对原请求的结案结果（见 InventorySettlement）。 */
  settlement?: InventorySettlement;
}

export type InventoryReconcileState = 'found' | 'not_found' | 'failed_terminal' | 'failed' | 'found_unlock_failed';

export interface InventoryReconcileOutcome {
  ok: boolean;
  state: InventoryReconcileState;
  message: string;
  errorCode: string | null;
  /** 找到时的原回执摘要（中文，不含内部 UUID 主文案）。 */
  receiptSummary?: string | null;
}

/* ------------------------------------------------------------------ *
 * 商品库存双视图 v1（仓库明细 / 商品汇总 / 国内表格快照）
 *
 * 口径：
 * - 仓库明细一行 = 一个参与仓 × 一个来源 SKU（含未对应、真实 0），不按名称合并；
 * - 商品汇总一行 = 一个标准商品，按市场分格；每格按完整筛选范围计算，不是当前明细页；
 * - 国内数量来自冻结聚水潭表格快照：只展示文件日期与原表实际数量，不冒充实时库存，
 *   不与海外来源跨来源相加；未确认选择不进入标准商品国内合计。
 * ------------------------------------------------------------------ */

export type InventoryViewMode = 'warehouse' | 'product';
/** 来源范围：海外 BigSeller / 国内表格快照 / 全部（分开计时，不跨来源相加）。 */
export type InventorySourceScope = 'overseas' | 'domestic' | 'all';
export type InventoryWarehouseRowSource = 'bigseller' | 'domestic';
/**
 * 海外仓库明细行状态（来源事实与当前对应分开表达，只有 adopted 计入合计）：
 * - adopted：本批已采用且当前对应 confirmed（海外=当前有效库存行；国内=冻结有效选择且关联到标准商品）；
 * - pending_adoption：当前对应已确认，但本批未采用（来源原数量保留、可按商品查到，不计入合计）；
 * - inactive：本批当时已采用，但当前对应重核/停用/无（保留原数量与原时间，不计入合计）；
 * - unmapped：来源未对应（不计入任何合计）。
 */
export type InventoryWarehouseRowStatus = 'adopted' | 'unmapped' | 'pending_adoption' | 'inactive';

/** 仓库明细一行。 */
export interface InventoryWarehouseRowDto {
  source: InventoryWarehouseRowSource;
  /** source + warehouseId + externalSku 组成的稳定行键（客户端列表 key / 定位用）。 */
  rowKey: string;
  warehouseId: string | null;
  warehouseExternalId: string | null;
  /** 海外=来源仓名；国内=「国内 · 原表未注明仓库」。 */
  warehouseName: string;
  /** 有证据的市场代码；null = 市场待确认（国内行恒为 null）。 */
  market: string | null;
  status: InventoryWarehouseRowStatus;
  itemId: string | null;
  iceCode: string | null;
  /** 标准中文名称（已对应时）；未对应为 null。 */
  itemName: string | null;
  /** 来源原始名称（未对应时用于显示并标待确认归属）。 */
  sourceName: string | null;
  externalSku: string;
  gtin: string | null;
  unit: string | null;
  /** 实物库存（国内=原表「实际库存数」解析值）。 */
  onHand: number | null;
  orderLocked: number | null;
  /** 可售库存（国内=原表「可用数」解析值；不并入实际数量）。 */
  warehouseAvailable: number | null;
  activityReserved: number | null;
  inTransit: number | null;
  /** 观测时间：海外=来源导出完成时间；国内=null（原表未注明精确观测时间）。 */
  observationAt: string | null;
  batchId: string | null;
  excelRow: number | null;
  /** confirmed / recheck / disabled / null。 */
  mappingStatus: string | null;
  itemRevision: number | null;
  /** 原始文本（数量原文，详情里可查；缺失为 null）。 */
  rawOnHand: string | null;
  /** 本次未见但历史批次里该商品/编码曾有采用数量：上次已知数量/时间（只展示，不当本次库存、不计入合计）。 */
  lastKnownQty?: number | null;
  lastKnownAt?: string | null;
  /** 未对应/未纳入的具体原因（中文，可直接显示）。 */
  note: string | null;
  /** 国内行：来源文件日期（YYYY-MM-DD）与文件名；海外为 null。 */
  fileDate?: string | null;
  fileName?: string | null;
  /** 国内行：原表「运营云仓可用数」原文（单独保留，不并入可用数）。 */
  cloudAvailableText?: string | null;
}

/** 逐仓读取状态（同步页 / 仓库明细顶部共用：真实批次与覆盖，不按最近登记 run 冒充）。 */
export interface InventoryWarehouseReadStateV2Dto {
  warehouseId: string;
  externalId: string;
  name: string;
  market: string | null;
  warehouseStatus: string;
  lastSuccessAt: string | null;
  lastBatchId: string | null;
  batchRows: number;
  adoptedRows: number;
  unmappedRows: number;
  observationAt: string | null;
  publishedAt: string | null;
  failed: boolean;
  stale: boolean;
  lastErrorCode: string | null;
  latestRunStatus: string | null;
  /** 本批来源未对应行数（= 待处理对应数量，不含已知待核候选）。 */
  pendingMappingRows: number;
}

export interface InventoryWarehouseRowsDto {
  total: number;
  offset: number;
  limit: number;
  rows: InventoryWarehouseRowDto[];
  scope: InventoryListScopeDto;
  marketOptions: InventoryMarketOptionDto[];
  warehouses: InventoryWarehouseReadStateV2Dto[];
  /** 当前筛选（海外）范围内，各状态行数；只有 adopted 计入合计，其余仅用于页面说明。 */
  counts: { adopted: number; unmapped: number; pendingAdoption: number; inactive: number };
}

/** 商品汇总的一个市场格（只发布实物口径；不发布未获批准的“整仓可用”合计）。 */
export interface InventoryProductMarketCellDto {
  /** null = 市场待确认（仓库未带市场证据）。 */
  market: string | null;
  /** 该市场实物合计；任一数量未知或单位冲突时为 null（不凑数）。 */
  onHand: number | null;
  /** 该市场内不同来源编码（SKU）种数，不是仓库明细行数。 */
  skuCount: number;
  warehouseCount: number;
  /** 同仓多来源编码：合计待核对（不擅自相加）。 */
  hasPendingTotal: boolean;
}

export interface InventoryProductDomesticCellDto {
  /** 冻结有效选择且关联到标准商品的「实际库存数」合计；缺失时为 null。 */
  onHand: number | null;
  available: number | null;
  rowCount: number;
  /** 涉及的文件日期（YYYY-MM-DD，去重排序）。 */
  fileDates: string[];
  /** 有效明细中有数量未知/冲突的行（页面标“含未注明数量行”）。 */
  hasQuantityAnomaly: boolean;
}

/** 商品汇总一行：标准商品 × 各市场库存对照。 */
export interface InventoryProductSummaryRowDto extends InventoryListItemDto {
  marketCells: InventoryProductMarketCellDto[];
  /** 海外实物合计（= 各市场格合计；多单位/未知时为 null）。 */
  overseasOnHand: number | null;
  overseasSkuCount: number;
  domestic: InventoryProductDomesticCellDto | null;
}

export interface InventoryProductSummaryDto {
  total: number;
  offset: number;
  limit: number;
  rows: InventoryProductSummaryRowDto[];
  scope: InventoryListScopeDto & {
    /** 市场汇总口径：市场列是否按筛选收窄。 */
    marketFilter?: string | null;
    warehouseFilter?: string | null;
  };
  marketOptions: InventoryMarketOptionDto[];
  warehouses: InventoryWarehouseReadStateV2Dto[];
  /** 当前范围内没有标准商品归属的海外来源行（不计入汇总，提供定位提示）。 */
  unmappedOverseasRows: number;
  /** 国内快照里已核对但未关联到标准商品的选择数（正常为 0，>0 时提示）。 */
  unmappedDomesticRows: number;
  /** 国内快照是否可用（false = 未读取/失败，不显示 0）。 */
  domesticAvailable: boolean;
  domesticReason: string | null;
}

/**
 * 国内表格快照的一条来源记录（冻结聚水潭样表）。
 * 只读展示：数量取原表「实际库存数」/「可用数」，保留文件日期与来源 SKU；
 * 原表未注明仓库/账号/单位/确切观测时间，不补造。
 */
export interface InventoryDomesticRowDto {
  source: 'domestic';
  legacyCandidateId: string;
  /** 冻结有效选择关联到的标准商品 UUID；未关联为 null。 */
  itemId: string | null;
  iceCode: string | null;
  itemNameCn: string | null;
  externalSku: string;
  sourceName: string | null;
  /** 原表「实际库存数」解析值；缺失/非法为 null（不转 0）。 */
  actualQty: number | null;
  /** 原表「可用数」解析值；不并入实际库存数。 */
  availableQty: number | null;
  /** 原表「运营云仓可用数」原文；单独保留，不并入前两列。 */
  cloudAvailableText: string | null;
  rawActualText: string | null;
  rawAvailableText: string | null;
  /** 原表未注明单位。 */
  unit: string | null;
  /** 固定：国内 · 原表未注明仓库 */
  warehouseLabel: string;
  sheet: string | null;
  excelRow: number | null;
  /** 来源文件日期（YYYY-MM-DD，取自原文件名）。 */
  fileDate: string;
  fileName: string;
  frozenFileSha256: string;
  /** manual_selected / pending / ignored / rejected / candidate。 */
  reviewState: string;
  /** ok / missing / invalid / conflict（页面按状态分开说明，不转 0）。 */
  quantityState: 'ok' | 'missing' | 'invalid' | 'conflict';
  /** 逐行说明（数量缺失/未关联/冲突等）；没有异常时为 null。 */
  note?: string | null;
}

export interface InventoryDomesticSnapshotDto {
  /** false = 快照未读取/读取失败：页面显示“未读取”，不显示 0。 */
  available: boolean;
  reason: string | null;
  /** 冻结发布标识与关键输入哈希（只读证据，不是实时来源）。 */
  releaseKey: string;
  sourceRecordsSha256: string;
  /** 887 条国内来源记录；118 条冻结有效选择（manual_selected）。 */
  recordCount: number;
  selectedCount: number;
  /** 已关联到标准商品的冻结有效选择数量（应为 118）。 */
  linkedSelectedCount: number;
  /** 涉及的商品数。 */
  linkedItemCount: number;
  /** 冻结有效选择里未关联到标准商品的记录（正常为 0；>0 时页面提示可定位）。 */
  unlinkedSelectedCount: number;
  fileDates: Array<{ fileDate: string; fileName: string; frozenFileSha256: string; recordCount: number }>;
  /** 全部 887 条来源记录（已关联或未关联均保留，供明细查询）。 */
  rows: InventoryDomesticRowDto[];
  /** true = 本进程内复用已校验的冻结快照（不是实时刷新）。 */
  cached: boolean;
}


