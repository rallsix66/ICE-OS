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
    reviewState: 'open' | 'resolved' | 'ignored' | 'superseded';
    reviewStateLabel: string;
    rows: number[];
    /** 关联商品与当前修订（人工补号动作需要；页面不显示 UUID）。 */
    itemId: string | null;
    itemRevision: number | null;
    /** 字段级问题（非法值/公式错误）的字段中文名与来源原值。 */
    fieldKey: string | null;
    fieldLabel: string | null;
    rawValue: string | null;
    /** true = 商品级“货号待确认”，不依赖原表行。 */
    pendingCode: boolean;
    /** 名称（仅空白差异）与现有缺货号商品的关系提示；仅作人工确认用，未确认前不建档/不绑定。 */
    candidate: null | {
      itemId: string | null;
      itemName: string | null;
      itemCode: string | null;
      sourceCode: string | null;
      matchedBy: string | null;
      nameNormalized: boolean;
    };
    /** 同号多行的实际差异（人工选择以哪一行为准）。 */
    duplicate: null | {
      decisionStale: boolean;
      fields: Array<{
        fieldKey: string;
        fieldLabel: string;
        values: Array<{ rowNumber: number; value: string; empty: boolean }>;
      }>;
      /** 已保存的选择（若有）。 */
      savedChoice: null | { chosenRowNumber: number | null; decidedAtDisplay: string; note: string | null };
    };
    /**
     * 最新待应用快照已读到的候选正式货号（只读投影，不写库）：
     * 接到原商品的“货号待确认”事项上，确认前不采用整批、不新建商品、不自动绑定。
     */
    pendingCodeCandidate: null | {
      sourceCode: string;
      matchedItemName: string | null;
      matchedBy: string | null;
      rowNumbers: number[];
      capturedAtDisplay: string;
    };
  }>;
  /**
   * 本次更新预览（来自最新待应用快照的真实计划；不是上一批已采用结果）。
   * 只投影变化字段、无变化数量与本批需核对项；确认动作只对应这一份计划。
   */
  preview: null | {
    snapshotToken: string;
    capturedAtDisplay: string;
    originLabel: string;
    captureSummary: string;
    counts: ProductSourceCountsDto;
    changed: Array<{
      itemKey: string;
      itemId: string | null;
      iceCode: string | null;
      nameCn: string | null;
      changes: Array<{
        fieldLabel: string;
        before: string;
        after: string;
        unitLabel: string | null;
      }>;
    }>;
    unchangedCount: number;
    reviewCount: number;
    reviewNotes: Array<{ fieldLabel: string; reasonLabel: string; count: number }>;
    canApply: boolean;
    disabledReason: string | null;
  };
  /** 已登记的人工决定：字段级暂不处理/人工口径/按来源列解释 + 同号多行选择。 */
  manualDecisions: {
    fieldDecisions: Array<{
      decisionId: string;
      itemId: string;
      iceCode: string | null;
      nameCn: string | null;
      fieldKey: string;
      fieldLabel: string;
      action: 'defer' | 'override' | 'interpret';
      actionLabel: string;
      /** interpret 时的规则英文键（页面只展示 ruleLabel；不展示原始键名以外的内容）。 */
      rule: string | null;
      ruleLabel: string | null;
      valueRaw: string | null;
      reason: string;
      note: string | null;
      decidedAtDisplay: string;
    }>;
    duplicateDecisions: Array<{
      decisionId: string;
      iceCode: string;
      nameCn: string | null;
      chosenRowNumber: number | null;
      decidedAtDisplay: string;
      note: string | null;
      chosenFields: Array<{ fieldLabel: string; value: string }>;
    }>;
  };
  /** 最近一条尚未应用的来源快照（页面初始加载即可应用）。 */
  pending: null | {
    snapshotToken: string;
    capturedAtDisplay: string;
    originLabel: string;
    captureSummary: string;
  };
  /**
   * 「已读取」只表示读到了来源并生成待应用快照，不写商品资料；
   * 「已采用」只表示最近一次按来源计划写入商品资料的批次。两者不得混用。
   */
  read: {
    /** 最近一次读取时间（定时或手动读取都记入同一状态文件）。 */
    lastReadAtDisplay: string | null;
    /** 最近一次读取结果（成功读取 / 内容未变化 / 读取失败）。 */
    lastResultLabel: string | null;
    /** 已读取但尚未采用的新快照时间；null = 当前没有待应用快照。 */
    pendingAtDisplay: string | null;
  };
  applied: null | {
    capturedAtDisplay: string;
    statusLabel: string;
    countsSummary: string;
    counts: ProductSourceCountsDto;
  };
  /** 只读定时读取进程状态（飞书真实读取；只生成待应用快照，不自动写商品）。 */
  schedule: null | {
    running: boolean;
    runningLabel: string;
    intervalMinutes: number | null;
    lastResultLabel: string | null;
    lastRunAtDisplay: string | null;
    nextRunAtDisplay: string | null;
    errorLabel: string | null;
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
    canRead: boolean;
    disabledReason: string | null;
  };
}
