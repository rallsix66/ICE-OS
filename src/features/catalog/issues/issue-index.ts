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
  CatalogIssueIndex,
  CatalogIssueKind,
  CatalogIssueModule,
  CatalogIssueToolbarModel,
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

/** 只读事实集合：现役商品库事实 + 已启用模块的既有状态。 */
export type CatalogIssueFacts = {
  uncodedNewItems: UncodedNewItemFact[];
  brushPending: BrushPendingFact[];
  moduleFacts?: {
    newItem?: NewItemModuleFacts | null;
    sourceIdentity?: SourceIdentityModuleFacts | null;
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
};

const KIND_ORDER: Record<CatalogIssueKind, number> = {
  new_item_missing_code: 0,
  brush_pending: 1,
  source_scope_unresolved: 2,
  source_identity_review: 3,
  source_identity_suspended: 4,
  new_item_review: 5,
  new_item_pending_association: 6,
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

function brushIssue(fact: BrushPendingFact): CatalogIssue {
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

/* ── 派生 ─────────────────────────────────────────────────── */

/** 一条既有事实一条事项；同一商品/范围可有多条事项。 */
export function buildCatalogIssues(facts: CatalogIssueFacts): CatalogIssue[] {
  const issues: CatalogIssue[] = [
    ...facts.uncodedNewItems.map(newItemIssue),
    ...facts.brushPending.map(brushIssue),
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

/** 列表工具栏投影：无问题时不制造警报，未授权时不显示任何计数。 */
export function buildCatalogIssueToolbarModel(index: CatalogIssueIndex): CatalogIssueToolbarModel {
  if (index.state === 'ok') {
    return { state: 'ok', issueCount: index.issueCount, itemCount: index.itemCount };
  }
  if (index.state === 'read_failed') return { state: 'read_failed', message: index.error };
  return { state: 'forbidden' };
}
