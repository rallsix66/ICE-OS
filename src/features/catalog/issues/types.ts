/**
 * 商品库「待处理」只读问题索引 — 对外契约（issues-nav 维护）。
 *
 * 只把**既有**事实/既有模块状态投影为事项：不新增审批流程、已读/忽略状态、长期绑定或 schema。
 * 每条事项必须给出：触发事实（内部 predicate，仅技术层/测试使用）、去重键、可见权限、
 * 现役动作（有则给处理入口；没有则如实写“当前无处理入口”）、关闭依据（未定义时如实写“待业务定义”）。
 * 业务文案不得包含表名、状态码、内部谓词、模块内部编号（N1A/N1C）或 fixture/schema 等工程说明。
 */

export type CatalogIssueKind =
  /** 现役商品库：已确认新品且当前资料版本缺 ICE 货号（有现役补录动作）。 */
  | 'new_item_missing_code'
  /** 现役商品库：两刷子历史保留记录（不可修改的历史事实，当前无处理入口）。 */
  | 'brush_pending'
  /** 来源范围未解析（不可修改的范围记录，当前无处理入口）。 */
  | 'source_scope_unresolved'
  /** 来源核实：来源身份记录待复核（有现役复核/恢复动作）。 */
  | 'source_identity_review'
  /** 来源核实：来源身份记录已暂停（有现役恢复动作）。 */
  | 'source_identity_suspended'
  /** 持续新品：来源观测的分类待复核（有现役重新分类动作）。 */
  | 'new_item_review'
  /** 持续新品：来源观测已分类但尚未建档/关联商品（有现役确认动作）。 */
  | 'new_item_pending_association';

export type CatalogIssueModule = 'catalog' | 'new_item' | 'source_identity';

/** 现役动作：`available` 有真实处理页；`none` 当前没有处理入口（不得虚构按钮）。 */
export type CatalogIssueActionState = 'available' | 'none';

/** 关闭依据：`defined` 有可核对的关闭事实；`pending_definition` 业务定义仍待确认。 */
export type CatalogIssueClosureState = 'defined' | 'pending_definition';

/** 单条待处理事项（一条既有事实一条事项，不做推断式聚合）。 */
export type CatalogIssue = {
  /** 稳定去重键：来自既有记录身份，不使用随机值或行号。 */
  key: string;
  kind: CatalogIssueKind;
  module: CatalogIssueModule;
  /** 关联商品；未关联商品的来源范围/记录事项为 null。 */
  itemId: string | null;
  iceCode: string | null;
  /** 事项标题：商品名 / 范围名 / 观测名称摘要。 */
  nameCn: string;
  /** 业务摘要（不含表名、状态码、内部谓词）。 */
  summary: string;
  /** 短状态（业务用语，如“待补货号”“待业务确认”“待复核”）。 */
  stateLabel: string;
  /** 是否有现役处理动作。 */
  action: CatalogIssueActionState;
  /** 现役动作说明；无处理入口时如实说明“当前无处理入口 + 原因”。 */
  actionNote: string;
  /** 有现役动作时的处理页（带安全返回点）；无动作为 null。 */
  actionHref: string | null;
  /** 只读参考入口（相关商品/范围，带安全返回点）；没有则 null。 */
  referenceHref: string | null;
  /** 关闭依据是否已定义。 */
  closure: CatalogIssueClosureState;
  /** 关闭依据（真实；未定义时写明“待业务定义”，不得承诺不存在的动作）。 */
  closureNote: string;
  /** 可见权限（业务用语，不出现权限码）。 */
  permissionLabel: string;
  /** 兼容入口：= actionHref ?? referenceHref（供既有视图/测试使用）。 */
  targetHref: string;
  /** 内部触发谓词：仅技术层与单元测试使用，不在业务文案渲染。 */
  predicate: string;
  /** 原记录引用（技术层/复核用，不在业务文案渲染）。 */
  recordRef: string | null;
  /** 原来源范围身份（技术层/复核用，不在业务文案渲染）。 */
  scopeRef: string | null;
};

/** 模块覆盖状态：未启用/无权/失败不得写成 0 项或“已查全”。 */
export type CatalogIssueModuleStatus =
  | 'covered'
  | 'partial'
  | 'disabled'
  | 'forbidden'
  | 'unavailable'
  | 'read_failed';

export type CatalogIssueModuleCoverage = {
  key: 'new_item' | 'source_identity';
  enabled: boolean;
  status: CatalogIssueModuleStatus;
  label: string;
  /** 本模块已纳入的既有状态（业务用语）。 */
  covered: string[];
  /** 明确未覆盖项（没有既有规则依据的不能猜）。 */
  uncovered: string[];
};

/** 覆盖边界：现役模块未启用/无权/失败时不得写成“0 项”或“已查全”。 */
export type CatalogIssueCoverage = {
  modules: CatalogIssueModuleCoverage[];
  note: string;
};

/** 集中问题索引导出（服务端只读派生）。 */
export type CatalogIssueIndex =
  | {
    state: 'ok';
    items: CatalogIssue[];
    /** 事项数（items.length）。 */
    issueCount: number;
    /** 去重商品数（itemId 非空去重）。 */
    itemCount: number;
    /** 未关联商品的来源范围/记录事项数。 */
    unlinkedCount: number;
    coverage: CatalogIssueCoverage;
    generatedAt: string;
  }
  | { state: 'read_failed'; error: string; coverage: CatalogIssueCoverage }
  | { state: 'forbidden'; error: string };

/** 列表工具栏入口的最小投影；无问题时不制造警报。 */
export type CatalogIssueToolbarModel =
  | { state: 'ok'; issueCount: number; itemCount: number }
  | { state: 'read_failed'; message: string }
  | { state: 'forbidden' }
  | null;
