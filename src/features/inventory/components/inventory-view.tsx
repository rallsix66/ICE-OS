'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { PageHeading } from '@/ui/ice-v4/data-surface';
import { useTableControls } from '@/ui/ice-v4/table-tools';
import styles from './inventory.module.css';
import {
  buildInventoryListHref,
  buildInventorySnapshotHref,
  DOMESTIC_SNAPSHOT_LABEL,
  pendingBlocksWrites,
  type InventoryQueryState,
} from '../model';
import type {
  InventoryDomesticRowDto,
  InventoryDomesticSnapshotDto,
  InventoryItemDetailDto,
  InventoryPendingActionDto,
  InventorySnapshotBatchDto,
  InventorySnapshotRowsDto,
  InventoryWarehouseDto,
  InventoryWarehouseReadStateV2Dto,
  InventoryWarehouseRowDto,
  SourceBindingDto,
} from '../types';
import type { ProductSummaryMergeResult, WarehouseRowsPageResult } from '../dual-view';
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
import { InventorySnapshotView } from './inventory-snapshot-view';
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
  warehouses,
  scopeEmpty,
  allowDomestic = true,
  warehouseRows,
  productSummary,
  warehouseStates,
  domestic,
  domesticDetailRows,
  detailRow,
  itemDetail,
  itemError,
  pending,
  pendingEntry,
  viewer,
  sourceBinding,
  sourceBindingError,
  bindingReady,
  showValue,
  snapshot,
}: {
  query: InventoryQueryState;
  effectiveFilters: { warehouse: string; market: string };
  /** 当前账号可见的仓库（管理员：参与仓；成员：被授予的仓）。 */
  warehouses: InventoryWarehouseDto[];
  /** 可见范围为 0 个仓（成员未分配范围时页面要明确说明，不显示 0 结论）。 */
  scopeEmpty: boolean;
  /** 是否允许切到国内（聚水潭）冻结快照：仅管理员可用。 */
  allowDomestic?: boolean;
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
  /** 工具栏「待处理」入口（服务端 <Suspense> 流式计数 + 弹窗懒加载清单）。 */
  pendingEntry: ReactNode;
  /** 当前会话身份：恢复记录归属校验与绑定写入登记。 */
  viewer: LocalViewerIdentity | null;
  /** 当前打开仓库行的固定来源绑定（服务端读取）。 */
  sourceBinding: SourceBindingDto | null;
  sourceBindingError: string | null;
  /** 服务端已针对当前行尝试读取绑定（false = 页面读取尚未返回）。 */
  bindingReady: boolean;
  /** 是否显示「估算货值」列（无金额权限不显示）。 */
  showValue?: boolean;
  /** 历史快照视图数据（只读；按需读取选定批次）。 */
  snapshot: {
    warehouseId: string;
    /** 书签指定的仓已不在当前账号授权范围：提示重新选仓，不静默改选。 */
    warehouseSelectionLost: boolean;
    batches: InventorySnapshotBatchDto[];
    batchTotal: number;
    batchPage: number;
    batchLimit: number;
    detail: InventorySnapshotRowsDto | null;
    /** 明确批次不可用时的原因（不存在/与所选仓不一致），不含任何数量。 */
    batchNotice: {
      kind: 'not_found' | 'warehouse_mismatch' | 'no_account';
      batchWarehouseId: string;
      batchWarehouseName: string;
      observationAt: string;
    } | null;
    batchesError: string | null;
    detailError: string | null;
  };
}) {
  const domesticScope = query.source === 'domestic';
  const failedCount = warehouseStates.filter((state) => state.warehouseStatus === 'confirmed' && state.failed).length;
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

  // 历史快照入口：沿用当前库存筛选；首次进入时用当前选中的海外仓作为快照默认仓。
  const snapshotHref = buildInventorySnapshotHref({
    q: query.q,
    warehouse: effectiveFilters.warehouse,
    market: effectiveFilters.market,
    view: query.view,
    source: query.source,
    page: query.page,
    sort: query.sort,
    sortDir: query.sortDir,
    snapWarehouse: query.snapWarehouse
      || (effectiveFilters.warehouse !== 'all' ? effectiveFilters.warehouse : ''),
    snapBatch: query.snapBatch,
    snapQ: query.snapQ,
    snapPage: query.snapPage,
    snapBPage: query.snapBPage,
  });

  // 详情里的国内分区与列表同一有效范围（明确的海外仓/市场下钻不带国内）。
  const domesticDetailIncluded = domesticIncludedInScope({
    source: query.source,
    warehouse: effectiveFilters.warehouse,
    market: effectiveFilters.market,
  });

  return (
    <div className={`${styles.page} ${query.snapshot ? styles.pageSnapshot : ''}`} data-testid="inventory-page">
      <PageHeading title="商品库存" />

      <div className={styles.viewTabs} role="tablist" aria-label="库存视图" data-testid="inventory-view-tabs">
        <Link
          className={`${styles.viewTab} ${query.view === 'warehouse' && !query.snapshot ? styles.viewTabActive : ''}`}
          role="tab"
          aria-selected={query.view === 'warehouse' && !query.snapshot}
          href={viewHref('warehouse')}
          data-testid="inventory-view-warehouse"
        >
          仓库明细
        </Link>
        <Link
          className={`${styles.viewTab} ${query.view === 'product' && !query.snapshot ? styles.viewTabActive : ''}`}
          role="tab"
          aria-selected={query.view === 'product' && !query.snapshot}
          href={viewHref('product')}
          data-testid="inventory-view-product"
        >
          商品汇总
        </Link>
        <Link
          className={`${styles.viewTab} ${query.snapshot ? styles.viewTabActive : ''}`}
          role="tab"
          aria-selected={query.snapshot}
          href={snapshotHref}
          data-testid="inventory-view-snapshot"
        >
          历史快照
        </Link>
      </div>

      {query.snapshot ? (
        <InventorySnapshotView
          query={listQuery}
          warehouses={warehouses}
          warehouseId={snapshot.warehouseId}
          warehouseSelectionLost={snapshot.warehouseSelectionLost}
          batches={snapshot.batches}
          batchTotal={snapshot.batchTotal}
          batchPage={snapshot.batchPage}
          batchLimit={snapshot.batchLimit}
          detail={snapshot.detail}
          batchNotice={snapshot.batchNotice}
          batchesError={snapshot.batchesError}
          detailError={snapshot.detailError}
        />
      ) : (
        <>
          <InventoryFilterBar
        query={listQuery}
        warehouses={warehouses}
        columns={activeColumns}
        controls={activeControls}
        total={page?.total ?? null}
        pendingEntry={pendingEntry}
        allowDomestic={allowDomestic}
      />

      {scopeEmpty || failedCount > 0 ? (
        <p className={styles.pageStatus} data-testid="inventory-status-line">
          {scopeEmpty
            ? <span>{allowDomestic ? '参与仓库为空' : '暂无授权库存：请联系管理员分配市场与仓库'}</span>
            : null}
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
        </>
      )}
    </div>
  );
}
