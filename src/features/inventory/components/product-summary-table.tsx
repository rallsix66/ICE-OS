'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { EmptyState } from '@/ui/ice-v4/data-surface';
import surface from '@/ui/ice-v4/data-surface.module.css';
import { SortableTh, type TableColumn, type TableControls } from '@/ui/ice-v4/table-tools';
import { formatMoney } from '@/features/catalog/local-display/decimal';
import { formatCnyValue } from '@/features/catalog/local-display/money-display';
import styles from './inventory.module.css';
import {
  buildInventoryListHref,
  domesticCellQuantity,
  marketCellQuantity,
  productOverseasTotalText,
  type InventoryQueryState,
  type InventorySortDir,
  type InventorySortKey,
  type Tone,
} from '../model';
import type { InventoryProductSummaryRowDto } from '../types';
import type { InventoryCostMap, ProductSummaryMergeResult } from '../dual-view';
import { estimateValueScaled } from '../dual-view';
import { columnOf } from './inventory-columns';
import { useInventoryDetail } from './detail-context';

/** 商品状态只留绑定与数据有无，不再解释“计入/待核对/采用”。 */
function summaryStatus(row: InventoryProductSummaryRowDto, domesticOnlyScope: boolean): { text: string; tone: Tone } {
  if (domesticOnlyScope) {
    return row.domestic ? { text: '已绑定', tone: 'green' } : { text: '未绑定', tone: 'amber' };
  }
  if (!row.hasCurrentData) return { text: '无当前库存', tone: 'neutral' };
  const bound = row.mapped || row.notMappedWarehouses.length < row.scopeWarehouseCount;
  return bound ? { text: '已绑定', tone: 'green' } : { text: '未绑定', tone: 'amber' };
}

/** 估算货值：海外/全部用海外实物合计×成本，仅国内用国内数量×成本；缺数量或缺成本显示“—”。 */
function summaryValueText(
  row: InventoryProductSummaryRowDto,
  domesticOnlyScope: boolean,
  costMap: InventoryCostMap | undefined,
): string {
  const qty = domesticOnlyScope ? row.domestic?.onHand : row.overseasOnHand;
  const scaled = estimateValueScaled(qty, costMap?.[row.itemId]);
  if (scaled === null) return '—';
  return formatCnyValue(formatMoney(scaled)) ?? '—';
}

function ProductNameButton({
  row,
  onOpen,
}: {
  row: InventoryProductSummaryRowDto;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className={styles.rowNameButton}
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
      data-testid="inventory-summary-open"
    >
      {row.nameCn ?? row.iceCode ?? '未命名商品'}
    </button>
  );
}

/**
 * 商品汇总表：一行一个标准商品，按市场分格；数量为纯数字，可显示列、调列宽。
 * 排序走 URL（sort/dir），在合并层对全量行排序后再切页；整行点击与「详情」按钮都打开详情。
 */
export function ProductSummaryTable({
  query,
  merged,
  domesticOnlyScope,
  controls,
  columns,
  costMap,
  showValue,
}: {
  query: InventoryQueryState;
  merged: ProductSummaryMergeResult;
  domesticOnlyScope: boolean;
  controls: TableControls;
  columns: TableColumn[];
  costMap?: InventoryCostMap;
  showValue: boolean;
}) {
  const api = useInventoryDetail();
  const router = useRouter();
  const [, startTransition] = useTransition();
  const marketColumns = merged.marketColumns;
  const sort = query.sort ? { key: query.sort, dir: query.sortDir } : null;
  const focused = query.focus ? merged.rows.find((row) => row.itemId === query.focus) ?? null : null;

  function handleSort(key: string) {
    const column = columns.find((entry) => entry.key === key);
    const defaultDir: InventorySortDir = column?.numeric ? 'desc' : 'asc';
    let nextSort: InventorySortKey = key as InventorySortKey;
    let nextDir: InventorySortDir = defaultDir;
    if (query.sort === key) {
      if (query.sortDir === defaultDir) nextDir = defaultDir === 'desc' ? 'asc' : 'desc';
      else {
        nextSort = '';
        nextDir = 'asc';
      }
    }
    startTransition(() => router.replace(buildInventoryListHref({
      ...query,
      page: 1,
      sort: nextSort,
      sortDir: nextDir,
    }), { scroll: false }));
  }

  return (
    <section className={styles.panelSection} data-testid="inventory-product-summary">
      {focused ? (
        <div className={styles.panelBar}>
          <span className={styles.focusTag}>已定位 {focused.iceCode ?? focused.nameCn ?? '目标商品'}</span>
        </div>
      ) : null}

      {!merged.domesticAvailable && query.source !== 'overseas' ? (
        <p className={styles.inlineError} data-testid="inventory-summary-domestic-unavailable">
          聚水潭未读取{merged.domesticReason ? `：${merged.domesticReason}` : ''}
        </p>
      ) : null}
      {merged.unlinkedSelected > 0 ? (
        <p className={styles.panelNote} data-testid="inventory-summary-domestic-unlinked">
          聚水潭 {merged.unlinkedSelected} 条未关联商品
          <Link
            className={`${surface.button} ${surface.buttonSmall}`}
            href={buildInventoryListHref({ ...query, view: 'warehouse', source: 'domestic' })}
          >
            查看
          </Link>
        </p>
      ) : null}

      {merged.rows.length === 0 ? (
        <div data-testid="inventory-empty">
          <EmptyState
            title={domesticOnlyScope ? '当前范围内没有带国内选择的商品' : '当前范围内没有可汇总的商品'}
            hint="切换来源范围或清空搜索"
          />
        </div>
      ) : (
        <div className={styles.tableScroll} tabIndex={0} data-testid="inventory-table-scroll">
          <table className={`${styles.table} ${styles.fixedTable} ${styles.matrixTable}`}>
            <thead>
              <tr>
                <SortableTh column={columnOf(columns, 'name')} controls={controls} sort={sort} onSort={handleSort} className={styles.stickyCol} sticky />
                {merged.domesticIncluded && controls.isVisible('domestic') ? (
                  <SortableTh column={columnOf(columns, 'domestic')} controls={controls} sort={sort} onSort={handleSort} className={styles.numericHead} sticky />
                ) : null}
                {marketColumns.map((column) => controls.isVisible(column.key) ? (
                  <SortableTh key={column.key} column={columnOf(columns, column.key)} controls={controls} sort={sort} onSort={handleSort} className={styles.numericHead} sticky>
                    <span data-testid={`inventory-market-column-${column.market ?? 'unknown'}`}>
                      {column.market === null ? '未知仓' : column.label}
                    </span>
                  </SortableTh>
                ) : null)}
                {!domesticOnlyScope && controls.isVisible('total') ? (
                  <SortableTh column={columnOf(columns, 'total')} controls={controls} sort={sort} onSort={handleSort} className={styles.numericHead} sticky />
                ) : null}
                {showValue && controls.isVisible('value') ? (
                  <SortableTh column={columnOf(columns, 'value')} controls={controls} sort={sort} onSort={handleSort} className={styles.numericHead} sticky />
                ) : null}
                {controls.isVisible('status') ? (
                  <SortableTh column={columnOf(columns, 'status')} controls={controls} sort={sort} onSort={handleSort} className={styles.stickyStatus} sticky />
                ) : null}
                <SortableTh
                  column={columnOf(columns, 'actions')}
                  controls={controls}
                  className={`${styles.stickyAction} ${styles.actionHead} ${styles.numericHead}`}
                  sticky
                />
              </tr>
            </thead>
            <tbody>
              {merged.rows.map((row) => {
                const status = summaryStatus(row, domesticOnlyScope);
                const focusedRow = row.itemId === query.focus;
                const open = () => api.openProduct({ itemId: row.itemId, label: row.nameCn, sublabel: row.iceCode });
                return (
                  <tr
                    key={row.itemId}
                    data-testid="inventory-summary-row"
                    data-item-code={row.iceCode ?? undefined}
                    data-focus={focusedRow ? 'true' : undefined}
                    className={`${styles.clickableRow} ${focusedRow ? styles.focusRow : ''}`}
                    onClick={open}
                  >
                    <td className={styles.stickyCol}>
                      <span className={styles.rowTitle}><ProductNameButton row={row} onOpen={open} /></span>
                    </td>
                    {merged.domesticIncluded && controls.isVisible('domestic') ? (
                      <td className={styles.numCell} data-testid="inventory-summary-domestic">
                        {row.domestic
                          ? <strong>{domesticCellQuantity(row.domestic)}</strong>
                          : <span className={styles.numCellMuted}>—</span>}
                      </td>
                    ) : null}
                    {marketColumns.map((column) => {
                      if (!controls.isVisible(column.key)) return null;
                      const cell = row.marketCells.find((entry) => entry.market === column.market) ?? null;
                      if (!cell) {
                        return <td key={column.key} className={styles.numCellMuted}>—</td>;
                      }
                      return (
                        <td
                          key={column.key}
                          className={styles.numCell}
                          data-testid={`inventory-market-cell-${column.market ?? 'unknown'}`}
                        >
                          {marketCellQuantity(cell)}
                        </td>
                      );
                    })}
                    {!domesticOnlyScope && controls.isVisible('total') ? (
                      <td className={styles.numCell}>
                        <strong>{productOverseasTotalText(row)}</strong>
                      </td>
                    ) : null}
                    {showValue && controls.isVisible('value') ? (
                      <td className={styles.numCell} data-testid="inventory-summary-value">
                        {summaryValueText(row, domesticOnlyScope, costMap)}
                      </td>
                    ) : null}
                    {controls.isVisible('status') ? (
                      <td className={styles.stickyStatus}>
                        <span className={styles.statusLine}>
                          <span className={styles.statusDot} data-tone={status.tone} aria-hidden />
                          {status.text}
                        </span>
                      </td>
                    ) : null}
                    <td className={styles.stickyAction}>
                      <button
                        type="button"
                        className={`${surface.button} ${surface.buttonSmall}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          open();
                        }}
                        data-testid="inventory-summary-detail"
                      >
                        详情
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
