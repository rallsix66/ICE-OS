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
  | 'new_item_pending_association'
  /** 飞书商品资料：来源待核对事项（可定位货号/问题字段/来源行，可标记已处理）。 */
  | 'product_source_review'
  /** 飞书原表：生产工厂列公式错误（合并一条展示，只读；原表修好后自动消失）。 */
  | 'source_formula_errors'
  /** 飞书原表：工厂资料已修好，等待确认更新（一条提示，确认采用后消失）。 */
  | 'source_formula_fixed'
  /** 飞书原表：这次没读到最新快照，不能确认工厂资料是否已修好（一条提示）。 */
  | 'source_formula_unreadable';

export type CatalogIssueModule = 'catalog' | 'new_item' | 'source_identity' | 'product_source';

/** 现役动作：`available` 有真实处理页；`none` 当前没有处理入口（不得虚构按钮）。 */
export type CatalogIssueActionState = 'available' | 'none';

/** 关闭依据：`defined` 有可核对的关闭事实；`pending_definition` 业务定义仍待确认。 */
export type CatalogIssueClosureState = 'defined' | 'pending_definition';

/**
 * 来源待核对事项的定位信息（只对需要修正的来源事项提供）。
 * 只描述既有事实：问题字段、来源行、原表/商品入口与修正后的重新读取、采用步骤。
 */
export type CatalogIssueDetail = {
  /** 问题字段（中文业务标签）；空数组表示没有具体字段（如来源缺码）。 */
  fieldLabels: string[];
  /** 来源行号（来源快照中的 1-based 行号）；空数组表示没有行号。 */
  rows: number[];
  /** 飞书原表地址（外部链接）；没有配置来源地址时为 null。 */
  sourceHref: string | null;
  /** 来源位置说明（如「ICE产品库 · Sheet1」）；未知为 null。 */
  sourceLabel: string | null;
  /** 商品资料入口（站内，带安全返回点）；没有对应商品时为 null。 */
  productHref: string | null;
  /** 修正后的重新读取、采用步骤。 */
  fixGuidance: string;
  /** 「标记已处理」的语义说明：只关闭事项，不改写商品资料。 */
  resolveNote: string;
};

/**
 * 同号多行的一条真实来源行（来源快照里的行号 + 每个差异字段的真实值）。
 * 只用于「待处理」弹窗让人当场选择，不写死示例：值全部来自既有事项 detail。
 */
export type CatalogIssueSourceCandidateRow = {
  rowNumber: number;
  /** 每个差异字段一行，例如「商品条码未填写」「商品条码 757577407380」。 */
  fieldLines: string[];
};

/** 来源待核对事项在「待处理」弹窗里可直接确认的投影（只读字段 + 动作所需标识）。 */
export type CatalogIssueSourceReview = {
  /** 来源待核对事项标识（confirm 动作的 issueId；不在业务正文展示）。 */
  issueId: string;
  /** 来源事项类型（duplicate_code_inconsistent / missing_code 等，仅技术分流）。 */
  kind: string;
  /** 补号动作需要的当前商品版本；读不到时为 null（不允许提交）。 */
  itemRevision: number | null;
  /** 商品规格文本；读不到时为「规格未填写」。 */
  specificationText: string;
  /** 同号多行的两个真实候选行；非同一号多行时为空数组。 */
  candidateRows: CatalogIssueSourceCandidateRow[];
  /** 最新来源已读到的候选正式货号；没有时为 null。 */
  candidateCode: string | null;
};

/**
 * 飞书原表「生产工厂」列公式错误的一条明细（只读证据）。
 * 单元格与错误原文都来自最近一次成功读取的快照，不在页面重算。
 */
export type CatalogFormulaErrorRow = {
  /** 来源货号（G 列原文）；空为 null。 */
  iceCode: string | null;
  /** 来源品名（B 列原文）；空为 null。 */
  nameCn: string | null;
  /** 单元格位置，如 E3。 */
  cell: string;
  /** 单元格错误原文，如 #REF!。 */
  error: string;
};

/** 飞书原表「生产工厂」公式错误分组（合并展示的一条待处理）。 */
export type CatalogFormulaErrorGroup = {
  /** 出错业务行数。 */
  count: number;
  /** 最近一次成功读取快照的时间（展示用）。 */
  capturedAtDisplay: string;
  /** 逐行明细（货号/品名/单元格/错误原文）。 */
  rows: CatalogFormulaErrorRow[];
};

/**
 * 「待处理」弹窗的单项投影：只含页面可展示字段。
 * 不含跳旧来源面板/来源页的链接（弹窗内不再出现 actionHref）。
 */
export type CatalogPendingItem = {
  key: string;
  kind: CatalogIssueKind;
  /** 来源事项类型；非来源事项为 null。 */
  sourceKind: string | null;
  issueId: string | null;
  itemId: string | null;
  itemRevision: number | null;
  nameCn: string;
  iceCode: string | null;
  /** 商品规格文本；读不到时为「规格未填写」。 */
  specificationText: string;
  reason: string;
  differences: string[];
  candidateRows: CatalogIssueSourceCandidateRow[];
  /** 缺货号时飞书已补充的候选货号。 */
  candidateCode: string | null;
  /** 来源事项的问题字段中文名（用于与合并事项去重；非来源事项为空数组）。 */
  fieldLabels: string[];
  /** 只读的「在商品详情查看」定位；没有对应商品时为 null。 */
  referenceHref: string | null;
  /** 飞书原表「生产工厂」公式错误分组（仅 source_formula_errors 项有值）。 */
  formulaErrors?: CatalogFormulaErrorGroup | null;
  /** 工厂资料提示的读取状态（仅 source_formula_fixed / source_formula_unreadable 项有值）。 */
  formulaState?: 'fixed' | 'unreadable' | null;
  /** 工厂资料提示的主按钮文案（仅上述两项有值；如「查看更新」「检查更新」）。 */
  formulaActionLabel?: string | null;
};

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
  /** 直接讲清原因的一句话（正常正文展示，不使用浅色小字）。 */
  reason: string;
  /** 需要人工判断的具体差异（逐行/逐字段）；没有差异时为空数组。 */
  differences: string[];
  /** 处理按钮的具体动作文案（不再统一写“去处理”）。 */
  actionLabel: string;
  /** 只读参考入口（如“查看资料”）的文案；没有参考入口时为 null。 */
  referenceLabel: string | null;
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
  /** 来源待核对事项的定位与修正说明；其它事项没有该字段。 */
  detail?: CatalogIssueDetail;
  /** 来源待核对事项的弹窗可操作投影（商品、版本、候选行/候选货号）；其它事项没有该字段。 */
  sourceReview?: CatalogIssueSourceReview;
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
  key: 'new_item' | 'source_identity' | 'product_source';
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
