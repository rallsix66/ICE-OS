'use client';

import Link from 'next/link';
import styles from './inventory.module.css';
import {
  buildInventoryListHref,
  buildProductToWarehouseHref,
  domesticCellMeta,
  domesticCellQuantity,
  marketCellQuantity,
  marketsDisplay,
  productOverseasTotalText,
  timestampOr,
  type InventoryQueryState,
  type Tone,
} from '../model';
import type { InventoryProductSummaryRowDto } from '../types';
import type { ProductSummaryMergeResult } from '../dual-view';
import { useInventoryDetail } from './detail-context';

function statusText(row: InventoryProductSummaryRowDto, domesticOnlyScope: boolean): { text: string; tone: Tone } {
  if (domesticOnlyScope) {
    if (!row.domestic) return { text: '无国内有效选择（不计入）', tone: 'neutral' };
    if (row.domestic.hasQuantityAnomaly) return { text: '含未注明数量行，逐行保留', tone: 'amber' };
    return { text: `已核对 ${row.domestic.rowCount} 条有效选择（计入国内）`, tone: 'green' };
  }
  if (!row.hasCurrentData) return { text: '海外无当前库存行（不是 0）', tone: 'neutral' };
  if (row.unitConflict) return { text: '多单位，不合计', tone: 'amber' };
  if (row.hasPendingTotal) return { text: '同仓多编码合计待核对', tone: 'amber' };
  if (row.hasPendingAdoptionWarehouses) return { text: '有对应待下一批次采用', tone: 'blue' };
  if (row.mapped) return { text: '已计入海外合计', tone: 'green' };
  return { text: '来源未对应（不计入）', tone: 'amber' };
}

function ProductDetailButton({ row }: { row: InventoryProductSummaryRowDto }) {
  const api = useInventoryDetail();
  return (
    <button
      type="button"
      className={styles.rowDetailButton}
      onClick={() => api.openProduct({ itemId: row.itemId, label: row.nameCn, sublabel: row.iceCode })}
      data-testid="inventory-summary-detail-button"
    >
      详情
    </button>
  );
}

/** 商品汇总表：一行一个标准商品，按市场分格；来源范围决定列与合计口径。 */
export function ProductSummaryTable({
  query,
  merged,
  domesticOnlyScope,
}: {
  query: InventoryQueryState;
  merged: ProductSummaryMergeResult;
  domesticOnlyScope: boolean;
}) {
  const columns = merged.marketColumns;
  const focused = query.focus ? merged.rows.find((row) => row.itemId === query.focus) ?? null : null;

  return (
    <section className={styles.panelSection} data-testid="inventory-product-summary">
      <div className={styles.panelBar}>
        <p className={styles.panelSummary} data-testid="inventory-summary-counts">
          {domesticOnlyScope
            ? `国内表格快照：${merged.domesticItemCount} 个商品有国内记录 · 共 ${merged.total} 行`
            : `海外商品 ${merged.overseasItemCount} 个${merged.domesticIncluded ? ` · 国内有记录商品 ${merged.domesticItemCount} 个` : ''} · 共 ${merged.total} 行`}
        </p>
        {focused ? <span className={styles.focusTag}>已定位 {focused.iceCode ?? focused.nameCn ?? '目标商品'}</span> : null}
      </div>

      {!merged.domesticAvailable && query.source !== 'overseas' ? (
        <p className={styles.inlineError} data-testid="inventory-summary-domestic-unavailable">
          国内表格快照未读取{merged.domesticReason ? `：${merged.domesticReason}` : ''}；国内列不显示 0。
        </p>
      ) : null}
      {merged.unlinkedSelected > 0 ? (
        <p className={styles.panelNote} data-testid="inventory-summary-domestic-unlinked">
          国内快照有 {merged.unlinkedSelected} 条已核对选择未关联标准商品，未纳入国内汇总；
          <Link className={styles.headerLink} href={buildInventoryListHref({ ...query, view: 'warehouse', source: 'domestic' })}>
            到仓库明细查看
          </Link>
        </p>
      ) : null}
      {!domesticOnlyScope && merged.unmappedOverseasRows > 0 ? (
        <p className={styles.panelNote} data-testid="inventory-summary-unmapped-overseas">
          当前筛选范围另有 {merged.unmappedOverseasRows} 条来源行未对应，不计入商品合计；
          <Link className={styles.headerLink} href={buildInventoryListHref({ ...query, view: 'warehouse', source: 'overseas' })}>到仓库明细核对</Link>
        </p>
      ) : null}

      {merged.rows.length === 0 ? (
        <div className={styles.emptyState} data-testid="inventory-empty">
          <strong>{domesticOnlyScope ? '当前范围内没有带国内有效选择的商品' : '当前范围内没有可汇总的标准商品'}</strong>
          <p>切换来源范围或清空搜索后重试；这不表示库存为 0。</p>
        </div>
      ) : (
        <div className={styles.tableScroll} tabIndex={0} data-testid="inventory-table-scroll">
          <table className={`${styles.table} ${styles.fixedTable} ${styles.matrixTable}`}>
            <thead>
              <tr>
                <th className={styles.stickyCol}>商品</th>
                {merged.domesticIncluded ? (
                  <th className={styles.numericHead}>国内（表格快照）</th>
                ) : null}
                {columns.map((column) => (
                  <th
                    key={column.key}
                    className={styles.numericHead}
                    data-testid={`inventory-market-column-${column.market ?? 'unknown'}`}
                  >
                    {column.label}
                  </th>
                ))}
                {!domesticOnlyScope ? <th className={styles.numericHead}>海外实物合计</th> : null}
                <th>状态</th>
                <th className={styles.actionHead}>详情</th>
              </tr>
            </thead>
            <tbody>
              {merged.rows.map((row) => {
                const status = statusText(row, domesticOnlyScope);
                const focusedRow = row.itemId === query.focus;
                return (
                  <tr
                    key={row.itemId}
                    data-testid="inventory-summary-row"
                    data-item-code={row.iceCode ?? undefined}
                    data-focus={focusedRow ? 'true' : undefined}
                    className={focusedRow ? styles.focusRow : undefined}
                  >
                    <td className={styles.stickyCol}>
                      <span className={styles.rowTitle}>{row.nameCn ?? row.iceCode ?? '未命名商品'}</span>
                      <span className={styles.rowSub}>
                        {row.iceCode ?? '未编号'}{row.gtin ? ` · 69 ${row.gtin}` : ''}
                        {' · '}{domesticOnlyScope ? '国内表格快照 · 原表未注明仓库' : marketsDisplay(row.markets, row.hasUnknownMarket, query.market).text}
                      </span>
                    </td>
                    {merged.domesticIncluded ? (
                      <td className={styles.numCell} data-testid="inventory-summary-domestic">
                        {row.domestic ? (
                          <>
                            <strong>{domesticCellQuantity(row.domestic)}</strong>
                            <span className={styles.rowSub}>{domesticCellMeta(row.domestic)}</span>
                          </>
                        ) : <span className={styles.rowSub}>无国内有效选择</span>}
                      </td>
                    ) : null}
                    {columns.map((column) => {
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
                          <Link
                            className={styles.cellLink}
                            href={buildProductToWarehouseHref(
                              { q: row.iceCode ?? '', warehouse: query.warehouse, market: query.market, source: query.source },
                              { iceCode: row.iceCode, nameCn: row.nameCn, itemId: row.itemId },
                              column.market,
                            )}
                            title={column.market ? '定位到同商品同市场的仓库明细' : '定位到该商品在市场待确认仓的仓库明细'}
                          >
                            {marketCellQuantity(cell)}
                          </Link>
                          <span className={styles.rowSub}>
                            {cell.skuCount} 个来源编码{cell.hasPendingTotal ? ' · 合计待核对' : ''}
                          </span>
                        </td>
                      );
                    })}
                    {!domesticOnlyScope ? (
                      <td className={styles.numCell}>
                        <strong>{productOverseasTotalText(row)}</strong>
                        <span className={styles.rowSub}>{row.overseasSkuCount} 个来源编码 · {timestampOr(row.lastObservedAt, '尚无成功观测')}</span>
                      </td>
                    ) : null}
                    <td className={styles.wrapCell}>
                      <span className={styles.statusLine}>
                        <span className={styles.statusDot} data-tone={status.tone} aria-hidden />
                        {status.text}
                      </span>
                      {row.itemRevisionMissing ? (
                        <span className={styles.rowSub}>{row.itemRevisionMissing} 行历史缺当时资料版本</span>
                      ) : null}
                    </td>
                    <td className={styles.actionCell}>
                      <ProductDetailButton row={row} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className={styles.panelNote}>
        {domesticOnlyScope
          ? '点「详情」看该商品的国内冻结记录（原数量 / 编码 / 文件日期）；不与海外合计。'
          : '点数量格下钻到仓库明细；点「详情」看该商品在当前筛选范围的各仓库存。'}
      </p>
    </section>
  );
}
