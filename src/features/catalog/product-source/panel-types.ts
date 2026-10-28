/**
 * 页面 DTO：飞书商品来源面板（中文业务投影）。
 *
 * 只含业务事实：不出现 UUID、JSON、哈希、内部英文键名或价格。
 */
export type ProductSourceBatchStatus = 'collected' | 'validated' | 'applied' | 'partial' | 'failed' | 'rejected_stale';
export type ProductSourceClassification = 'updated' | 'created' | 'unchanged' | 'needs_review' | 'missing' | 'failed';

export interface ProductSourceCountsDto {
  created: number;
  updated: number;
  unchanged: number;
  needsReview: number;
  failed: number;
  missing: number;
}

export interface ProductSourcePanelDto {
  source: {
    profileKey: string;
    displayName: string;
    documentLabel: string;
    sheetName: string;
    mode: 'local_snapshot' | 'feishu_api';
    modeLabel: string;
    simulation: boolean;
  };
  latest: null | {
    batchIdLabel: string;
    /** 提交动作所需的隐藏令牌（不在页面正文展示）。 */
    snapshotToken: string;
    capturedAtDisplay: string;
    originLabel: string;
    status: ProductSourceBatchStatus;
    statusLabel: string;
    counts: ProductSourceCountsDto;
    message: string | null;
    /** 采集摘要：表头校验/有效业务行/来源编号数等（中文）。 */
    captureSummary: string | null;
  };
  results: Array<{
    sourceKeyLabel: string;
    iceCode: string | null;
    nameCn: string | null;
    classification: ProductSourceClassification;
    classificationLabel: string;
    reasonLabel: string;
    rowNumbers: number[];
    changes: Array<{ fieldLabel: string; before: string; after: string; unitLabel: string | null }>;
  }>;
  issues: Array<{
    /** 待核对项标识：resolve 动作的入参，不在页面正文展示。 */
    issueKey: string;
    sourceKeyLabel: string;
    iceCode: string | null;
    nameCn: string | null;
    kind: string;
    kindLabel: string;
    detailLabel: string;
    reviewState: 'open' | 'resolved' | 'ignored';
    reviewStateLabel: string;
    rows: number[];
  }>;
  /** 最近一条尚未应用的来源快照（页面初始加载即可应用）。 */
  pending: null | {
    snapshotToken: string;
    capturedAtDisplay: string;
    originLabel: string;
    captureSummary: string;
  };
  batchHistory: Array<{
    batchIdLabel: string;
    capturedAtDisplay: string;
    originLabel: string;
    statusLabel: string;
    countsSummary: string;
  }>;
  actions: {
    canApply: boolean;
    canRetry: boolean;
    canResolveIssues: boolean;
    disabledReason: string | null;
  };
}
