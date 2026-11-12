import 'server-only';

import { requireCatalogAdmin } from '../authorization';
import { catalogRepository } from '../repository';
import {
  buildCatalogIssueIndex,
  buildCatalogIssueToolbarModel,
  buildCatalogPendingItems,
  type CatalogIssueOkIndex,
  type NewItemModuleFacts,
  type ProductSourceModuleFacts,
  type SourceIdentityModuleFacts,
} from './issue-index';
import { classifyCatalogReadFailure } from './entry-state';
import {
  readNewItemModuleFacts,
  readProductSourceModuleFacts,
  readSourceIdentityModuleFacts,
  type ModuleRead,
  type ModuleReadStatus,
} from './module-facts';
import { readFactoryFormulaErrorState, SOURCE_PROFILE } from '../product-source/service';
import type { FactoryFormulaErrorReadState } from '../product-source/service';
import { readCatalogIssueFacts } from './repository';
import type {
  CatalogFormulaErrorGroup,
  CatalogIssueCoverage,
  CatalogIssueIndex,
  CatalogIssueModuleCoverage,
  CatalogIssueToolbarModel,
  CatalogPendingItem,
} from './types';

type CoverageModuleKey = 'new_item' | 'source_identity' | 'product_source';

/** 各模块已纳入的既有状态（业务用语，与逐类能力表一一对应）。 */
const COVERED_ITEMS: Record<CoverageModuleKey, string[]> = {
  new_item: [
    '来源观测的分类待复核',
    '已分类但尚未建档或关联商品的来源观测',
    '来源范围未解析',
  ],
  source_identity: [
    '来源身份记录待复核',
    '来源身份记录已暂停',
    '来源范围未解析',
  ],
  product_source: [
    '飞书商品资料的来源待核对事项（可定位货号、问题字段与来源行）',
    '来源同号多行不一致、字段值非法、来源缺码等既有待核对项',
  ],
};

/** 明确未覆盖项（业务用语）：没有既有规则依据的不能猜，逐个兜住。 */
const UNCOVERED_NOTES: Record<CoverageModuleKey, string[]> = {
  new_item: [
    '尚未分类的来源观测：既有规则未规定它是否算待办，暂不纳入（待业务确认）。',
    '来源候选冲突与外部规则差异：不进入待办。',
    '来源文件本身是否读取成功不是待处理事项。',
  ],
  source_identity: [
    '已撤销的来源记录：视为已结束，不进入待办。',
    '来源操作历史：是已发生动作的记录，不是待处理事项。',
    '历史保留的人工选择快照：只读历史事实，不进入待办。',
    '正式长期来源关系：尚未启用，不纳入。',
    '被驳回、忽略或判为规则外的记录：不重新变成待办。',
  ],
  product_source: [
    '图片引用与受限价格列不属于待处理事项：图片只作来源证据，价格只进受限私有表，页面不展示、不采用。',
    '定时读取本身是否成功不是待处理事项：读取状态在「数据同步 → 飞书商品资料」显示，失败不当作没有变化。',
    '「标记已处理」只关闭来源待核对事项，不改写商品资料；已处理/已忽略的事项不再进入待办。',
  ],
};

function statusLabel(moduleKey: CoverageModuleKey, read: ModuleRead<unknown>): string {
  if (moduleKey === 'product_source') {
    const sourceIssues = (read.facts as ProductSourceModuleFacts | null)?.issues.length ?? null;
    switch (read.status) {
      case 'disabled':
        return '飞书商品资料当前未接入（来源表尚未安装）：本页未读取其待核对事项，不计为 0 项。';
      case 'covered':
        return `飞书商品资料已接入：读取到 ${sourceIssues ?? '未知'} 条待核对事项（可定位货号、问题字段与来源行）。`;
      case 'partial':
        return '飞书商品资料已接入：只读取到部分来源范围，未读取的部分不计为 0 项。';
      case 'forbidden':
        return '飞书商品资料已接入，但当前账号没有读取权限：不显示其待核对事项，也不计为 0 项。';
      case 'unavailable':
        return '飞书商品资料当前不可用（独立平台运行环境未就绪）：未读取待核对事项，不计为 0 项。';
      default:
        return '飞书商品资料读取失败（网络、传输或环境异常）：未读入待核对事项，这不等于 0 项。';
    }
  }
  const moduleName = moduleKey === 'new_item' ? '持续新品资料' : '来源身份核实';
  switch (read.status) {
    case 'disabled':
      return `${moduleName}当前未启用：本页未读取该模块的现有状态，不计为 0 项。`;
    case 'covered':
      return `${moduleName}已启用并读取 ${read.readScopeCount} 个授权范围的现有状态。`;
    case 'partial':
      return `${moduleName}已启用：读取 ${read.readScopeCount} 个授权范围；另有 ${read.deniedScopeCount} 个范围无读取权限、${read.failedScopeCount} 个范围读取失败，未计入。`;
    case 'forbidden':
      return `${moduleName}已启用，但当前账号对其来源范围没有读取权限：不显示其事项，也不计为 0 项。`;
    case 'unavailable':
      return `${moduleName}已启用，但隔离运行环境未就绪：未读取事项，不计为 0 项。`;
    default:
      return `${moduleName}读取失败（网络、传输或环境异常）：未读入其事项，这不等于 0 项。`;
  }
}

function moduleCoverage(
  moduleKey: CoverageModuleKey,
  read: ModuleRead<unknown>,
  enabled: boolean,
): CatalogIssueModuleCoverage {
  const status: ModuleReadStatus = read.status;
  return {
    key: moduleKey,
    enabled,
    status,
    label: statusLabel(moduleKey, read),
    covered: status === 'covered' || status === 'partial' ? COVERED_ITEMS[moduleKey] : [],
    uncovered: UNCOVERED_NOTES[moduleKey],
  };
}

export function buildCatalogIssueCoverage(
  newItemRead: ModuleRead<NewItemModuleFacts>,
  sourceRead: ModuleRead<SourceIdentityModuleFacts>,
  productSourceRead: ModuleRead<ProductSourceModuleFacts>,
): CatalogIssueCoverage {
  return {
    modules: [
      moduleCoverage('new_item', newItemRead, newItemRead.status !== 'disabled'),
      moduleCoverage('source_identity', sourceRead, sourceRead.status !== 'disabled'),
      moduleCoverage('product_source', productSourceRead, productSourceRead.status !== 'disabled'),
    ],
    note:
      '只读汇总：基于商品库当前资料与已启用模块的现有状态（新品缺货号、两刷子历史保留、'
      + '来源范围与记录状态、来源观测的分类与关联状态、飞书商品资料的来源待核对事项）。'
      + '未启用、无读取权限、读取失败或未覆盖的部分不计为 0 项，也不代表已查全。'
      + '候选冲突、外部规则差异、已结束记录、未建档资料与普通字段缺失不进入待处理。'
      + '本索引不新增审批状态、已读/忽略状态或长期绑定；历史保留记录与未解析范围不可修改，'
      + '这两类保留事项并如实标注“当前无处理入口 / 关闭依据待业务定义”。'
      + '来源待核对事项可定位货号、问题字段与来源行；「标记已处理」只关闭事项，不改写商品资料。',
  };
}

/** 核心读取失败时的保守覆盖：已启用模块标记为未读入，绝不写成已覆盖或 0 项。 */
function failureCoverage(
  newItemRead: ModuleRead<NewItemModuleFacts>,
  sourceRead: ModuleRead<SourceIdentityModuleFacts>,
  productSourceRead: ModuleRead<ProductSourceModuleFacts>,
  forcedStatus: 'read_failed' | 'forbidden',
): CatalogIssueCoverage {
  const force = <T>(read: ModuleRead<T>): ModuleRead<T> => (
    read.status === 'disabled' ? read : { ...read, status: forcedStatus, facts: null }
  );
  return buildCatalogIssueCoverage(force(newItemRead), force(sourceRead), force(productSourceRead));
}

/** 集中问题索引的只读投影；四态：ok / read_failed / forbidden（零项是 ok 的子情形）。 */
export async function getCatalogIssueIndex(): Promise<CatalogIssueIndex> {
  const [newItemRead, sourceRead, productSourceRead] = await Promise.all([
    readNewItemModuleFacts().catch((): ModuleRead<NewItemModuleFacts> => ({
      status: 'read_failed', facts: null, readScopeCount: 0, deniedScopeCount: 0, failedScopeCount: 0, failureKind: 'read_failed',
    })),
    readSourceIdentityModuleFacts().catch((): ModuleRead<SourceIdentityModuleFacts> => ({
      status: 'read_failed', facts: null, readScopeCount: 0, deniedScopeCount: 0, failedScopeCount: 0, failureKind: 'read_failed',
    })),
    readProductSourceModuleFacts().catch((): ModuleRead<ProductSourceModuleFacts> => ({
      status: 'read_failed', facts: null, readScopeCount: 0, deniedScopeCount: 0, failedScopeCount: 0, failureKind: 'read_failed',
    })),
  ]);
  const coverage = buildCatalogIssueCoverage(newItemRead, sourceRead, productSourceRead);
  try {
    const identity = await requireCatalogAdmin();
    const core = await readCatalogIssueFacts(identity);
    const ok: CatalogIssueOkIndex = buildCatalogIssueIndex({
      ...core,
      moduleFacts: {
        newItem: newItemRead.facts,
        sourceIdentity: sourceRead.facts,
        productSource: productSourceRead.facts,
      },
    }, coverage, new Date().toISOString());
    return ok;
  } catch (error) {
    const kind = classifyCatalogReadFailure(error);
    if (kind === 'unavailable') {
      return { state: 'forbidden', error: '商品库当前未启用（本地独立资料环境未连接）。' };
    }
    if (kind === 'forbidden') {
      return { state: 'forbidden', error: '账号没有访问权限，或所请求的待处理索引不存在。' };
    }
    return {
      state: 'read_failed',
      error: '读取失败（网络、传输或环境异常），可重试。',
      coverage: failureCoverage(newItemRead, sourceRead, productSourceRead, 'read_failed'),
    };
  }
}

/**
 * 待处理清单的唯一取数口径：来源待核对事项投影 + 快照派生的合并事项。
 *
 * 飞书原表「生产工厂」公式错误按最近一次成功读取的结果分三种：
 * - errors：仍公式错误 → 合并成一条展示，逐条来源事项被吸收；
 * - clean：成功读到零个公式错误，且上一批仍登记着工厂待办 → 只显示一条
 *   「飞书工厂资料已修好，等待确认更新」（确认采用后旧待办退出，提示随之消失）；
 * - unavailable：**这次没有读到快照**（不是读到 0）→ 只显示一条「暂时无法确认」，
 *   绝不把读取失败写成已修好。
 *
 * 其它字段的公式错误仍逐条保留。
 */
function buildPendingItems(
  index: CatalogIssueOkIndex,
  factoryState: FactoryFormulaErrorReadState,
): { items: CatalogPendingItem[]; suppressedCount: number; appendedCount: number } {
  const base = buildCatalogPendingItems(index.items);
  const factoryItems = base.filter(isFactoryFormulaIssue);
  const kept = base.filter((item) => !isFactoryFormulaIssue(item));
  if (factoryState.state === 'errors') {
    return {
      items: [...kept, factoryFormulaErrorItem(factoryState.group)],
      suppressedCount: factoryItems.length,
      appendedCount: 1,
    };
  }
  if (factoryState.state === 'clean' && factoryItems.length > 0) {
    return {
      items: [...kept, factoryFormulaFixedItem(factoryState.capturedAtDisplay, factoryItems.length)],
      suppressedCount: factoryItems.length,
      appendedCount: 1,
    };
  }
  if (factoryState.state === 'unavailable' && factoryItems.length > 0) {
    return {
      items: [...kept, factoryFormulaUnreadableItem(factoryItems.length)],
      suppressedCount: factoryItems.length,
      appendedCount: 1,
    };
  }
  return { items: base, suppressedCount: 0, appendedCount: 0 };
}

/** 是否「生产工厂」公式错误的逐条来源事项（Save 之后数据库会登记这些逐条事项）。 */
function isFactoryFormulaIssue(item: CatalogPendingItem): boolean {
  return item.sourceKind === 'formula_error'
    && item.fieldLabels.some((label) => label.includes('生产工厂'));
}

export async function getCatalogIssueToolbarModel(): Promise<CatalogIssueToolbarModel> {
  const [index, factoryState] = await Promise.all([
    getCatalogIssueIndex(),
    readFactoryFormulaErrorState(),
  ]);
  if (index.state !== 'ok') return buildCatalogIssueToolbarModel(index);
  const { appendedCount, suppressedCount } = buildPendingItems(index, factoryState);
  return buildCatalogIssueToolbarModel(index, appendedCount, suppressedCount);
}

/** 「待处理」弹窗/待处理页用的只读投影：商品、规格、真实候选行与确认所需标识（不含旧来源页链接）。 */
export type CatalogPendingPreviewItem = CatalogPendingItem;

export type CatalogPendingPreview =
  | {
    state: 'ok';
    /** 可当场处理的事项数（= 弹窗行数 = 商品库徽标 = 经营总览数字）。 */
    issueCount: number;
    itemCount: number;
    items: CatalogPendingItem[];
    /** 只在商品详情查看的刷子历史条数（不计入 issueCount；页面可单独说明）。 */
    brushCount: number;
  }
  | { state: 'read_failed' }
  | { state: 'forbidden' };

/** 「飞书原表生产工厂公式错误」合并事项的稳定键（一条快照一批错误合并展示）。 */
const FACTORY_FORMULA_ERROR_KEY = 'source_formula_errors:factory';

/** 「飞书工厂资料已修好，等待确认更新」的稳定键（确认采用前只显示这一条）。 */
const FACTORY_FORMULA_FIXED_KEY = 'source_formula_fixed:factory';

/** 「这次没读到快照」的稳定键（与“读到 0 个错误”区分开）。 */
const FACTORY_FORMULA_UNREADABLE_KEY = 'source_formula_unreadable:factory';

/** 飞书原表「生产工厂」公式错误 → 一条可展开的只读待处理项。 */
function factoryFormulaErrorItem(group: CatalogFormulaErrorGroup): CatalogPendingItem {
  return {
    key: FACTORY_FORMULA_ERROR_KEY,
    kind: 'source_formula_errors',
    sourceKind: null,
    issueId: null,
    itemId: null,
    itemRevision: null,
    nameCn: '飞书原表「生产工厂」',
    iceCode: null,
    specificationText: '',
    reason: `飞书原表「生产工厂」有 ${group.count} 个公式错误（#REF!），这批更新里这些商品的工厂资料不会被采用；请先在原表修好，再回数据同步「检查更新 → 确认更新」。`,
    differences: [],
    candidateRows: [],
    candidateCode: null,
    fieldLabels: ['生产工厂'],
    referenceHref: SOURCE_PROFILE.sourceUrl,
    formulaErrors: group,
  };
}

/**
 * 已成功读到零个公式错误、但上一批仍登记着工厂待办：
 * 只显示一条「已修好，等待确认更新」，按钮直达数据同步的商品库更新弹窗。
 */
function factoryFormulaFixedItem(capturedAtDisplay: string, pendingCount: number): CatalogPendingItem {
  return {
    key: FACTORY_FORMULA_FIXED_KEY,
    kind: 'source_formula_fixed',
    sourceKind: null,
    issueId: null,
    itemId: null,
    itemRevision: null,
    nameCn: '飞书工厂资料已修好，等待确认更新',
    iceCode: null,
    specificationText: '',
    reason: `最新一次读取（${capturedAtDisplay}）里，生产工厂列已经没有公式错误；上一批登记的 ${pendingCount} 条工厂待办要等确认采用后才退出。`,
    differences: [],
    candidateRows: [],
    candidateCode: null,
    fieldLabels: ['生产工厂'],
    referenceHref: '/dashboard/sync?panel=product-update',
    formulaState: 'fixed',
    formulaActionLabel: '查看更新',
  };
}

/** 没读到快照（不是读到 0 个错误）：只说明无法确认，不写成已修好。 */
function factoryFormulaUnreadableItem(pendingCount: number): CatalogPendingItem {
  return {
    key: FACTORY_FORMULA_UNREADABLE_KEY,
    kind: 'source_formula_unreadable',
    sourceKind: null,
    issueId: null,
    itemId: null,
    itemRevision: null,
    nameCn: '飞书工厂资料暂时无法确认',
    iceCode: null,
    specificationText: '',
    reason: `这次没有读到飞书原表的最新内容，暂时不能确认工厂资料是否已修好；上一批还有 ${pendingCount} 条工厂待办，请先点「检查更新」重新读取。`,
    differences: [],
    candidateRows: [],
    candidateCode: null,
    fieldLabels: ['生产工厂'],
    referenceHref: '/dashboard/sync',
    formulaState: 'unreadable',
    formulaActionLabel: '检查更新',
  };
}

export async function getCatalogIssuePendingPreview(): Promise<CatalogPendingPreview> {
  const [index, factoryState] = await Promise.all([
    getCatalogIssueIndex(),
    // 只读本地最近一次成功读取的快照；读取失败与“读到 0 个错误”分开处理。
    readFactoryFormulaErrorState(),
  ]);
  if (index.state === 'read_failed') return { state: 'read_failed' };
  if (index.state === 'forbidden') return { state: 'forbidden' };
  // 刷子历史（仅查看）不进弹窗/徽标；其余事项逐条投影成可操作项；生产工厂公式错误合并成一条。
  const { items } = buildPendingItems(index, factoryState);
  const itemCount = new Set(
    items.map((item) => item.itemId).filter((itemId): itemId is string => Boolean(itemId)),
  ).size;
  return {
    state: 'ok',
    issueCount: items.length,
    itemCount,
    items,
    brushCount: index.items.filter((issue) => issue.kind === 'brush_pending').length,
  };
}

/** 商品识别信息（启用态旧入口页展示关联商品，不读金额、不带未授权范围内容）。 */
export async function getCatalogItemLabel(itemId?: string): Promise<string | null> {
  if (!itemId || !/^[a-f\d-]{36}$/i.test(itemId)) return null;
  try {
    const identity = await requireCatalogAdmin();
    const item = await catalogRepository.get(identity, itemId);
    return item ? `${item.iceCode ?? '待补货号'} · ${item.nameCn}` : null;
  } catch {
    return null;
  }
}

export type LegacyEntryItemContext = {
  /** 商品识别信息；读不到时为 null（不显示推测值）。 */
  label: string | null;
  /** 该商品在问题索引中的事项数；索引不可读时为 null（不写成 0）。 */
  issueCount: number | null;
};

/** 旧入口安全引导页的上下文：只在能真实读取时返回，读不到返回 null。 */
export async function getLegacyEntryItemContext(itemId?: string): Promise<LegacyEntryItemContext | null> {
  if (!itemId || !/^[a-f\d-]{36}$/i.test(itemId)) return null;
  const label = await getCatalogItemLabel(itemId);
  const index = await getCatalogIssueIndex();
  return {
    label,
    issueCount: index.state === 'ok' ? index.items.filter((issue) => issue.itemId === itemId).length : null,
  };
}
