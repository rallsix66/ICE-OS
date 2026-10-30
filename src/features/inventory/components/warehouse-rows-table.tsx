'use client';

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
  formatQuantityOr,
  warehouseRowTitleDisplay,
  type InventoryQueryState,
  type InventorySortDir,
  type InventorySortKey,
  type Tone,
} from '../model';
import type { InventoryWarehouseRowDto } from '../types';
import type { InventoryCostMap, WarehouseRowsPageResult } from '../dual-view';
import { estimateValueScaled } from '../dual-view';
import { columnOf } from './inventory-columns';
import { useInventoryDetail } from './detail-context';

/** 展示层短状态：只留绑定与数据有无，不用 model 里的括号长句。 */
function shortRowStatus(row: InventoryWarehouseRowDto): { text: string; tone: Tone } {
  if (row.source === 'domestic') {
    return row.status === 'adopted' ? { text: '已绑定', tone: 'green' } : { text: '未绑定', tone: 'amber' };
  }
  if (row.status === 'adopted' || row.status === 'pending_adoption') return { text: '已绑定', tone: 'green' };
  return { text: '未绑定', tone: 'amber' };
}

function RowTitleButton({ row }: { row: InventoryWarehouseRowDto }) {
  const api = useInventoryDetail();
  const title = warehouseRowTitleDisplay(row);
  return (
    <button
      type="button"
      className={styles.rowNameButton}
      onClick={(event) => {
        event.stopPropagation();
        api.openRow(row);
      }}
      data-testid="inventory-row-open"
    >
      {title.title}
    </button>
  );
}

/** 估算货值：行内实物数量 × 该商品当前采用单位成本；任一缺失显示“—”（缺成本不是 0）。 */
function valueText(row: InventoryWarehouseRowDto, costMap: InventoryCostMap | undefined): string {
  const scaled = estimateValueScaled(row.onHand, costMap?.[row.itemId ?? '']);
  if (scaled === null) return '—';
  return formatCnyValue(formatMoney(scaled)) ?? '—';
}

/**
 * 仓库明细表：商品 / 仓库 / 可售 / 估算货值 / 状态 / 操作（URL 排序，先排序再切页）。
 * 整行点击与「详情」按钮都打开同一详情抽屉。
 */
export function WarehouseRowsTable({
  query,
  page,
  controls,
  columns,
  costMap,
  showValue,
}: {
  query: InventoryQueryState;
  page: WarehouseRowsPageResult;
  controls: TableControls;
  columns: TableColumn[];
  costMap?: InventoryCostMap;
  showValue: boolean;
}) {
  const api = useInventoryDetail();
  const router = useRouter();
  const [, startTransition] = useTransition();
  const sort = query.sort ? { key: query.sort, dir: query.sortDir } : null;

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
    <section className={styles.panelSection} data-testid="inventory-warehouse-rows">
      {query.source !== 'overseas' && !page.domesticAvailable ? (
        <p className={styles.inlineError} data-testid="inventory-domestic-unavailable">
          聚水潭未读取{page.domesticReason ? `：${page.domesticReason}` : ''}
        </p>
      ) : null}

      {page.rows.length === 0 ? (
        <div data-testid="inventory-empty">
          <EmptyState
            title={page.total === 0 ? '当前范围内没有来源行' : '本页没有行'}
            hint={page.total === 0 ? '清空搜索或切换来源范围' : '页码超出当前结果'}
          />
        </div>
      ) : (
        <div className={styles.tableScroll} tabIndex={0} data-testid="inventory-table-scroll">
          <table className={`${styles.table} ${styles.fixedTable}`}>
            <thead>
              <tr>
                <SortableTh column={columnOf(columns, 'name')} controls={controls} sort={sort} onSort={handleSort} className={styles.stickyCol} sticky />
                {controls.isVisible('warehouse') ? <SortableTh column={columnOf(columns, 'warehouse')} controls={controls} sort={sort} onSort={handleSort} sticky /> : null}
                {controls.isVisible('available') ? <SortableTh column={columnOf(columns, 'available')} controls={controls} sort={sort} onSort={handleSort} className={styles.numericHead} sticky /> : null}
                {showValue && controls.isVisible('value') ? <SortableTh column={columnOf(columns, 'value')} controls={controls} sort={sort} onSort={handleSort} className={styles.numericHead} sticky /> : null}
                {controls.isVisible('status') ? <SortableTh column={columnOf(columns, 'status')} controls={controls} sort={sort} onSort={handleSort} sticky /> : null}
                <SortableTh column={columnOf(columns, 'actions')} controls={controls} className={`${styles.stickyAction} ${styles.actionHead} ${styles.numericHead}`} sticky />
              </tr>
            </thead>
            <tbody>
              {page.rows.map((row) => {
                const status = shortRowStatus(row);
                const focused = Boolean(query.focus) && row.itemId === query.focus;
                const isDomestic = row.source === 'domestic';
                const availableText = row.warehouseAvailable !== null && row.warehouseAvailable !== undefined
                  ? formatQuantityOr(row.warehouseAvailable, '—')
                  : '—';
                return (
                  <tr
                    key={row.rowKey}
                    id={`inv-row-${row.rowKey}`}
                    data-testid={isDomestic ? 'inventory-domestic-row' : 'inventory-warehouse-row'}
                    data-source={row.source}
                    data-status={row.status}
                    data-focus={focused ? 'true' : undefined}
                    className={`${styles.clickableRow} ${focused ? styles.focusRow : ''}`}
                    onClick={() => api.openRow(row)}
                  >
                    <td className={styles.stickyCol}>
                      <span className={styles.rowTitle}><RowTitleButton row={row} /></span>
                      <span className={styles.rowSub}>来源 SKU {row.externalSku}</span>
                    </td>
                    {controls.isVisible('warehouse') ? (
                      <td>
                        <span>{row.warehouseName}</span>
                        {isDomestic ? <span className={styles.rowSub}>聚水潭</span> : null}
                      </td>
                    ) : null}
                    {controls.isVisible('available') ? (
                      <td className={styles.numCell}>
                        <span>{availableText}</span>
                      </td>
                    ) : null}
                    {showValue && controls.isVisible('value') ? (
                      <td className={styles.numCell} data-testid="inventory-row-value">
                        {valueText(row, costMap)}
                      </td>
                    ) : null}
                    {controls.isVisible('status') ? (
                      <td className={styles.wrapCell}>
                        <span className={styles.statusLine}>
                          <span className={styles.statusDot} data-tone={status.tone} aria-hidden />
                          {status.text}
                        </span>
                      </td>
                    ) : null}
                    <td className={`${styles.stickyAction} ${styles.actionCell}`}>
                      <button
                        type="button"
                        className={`${surface.button} ${surface.buttonSmall}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          api.openRow(row);
                        }}
                        data-testid="inventory-row-detail"
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
