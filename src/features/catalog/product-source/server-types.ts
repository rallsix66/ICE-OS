/**
 * 服务端提交契约：本地快照读取与应用计划。
 *
 * 这些结构是 server→DB 的受控 JSON 载荷，不导出到客户端；
 * 页面 DTO 由 service.ts 生成（中文、无 UUID/JSON）。
 */
import type { FieldObservation } from '../types';
import type { SourceCell } from './contract';

export type SourceOrigin = 'real_capture' | 'local_simulation';
export type ApplyAction = 'update' | 'create' | 'unchanged' | 'needs_review' | 'failed';

export interface SourceProfileInput {
  profileKey: string;
  documentKey: string;
  spreadsheetToken: string | null;
  sheetId: string | null;
  sheetName: string;
  displayName: string;
  sourceUrl: string;
  acquisitionMode: 'local_snapshot' | 'feishu_api';
}

export interface SourceArtifactInput {
  logicalName: string;
  sha256: string;
  size: number;
  format: string;
  storageHandle: string;
  role: 'snapshot' | 'raw_capture' | 'metadata';
}

export interface SourceBatchRowInput {
  rowNumber: number;
  isBusinessRow: boolean;
  iceCode: string | null;
  /** 列字母 → 原文。公共行的受限价格列已按表头映射剔除，只进入受控表。 */
  cells: Record<string, string>;
  /** 规范化后的非受限字段（人工核对/同号选择用）。 */
  fields?: Record<string, unknown>;
  rowSha256: string;
}

export interface SourceBatchAmountInput {
  rowNumber: number;
  /** 语义金额键：按实际表头映射取得，列字母只作证据。 */
  payload: { costPrice?: string; operatingPrice?: string; shippingPrice?: string };
}

export interface SourceBatchInput {
  snapshotKey: string;
  origin: SourceOrigin;
  capturedAt: string;
  sourceModifiedLabel: string | null;
  collection: Record<string, unknown>;
  rowsSha256: string;
  adoptionSha256: string;
  /** 模拟快照的父批次（本地模拟链）。 */
  parentBatchId: string | null;
  /** 已知部分失败后只补做失败项的父批次；null 表示普通原批次。 */
  retryOfBatchId: string | null;
  simulationNote: string | null;
  artifacts: SourceArtifactInput[];
  rows: SourceBatchRowInput[];
  amounts: SourceBatchAmountInput[];
}

/** 服务端在提交前保留的原请求及完整意图（提交结果未知时按原样核对）。 */
export interface StoredRequestIntent {
  requestId: string;
  action: string;
  intentSha256: string;
  profileKey: string;
  snapshotKey: string;
  payload: {
    profile: SourceProfileInput;
    batch: SourceBatchInput;
    plan: SourcePlanInput;
  };
}

export interface SourceChangeInput {
  fieldKey: string;
  beforeRaw: string | null;
  afterRaw: string | null;
  kind: 'update' | 'initial_baseline' | 'unit_unconfirmed';
}

export interface SourceAdoptionInput {
  fieldKey: string;
  raw: string;
  state: 'observed' | 'explicit_empty';
  unitState: 'confirmed' | 'unconfirmed' | 'not_applicable';
}

export interface SourceIssueInput {
  kind: string;
  detail: Record<string, unknown>;
}

export interface SourcePlanResult {
  sourceKey: string;
  iceCode: string | null;
  itemId: string | null;
  action: ApplyAction;
  reasonCode: string;
  reasonText: string;
  rowNumbers: number[];
  expectedRevision: number | null;
  changes: SourceChangeInput[];
  adoptions: SourceAdoptionInput[];
  nextFields: Record<string, FieldObservation> | null;
  nameCn: string | null;
  createCode: string | null;
  /** 回执结果中该商品实际写入后的修订号；needs_review 且已部分写入时也非 null。 */
  itemRevision?: number | null;
  issues: SourceIssueInput[];
  missing: boolean;
}

export interface SourcePlanCounts {
  created: number;
  updated: number;
  unchanged: number;
  needsReview: number;
  failed: number;
  missing: number;
}

export interface SourcePlanInput {
  countsHint: SourcePlanCounts;
  results: SourcePlanResult[];
  seenItemIds: string[];
  batchStatusHint: 'applied' | 'partial' | 'failed';
}

export interface ApplyReceipt {
  status: 'applied' | 'partial' | 'failed' | 'rejected_stale' | 'duplicate';
  batchId: string | null;
  snapshotKey: string;
  counts: SourcePlanCounts & { rejectedStale?: number };
  results?: SourcePlanResult[];
  message?: string | null;
}

export interface SourceIssueRecord {
  issueKey: string;
  sourceKey: string;
  iceCode: string | null;
  nameCn: string | null;
  kind: string;
  detail: Record<string, unknown>;
  reviewState: 'open' | 'resolved' | 'ignored' | 'superseded';
  scope: 'batch' | 'item';
  itemId: string | null;
  itemRevision: number | null;
  rows: number[];
}

/** 036 只读投影：当前生效（state='active'）的字段级人工决定。 */
export interface SourceFieldDecisionRecord {
  decisionId: string;
  itemId: string;
  iceCode: string | null;
  nameCn: string | null;
  fieldKey: string;
  action: 'defer' | 'override' | 'interpret';
  /** Only for action=interpret: the registered source-column interpretation rule. */
  rule: string | null;
  valueRaw: string | null;
  reason: string;
  note: string | null;
  state: string;
  decidedAt: string;
}

/** 036 只读投影：当前生效（state='active'）的同号多行人工选择。 */
export interface SourceDuplicateDecisionRecord {
  decisionId: string;
  iceCode: string;
  itemId: string | null;
  nameCn: string | null;
  chosenRowNumber: number | null;
  /** 选择当时该来源行的业务字段（fieldKey → SourceCell），只用于页面展示已选内容。 */
  chosenFields: Record<string, SourceCell>;
  comparison: Record<string, unknown>;
  state: string;
  decidedAt: string;
  note: string | null;
}

export interface SourceManualDecisionsRaw {
  fieldDecisions: SourceFieldDecisionRecord[];
  duplicateDecisions: SourceDuplicateDecisionRecord[];
}

/**
 * 人工决定动作的服务端上下文：只用于校验事项/来源行并按内容指纹落库，
 * 不进入页面 DTO（UUID/哈希不得上屏）。
 */
export interface SourceIssueRowContext {
  rowNumber: number;
  rowSha256: string | null;
  /** 批次落库的公共列（限制价格列已剔除）。 */
  cells: Record<string, string>;
  fields: Record<string, SourceCell>;
}

export interface SourceIssueDecisionContext {
  issueId: string;
  batchId: string;
  snapshotKey: string;
  sourceKey: string;
  issueKind: string;
  itemId: string | null;
  detail: Record<string, unknown>;
  reviewState: 'open' | 'resolved' | 'ignored' | 'superseded';
  /** 批次采集信息（含 headers；历史批次 rows.fields 为空时据此重建行字段）。 */
  collection: Record<string, unknown>;
  rows: SourceIssueRowContext[];
}

export interface SourceOverviewRaw {
  source: {
    profileKey: string;
    displayName: string;
    documentKey: string;
    sheetName: string;
    acquisitionMode: 'local_snapshot' | 'feishu_api';
  };
  latest: {
    batchId: string;
    snapshotKey: string;
    origin: SourceOrigin;
    capturedAt: string;
    sourceModifiedLabel: string | null;
    status: 'collected' | 'validated' | 'applied' | 'partial' | 'failed' | 'rejected_stale';
    counts: SourcePlanCounts;
    message: string | null;
    /** 该批次采集覆盖信息原样（供页面生成中文摘要）。 */
    collection: Record<string, unknown>;
  } | null;
  results: SourcePlanResult[];
  issues: SourceIssueRecord[];
  batches: Array<{
    batchId: string;
    snapshotKey: string;
    origin: SourceOrigin;
    capturedAt: string;
    status: string;
    counts: SourcePlanCounts;
    parentBatchId: string | null;
    /** 补做批次指向其父批次；普通批次为 null。 */
    retryOfBatchId?: string | null;
  }>;
  bindingCount: number;
}

export interface SourceItemStateRaw {
  itemId: string;
  iceCode: string | null;
  binding: { iceCode: string; state: 'active' | 'missing' } | null;
  adoptions: Record<string, { raw: string; unitState: string }>;
  latestResult: {
    classification: ApplyAction | 'missing';
    reasonCode: string;
    capturedAt: string;
    origin: SourceOrigin;
  } | null;
}
