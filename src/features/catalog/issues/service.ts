import 'server-only';

import { requireCatalogAdmin } from '../authorization';
import { catalogRepository } from '../repository';
import {
  buildCatalogIssueIndex,
  buildCatalogIssueToolbarModel,
  type CatalogIssueOkIndex,
  type NewItemModuleFacts,
  type SourceIdentityModuleFacts,
} from './issue-index';
import { classifyCatalogReadFailure } from './entry-state';
import {
  readNewItemModuleFacts,
  readSourceIdentityModuleFacts,
  type ModuleRead,
  type ModuleReadStatus,
} from './module-facts';
import { readCatalogIssueFacts } from './repository';
import type {
  CatalogIssueCoverage,
  CatalogIssueIndex,
  CatalogIssueModuleCoverage,
  CatalogIssueToolbarModel,
} from './types';

/** 各模块已纳入的既有状态（业务用语，与逐类能力表一一对应）。 */
const COVERED_ITEMS: Record<'new_item' | 'source_identity', string[]> = {
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
};

/** 明确未覆盖项（业务用语）：没有既有规则依据的不能猜，逐个兜住。 */
const UNCOVERED_NOTES: Record<'new_item' | 'source_identity', string[]> = {
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
};

function statusLabel(moduleKey: 'new_item' | 'source_identity', read: ModuleRead<unknown>): string {
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
  moduleKey: 'new_item' | 'source_identity',
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
): CatalogIssueCoverage {
  return {
    modules: [
      moduleCoverage('new_item', newItemRead, newItemRead.status !== 'disabled'),
      moduleCoverage('source_identity', sourceRead, sourceRead.status !== 'disabled'),
    ],
    note:
      '只读汇总：基于商品库当前资料与已启用模块的现有状态（新品缺货号、两刷子历史保留、'
      + '来源范围与记录状态、来源观测的分类与关联状态）。'
      + '未启用、无读取权限、读取失败或未覆盖的部分不计为 0 项，也不代表已查全。'
      + '候选冲突、外部规则差异、已结束记录、未建档资料与普通字段缺失不进入待处理。'
      + '本索引不新增审批状态、已读/忽略状态或长期绑定；历史保留记录与未解析范围不可修改，'
      + '这两类保留事项并如实标注“当前无处理入口 / 关闭依据待业务定义”。',
  };
}

/** 核心读取失败时的保守覆盖：已启用模块标记为未读入，绝不写成已覆盖或 0 项。 */
function failureCoverage(
  newItemRead: ModuleRead<NewItemModuleFacts>,
  sourceRead: ModuleRead<SourceIdentityModuleFacts>,
  forcedStatus: 'read_failed' | 'forbidden',
): CatalogIssueCoverage {
  const force = <T>(read: ModuleRead<T>): ModuleRead<T> => (
    read.status === 'disabled' ? read : { ...read, status: forcedStatus, facts: null }
  );
  return buildCatalogIssueCoverage(force(newItemRead), force(sourceRead));
}

/** 集中问题索引的只读投影；四态：ok / read_failed / forbidden（零项是 ok 的子情形）。 */
export async function getCatalogIssueIndex(): Promise<CatalogIssueIndex> {
  const [newItemRead, sourceRead] = await Promise.all([
    readNewItemModuleFacts().catch((): ModuleRead<NewItemModuleFacts> => ({
      status: 'read_failed', facts: null, readScopeCount: 0, deniedScopeCount: 0, failedScopeCount: 0, failureKind: 'read_failed',
    })),
    readSourceIdentityModuleFacts().catch((): ModuleRead<SourceIdentityModuleFacts> => ({
      status: 'read_failed', facts: null, readScopeCount: 0, deniedScopeCount: 0, failedScopeCount: 0, failureKind: 'read_failed',
    })),
  ]);
  const coverage = buildCatalogIssueCoverage(newItemRead, sourceRead);
  try {
    const identity = await requireCatalogAdmin();
    const core = await readCatalogIssueFacts(identity);
    const ok: CatalogIssueOkIndex = buildCatalogIssueIndex({
      ...core,
      moduleFacts: { newItem: newItemRead.facts, sourceIdentity: sourceRead.facts },
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
      coverage: failureCoverage(newItemRead, sourceRead, 'read_failed'),
    };
  }
}

/**
 * 列表工具栏入口投影（供商品库接线使用，不得抛错）：
 * - 无问题只给 `issueCount: 0`，由列表决定是否显示入口，不制造警报；
 * - 读取失败给可重试提示；无权限不显示计数。
 */
export async function getCatalogIssueToolbarModel(): Promise<CatalogIssueToolbarModel> {
  const index = await getCatalogIssueIndex();
  return buildCatalogIssueToolbarModel(index);
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
