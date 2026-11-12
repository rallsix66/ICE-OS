/**
 * 「待处理」只读问题索引的纯派生逻辑（不访问数据库、不读环境变量）。
 *
 * 调用方：`./service.ts`（读取既有事实后派生）、`./module-facts.ts`（提供模块事实）、
 * `./issue-index.test.ts`（单元测试）。
 *
 * 只把既有事实/既有模块状态投影为事项：不新增审批流程、已读/忽略状态或异常规则。
 * 候选冲突、被驳回/忽略/规则外的记录、已结束记录、未建档资料与普通字段缺失都不进入待办。
 *
 * ── 逐类能力表（业务文案以此为准；谓词仅作技术层/测试用，不渲染） ─────────────
 * | 事项 | 触发事实（内部谓词） | 去重键 | 可见权限 | 现役动作 | 关闭依据 |
 * |---|---|---|---|---|---|
 * | 新品待补货号 | new_product_confirmed 且当前版本无货号 | new_item_missing_code:<itemId> | 商品资料写入（管理员） | 有：商品详情“编辑资料”补录货号 | 已定义：补录后事实消失 |
 * | 两刷子待确认 | 历史保留记录，状态为待确认 | brush_pending:<记录ID> | 仅查看 | 无（不可修改的历史记录） | 待业务定义：需后续确认方式 |
 * | 来源范围未解析 | 范围状态为未解析 | source_scope_unresolved:<范围ID> | 仅查看 | 无（范围记录不可修改） | 待业务定义：需后续解析能力 |
 * | 来源记录待复核 | 身份记录状态=待复核 | source_identity_record:<记录ID> | 来源身份维护（管理员） | 有：来源核实内复核/恢复 | 已定义：记录恢复有效 |
 * | 来源记录已暂停 | 身份记录状态=已暂停 | source_identity_record:<记录ID> | 来源身份维护（管理员） | 有：来源核实内恢复 | 已定义：恢复有效或撤销 |
 * | 分类待复核 | 最新分类状态=待复核 | new_item_observation:<观测ID> | 持续新品维护（管理员） | 有：持续新品内重新分类 | 已定义：分类离开待复核 |
 * | 观测未关联商品 | 已分类建议但未建档/关联 | new_item_observation:<观测ID> | 持续新品维护与发布（管理员） | 有：持续新品内确认建档或关联 | 已定义：建立关联后消失 |
 *
 * 说明：历史保留记录与未解析范围都是**不可修改**的既有事实，本索引不提供改动数据库的入口；
 * 这两类保留事项并如实标注“当前无处理入口 / 关闭依据待业务定义”，不得虚构按钮或承诺未实现的能力。
 */
import { ISSUES_RETURN_HREF, appendReturnContext } from './context';
import type {
  CatalogIssue,
  CatalogIssueCoverage,
  CatalogIssueDetail,
  CatalogIssueIndex,
  CatalogIssueKind,
  CatalogIssueModule,
  CatalogIssueSourceCandidateRow,
  CatalogIssueSourceReview,
  CatalogIssueToolbarModel,
  CatalogPendingItem,
} from './types';

/* ── 现役商品库事实 ───────────────────────────────────────── */

/** 已确认新品且当前资料版本缺 ICE 货号（一条既有事实）。 */
export type UncodedNewItemFact = {
  itemId: string;
  nameCn: string;
  revision: number;
  /** 原始证据引用（技术层/复核用，不在业务文案渲染）；无引用时为 null。 */
  evidenceRef: string | null;
};

/** 两刷子历史保留记录（不可修改的历史事实；一条记录一条事项）。 */
export type BrushPendingFact = {
  decisionId: string;
  entryKey: string;
  rawRef: string;
  itemId: string;
  iceCode: string | null;
  nameCn: string;
  sourceSystem: string | null;
  /** 历史原因原文（可能含内部英文，只在技术层，不渲染）。 */
  reason: string | null;
  doNotMerge: boolean;
};

/* ── 既有模块状态事实（来源核实 / 持续新品） ─────────────────── */

/** 来源范围：身份范围与解析状态。 */
export type SourceScopeFact = {
  scopeId: string;
  displayName: string;
  system: string;
  scopeState: 'identity_ready' | 'unresolved';
};

/** 来源身份记录：只取需要处理的两个既有状态。 */
export type SourceIdentityRecordFact = {
  recordId: string;
  scopeId: string;
  scopeDisplayName: string;
  state: 'review_required' | 'suspended';
  revision: number;
  entityKind: string;
};

/** 商品观测：只取分类/复核/关联与名称摘要。 */
export type NewItemObservationFact = {
  observationId: string;
  scopeId: string;
  scopeDisplayName: string;
  recordPointer: string;
  /** 名称摘要（来自已观测的名称字段）；没读到时不猜测。 */
  nameHint: string | null;
  reviewState: 'proposed' | 'needs_review' | null;
  classification: string | null;
  /** 已关联商品时给出 itemId；未关联为 null。 */
  originItemId: string | null;
};

export type NewItemModuleFacts = {
  scopes: SourceScopeFact[];
  observations: NewItemObservationFact[];
};

export type SourceIdentityModuleFacts = {
  scopes: SourceScopeFact[];
  records: SourceIdentityRecordFact[];
};

/**
 * 飞书商品资料的一条来源待核对事项（既有 product_source_issue review_state=open）。
 * 字段标签与事项名称由服务端按既有字段/事项标签表转换后传入，派生逻辑不猜、不翻译。
 */
export type ProductSourceIssueFact = {
  issueId: string;
  iceCode: string | null;
  nameCn: string | null;
  /** 内部事项类型（只在技术层/测试使用；业务文案用 kindLabel）。 */
  kind: string;
  kindLabel: string;
  /** 关联商品；来源缺码等未关联商品的项为 null。 */
  itemId: string | null;
  /** 关联商品当前资料版本；补号动作需要（无关联商品/未读到为 null）。 */
  itemRevision?: number | null;
  /** 商品规格文本；读不到时为 ''（投影时显示「规格未填写」）。 */
  specificationText?: string | null;
  /** 来源行号（来源快照中的 1-based 行号）。 */
  rows: number[];
  /** 问题字段中文标签；没有具体字段时为空数组（如来源缺码）。 */
  fieldLabels: string[];
  /** 同号多行的逐字段差异（来自既有事项 detail）；其他事项为 null。 */
  duplicate?: {
    fields: Array<{
      fieldLabel: string;
      values: Array<{ rowNumber: number; value: string; empty: boolean }>;
    }>;
  } | null;
  /** true = 商品级“货号待确认”，不依赖具体来源行。 */
  pendingCode?: boolean;
  /**
   * 最新待应用来源快照已读到的候选正式货号（只读投影）。
   * 有值时直接显示「未填写 → 来源货号」并请用户确认，不要求先采用整批。
   */
  sourceCodeCandidate?: {
    sourceCode: string;
    rowNumbers: number[];
    capturedAtDisplay: string;
  } | null;
};

export type ProductSourceModuleFacts = {
  /** 来源位置说明（如「ICE产品库 · Sheet1」）。 */
  sourceLabel: string;
  /** 飞书原表地址（外部链接）；没有配置时为 null。 */
  sourceHref: string | null;
  issues: ProductSourceIssueFact[];
};

/** 只读事实集合：现役商品库事实 + 已启用模块的既有状态。 */
export type CatalogIssueFacts = {
  uncodedNewItems: UncodedNewItemFact[];
  brushPending: BrushPendingFact[];
  moduleFacts?: {
    newItem?: NewItemModuleFacts | null;
    sourceIdentity?: SourceIdentityModuleFacts | null;
    productSource?: ProductSourceModuleFacts | null;
  } | null;
};

/* ── 标签与排序 ───────────────────────────────────────────── */

export const CATALOG_ISSUE_KIND_LABELS: Record<CatalogIssueKind, string> = {
  new_item_missing_code: '新品待补货号',
  brush_pending: '两刷子待确认',
  source_scope_unresolved: '来源范围未解析',
  source_identity_review: '来源记录待复核',
  source_identity_suspended: '来源记录已暂停',
  new_item_review: '分类待复核',
  new_item_pending_association: '观测未关联商品',
  product_source_review: '来源资料待核对',
  source_formula_errors: '飞书原表生产工厂公式错误',
  source_formula_fixed: '飞书工厂资料已修好',
  source_formula_unreadable: '飞书工厂资料未读到',
};

const KIND_ORDER: Record<CatalogIssueKind, number> = {
  new_item_missing_code: 0,
  brush_pending: 1,
  source_scope_unresolved: 2,
  source_identity_review: 3,
  source_identity_suspended: 4,
  new_item_review: 5,
  new_item_pending_association: 6,
  product_source_review: 7,
  source_formula_errors: 8,
  source_formula_fixed: 8,
  source_formula_unreadable: 8,
};

const ALL_KINDS = Object.keys(KIND_ORDER) as CatalogIssueKind[];

const SOURCE_SYSTEM_LABELS: Record<string, string> = {
  bigseller: 'BigSeller',
  jushuitan: '聚水潭',
  feishu: '飞书',
};

const ENTITY_KIND_LABELS: Record<string, string> = {
  product_record: '商品记录',
  sku_record: 'SKU 记录',
};

export function issueKindLabel(kind: CatalogIssueKind): string {
  return CATALOG_ISSUE_KIND_LABELS[kind];
}

export function issueModuleLabel(module: CatalogIssueModule): string {
  if (module === 'source_identity') return '来源核实';
  if (module === 'new_item') return '持续新品';
  if (module === 'product_source') return '飞书商品资料';
  return '商品库';
}

export function sourceSystemLabel(sourceSystem: string | null): string {
  if (!sourceSystem) return '未标注';
  return SOURCE_SYSTEM_LABELS[sourceSystem] ?? '未标注';
}

function entityKindLabel(entityKind: string): string {
  return ENTITY_KIND_LABELS[entityKind] ?? '来源记录';
}

/* ── 入口链接（V3-05：全部带安全返回点，不嵌套/不自循环） ─────────── */

/** 商品详情弹窗入口：保留商品上下文，默认返回到待处理索引。 */
export function catalogDetailHref(itemId: string, from: string | undefined = ISSUES_RETURN_HREF): string {
  return appendReturnContext(`/dashboard/catalog?detail=${encodeURIComponent(itemId)}`, from);
}

/** 旧来源处理页入口（历史保留记录不再以此作为“处理”入口，仅供来源核实/旧链兼容使用）。 */
export function legacySourceHref(itemId: string, from: string | undefined = ISSUES_RETURN_HREF): string {
  return appendReturnContext(`/dashboard/catalog/sources?item=${encodeURIComponent(itemId)}`, from);
}

/** 来源范围入口。 */
export function sourceScopeHref(scopeId: string, from: string | undefined = ISSUES_RETURN_HREF): string {
  return appendReturnContext(`/dashboard/catalog/sources?scope=${encodeURIComponent(scopeId)}`, from);
}

/** 来源记录入口：范围 + 原记录定位 + 返回点。 */
export function sourceRecordHref(
  scopeId: string,
  recordId: string,
  from: string | undefined = ISSUES_RETURN_HREF,
): string {
  return appendReturnContext(
    `/dashboard/catalog/sources?scope=${encodeURIComponent(scopeId)}&record=${encodeURIComponent(recordId)}`,
    from,
  );
}

/** 新品来源范围入口。 */
export function intakeScopeHref(scopeId: string, from: string | undefined = ISSUES_RETURN_HREF): string {
  return appendReturnContext(`/dashboard/catalog/intake?scope=${encodeURIComponent(scopeId)}`, from);
}

/** 新品观测入口：范围 + 原观测定位 + 返回点。 */
export function intakeObservationHref(
  scopeId: string,
  observationId: string,
  from: string | undefined = ISSUES_RETURN_HREF,
): string {
  return appendReturnContext(
    `/dashboard/catalog/intake?scope=${encodeURIComponent(scopeId)}&observation=${encodeURIComponent(observationId)}`,
    from,
  );
}

/** 飞书商品资料入口：打开现有来源面板并定位到对应事项，同时保留返回待处理的点。 */
export function productSourceReviewHref(
  issueId: string,
  from: string | undefined = ISSUES_RETURN_HREF,
): string {
  const base = `/dashboard/catalog/sources?issue=${encodeURIComponent(issueId)}`;
  return `${appendReturnContext(base, from)}#product-source-issue-${encodeURIComponent(issueId)}`;
}

/* ── 事项构造（业务文案；技术谓词只在 predicate 字段） ───────────── */

function withTargetHref(issue: Omit<CatalogIssue, 'targetHref'>): CatalogIssue {
  return { ...issue, targetHref: issue.actionHref ?? issue.referenceHref ?? '/dashboard/catalog' };
}

function newItemIssue(fact: UncodedNewItemFact): CatalogIssue {
  return withTargetHref({
    key: `new_item_missing_code:${fact.itemId}`,
    kind: 'new_item_missing_code',
    module: 'catalog',
    itemId: fact.itemId,
    iceCode: null,
    nameCn: fact.nameCn,
    summary: `已确认的新品尚未补录 ICE 货号（当前资料第 ${fact.revision} 版）。`,
    reason: '该商品尚无正式货号，需要人工补录。',
    differences: [],
    actionLabel: '补录货号',
    referenceLabel: null,
    stateLabel: '待补货号',
    action: 'available',
    actionNote: '在商品详情的「编辑资料」中补录 ICE 货号。',
    actionHref: catalogDetailHref(fact.itemId),
    referenceHref: null,
    closure: 'defined',
    closureNote: '补录后当前资料版本已有货号，本事项随事实变化自动消失。',
    permissionLabel: '需要商品资料写入权限（管理员）',
    predicate: `new_product_confirmed = true 且当前资料版本 r${fact.revision} 无货号`,
    recordRef: fact.evidenceRef ?? null,
    scopeRef: null,
  });
}

function brushIssue(fact: BrushPendingFact, pairReason: string): CatalogIssue {
  const source = sourceSystemLabel(fact.sourceSystem);
  const keepSeparate = fact.doNotMerge ? '明确不合并、分列保留' : '分列保留';
  return withTargetHref({
    key: `brush_pending:${fact.decisionId}`,
    kind: 'brush_pending',
    module: 'catalog',
    itemId: fact.itemId,
    iceCode: fact.iceCode,
    nameCn: fact.nameCn,
    summary: `「${fact.nameCn}」的两刷子资料在历史记录中${keepSeparate}（来源 ${source}），当时未合并。`,
    reason: pairReason,
    differences: [],
    actionLabel: '查看资料',
    referenceLabel: '查看资料',
    stateLabel: '待业务确认',
    action: 'none',
    actionNote: '该记录属不可修改的历史保留事实，确认与合并方式仍待业务定义。',
    actionHref: null,
    referenceHref: catalogDetailHref(fact.itemId),
    closure: 'pending_definition',
    closureNote: '关闭依据待业务定义：需后续提供可核对的确认方式后才会消失。',
    permissionLabel: '仅查看（当前无维护动作）',
    predicate: "历史保留记录，状态为 pending_confirmation",
    recordRef: `${fact.rawRef} · decision:${fact.decisionId}`,
    scopeRef: null,
  });
}

function scopeIssue(scope: SourceScopeFact, module: CatalogIssueModule): CatalogIssue {
  return withTargetHref({
    key: `source_scope_unresolved:${scope.scopeId}`,
    kind: 'source_scope_unresolved',
    module,
    itemId: null,
    iceCode: null,
    nameCn: scope.displayName,
    summary: `来源范围「${scope.displayName}」（${sourceSystemLabel(scope.system)}）尚未完成身份解析，当前不能据此核实来源。`,
    reason: '来源范围尚未解析，暂时不能据此核对来源。',
    differences: [],
    actionLabel: '查看范围',
    referenceLabel: '查看范围',
    stateLabel: '未解析',
    action: 'none',
    actionNote: '该范围记录不可修改，解析方式仍待业务定义。',
    actionHref: null,
    referenceHref: module === 'new_item' ? intakeScopeHref(scope.scopeId) : sourceScopeHref(scope.scopeId),
    closure: 'pending_definition',
    closureNote: '关闭依据待业务定义：需后续提供范围解析能力后才会消失。',
    permissionLabel: '仅查看（当前无维护动作）',
    predicate: "范围记录状态为 unresolved",
    recordRef: null,
    scopeRef: scope.scopeId,
  });
}

function identityRecordIssue(record: SourceIdentityRecordFact): CatalogIssue {
  const reviewing = record.state === 'review_required';
  return withTargetHref({
    key: `source_identity_record:${record.recordId}`,
    kind: reviewing ? 'source_identity_review' : 'source_identity_suspended',
    module: 'source_identity',
    itemId: null,
    iceCode: null,
    nameCn: `${record.scopeDisplayName} · ${entityKindLabel(record.entityKind)}`,
    summary: reviewing
      ? `来源范围「${record.scopeDisplayName}」有一条身份记录处于待复核状态（第 ${record.revision} 版）。`
      : `来源范围「${record.scopeDisplayName}」有一条身份记录已暂停（第 ${record.revision} 版），需要核实后恢复。`,
    reason: reviewing
      ? '有一条来源记录等待复核。'
      : '有一条来源记录已暂停，需要核实后恢复。',
    differences: [],
    actionLabel: reviewing ? '去复核' : '恢复记录',
    referenceLabel: null,
    stateLabel: reviewing ? '待复核' : '已暂停',
    action: 'available',
    actionNote: reviewing
      ? '在来源核实工作区中对原记录执行复核动作。'
      : '在来源核实工作区中对原记录执行恢复（复核）动作。',
    actionHref: sourceRecordHref(record.scopeId, record.recordId),
    referenceHref: null,
    closure: 'defined',
    closureNote: reviewing
      ? '复核完成、记录恢复到有效状态后自动消失；若被撤销则以“已结束”离开本列表。'
      : '记录恢复为有效状态或被撤销后自动消失。',
    permissionLabel: '需要来源身份维护权限（管理员）',
    predicate: `身份记录状态为 ${record.state}`,
    recordRef: `source_record:${record.recordId}`,
    scopeRef: record.scopeId,
  });
}

function observationReviewIssue(observation: NewItemObservationFact): CatalogIssue {
  const title = observation.nameHint ?? `${observation.scopeDisplayName} · 来源观测`;
  return withTargetHref({
    key: `new_item_observation:${observation.observationId}`,
    kind: 'new_item_review',
    module: 'new_item',
    itemId: observation.originItemId,
    iceCode: null,
    nameCn: title,
    summary: `来源观测「${title}」的最新分类被标记为待复核，确认前不改动商品资料。`,
    reason: '来源观测的分类等待复核。',
    differences: [],
    actionLabel: '重新分类',
    referenceLabel: null,
    stateLabel: '待复核',
    action: 'available',
    actionNote: '在持续新品工作区中重新分类该来源观测（或确认当前分类）。',
    actionHref: intakeObservationHref(observation.scopeId, observation.observationId),
    referenceHref: null,
    closure: 'defined',
    closureNote: '该观测的最新分类不再处于待复核状态后自动消失。',
    permissionLabel: '需要持续新品维护权限（管理员）',
    predicate: '该观测最新分类状态为 needs_review',
    recordRef: `product_observation:${observation.observationId}`,
    scopeRef: observation.scopeId,
  });
}

function observationAssociationIssue(observation: NewItemObservationFact): CatalogIssue {
  const title = observation.nameHint ?? `${observation.scopeDisplayName} · 来源观测`;
  return withTargetHref({
    key: `new_item_observation:${observation.observationId}`,
    kind: 'new_item_pending_association',
    module: 'new_item',
    itemId: null,
    iceCode: null,
    nameCn: title,
    summary: `来源观测「${title}」已提出分类建议，但尚未建档或关联到商品。`,
    reason: '来源观测已提出分类建议，但还没有建档或关联商品。',
    differences: [],
    actionLabel: '确认建档或关联',
    referenceLabel: null,
    stateLabel: '待建档或关联',
    action: 'available',
    actionNote: '在持续新品工作区中确认建档，或关联到既有商品。',
    actionHref: intakeObservationHref(observation.scopeId, observation.observationId),
    referenceHref: null,
    closure: 'defined',
    closureNote: '完成建档或关联后自动消失；若转入待复核，会以“分类待复核”事项继续跟踪。',
    permissionLabel: '需要持续新品维护与发布权限（管理员）',
    predicate: '该观测最新分类为建议状态且尚未建档/关联',
    recordRef: `product_observation:${observation.observationId}`,
    scopeRef: observation.scopeId,
  });
}

/** 同号多行的事项文案与逐行差异（行号与值都来自既有事项 detail，不写死示例）。 */
function duplicateIssueCopy(fact: ProductSourceIssueFact): { reason: string; differences: string[] } {
  const fields = fact.duplicate?.fields ?? [];
  const valuesByRow = new Map<number, number>();
  for (const field of fields) {
    for (const value of field.values) valuesByRow.set(value.rowNumber, (valuesByRow.get(value.rowNumber) ?? 0) + 1);
  }
  const rows = fact.rows.length > 0
    ? fact.rows
    : [...valuesByRow.keys()].sort((left, right) => left - right);
  const labels = [...new Set([
    ...fact.fieldLabels,
    ...fields.map((field) => field.fieldLabel),
  ].filter((label) => label.trim() !== ''))];
  const labelsText = labels.length > 0 ? labels.join('、') : '资料';
  const rowCountText = rows.length === 2 ? '两行' : '多行';
  const reason = `同一货号有${rowCountText}，${labelsText}不一致，请选择以后采用哪行资料。`;
  const differences = fields
    .map((field) => {
      const parts = rows.map((rowNumber) => {
        const entry = field.values.find((value) => value.rowNumber === rowNumber);
        const empty = !entry || entry.empty || entry.value.trim() === '';
        return `第${rowNumber}行：${empty ? '未填写' : entry.value.trim()}`;
      });
      if (parts.length === 0) return null;
      return `${fields.length > 1 ? `${field.fieldLabel}：` : ''}${parts.join('；')}。`;
    })
    .filter((line): line is string => line !== null);
  return { reason, differences };
}

function productSourceCopy(fact: ProductSourceIssueFact): { reason: string; differences: string[] } {
  if (fact.kind === 'duplicate_code_inconsistent') return duplicateIssueCopy(fact);
  const candidateCode = fact.sourceCodeCandidate?.sourceCode ?? null;
  if (candidateCode) {
    return {
      reason: `飞书已补充货号 ${candidateCode}，请确认用于这款商品。`,
      differences: [`正式货号：未填写 → ${candidateCode}`],
    };
  }
  const fieldsText = fact.fieldLabels.join('、');
  switch (fact.kind) {
    case 'missing_code':
      return fact.itemId
        ? { reason: '该商品尚无正式货号，需要人工确认后补录。', differences: [] }
        : { reason: '来源行没有正式货号，需要人工核对后补录。', differences: [] };
    case 'missing_code_candidate':
      return {
        reason: `来源缺码行与现有商品「${fact.nameCn ?? '同名商品'}」可能相同，需要人工确认是否为同一商品后再补号。`,
        differences: [],
      };
    case 'invalid_value':
    case 'formula_error':
    case 'invalid_carton_quantity':
    case 'unit_unconfirmed':
      return {
        reason: fieldsText ? `${fieldsText}不能按来源原值直接采用，需要人工核对。` : '来源字段值不能直接采用，需要人工核对。',
        differences: [],
      };
    case 'field_conflict':
    case 'field_group_conflict':
      return {
        reason: fieldsText
          ? `本地与来源同时修改了${fieldsText}，需要人工确认保留哪个值。`
          : '本地与来源同时修改了资料，需要人工确认保留哪个值。',
        differences: [],
      };
    case 'suspected_code_change':
      return { reason: '来源货号与现有商品的对应关系需要人工确认。', differences: [] };
    case 'capture_incomplete':
    case 'header_contract_invalid':
      return { reason: '本批来源读取不完整，需要人工查看批次。', differences: [] };
    case 'missing_row':
      return { reason: '本次来源中没有该商品，需要人工确认是否已经下架。', differences: [] };
    default:
      return {
        reason: `${fact.kindLabel}，需要人工核对。`,
        differences: [],
      };
  }
}

function productSourceActionLabel(kind: string, fact: ProductSourceIssueFact): string {
  if (kind === 'duplicate_code_inconsistent') return '选择采用行';
  if ((kind === 'missing_code' || kind === 'missing_code_candidate') && fact.sourceCodeCandidate) return '确认采用此货号';
  if (kind === 'missing_code' || kind === 'missing_code_candidate') return '确认并补货号';
  if (kind === 'capture_incomplete' || kind === 'header_contract_invalid') return '查看批次';
  if (kind === 'suspected_code_change') return '核对货号';
  if (kind === 'missing_row') return '核对商品';
  return '核对并处理';
}

/**
 * 同号多行的两个真实候选行：每个来源行号 + 每个差异字段的一行真实值。
 * 值全部来自既有事项 detail，不写死示例；例：
 *   第 63 行 →「商品条码未填写」，第 128 行 →「商品条码 757577407380」。
 */
function duplicateCandidateRows(fact: ProductSourceIssueFact): CatalogIssueSourceCandidateRow[] {
  const fields = fact.duplicate?.fields ?? [];
  if (fields.length === 0) return [];
  const rowNumbers = new Set<number>(fact.rows);
  for (const field of fields) {
    for (const value of field.values) rowNumbers.add(value.rowNumber);
  }
  return [...rowNumbers]
    .sort((left, right) => left - right)
    .map((rowNumber) => ({
      rowNumber,
      fieldLines: fields.map((field) => {
        const entry = field.values.find((value) => value.rowNumber === rowNumber);
        const empty = !entry || entry.empty || entry.value.trim() === '';
        return empty ? `${field.fieldLabel}未填写` : `${field.fieldLabel} ${entry.value.trim()}`;
      }),
    }));
}

/** 来源事项的弹窗投影：商品版本、规格文本、同号多行候选与候选货号（只读）。 */
function productSourceReview(fact: ProductSourceIssueFact): CatalogIssueSourceReview {
  return {
    issueId: fact.issueId,
    kind: fact.kind,
    itemRevision: fact.itemRevision ?? null,
    specificationText: (fact.specificationText ?? '').trim() || '规格未填写',
    candidateRows: fact.kind === 'duplicate_code_inconsistent' ? duplicateCandidateRows(fact) : [],
    candidateCode: fact.sourceCodeCandidate?.sourceCode ?? null,
  };
}

function productSourceIssue(
  fact: ProductSourceIssueFact,
  moduleFacts: ProductSourceModuleFacts,
): CatalogIssue {
  const rowsText = fact.rows.length ? `来源第 ${fact.rows.join('、')} 行` : '来源行号未记录';
  const fieldsText = fact.fieldLabels.length ? `问题字段：${fact.fieldLabels.join('、')}；` : '';
  const title = fact.nameCn
    ?? fact.iceCode
    ?? (fact.rows.length ? `来源第 ${fact.rows.join('、')} 行` : '来源待核对行');
  const { reason, differences } = productSourceCopy(fact);
  const detail: CatalogIssueDetail = {
    fieldLabels: fact.fieldLabels,
    rows: fact.rows,
    sourceHref: moduleFacts.sourceHref,
    sourceLabel: moduleFacts.sourceLabel,
    productHref: fact.itemId ? catalogDetailHref(fact.itemId) : null,
    fixGuidance: fact.itemId
      ? '修正入口：先在「飞书原表」核对来源行，或在商品资料修正本地值；改完后到「数据同步 → 飞书商品资料」重新读取并应用本批。'
      : '修正入口：先在飞书原表补齐或修正该行，再到「数据同步 → 飞书商品资料」重新读取并应用本批；系统不按名称自动建档或合并。',
    resolveNote: '只关闭本条来源待核对事项，不改写商品资料；商品资料仍以最近一次「已采用」批次为准。',
  };
  return withTargetHref({
    key: `product_source_review:${fact.issueId}`,
    kind: 'product_source_review',
    module: 'product_source',
    itemId: fact.itemId,
    iceCode: fact.iceCode,
    nameCn: title,
    summary: `来源「${moduleFacts.sourceLabel}」${rowsText}：${fact.kindLabel}${fieldsText ? `（${fieldsText.replace(/；$/, '')}）` : ''}；未自动改写商品资料。`,
    reason,
    differences,
    actionLabel: productSourceActionLabel(fact.kind, fact),
    referenceLabel: null,
    stateLabel: '待核对',
    action: 'available',
    actionNote: '打开「飞书商品资料」核对来源行：可重新读取、应用本批或标记已处理；标记已处理只关闭事项，不改写商品资料。',
    actionHref: productSourceReviewHref(fact.issueId),
    referenceHref: fact.itemId ? catalogDetailHref(fact.itemId) : null,
    closure: 'defined',
    closureNote: '在飞书原表修正并重新读取、采用后，或人工核对后标记已处理，本事项从待处理消失；标记已处理不改写商品资料。',
    permissionLabel: '需要商品资料/来源维护权限（管理员）',
    predicate: `来源待核对事项处于待核对状态（${fact.kind}）`,
    recordRef: `product_source_issue:${fact.issueId}`,
    scopeRef: null,
    detail,
    sourceReview: productSourceReview(fact),
  });
}

/* ── 派生 ─────────────────────────────────────────────────── */

/** 两条刷子历史事项共用一句话讲清“分别保留、是否同款未确认”的关系。 */
function brushPairReason(facts: BrushPendingFact[]): string {
  if (facts.length === 0) return '';
  const labels = facts.map((fact) => fact.iceCode ?? fact.nameCn);
  const joined = labels.length === 1
    ? labels[0]!
    : `${labels.slice(0, -1).join('、')} 与 ${labels[labels.length - 1]}`;
  const countText = labels.length === 2 ? '两款' : '多款';
  const stillUnconfirmed = facts.some((fact) => fact.doNotMerge);
  return stillUnconfirmed
    ? `${joined} 暂按${countText}分别保留，是否同款尚未确认。`
    : `${joined} 已按${countText}分别保留。`;
}

/** 一条既有事实一条事项；同一商品/范围可有多条事项。 */
export function buildCatalogIssues(facts: CatalogIssueFacts): CatalogIssue[] {
  // 同一个商品的“缺货号”只显示一次：商品来源已建立 item 级“货号待确认”时，
  // 不再重复生成新品缺货号事项（两者是同一事实的两个投影）。
  const productSourcePendingItemIds = new Set(
    (facts.moduleFacts?.productSource?.issues ?? [])
      .filter((issue) => issue.kind === 'missing_code' && issue.itemId !== null)
      .map((issue) => issue.itemId as string),
  );
  const brushReason = brushPairReason(facts.brushPending);
  const issues: CatalogIssue[] = [
    ...facts.uncodedNewItems
      .filter((item) => !productSourcePendingItemIds.has(item.itemId))
      .map(newItemIssue),
    ...facts.brushPending.map((fact) => brushIssue(fact, brushReason)),
  ];

  // 范围事项：两个模块共用同一份来源范围列表，按范围去重，优先归到来源核实模块。
  const seenScopeIds = new Set<string>();
  for (const scope of facts.moduleFacts?.sourceIdentity?.scopes ?? []) {
    if (scope.scopeState !== 'unresolved' || seenScopeIds.has(scope.scopeId)) continue;
    seenScopeIds.add(scope.scopeId);
    issues.push(scopeIssue(scope, 'source_identity'));
  }
  for (const scope of facts.moduleFacts?.newItem?.scopes ?? []) {
    if (scope.scopeState !== 'unresolved' || seenScopeIds.has(scope.scopeId)) continue;
    seenScopeIds.add(scope.scopeId);
    issues.push(scopeIssue(scope, 'new_item'));
  }

  for (const record of facts.moduleFacts?.sourceIdentity?.records ?? []) {
    issues.push(identityRecordIssue(record));
  }

  for (const observation of facts.moduleFacts?.newItem?.observations ?? []) {
    if (!observation.classification) continue; // 未分类观测：无既有规则依据，明确未覆盖（见 coverage.uncovered）
    if (observation.reviewState === 'needs_review') {
      issues.push(observationReviewIssue(observation));
      continue;
    }
    if (observation.reviewState === 'proposed' && !observation.originItemId) {
      issues.push(observationAssociationIssue(observation));
    }
  }

  // 飞书商品资料的来源待核对事项：只投影既有 open 事项，不新增审批/已读状态。
  const productSource = facts.moduleFacts?.productSource;
  if (productSource) {
    for (const issue of productSource.issues) issues.push(productSourceIssue(issue, productSource));
  }

  return issues.sort((left, right) => (
    KIND_ORDER[left.kind] - KIND_ORDER[right.kind]
    || left.nameCn.localeCompare(right.nameCn, 'zh-Hans-CN')
    || left.key.localeCompare(right.key)
  ));
}

/** 去重商品数：按 itemId 去重（未关联商品的事项不计入），不把事项条数当商品数。 */
export function dedupeItemCount(issues: CatalogIssue[]): number {
  return new Set(issues.map((issue) => issue.itemId).filter((itemId): itemId is string => Boolean(itemId))).size;
}

/** 未关联商品的来源范围/记录事项数。 */
export function unlinkedIssueCount(issues: CatalogIssue[]): number {
  return issues.filter((issue) => !issue.itemId).length;
}

export function countIssuesByKind(issues: CatalogIssue[]): Record<CatalogIssueKind, number> {
  const counts = Object.fromEntries(ALL_KINDS.map((kind) => [kind, 0])) as Record<CatalogIssueKind, number>;
  for (const issue of issues) counts[issue.kind] += 1;
  return counts;
}

export function countIssuesForItem(issues: CatalogIssue[], itemId: string): number {
  return issues.filter((issue) => issue.itemId === itemId).length;
}

export type CatalogIssueOkIndex = Extract<CatalogIssueIndex, { state: 'ok' }>;

/** 是否真正的空态：三项计数都为 0。1 条未关联事项不是空态。 */
export function isEmptyIssueIndex(index: CatalogIssueOkIndex): boolean {
  return index.issueCount === 0 && index.itemCount === 0 && index.unlinkedCount === 0;
}

export function buildCatalogIssueIndex(
  facts: CatalogIssueFacts,
  coverage: CatalogIssueCoverage,
  generatedAt: string,
): CatalogIssueOkIndex {
  const issues = buildCatalogIssues(facts);
  return {
    state: 'ok',
    items: issues,
    issueCount: issues.length,
    itemCount: dedupeItemCount(issues),
    unlinkedCount: unlinkedIssueCount(issues),
    coverage,
    generatedAt,
  };
}

/**
 * 列表工具栏 / 经营总览投影：**与「待处理」弹窗、商品库徽标同一份数据**
 * （都来自 buildCatalogPendingItems），不再使用包含刷子历史的索引条数，
 * 避免总览写 7 项、点进去只有 5 项这种对不上的情况。
 * 无问题时不制造警报，未授权时不显示任何计数。
 */
export function buildCatalogIssueToolbarModel(
  index: CatalogIssueIndex,
  extraItemCount = 0,
  suppressedItemCount = 0,
): CatalogIssueToolbarModel {
  if (index.state === 'ok') {
    const pending = buildCatalogPendingItems(index.items);
    // extraItemCount 供“快照派生但不进入问题索引”的合并事项（如飞书原表生产工厂公式错误）追加计数，
    // suppressedItemCount 是被该合并事项吸收、不再逐条显示的同类来源事项数；
    // 保证总览/徽标与弹窗/待处理页 items 数一致。
    const extra = Number.isFinite(extraItemCount) && extraItemCount > 0
      ? Math.trunc(extraItemCount)
      : 0;
    const suppressed = Number.isFinite(suppressedItemCount) && suppressedItemCount > 0
      ? Math.trunc(suppressedItemCount)
      : 0;
    return {
      state: 'ok',
      issueCount: Math.max(0, pending.length - suppressed + extra),
      itemCount: new Set(pending.map((item) => item.itemId).filter((itemId): itemId is string => Boolean(itemId))).size,
    };
  }
  if (index.state === 'read_failed') return { state: 'read_failed', message: index.error };
  return { state: 'forbidden' };
}

/**
 * 「待处理」弹窗 / 待处理页的可操作清单投影（唯一取数口径）：
 * - 刷子历史（brush_pending，仅查看）不进入清单与徽标数量，改在对应商品详情查看；
 * - 只保留页面可展示字段与服务端动作所需标识；不含跳旧来源面板/来源页的 actionHref。
 */
export function buildCatalogPendingItems(issues: CatalogIssue[]): CatalogPendingItem[] {
  return issues
    .filter((issue) => issue.kind !== 'brush_pending')
    .map((issue) => ({
      key: issue.key,
      kind: issue.kind,
      sourceKind: issue.sourceReview?.kind ?? null,
      issueId: issue.sourceReview?.issueId ?? null,
      itemId: issue.itemId,
      itemRevision: issue.sourceReview?.itemRevision ?? null,
      nameCn: issue.nameCn,
      iceCode: issue.iceCode,
      specificationText: issue.sourceReview?.specificationText ?? '规格未填写',
      reason: issue.reason,
      differences: issue.differences,
      candidateRows: issue.sourceReview?.candidateRows ?? [],
      candidateCode: issue.sourceReview?.candidateCode ?? null,
      fieldLabels: issue.detail?.fieldLabels ?? [],
      referenceHref: issue.referenceHref,
    }));
}
