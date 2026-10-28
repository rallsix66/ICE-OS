import Link from 'next/link';
import styles from './inventory.module.css';
import {
  buildInventoryListHref,
  buildInventoryMappingHref,
  DOMESTIC_SNAPSHOT_LABEL,
  timestampOr,
  type InventoryQueryState,
} from '../model';
import type {
  InventoryDomesticRowDto,
  InventoryDomesticSnapshotDto,
  InventoryItemDetailDto,
  InventoryOverviewDto,
  InventoryWarehouseReadStateV2Dto,
  InventoryWarehouseRowDto,
} from '../types';
import type { ProductSummaryMergeResult, WarehouseRowsPageResult } from '../dual-view';
import { domesticIncludedInScope } from '../dual-view';
import { InventoryDetailLayer } from './inventory-detail-layer';
import { InventoryFilterBar } from './inventory-filter-bar';
import { InventoryPagination } from './inventory-pagination';
import { ProductSummaryTable } from './product-summary-table';
import { WarehouseRowsTable } from './warehouse-rows-table';

/**
 * /dashboard/inventory：同一入口的「仓库明细 / 商品汇总」双视图。
 * - 首屏只有标题、两视图页签、一行工具栏、主表与固定分页；规则说明不占页面；
 * - 每行只有一个「详情」入口（名称也可点开同一详情），点击立即打开右侧详情层；
 * - 来源范围约束数据集合与计数；独立市场下拉已删除，只保留可清除的下钻标签。
 */
export function InventoryView({
  query,
  effectiveFilters,
  overview,
  warehouseRows,
  productSummary,
  warehouseStates,
  domestic,
  domesticDetailRows,
  detailRow,
  itemDetail,
  itemError,
}: {
  query: InventoryQueryState;
  effectiveFilters: { warehouse: string; market: string };
  overview: InventoryOverviewDto | null;
  warehouseRows: WarehouseRowsPageResult | null;
  productSummary: ProductSummaryMergeResult | null;
  warehouseStates: InventoryWarehouseReadStateV2Dto[];
  domestic: InventoryDomesticSnapshotDto | null;
  domesticDetailRows: InventoryDomesticRowDto[];
  detailRow: InventoryWarehouseRowDto | null;
  itemDetail: InventoryItemDetailDto | null;
  itemError: string | null;
}) {
  const warehouses = overview?.warehouses ?? [];
  const domesticScope = query.source === 'domestic';
  const domesticDates = domestic?.fileDates.map((entry) => entry.fileDate) ?? [];
  const latestOverseasObservation = warehouseStates
    .map((state) => state.observationAt)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) ?? null;
  const failedStates = warehouseStates.filter((state) => state.warehouseStatus === 'confirmed' && state.failed);
  const scopeEmpty = overview?.scope.empty === true;
  const scopeWarehouseCount = Number(overview?.scope.warehouseCount ?? 0) || 0;

  function viewHref(view: InventoryQueryState['view']): string {
    return buildInventoryListHref({
      q: query.q,
      warehouse: effectiveFilters.warehouse,
      market: effectiveFilters.market,
      view,
      source: query.source,
      page: 1,
    });
  }

  const statusBits: string[] = [];
  if (!scopeEmpty && !domesticScope) statusBits.push(`${scopeWarehouseCount} 个参与仓`);
  if (!domesticScope) statusBits.push(`海外数据 ${timestampOr(latestOverseasObservation, '尚无成功批次')}`);
  if (!domesticScope && failedStates.length > 0) {
    statusBits.push(`${failedStates.length} 个仓本次失败，沿用上次成功数据`);
  }
  if (query.source !== 'overseas') {
    statusBits.push(domestic?.available
      ? `国内快照文件 ${domesticDates.join(' / ') || '见原表'}`
      : '国内快照未读取');
  }
  if (domesticScope && !statusBits.some((bit) => bit.startsWith('国内快照'))) {
    statusBits.push('国内快照未读取');
  }

  const page = warehouseRows ?? productSummary;
  // 详情里的国内分区与列表同一有效范围（明确的海外仓/市场下钻不带国内）。
  const domesticDetailIncluded = domesticIncludedInScope({
    source: query.source,
    warehouse: effectiveFilters.warehouse,
    market: effectiveFilters.market,
  });
  const mappingHref = buildInventoryMappingHref(query, {
    itemId: query.focus || null,
    warehouseId: effectiveFilters.warehouse !== 'all' ? effectiveFilters.warehouse : null,
    externalSku: '',
  });

  return (
    <div className={styles.page} data-testid="inventory-page">
      <header className={styles.pageHeader}>
        <div className={styles.titleRow}>
          <h1>商品库存</h1>
          <nav className={styles.headerLinks} aria-label="库存相关入口">
            <Link className={styles.headerLink} href="/dashboard/sync">数据同步</Link>
            <Link className={styles.headerLink} href={mappingHref} data-testid="inventory-mappings-entry">来源 SKU 对应</Link>
            <Link
              className={styles.headerLink}
              href={buildInventoryListHref({
                q: query.q,
                warehouse: effectiveFilters.warehouse,
                market: effectiveFilters.market,
                view: query.view,
                source: query.source,
                focus: query.focus,
                page: query.page,
              })}
            >
              刷新
            </Link>
          </nav>
        </div>
        <div className={styles.viewTabs} role="tablist" aria-label="库存视图" data-testid="inventory-view-tabs">
          <Link
            className={`${styles.viewTab} ${query.view === 'warehouse' ? styles.viewTabActive : ''}`}
            role="tab"
            aria-selected={query.view === 'warehouse'}
            href={viewHref('warehouse')}
            data-testid="inventory-view-warehouse"
          >
            仓库明细
          </Link>
          <Link
            className={`${styles.viewTab} ${query.view === 'product' ? styles.viewTabActive : ''}`}
            role="tab"
            aria-selected={query.view === 'product'}
            href={viewHref('product')}
            data-testid="inventory-view-product"
          >
            商品汇总
          </Link>
        </div>
      </header>

      <InventoryFilterBar query={{ ...query, warehouse: effectiveFilters.warehouse, market: effectiveFilters.market }} warehouses={warehouses} />

      <p className={styles.pageStatus} data-testid="inventory-status-line">
        {scopeEmpty
          ? '参与仓库为空：已停止发布，列表不显示为 0；请先在数据同步页选择参与仓库。'
          : statusBits.join(' · ')}
        {failedStates.length > 0 ? (
          <span className={styles.statusWarn}>
            {' '}失败仓：{failedStates.map((state) => state.name).join('、')}（明细见同步页）
          </span>
        ) : null}
      </p>

      {query.view === 'warehouse' && !domestic?.available && query.source !== 'overseas' ? (
        <p className={styles.inlineError} data-testid="inventory-domestic-failure">
          {DOMESTIC_SNAPSHOT_LABEL}未读取{domestic?.reason ? `：${domestic.reason}` : ''}；此处不显示 0。
        </p>
      ) : null}

      <InventoryDetailLayer
        query={query}
        detailRow={detailRow}
        itemDetail={itemDetail}
        itemError={itemError}
        domesticRows={domesticDetailRows}
        domesticIncluded={domesticDetailIncluded}
      >
        <div className={styles.panel}>
        {query.view === 'warehouse' && warehouseRows ? (
          <WarehouseRowsTable query={query} page={warehouseRows} />
        ) : null}
        {query.view === 'product' && productSummary ? (
          <ProductSummaryTable query={query} merged={productSummary} domesticOnlyScope={domesticScope} />
        ) : null}
        {page ? (
          <InventoryPagination
            query={query}
            total={page.total}
            limit={page.limit}
            page={page.page}
          />
        ) : null}
        </div>
      </InventoryDetailLayer>
    </div>
  );
}
