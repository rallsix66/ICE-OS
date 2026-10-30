import type { Metadata } from 'next';
import { ReadFailurePanel } from '@/features/inventory/components/display';
import { InventoryView } from '@/features/inventory/components/inventory-view';
import { domesticIncludedInScope, mergeProductSummary, mergeWarehouseRowsPage } from '@/features/inventory/dual-view';
import {
  classifyReadFailure,
  errorMessageOf,
  parseInventorySearchParams,
} from '@/features/inventory/model';
import {
  getInventoryItem,
  getInventoryProductSummary,
  getInventorySyncOverview,
  getInventoryWarehouseRows,
  getSourceBinding,
  requireInventoryAdmin,
} from '@/features/inventory/server/reads';
import { getInventoryDomesticSnapshot } from '@/features/inventory/server/domestic-reads';
import { requireCatalogAdmin } from '@/features/catalog/authorization';
import { catalogRepository } from '@/features/catalog/repository';
import { adoptedUnitCostFromFinancial } from '@/features/catalog/local-display/adopted-price';
import type {
  InventoryDomesticSnapshotDto,
  InventoryItemDetailDto,
  InventoryOverviewDto,
  InventoryProductSummaryDto,
  InventoryWarehouseRowDto,
  InventoryWarehouseRowsDto,
  SourceBindingDto,
} from '@/features/inventory/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const metadata: Metadata = { title: '商品库存 · 双视图' };

function toUrlSearchParams(sp: Record<string, string | string[] | undefined>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) {
    if (value === undefined) continue;
    const first = Array.isArray(value) ? value[0] : value;
    if (first !== undefined) params.set(key, first);
  }
  return params;
}

/** 详情读取失败的短原因：不把 SQL/路径带到页面；“没找到该商品”不是网络失败。 */
function shortFailure(error: unknown): string | null {
  const message = errorMessageOf(error);
  if (/INVENTORY_ITEM_NOT_FOUND|INVENTORY_INVALID_INPUT/.test(message)) return null;
  const kind = classifyReadFailure(error);
  if (kind === 'forbidden') return '当前账号无权查看该商品';
  if (kind === 'unavailable') return '后台库存功能尚未就绪';
  return '网络或传输异常';
}

/**
 * 商品库存页：默认「仓库明细」，同一入口切「商品汇总」。
 *
 * - 视图/来源范围/搜索/仓库/市场下钻/分页/详情全部由 URL 还原（刷新、前进后退不丢上下文）；
 * - 来源范围同时约束查询、行集合、列与计数：仅国内时只有国内有效商品（118），不混入海外-only 商品；
 * - 海外数量来自每仓最后完整成功批次（服务端读模型）；国内数量来自冻结聚水潭表格快照（只读适配）；
 * - 两个来源分开计时、分开计数，不跨来源相加；失败/缺失/未对应都不写 0；
 * - 详情只有一个入口：URL 带 item/row 时首屏即渲染可见详情弹层，点击行时先在客户端立即打开再由 URL 还原数据。
 */
export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const query = parseInventorySearchParams(toUrlSearchParams(sp));

  let identity;
  try {
    identity = await requireInventoryAdmin();
  } catch (error) {
    return <ReadFailurePanel kind={classifyReadFailure(error)} backHref="/dashboard/catalog" backLabel="返回 ICE 商品库" />;
  }

  // 估算货值：单独走 amount:read 权限；无权限不读成本、不显示该列。
  // 成本读取失败时保留列但全部按缺成本显示“—”，不把缺失写成 0。
  let amountAllowed = false;
  try {
    await requireCatalogAdmin('amount:read');
    amountAllowed = true;
  } catch {
    amountAllowed = false;
  }
  const inventoryCostMap: Record<string, string> = {};
  if (amountAllowed) {
    try {
      const batch = await catalogRepository.baselineAmountsMap(identity);
      for (const [itemId, financial] of batch) {
        const cost = adoptedUnitCostFromFinancial(financial);
        if (cost.state === 'priced') inventoryCostMap[itemId] = cost.amountCny;
      }
    } catch {
      /* 成本读取失败：列保留，金额按缺成本显示“—”。 */
    }
  }

  // 国内表格快照没有仓库/市场维度：选择「仅国内」时不再把海外仓/市场条件带进国内查询。
  const domesticScope = query.source === 'domestic';
  const warehouseFilter = domesticScope ? 'all' : query.warehouse;
  const marketFilter = domesticScope ? 'all' : query.market;

  const [warehouseSettled, summarySettled, domesticSettled, overviewSettled] = await Promise.allSettled([
    query.view === 'warehouse'
      ? getInventoryWarehouseRows(identity, { q: query.q, warehouse: warehouseFilter, market: marketFilter })
      : Promise.resolve(null),
    query.view === 'product'
      // 商品汇总在服务端按完整筛选范围计算；这里取全量后与国内快照合并，再统一切页。
      ? getInventoryProductSummary(identity, {
        q: query.q,
        warehouse: warehouseFilter,
        market: marketFilter,
        limit: 200,
        offset: 0,
      })
      : Promise.resolve(null),
    getInventoryDomesticSnapshot(identity),
    getInventorySyncOverview(identity),
  ]);

  const viewFailure = query.view === 'warehouse' ? warehouseSettled : summarySettled;
  if (viewFailure.status === 'rejected') {
    const message = errorMessageOf(viewFailure.reason);
    const invalidFilter = /INVENTORY_WAREHOUSE_UNKNOWN/.test(message);
    return (
      <ReadFailurePanel
        kind={classifyReadFailure(viewFailure.reason)}
        backHref="/dashboard/catalog"
        backLabel="返回 ICE 商品库"
        extra={(
          <p style={{ margin: '10px 0 0', color: '#8d98a8', fontSize: '12px' }}>
            {invalidFilter
              ? '所选仓库不在当前账号的仓库清单里；请清空筛选后重试。'
              : '库存读模型没有读到，因此不显示商品数量或“没有库存”的结论。'}
          </p>
        )}
      />
    );
  }

  const overview: InventoryOverviewDto | null = overviewSettled.status === 'fulfilled' ? overviewSettled.value : null;
  const domestic: InventoryDomesticSnapshotDto | null = domesticSettled.status === 'fulfilled' ? domesticSettled.value : null;
  const overseasRows: InventoryWarehouseRowsDto | null = warehouseSettled.status === 'fulfilled' ? warehouseSettled.value : null;
  const productSummary: InventoryProductSummaryDto | null = summarySettled.status === 'fulfilled' ? summarySettled.value : null;

  const warehouseRows = query.view === 'warehouse'
    ? mergeWarehouseRowsPage({
      query: { ...query, warehouse: warehouseFilter, market: marketFilter },
      overseas: overseasRows,
      domestic,
      costMap: inventoryCostMap,
    })
    : null;
  const mergedSummary = query.view === 'product' && productSummary
    ? mergeProductSummary({
      query: { ...query, warehouse: warehouseFilter, market: marketFilter },
      summary: productSummary,
      domestic,
      costMap: inventoryCostMap,
    })
    : null;

  // 详情目标行：优先 URL 的 row（来源+仓+SKU），其次 item（商品汇总/商品详情）。
  let detailRow: InventoryWarehouseRowDto | null = null;
  if (warehouseRows) {
    if (query.row) detailRow = warehouseRows.rows.find((row) => row.rowKey === query.row) ?? null;
    if (!detailRow && query.item) detailRow = warehouseRows.rows.find((row) => row.itemId === query.item) ?? null;
  }

  // 国内详情只用国内冻结记录（原数量/编码/文件日期），不混入海外各仓，也不提供 BS 对应动作。
  // 取数与显示复用列表的有效范围：仅国内可以；全部来源只在未限定海外仓/市场时分区展示；
  // 仅海外、或任意明确的海外仓/市场（含未知市场）筛选时不带国内，与列表/列/计数同一判断。
  const domesticDetailRows = query.item
    && domestic
    && domesticIncludedInScope({ source: query.source, warehouse: warehouseFilter, market: marketFilter })
    ? (domestic.rows ?? []).filter((row) => row.itemId === query.item)
    : [];

  // 仓库行详情直接用行内事实（数量/占用/来源时间/状态），不再多读一次；
  // 商品汇总行详情才需要按标准商品读取当前范围的各仓库存。旧式 ?item= 直链（不在当前页）也走这条。
  const needsItemDetail = Boolean(query.item) && !detailRow && !domesticScope;
  let itemDetail: InventoryItemDetailDto | null = null;
  let itemError: string | null = null;
  if (needsItemDetail) {
    try {
      itemDetail = await getInventoryItem(identity, query.item, {
        warehouse: warehouseFilter,
        market: marketFilter,
        allWarehouses: false,
      });
    } catch (error) {
      itemError = shortFailure(error);
    }
  }

  const warehouseStates = overseasRows?.warehouses ?? productSummary?.warehouses ?? [];

  // 仓库行详情：读取固定来源（仓 + 原 SKU）的当前绑定，供详情内直接绑定/更换商品。
  // 国内行只读冻结快照，不提供 BigSeller 绑定；读取失败显示“可重试”，不当作“未绑定”。
  const bindingTarget = detailRow && detailRow.source === 'bigseller' && detailRow.warehouseId ? detailRow : null;
  let sourceBinding: SourceBindingDto | null = null;
  let sourceBindingError: string | null = null;
  if (bindingTarget?.warehouseId) {
    try {
      const binding = await getSourceBinding(identity, bindingTarget.warehouseId, bindingTarget.externalSku);
      if (binding) {
        sourceBinding = binding;
      } else {
        // 读不到不等于“未绑定”：显示可重试，避免把未知写成未绑定。
        sourceBindingError = '没有读取到该来源的绑定信息';
      }
    } catch (error) {
      sourceBindingError = shortFailure(error) ?? '绑定信息读取失败';
    }
  }

  // 恢复入口只在有未完成原请求/本地未知记录时出现；身份用于判断本地记录是否属于当前管理员。
  const viewer = { actorId: identity.profileUserId, accountId: overview?.account.accountId ?? '' };

  return (
    <InventoryView
      query={query}
      effectiveFilters={{ warehouse: warehouseFilter, market: marketFilter }}
      overview={overview}
      warehouseRows={warehouseRows}
      productSummary={mergedSummary}
      warehouseStates={warehouseStates}
      domestic={domestic}
      domesticDetailRows={domesticDetailRows}
      detailRow={detailRow}
      itemDetail={itemDetail}
      itemError={itemError}
      pending={overview?.pendingAction ?? null}
      viewer={viewer}
      sourceBinding={sourceBinding}
      sourceBindingError={sourceBindingError}
      bindingReady={Boolean(bindingTarget)}
      costMap={amountAllowed ? inventoryCostMap : undefined}
      showValue={amountAllowed}
    />
  );
}
