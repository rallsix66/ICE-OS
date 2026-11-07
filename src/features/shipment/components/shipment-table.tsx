'use client';

import Link from 'next/link';
import { EmptyState } from '@/ui/ice-v4/data-surface';
import surface from '@/ui/ice-v4/data-surface.module.css';
import { SortableTh, sortRows, type TableColumn, type TableControls } from '@/ui/ice-v4/table-tools';
import styles from './shipment.module.css';
import {
  arrivalColumnText,
  buildShipmentListHref,
  marketText,
  productSummaryDisplay,
  purchaseOrderText,
  shipmentStatusLabel,
  shipmentStatusTone,
  transportColumnText,
  waybillsText,
  type ShipmentQueryState,
} from '../model';
import type { ShipmentListDto, ShipmentListRowDto } from '../types';

export const SHIPMENT_TABLE_STORAGE_KEY = 'ice-shipment-list-table-v2';

/**
 * 列表列顺序固定（合同 §7）：市场 → 采购单号 → 运单号 → 商品摘要 → 业务状态 → 预计到仓 → 操作。
 * 不再有「货票号」「来源更新时间」列；采购单号没有就显示「未提供」，不用运单号顶替。
 */
export function shipmentTableColumns(): TableColumn[] {
  return [
    { key: 'market', label: '市场', width: '9%', hideable: false },
    { key: 'purchaseOrder', label: '采购单号', width: '14%' },
    { key: 'waybills', label: '运单号', width: '13%' },
    { key: 'products', label: '商品摘要', width: '21%' },
    { key: 'status', label: '业务状态', width: '18%' },
    { key: 'arrival', label: '预计到仓', width: '15%' },
    // 操作列不写宽度：与商品库/库存表一致，由它吸收剩余宽度（拖拽其它列时从这里让出/收回）。
    { key: 'actions', label: '操作', hideable: false, sortable: false, resizable: false },
  ];
}

function columnOf(columns: TableColumn[], key: string): TableColumn {
  return columns.find((column) => column.key === key) ?? { key, label: key };
}

const SORT_ACCESSORS: Record<string, (row: ShipmentListRowDto) => string | number | null | undefined> = {
  market: (row) => marketText(row.market),
  purchaseOrder: (row) => purchaseOrderText(row.purchaseOrder),
  waybills: (row) => row.waybillsText ?? '',
  products: (row) => productSummaryDisplay(row).primary,
  // 业务状态列显示 G 列物流情况原文；排序按同一显示文本，避免「排序看到的顺序」与「看到的内容」不一致。
  status: (row) => transportColumnText(row.transportText),
  arrival: (row) => row.arrivalText ?? '',
};

/**
 * 货票列表：一行一票，整行可点开详情；沿用现役表格样式
 * （sticky 表头、固定分页底栏、操作列「详情」按钮）。
 */
export function ShipmentTable({
  query,
  page,
  columns,
  controls,
  footer,
  onOpen,
}: {
  query: ShipmentQueryState;
  page: ShipmentListDto;
  columns: TableColumn[];
  controls: TableControls;
  /** 分页底栏（固定在面板底部，不随表格滚动）。 */
  footer?: React.ReactNode;
  onOpen: (shipmentId: string, trigger: HTMLElement | null) => void;
}) {
  const rows = sortRows(page.rows, controls.sort, SORT_ACCESSORS);
  const hasAnyTicket = page.counts.total > 0;
  const hasAbsentHistory = page.absentTickets > 0 && !query.includeAbsent;
  const emptyTitle = hasAbsentHistory
    ? '当前来源没有货票'
    : hasAnyTicket ? '没有符合条件的货票' : '还没有读取到货票';
  const emptyHint = hasAbsentHistory
    ? `本次来源未见 ${page.absentTickets} 票 / ${page.absentItems} 明细（已退出当前列表，历史保留）`
    : hasAnyTicket
      ? (query.product ? '该商品没有关联到这些筛选下的货票' : '切换市场/状态或清空搜索')
      : '点上方「刷新来源」从飞书物流情况表读取';
  const clearHref = buildShipmentListHref({
    ...query,
    market: 'all',
    status: 'all',
    q: '',
    product: '',
    includeAbsent: false,
    page: 1,
  });
  const includeAbsentHref = buildShipmentListHref({ ...query, includeAbsent: true, page: 1 });

  return (
    <section className={styles.panel} data-testid="shipment-list">
      {rows.length === 0 ? (
        <div className={styles.emptyWrap} data-testid="shipment-empty">
          <EmptyState
            title={emptyTitle}
            hint={emptyHint}
            action={hasAbsentHistory ? (
              <Link href={includeAbsentHref} className={`${surface.button} ${surface.buttonSmall}`} data-testid="shipment-empty-include-absent">
                包含本次来源未见
              </Link>
            ) : hasAnyTicket ? (
              <Link href={clearHref} className={`${surface.button} ${surface.buttonSmall}`}>清空筛选</Link>
            ) : null}
          />
        </div>
      ) : (
        <div className={styles.tableScroll} tabIndex={0} data-testid="shipment-table-scroll">
          <table className={`${styles.table} ${styles.fixedTable}`}>
            <thead>
              <tr>
                <SortableTh column={columnOf(columns, 'market')} controls={controls} className={styles.stickyCol} sticky />
                {controls.isVisible('purchaseOrder') ? (
                  <SortableTh column={columnOf(columns, 'purchaseOrder')} controls={controls} />
                ) : null}
                {controls.isVisible('waybills') ? (
                  <SortableTh column={columnOf(columns, 'waybills')} controls={controls} />
                ) : null}
                {controls.isVisible('products') ? (
                  <SortableTh column={columnOf(columns, 'products')} controls={controls} />
                ) : null}
                {controls.isVisible('status') ? (
                  <SortableTh column={columnOf(columns, 'status')} controls={controls} />
                ) : null}
                {controls.isVisible('arrival') ? (
                  <SortableTh column={columnOf(columns, 'arrival')} controls={controls} />
                ) : null}
                <SortableTh column={columnOf(columns, 'actions')} controls={controls} className={styles.actionHead} />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const products = productSummaryDisplay(row);
                const missingPurchaseOrder = !(row.purchaseOrder ?? '').trim();
                const identityPending = row.identityStatus === 'pending';
                const absent = !row.presentInLatestRead;
                const handleOpen = (trigger: HTMLElement | null) => onOpen(row.shipmentId, trigger);
                return (
                  <tr
                    key={row.shipmentId}
                    className={`${styles.clickableRow} ${absent ? styles.historicalRow : ''}`}
                    data-testid="shipment-row"
                    data-ticket-no={row.ticketNo}
                    data-shipment-id={row.shipmentId}
                    data-purchase-order={row.purchaseOrder ?? ''}
                    data-identity-status={row.identityStatus}
                    data-present={row.presentInLatestRead ? 'true' : 'false'}
                    data-status-class={row.statusClass}
                    data-effective-status-class={row.effectiveStatusClass}
                    data-manual-count={row.manualCorrectionCount}
                    onClick={(event) => handleOpen(event.currentTarget.querySelector<HTMLElement>('button'))}
                  >
                    <td className={styles.stickyCol}>
                      <span className={styles.cellTruncate}>{marketText(row.market)}</span>
                      {absent ? <span className={styles.cellSub} data-testid="shipment-row-absent">本次来源未见</span> : null}
                    </td>
                    {controls.isVisible('purchaseOrder') ? (
                      <td>
                        <span
                          className={missingPurchaseOrder ? `${styles.cellTruncate} ${styles.cellMuted}` : styles.cellTruncate}
                          data-testid="shipment-row-purchase-order"
                        >
                          {purchaseOrderText(row.purchaseOrder)}
                        </span>
                      </td>
                    ) : null}
                    {controls.isVisible('waybills') ? (
                      <td>
                        <span
                          className={styles.waybillsCell}
                          title={row.waybillsText ?? ''}
                          data-testid="shipment-row-waybills"
                        >
                          {waybillsText(row.waybillsText)}
                        </span>
                      </td>
                    ) : null}
                    {controls.isVisible('products') ? (
                      <td>
                        <span className={styles.cellTruncate} title={row.productSummary.join('、')}>
                          {products.primary}
                        </span>
                        <span className={styles.cellSub}>
                          共 {row.itemCount} 条明细{products.more ? ` · ${products.more}` : ''}
                        </span>
                      </td>
                    ) : null}
                    {controls.isVisible('status') ? (
                      <td>
                        <span className={styles.statusCell}>
                          {/* 主内容 = G 列物流情况原文；长文截断，完整原文看 title。 */}
                          <span
                            className={styles.cellTruncate}
                            title={row.transportText ?? ''}
                            data-testid="shipment-row-transport"
                          >
                            {transportColumnText(row.transportText)}
                          </span>
                          {/* H 列判断出的到货/上架分类：小字副行保留；含人工修正时显示生效状态。 */}
                          <span className={styles.statusCellLine} data-testid="shipment-row-status-class">
                            <span className={styles.statusDot} data-tone={shipmentStatusTone(row.effectiveStatusClass)} aria-hidden />
                            {shipmentStatusLabel(row.effectiveStatusClass)}
                          </span>
                          {row.quantityPending
                            || identityPending
                            || absent
                            || row.manualCorrectionCount > 0
                            || row.manualReviewCount > 0 ? (
                              <span className={styles.chipRow}>
                                {row.quantityPending ? <span className={styles.pendingChip}>数量待核</span> : null}
                                {identityPending ? <span className={styles.identityChip}>身份待核</span> : null}
                                {absent ? <span className={styles.absentChip}>本次来源未见</span> : null}
                                {row.manualCorrectionCount > 0 ? (
                                  <span className={styles.manualChip} data-testid="shipment-row-manual">
                                    人工修正{row.manualCorrectionCount > 1 ? ` ${row.manualCorrectionCount}` : ''}
                                  </span>
                                ) : null}
                                {row.manualReviewCount > 0 ? (
                                  <span className={styles.manualReviewChip} data-testid="shipment-row-manual-review">
                                    待复核{row.manualReviewCount > 1 ? ` ${row.manualReviewCount}` : ''}
                                  </span>
                                ) : null}
                              </span>
                            ) : null}
                        </span>
                      </td>
                    ) : null}
                    {controls.isVisible('arrival') ? (
                      <td>
                        <span
                          className={styles.arrivalCell}
                          title={row.arrivalText ?? ''}
                          data-testid="shipment-row-arrival"
                        >
                          {arrivalColumnText(row.arrivalText)}
                        </span>
                      </td>
                    ) : null}
                    <td className={styles.actionCell}>
                      <button
                        type="button"
                        className={`${surface.button} ${surface.buttonSmall}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          handleOpen(event.currentTarget);
                        }}
                        data-testid="shipment-row-detail"
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
      {footer ? <div className={styles.pagerBar}>{footer}</div> : null}
    </section>
  );
}
