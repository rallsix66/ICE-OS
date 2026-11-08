import 'server-only';

import { requireCatalogAdmin } from '@/features/catalog/authorization';
import { catalogRepository } from '@/features/catalog/repository';
import { adoptedUnitCostFromFinancial } from '@/features/catalog/local-display/adopted-price';
import { getInventoryDomesticSnapshot } from '@/features/inventory/server/domestic-reads';
import {
  getInventoryProductSummary,
  getInventorySyncOverview,
  getInventoryWarehouseStates,
  requireInventoryAdmin,
} from '@/features/inventory/server/reads';
import { runStatusDisplay } from '@/features/inventory/model';
import { getShipmentGroupingReviews, getShipmentHomeSummary, getShipmentSourceStatus } from '@/features/shipment/server/reads';
import type { InventoryProductSummaryRowDto, InventoryWarehouseReadStateV2Dto } from '@/features/inventory/types';
import type { ShipmentSourceStatusDto } from '@/features/shipment/types';
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
  /** 可计数的待处理总数（状态类事项不计入）。 */
  pendingCount: number;
  amountsVisible: boolean;
  costReadFailed: boolean;
  domesticAvailable: boolean;
  domesticReason: string | null;
  domesticFileDate: string | null;
  transitAvailable: boolean;
  transitError: string | null;
  transitTicketCount: number;
  transitItemCount: number;
  /** 同步页「待处理」总数与商品库存可处理范围的差额（已排除仓）。 */
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
  scopeUnmappedRows: number;
  mappingQueueTotal: number;
  reviewsPending: number | null;
  aggregate: HomeAggregateResult;
  overview: Awaited<ReturnType<typeof getInventorySyncOverview>> | null;
  sourceStatus: ShipmentSourceStatusDto | null;
  sourceError: string | null;
  transitAvailable: boolean;
  amountsVisible: boolean;
  costReadFailed: boolean;
}): HomePendingItem[] {
  const items: HomePendingItem[] = [];
  const { aggregate, overview, sourceStatus, reviewsPending } = input;

  if (overview && input.scopeUnmappedRows > 0) {
    const excludedExtra = Math.max(0, input.mappingQueueTotal - input.scopeUnmappedRows);
    items.push({
      key: 'inventory-unmapped',
      title: `${input.scopeUnmappedRows} 条来源 SKU 待对应`,
      detail: excludedExtra > 0
        ? `未对应数量保留、不计入商品合计；在商品库存「仓库明细」逐行确认（同步页「待处理」${input.mappingQueueTotal} 条含已排除仓 ${excludedExtra} 条，不在本页处理）。`
        : '未对应数量保留、不计入商品合计；在商品库存「仓库明细」逐行确认。',
      count: input.scopeUnmappedRows,
      href: '/dashboard/inventory?view=warehouse&source=overseas',
    });
  }

  if (reviewsPending !== null && reviewsPending > 0) {
    items.push({
      key: 'shipment-review',
      title: `${reviewsPending} 项拆票/合票待复核`,
      detail: '打开物流在途页工具栏「待复核」，按上次/本次分组确认。',
      count: reviewsPending,
      href: '/dashboard/in-transit',
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
      title: `${aggregate.stages.transit.excludedItems} 条在途明细未计入货值`,
      detail: parts ? `原因：${parts}；在货值汇总查看明细。` : '在货值汇总查看未计入明细。',
      count: aggregate.stages.transit.excludedItems,
      href: '/dashboard/in-transit?view=value',
    });
  }

  if (overview) {
    const lastRun = overview.lastRun;
    const lastRunLabel = runStateLabel(lastRun?.status);
    if (!overview.worker || !overview.worker.online) {
      items.push({
        key: 'inventory-worker-offline',
        title: '库存自动同步未运行',
        detail: overview.scopeLastAllSuccessAt
          ? `最近成功数据 ${overview.scopeLastAllSuccessAt.slice(0, 16).replace('T', ' ')}；后台启动后按计划继续。`
          : '后台未登记或已离线；启动后按计划继续。',
        count: null,
        href: '/dashboard/sync',
      });
    } else if (overview.account.status === 'needs_login') {
      items.push({
        key: 'inventory-needs-login',
        title: 'BigSeller 登录失效',
        detail: '自动同步暂停；人工重新登录后由后台探测恢复。',
        count: null,
        href: '/dashboard/sync',
      });
    } else if (!overview.settings.enabled) {
      items.push({
        key: 'inventory-disabled',
        title: '库存自动同步已关闭',
        detail: '计划不再执行；在数据同步页重新启用。',
        count: null,
        href: '/dashboard/sync',
      });
    } else if (lastRun && lastRunLabel && ['failed', 'partial', 'needs_login'].includes(lastRun.status)) {
      items.push({
        key: 'inventory-last-run',
        title: `最近一次库存同步${lastRun.status === 'partial' ? '部分失败' : '失败'}`,
        detail: `${lastRunLabel}${lastRun.errorCode ? `（${lastRun.errorCode}）` : ''}；保留已有成功批次，在数据同步页查看原因。`,
        count: null,
        href: '/dashboard/sync',
      });
    }
  } else {
    items.push({
      key: 'inventory-state-unreadable',
      title: '库存同步状态读取失败',
      detail: '无法确认后台与最近任务状态；到数据同步页重试。',
      count: null,
      href: '/dashboard/sync',
    });
  }

  if (sourceStatus) {
    const lastAttempt = sourceStatus.lastAttempt;
    if (lastAttempt?.status === 'failed') {
      items.push({
        key: 'shipment-read-failed',
        title: '物流在途最近一次读取失败',
        detail: `${lastAttempt.errorCode ?? '读取失败'}；保留上次成功数据，按计划重试。`,
        count: null,
        href: '/dashboard/sync',
      });
    }
    const reader = sourceStatus.autoReader;
    if (!reader) {
      items.push({
        key: 'shipment-reader-unknown',
        title: '在途自动读取状态不可用',
        detail: '状态读取失败；到数据同步页查看。',
        count: null,
        href: '/dashboard/sync',
      });
    } else if (!reader.workerOnline) {
      items.push({
        key: 'shipment-reader-offline',
        title: '在途自动读取未运行',
        detail: '后台读取进程未在线；启动后按 10 分钟计划继续。',
        count: null,
        href: '/dashboard/sync',
      });
    } else if (reader.lastResult === 'failed') {
      items.push({
        key: 'shipment-reader-failed',
        title: '在途自动读取最近一次失败',
        detail: `${reader.lastErrorCode ?? '读取失败'}；保留上次成功数据，按计划重试。`,
        count: null,
        href: '/dashboard/sync',
      });
    }
  } else {
    items.push({
      key: 'shipment-state-unreadable',
      title: '物流来源状态读取失败',
      detail: input.sourceError || '无法确认在途来源状态；到数据同步页重试。',
      count: null,
      href: '/dashboard/sync',
    });
  }

  if (input.amountsVisible && !input.costReadFailed && aggregate.valuation.missingCostProducts.length > 0) {
    items.push({
      key: 'inventory-missing-cost',
      title: `${aggregate.valuation.missingCostProducts.length} 款商品缺进货价`,
      detail: `涉及 ${aggregate.valuation.missingCostQuantity.toLocaleString('zh-CN')} 件已知数量（库存+在途）未计入估算货值；在商品库补充采用进货价。`,
      count: aggregate.valuation.missingCostProducts.length,
      href: '/dashboard/catalog',
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

  const [domesticSettled, overviewSettled, statesSettled, shipmentSettled, sourceSettled, reviewsSettled, costSettled] = await Promise.allSettled([
    getInventoryDomesticSnapshot(identity),
    getInventorySyncOverview(identity),
    getInventoryWarehouseStates(identity),
    getShipmentHomeSummary(),
    getShipmentSourceStatus(),
    getShipmentGroupingReviews(),
    amountsVisible ? catalogRepository.baselineAmountsMap(identity) : Promise.resolve(new Map()),
  ]);

  const domestic = domesticSettled.status === 'fulfilled' ? domesticSettled.value : null;
  const overview = overviewSettled.status === 'fulfilled' ? overviewSettled.value : null;
  const states = statesSettled.status === 'fulfilled' ? statesSettled.value : [];
  const shipment = shipmentSettled.status === 'fulfilled' ? shipmentSettled.value : null;
  const sourceStatus = sourceSettled.status === 'fulfilled' ? sourceSettled.value : null;
  const reviews = reviewsSettled.status === 'fulfilled' ? reviewsSettled.value : null;
  const costReadFailed = amountsVisible && costSettled.status === 'rejected';

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
    // 首页「待对应」用商品库存同一范围（022 unmapped 行，可逐行处理）；
    // 同步页「待处理」另含已排除仓，差额在页面文案说明。
    mappingQueueTotal: products.unmappedOverseasRows,
    marketLabels: MARKET_LABELS,
    domesticFileDate,
    overseasTime,
    transitTime,
  });

  const transitError = shipmentSettled.status === 'rejected'
    ? '在途来源读取失败，未显示在途数量与货值（可到数据同步页重试）'
    : null;

  const pending = buildPending({
    scopeUnmappedRows: products.unmappedOverseasRows,
    mappingQueueTotal: overview?.mappingQueueTotal ?? 0,
    reviewsPending: reviews ? reviews.pending.length : null,
    aggregate,
    overview,
    sourceStatus,
    sourceError: sourceSettled.status === 'rejected' ? '物流来源状态读取失败' : null,
    transitAvailable: Boolean(shipment),
    amountsVisible,
    costReadFailed,
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
    pendingCount: pending.reduce((sum, item) => sum + (item.count ?? 0), 0),
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
    excludedWarehouseUnmappedRows: Math.max(0, (overview?.mappingQueueTotal ?? 0) - products.unmappedOverseasRows),
    inventoryStateLabel,
    inventoryStateDetail,
    sourceError: sourceSettled.status === 'rejected' ? '物流来源状态读取失败' : null,
  };
}
