'use client';

import Link from 'next/link';
import { PageHeading } from '@/ui/ice-v4/data-surface';
import { useTableControls } from '@/ui/ice-v4/table-tools';
import styles from './inventory.module.css';
import {
  buildInventoryListHref,
  DOMESTIC_SNAPSHOT_LABEL,
  pendingBlocksWrites,
  type InventoryQueryState,
} from '../model';
import type {
  InventoryDomesticRowDto,
  InventoryDomesticSnapshotDto,
  InventoryItemDetailDto,
  InventoryOverviewDto,
  InventoryPendingActionDto,
  InventoryWarehouseReadStateV2Dto,
  InventoryWarehouseRowDto,
  SourceBindingDto,
} from '../types';
import type { InventoryCostMap, ProductSummaryMergeResult, WarehouseRowsPageResult } from '../dual-view';
import { domesticIncludedInScope } from '../dual-view';
import {
  SUMMARY_TABLE_STORAGE_KEY,
  WAREHOUSE_TABLE_STORAGE_KEY,
  summaryTableColumns,
  warehouseTableColumns,
} from './inventory-columns';
import { InventoryDetailLayer } from './inventory-detail-layer';
import { InventoryFilterBar } from './inventory-filter-bar';
import { InventoryPagination } from './inventory-pagination';
import { PendingRecoveryPanel } from './pending-recovery';
import { ProductSummaryTable } from './product-summary-table';
import { WarehouseRowsTable } from './warehouse-rows-table';
import type { LocalViewerIdentity } from '../client-pending';

/**
 * /dashboard/inventory：同一入口的「仓库明细 / 商品汇总」双视图（客户端壳）。
 * 表格布局状态（显示列/列宽）在这里持有，工具栏「显示列」与两张表共用。
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
  pending,
  viewer,
  sourceBinding,
  sourceBindingError,
  bindingReady,
  costMap,
  showValue,
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
  /** 最近未完成原请求（服务端）；本地未知记录由恢复面板自行读取。 */
  pending: InventoryPendingActionDto | null;
  /** 当前会话身份：恢复记录归属校验与绑定写入登记。 */
  viewer: LocalViewerIdentity | null;
  /** 当前打开仓库行的固定来源绑定（服务端读取）。 */
  sourceBinding: SourceBindingDto | null;
  sourceBindingError: string | null;
  /** 服务端已针对当前行尝试读取绑定（false = 页面读取尚未返回）。 */
  bindingReady: boolean;
  /** itemId → 当前采用单位成本（仅 amount:read 权限时有值；无权限不传）。 */
  costMap?: InventoryCostMap;
  /** 是否显示「估算货值」列（无金额权限不显示）。 */
  showValue?: boolean;
}) {
  const warehouses = overview?.warehouses ?? [];
  const domesticScope = query.source === 'domestic';
  const failedCount = warehouseStates.filter((state) => state.warehouseStatus === 'confirmed' && state.failed).length;
  const scopeEmpty = overview?.scope.empty === true;
  const showValueColumn = showValue === true;

  const warehouseColumns = warehouseTableColumns(showValueColumn);
  const summaryColumns = summaryTableColumns({ merged: productSummary, domesticOnlyScope: domesticScope, showValue: showValueColumn });
  const warehouseControls = useTableControls({ storageKey: WAREHOUSE_TABLE_STORAGE_KEY, columns: warehouseColumns });
  const summaryControls = useTableControls({ storageKey: SUMMARY_TABLE_STORAGE_KEY, columns: summaryColumns });
  const activeColumns = query.view === 'warehouse' ? warehouseColumns : summaryColumns;
  const activeControls = query.view === 'warehouse' ? warehouseControls : summaryControls;
  const page = warehouseRows ?? productSummary;

  function viewHref(view: InventoryQueryState['view']): string {
    return buildInventoryListHref({
      q: query.q,
      warehouse: effectiveFilters.warehouse,
      market: effectiveFilters.market,
      view,
      source: query.source,
      page: 1,
      sort: query.sort,
      sortDir: query.sortDir,
    });
  }

  // 表格/分页用同一有效筛选（来源范围下 warehouse/market 可能被服务端忽略）。
  const listQuery: InventoryQueryState = {
    ...query,
    warehouse: effectiveFilters.warehouse,
    market: effectiveFilters.market,
  };

  // 详情里的国内分区与列表同一有效范围（明确的海外仓/市场下钻不带国内）。
  const domesticDetailIncluded = domesticIncludedInScope({
    source: query.source,
    warehouse: effectiveFilters.warehouse,
    market: effectiveFilters.market,
  });

  return (
    <div className={styles.page} data-testid="inventory-page">
      <PageHeading title="商品库存" />

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

      <InventoryFilterBar
        query={listQuery}
        warehouses={warehouses}
        columns={activeColumns}
        controls={activeControls}
        total={page?.total ?? null}
      />

      {scopeEmpty || failedCount > 0 ? (
        <p className={styles.pageStatus} data-testid="inventory-status-line">
          {scopeEmpty ? <span>参与仓库为空</span> : null}
          {scopeEmpty && failedCount > 0 ? <span className={styles.statusSep}>·</span> : null}
          {failedCount > 0 ? <span>{failedCount} 个仓沿用上次成功数据</span> : null}
        </p>
      ) : null}

      <PendingRecoveryPanel pending={pending} viewer={viewer} />

      {query.view === 'warehouse' && !domestic?.available && query.source !== 'overseas' ? (
        <p className={styles.inlineError} data-testid="inventory-domestic-failure">
          {DOMESTIC_SNAPSHOT_LABEL}未读取{domestic?.reason ? `：${domestic.reason}` : ''}
        </p>
      ) : null}

      <InventoryDetailLayer
        query={query}
        detailRow={detailRow}
        itemDetail={itemDetail}
        itemError={itemError}
        domesticRows={domesticDetailRows}
        domesticIncluded={domesticDetailIncluded}
        warehouses={warehouses}
        sourceBinding={sourceBinding}
        sourceBindingError={sourceBindingError}
        bindingReady={bindingReady}
        viewer={viewer}
        pendingLocked={pendingBlocksWrites(pending)}
      >
        <div className={styles.panel}>
          {query.view === 'warehouse' && warehouseRows ? (
            <WarehouseRowsTable
              query={listQuery}
              page={warehouseRows}
              controls={warehouseControls}
              columns={warehouseColumns}
              costMap={costMap}
              showValue={showValueColumn}
            />
          ) : null}
          {query.view === 'product' && productSummary ? (
            <ProductSummaryTable
              query={listQuery}
              merged={productSummary}
              domesticOnlyScope={domesticScope}
              controls={summaryControls}
              columns={summaryColumns}
              costMap={costMap}
              showValue={showValueColumn}
            />
          ) : null}
          {page ? (
            <div className={styles.pagerBar}>
              <InventoryPagination query={listQuery} total={page.total} limit={page.limit} page={page.page} />
            </div>
          ) : null}
        </div>
      </InventoryDetailLayer>
    </div>
  );
}
