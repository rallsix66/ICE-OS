import 'server-only';

import { requireCatalogAdmin } from '@/features/catalog/authorization';
import { catalogRepository } from '@/features/catalog/repository';
import { getCatalogIssueToolbarModel } from '@/features/catalog/issues/service';
import { adoptedUnitCostFromFinancial } from '@/features/catalog/local-display/adopted-price';
import { getInventoryDomesticSnapshot } from '@/features/inventory/server/domestic-reads';
import {
  getInventoryProductSummary,
  getInventorySyncOverview,
  getInventoryWarehouseStates,
  requireInventoryAdmin,
} from '@/features/inventory/server/reads';
import { runStatusDisplay } from '@/features/inventory/model';
import type { PendingBindingsReadResult } from '@/features/inventory/pending-bindings';
import { getShipmentGroupingReviews, getShipmentHomeSummary, getShipmentSourceStatus } from '@/features/shipment/server/reads';
import type { InventoryProductSummaryRowDto, InventoryWarehouseReadStateV2Dto } from '@/features/inventory/types';
import type { ShipmentGroupingReviewsDto, ShipmentSourceStatusDto } from '@/features/shipment/types';
import { aggregateHome, type HomeAggregateResult } from '../aggregate';
import { MARKET_LABELS } from '../markets';
import type { HomePendingItem } from '../model';

/**
 * 经营总览首页服务端读取。
 *
 * 全部复用现有只读入口：国内冻结快照、商品汇总（按完整范围分页取全）、BigSeller 同步总览/
 * 逐仓状态、飞书在途市场汇总（028）、来源状态与拆合票复核、商品库批量采用进货价。
 * 首页不新增 SQL、不触发来源读取、不写任何表；金额只走 amount:read 权限。
 */

/** 商品汇总单次上限 200（RPC 限制）；按 total 分页取全，避免用可见页累加冒充总额。 */
const PRODUCT_PAGE_LIMIT = 200;
const PRODUCT_PAGE_MAX = 25;

export interface HomePageData {
  aggregate: HomeAggregateResult;
  pending: HomePendingItem[];
  /** 物流在途待复核数据（本页「需要处理」→物流分类当场打开同一复核弹窗）。 */
  groupingReviews: ShipmentGroupingReviewsDto | null;
  groupingReviewsError: string | null;
  amountsVisible: boolean;
  costReadFailed: boolean;
  domesticAvailable: boolean;
  domesticReason: string | null;
  domesticFileDate: string | null;
  transitAvailable: boolean;
  transitError: string | null;
  transitTicketCount: number;
  transitItemCount: number;
  /** 同步页「待处理」总数与商品库存可处理范围的差额（已排除仓）；读不到待绑定数量时为 0（不显示该补充说明）。 */
  excludedWarehouseUnmappedRows: number;
  inventoryStateLabel: string;
  inventoryStateDetail: string;
  sourceError: string | null;
}

async function loadAllProductSummary(identity: Awaited<ReturnType<typeof requireInventoryAdmin>>) {
  const rows: InventoryProductSummaryRowDto[] = [];
  let total = 0;
  let unmappedOverseasRows = 0;
  for (let page = 0; page < PRODUCT_PAGE_MAX; page += 1) {
    const dto = await getInventoryProductSummary(identity, {
      q: '',
      warehouse: 'all',
      market: 'all',
      limit: PRODUCT_PAGE_LIMIT,
      offset: page * PRODUCT_PAGE_LIMIT,
    });
    total = dto.total;
    unmappedOverseasRows = dto.unmappedOverseasRows;
    rows.push(...dto.rows);
    if (rows.length >= total || dto.rows.length === 0) break;
  }
  return { rows, total, unmappedOverseasRows };
}

/** 逐仓最近观测时间（优先观测时间，其次最近成功）。 */
function latestObservationAt(states: InventoryWarehouseReadStateV2Dto[]): string | null {
  let latest: string | null = null;
  for (const state of states) {
    const candidate = state.observationAt ?? state.lastSuccessAt;
    if (!candidate) continue;
    const time = Date.parse(candidate);
    if (!Number.isFinite(time)) continue;
    if (!latest || time > Date.parse(latest)) latest = candidate;
  }
  return latest;
}

function latestFileDate(fileDates: Array<{ fileDate: string }> | undefined): string | null {
  const dates = (fileDates ?? []).map((entry) => entry.fileDate).filter(Boolean).sort();
  return dates.length > 0 ? dates[dates.length - 1] : null;
}

function runStateLabel(status: string | null | undefined): string | null {
  if (!status) return null;
  const display = runStatusDisplay(status);
  return display?.label ?? null;
}

function buildPending(input: {
  /** 商品库存页同一份「待绑定商品」读取结果：数量必须与商品库存页待处理数字一致。 */
  pendingBindings: PendingBindingsReadResult;
  reviewsPending: number | null;
  reviewsError: boolean;
  aggregate: HomeAggregateResult;
  overview: Awaited<ReturnType<typeof getInventorySyncOverview>> | null;
  sourceStatus: ShipmentSourceStatusDto | null;
  sourceError: string | null;
  transitAvailable: boolean;
  amountsVisible: boolean;
  costReadFailed: boolean;
  /** 商品库待处理索引数量；null = 未读到（不补 0）。 */
  catalogIssueCount: number | null;
  catalogIssueError: boolean;
}): HomePendingItem[] {
  const items: HomePendingItem[] = [];
  const { aggregate, overview, sourceStatus, reviewsPending } = input;

  if (input.catalogIssueCount !== null && input.catalogIssueCount > 0) {
    items.push({
      key: 'catalog-issues',
      category: '商品资料',
      title: `${input.catalogIssueCount} 项商品资料待处理`,
      detail: '商品库待处理索引集中列出需要核对的商品、原因与具体操作。',
      countLabel: `${input.catalogIssueCount} 项`,
      href: '/dashboard/catalog?pending=open',
      action: 'link',
      actionLabel: '查看商品资料',
    });
  } else if (input.catalogIssueError) {
    items.push({
      key: 'catalog-issues-unreadable',
      category: '商品资料',
      title: '商品库待处理读取失败',
      detail: '没有读到商品库待处理数量，不显示为 0；可刷新本页重试。',
      countLabel: null,
      href: '/dashboard/catalog?pending=open',
      action: 'link',
      actionLabel: '查看商品资料',
    });
  }

  if (input.pendingBindings.state === 'ok') {
    if (input.pendingBindings.total > 0) {
      items.push({
        key: 'inventory-unmapped',
        category: '库存待对应',
        title: `${input.pendingBindings.total} 条来源 SKU 待对应`,
        detail: '未对应数量保留、不计入商品合计；在商品库存「仓库明细」逐条确认。',
        countLabel: `${input.pendingBindings.total} 条`,
        href: '/dashboard/inventory?view=warehouse&source=overseas&pending=open',
        action: 'link',
        actionLabel: '查看待绑定商品',
      });
    }
  } else {
    items.push({
      key: 'inventory-unmapped-unreadable',
      category: '库存待对应',
      title: '库存待对应数量读取失败',
      detail: input.pendingBindings.error,
      countLabel: null,
      href: '/dashboard/inventory?view=warehouse&source=overseas&pending=open',
      action: 'link',
      actionLabel: '查看待绑定商品',
    });
  }

  if (reviewsPending !== null && reviewsPending > 0) {
    items.push({
      key: 'shipment-review',
      category: '物流待复核',
      title: `${reviewsPending} 项拆票/合票待复核`,
      detail: '在本区块当场打开复核弹窗，按上次/本次分组确认。',
      countLabel: `${reviewsPending} 项`,
      href: '/dashboard/in-transit',
      action: 'review',
      actionLabel: '复核货票',
    });
  } else if (input.reviewsError) {
    items.push({
      key: 'shipment-review-unreadable',
      category: '物流待复核',
      title: '物流待复核读取失败',
      detail: '没有读到待复核数量，不显示为 0；打开复核弹窗可看失败原因，刷新后重试。',
      countLabel: null,
      href: '/dashboard/in-transit',
      action: 'review',
      actionLabel: '复核货票',
    });
  }

  if (input.transitAvailable && aggregate.stages.transit.excludedItems > 0) {
    const reasons = aggregate.valuation.transitExclusions;
    const parts = [
      reasons.unbound > 0 ? `未关联 ${reasons.unbound}` : null,
      reasons.quantityPending > 0 ? `数量待核 ${reasons.quantityPending}` : null,
      reasons.priceMissing > 0 ? `缺单价 ${reasons.priceMissing}` : null,
      reasons.reviewPending > 0 ? `待复核 ${reasons.reviewPending}` : null,
    ].filter(Boolean).join(' · ');
    items.push({
      key: 'transit-excluded',
      category: '在途未计入',
      title: `${aggregate.stages.transit.excludedItems} 条在途明细未计入货值`,
      detail: parts ? `原因：${parts}；在货值汇总查看明细。` : '在货值汇总查看未计入明细。',
      countLabel: `${aggregate.stages.transit.excludedItems} 条`,
      href: '/dashboard/in-transit?view=value&excluded=open',
      action: 'link',
      actionLabel: '查看未计入货票',
    });
  }

  if (overview) {
    const lastRun = overview.lastRun;
    const lastRunLabel = runStateLabel(lastRun?.status);
    if (!overview.worker || !overview.worker.online) {
      items.push({
        key: 'inventory-worker-offline',
        category: '同步状态',
        title: '库存自动同步未运行',
        detail: overview.scopeLastAllSuccessAt
          ? `最近成功数据 ${overview.scopeLastAllSuccessAt.slice(0, 16).replace('T', ' ')}；后台启动后按计划继续。`
          : '后台未登记或已离线；启动后按计划继续。',
        countLabel: null,
        href: '/dashboard/sync',
        action: 'link',
        actionLabel: '查看同步',
      });
    } else if (overview.account.status === 'needs_login') {
      items.push({
        key: 'inventory-needs-login',
        category: '同步状态',
        title: 'BigSeller 登录失效',
        detail: '自动同步暂停；人工重新登录后由后台探测恢复。',
        countLabel: null,
        href: '/dashboard/sync',
        action: 'link',
        actionLabel: '查看同步',
      });
    } else if (!overview.settings.enabled) {
      items.push({
        key: 'inventory-disabled',
        category: '同步状态',
        title: '库存自动同步已关闭',
        detail: '计划不再执行；在数据同步页重新启用。',
        countLabel: null,
        href: '/dashboard/sync',
        action: 'link',
        actionLabel: '查看同步',
      });
    } else if (lastRun && lastRunLabel && ['failed', 'partial', 'needs_login'].includes(lastRun.status)) {
      items.push({
        key: 'inventory-last-run',
        category: '同步状态',
        title: `最近一次库存同步${lastRun.status === 'partial' ? '部分失败' : '失败'}`,
        detail: `${lastRunLabel}${lastRun.errorCode ? `（${lastRun.errorCode}）` : ''}；保留已有成功批次，在数据同步页查看原因。`,
        countLabel: null,
        href: '/dashboard/sync',
        action: 'link',
        actionLabel: '查看同步',
      });
    }
  } else {
    items.push({
      key: 'inventory-state-unreadable',
      category: '同步状态',
      title: '库存同步状态读取失败',
      detail: '无法确认后台与最近任务状态；到数据同步页重试。',
      countLabel: null,
      href: '/dashboard/sync',
      action: 'link',
      actionLabel: '查看同步',
    });
  }

  if (sourceStatus) {
    const lastAttempt = sourceStatus.lastAttempt;
    if (lastAttempt?.status === 'failed') {
      items.push({
        key: 'shipment-read-failed',
        category: '同步状态',
        title: '物流在途最近一次读取失败',
        detail: `${lastAttempt.errorCode ?? '读取失败'}；保留上次成功数据，按计划重试。`,
        countLabel: null,
        href: '/dashboard/sync',
        action: 'link',
        actionLabel: '查看同步',
      });
    }
    const reader = sourceStatus.autoReader;
    if (!reader) {
      items.push({
        key: 'shipment-reader-unknown',
        category: '同步状态',
        title: '在途自动读取状态不可用',
        detail: '状态读取失败；到数据同步页查看。',
        countLabel: null,
        href: '/dashboard/sync',
        action: 'link',
        actionLabel: '查看同步',
      });
    } else if (!reader.workerOnline) {
      items.push({
        key: 'shipment-reader-offline',
        category: '同步状态',
        title: '在途自动读取未运行',
        detail: '后台读取进程未在线；启动后按 10 分钟计划继续。',
        countLabel: null,
        href: '/dashboard/sync',
        action: 'link',
        actionLabel: '查看同步',
      });
    } else if (reader.lastResult === 'failed') {
      items.push({
        key: 'shipment-reader-failed',
        category: '同步状态',
        title: '在途自动读取最近一次失败',
        detail: `${reader.lastErrorCode ?? '读取失败'}；保留上次成功数据，按计划重试。`,
        countLabel: null,
        href: '/dashboard/sync',
        action: 'link',
        actionLabel: '查看同步',
      });
    }
  } else {
    items.push({
      key: 'shipment-state-unreadable',
      category: '同步状态',
      title: '物流来源状态读取失败',
      detail: input.sourceError || '无法确认在途来源状态；到数据同步页重试。',
      countLabel: null,
      href: '/dashboard/sync',
      action: 'link',
      actionLabel: '查看同步',
    });
  }

  if (input.amountsVisible && !input.costReadFailed && aggregate.valuation.missingCostProducts.length > 0) {
    items.push({
      key: 'inventory-missing-cost',
      // 与「商品资料待处理」分开：这是缺进货价的商品，不是商品库待处理事项，
      // 避免总览出现两条都叫「商品资料」、看起来像 5+2=7 的误读。
      category: '缺价商品',
      title: `${aggregate.valuation.missingCostProducts.length} 款商品缺进货价`,
      detail: `涉及 ${aggregate.valuation.missingCostQuantity.toLocaleString('zh-CN')} 件已知数量（库存+在途）未计入估算货值；展开清单逐款核对。`,
      countLabel: `${aggregate.valuation.missingCostProducts.length} 款`,
      href: '/dashboard/catalog?pending=open',
      action: 'missing-cost',
      actionLabel: '查看缺价商品',
    });
  }

  return items;
}

export async function getBusinessOverviewData(): Promise<HomePageData> {
  const identity = await requireInventoryAdmin();

  // 金额列单独走 amount:read；无权限不读成本、不显示金额。
  let amountsVisible = false;
  try {
    await requireCatalogAdmin('amount:read');
    amountsVisible = true;
  } catch {
    amountsVisible = false;
  }

  let products: { rows: InventoryProductSummaryRowDto[]; total: number; unmappedOverseasRows: number };
  try {
    products = await loadAllProductSummary(identity);
  } catch (error) {
    // 商品汇总是首页数量的主来源：读不到时整页给明确失败态，不用 0 代替。
    throw new Error(`OVERVIEW_PRODUCT_SUMMARY_FAILED:${(error as Error)?.message ?? 'unknown'}`);
  }

  const [domesticSettled, overviewSettled, statesSettled, shipmentSettled, sourceSettled, reviewsSettled, costSettled, catalogIssuesSettled] = await Promise.allSettled([
    getInventoryDomesticSnapshot(identity),
    getInventorySyncOverview(identity),
    getInventoryWarehouseStates(identity),
    getShipmentHomeSummary(),
    getShipmentSourceStatus(),
    getShipmentGroupingReviews(),
    amountsVisible ? catalogRepository.baselineAmountsMap(identity) : Promise.resolve(new Map()),
    getCatalogIssueToolbarModel(),
  ]);

  const domestic = domesticSettled.status === 'fulfilled' ? domesticSettled.value : null;
  const overview = overviewSettled.status === 'fulfilled' ? overviewSettled.value : null;
  const states = statesSettled.status === 'fulfilled' ? statesSettled.value : [];
  const shipment = shipmentSettled.status === 'fulfilled' ? shipmentSettled.value : null;
  const sourceStatus = sourceSettled.status === 'fulfilled' ? sourceSettled.value : null;
  const reviews = reviewsSettled.status === 'fulfilled' ? reviewsSettled.value : null;
  const costReadFailed = amountsVisible && costSettled.status === 'rejected';
  // 商品库待处理：只有 state=ok 才有确定数量；未启用/无权限/读取失败都不补 0。
  const catalogIssues = catalogIssuesSettled.status === 'fulfilled' ? catalogIssuesSettled.value : null;
  const catalogIssueCount = catalogIssues?.state === 'ok' ? catalogIssues.issueCount : null;
  const catalogIssueError = catalogIssueCount === null;

  const costMap: Record<string, string> = {};
  if (amountsVisible && costSettled.status === 'fulfilled') {
    for (const [itemId, financial] of costSettled.value) {
      const cost = adoptedUnitCostFromFinancial(financial);
      if (cost.state === 'priced') costMap[itemId] = cost.amountCny;
    }
  }

  const domesticFileDate = latestFileDate(domestic?.fileDates);
  const overseasTime = latestObservationAt(states) ?? overview?.scopeLastAllSuccessAt ?? null;
  const transitTime = sourceStatus?.lastSuccess?.readAt ?? shipment?.latestReadAt ?? null;

  // 库存待对应数量：口径 = 商品库存页「待处理」的同一批「未对应来源行」（参与仓范围）。
  // 这里直接取商品汇总读取同时返回的 unmappedOverseasRows（同一 022 读模型、同一参与仓范围），
  // 不再为首页多跑一次 5 页待绑定队列（实测约 1s，会把首页从 ~1.1s 拖到 ~2.4s）；
  // 与商品库存页徽标（队列过滤后）实测同为 141，验收脚本会比对两页数字。
  const pendingBindings: PendingBindingsReadResult = overview && Number.isFinite(products.unmappedOverseasRows)
    ? { state: 'ok', rows: [], total: products.unmappedOverseasRows }
    : {
      state: 'read_failed',
      rows: [],
      total: null,
      error: '库存同步状态未读取，无法确认待绑定数量；可刷新本页重试。',
    };

  const aggregate = aggregateHome({
    amountsVisible,
    costUnavailable: costReadFailed,
    domestic,
    products: products.rows,
    costMap,
    transit: shipment?.summary ?? {
      market: null,
      unknownMarket: false,
      latestReadAt: null,
      snapshotId: null,
      ticketCount: 0,
      itemCount: 0,
      products: [],
      totalValueCny: null,
      pricedItemCount: 0,
      unpricedItemCount: 0,
      quantityPendingCount: 0,
      reviewPendingCount: 0,
      unboundItemCount: 0,
      excludedItemCount: 0,
      excludedByReason: { unbound: 0, quantityPending: 0, priceMissing: 0, reviewPending: 0 },
      excludedItems: [],
    },
    transitMarkets: shipment?.overview ?? {
      latestReadAt: null,
      snapshotId: null,
      marketCount: 0,
      ticketCount: 0,
      itemCount: 0,
      totalValueCny: null,
      pricedItemCount: 0,
      excludedItemCount: 0,
      markets: [],
    },
    transitItems: shipment?.items ?? [],
    // 估值说明里的「未对应来源行」与首页「库存待对应」同一口径（商品库存页待绑定读取）；
    // 待绑定读取失败时退回商品汇总同范围的 unmapped 数（仍是已知值，不写 0）。
    mappingQueueTotal: pendingBindings.state === 'ok' ? pendingBindings.total : products.unmappedOverseasRows,
    marketLabels: MARKET_LABELS,
    domesticFileDate,
    overseasTime,
    transitTime,
  });

  const transitError = shipmentSettled.status === 'rejected'
    ? '在途来源读取失败，未显示在途数量与货值（可到数据同步页重试）'
    : null;

  const pending = buildPending({
    pendingBindings,
    reviewsPending: reviews ? reviews.pending.length : null,
    reviewsError: reviewsSettled.status === 'rejected',
    aggregate,
    overview,
    sourceStatus,
    sourceError: sourceSettled.status === 'rejected' ? '物流来源状态读取失败' : null,
    transitAvailable: Boolean(shipment),
    amountsVisible,
    costReadFailed,
    catalogIssueCount,
    catalogIssueError,
  });

  const inventoryStateLabel = overview
    ? (!overview.worker || !overview.worker.online
      ? '库存自动同步未运行'
      : overview.account.status === 'needs_login'
        ? 'BigSeller 登录失效'
        : overview.settings.enabled
          ? '自动同步运行中'
          : '自动同步已关闭')
    : '库存同步状态读取失败';
  const inventoryStateDetail = overview?.scopeLastAllSuccessAt
    ? `最近成功数据 ${overview.scopeLastAllSuccessAt.slice(0, 16).replace('T', ' ')}`
    : '尚无成功数据记录';

  return {
    aggregate,
    pending,
    groupingReviews: reviews,
    groupingReviewsError: reviewsSettled.status === 'rejected' ? '物流待复核读取失败' : null,
    // 金额权限与成本读取状态分开：不要再把成本失败显示成「无金额权限」。
    amountsVisible,
    costReadFailed,
    domesticAvailable: Boolean(domestic?.available),
    domesticReason: domestic?.available ? null : (domestic?.reason ?? '国内冻结快照未读取'),
    domesticFileDate,
    transitAvailable: Boolean(shipment),
    transitError,
    transitTicketCount: shipment?.summary.ticketCount ?? 0,
    transitItemCount: shipment?.summary.itemCount ?? 0,
    // 同步页队列总数 − 商品库存可处理数 = 已排除仓；待绑定读取失败时无法得出，保持 0（页面不显示该补充句）。
    excludedWarehouseUnmappedRows: overview && pendingBindings.state === 'ok'
      ? Math.max(0, overview.mappingQueueTotal - pendingBindings.total)
      : 0,
    inventoryStateLabel,
    inventoryStateDetail,
    sourceError: sourceSettled.status === 'rejected' ? '物流来源状态读取失败' : null,
  };
}
