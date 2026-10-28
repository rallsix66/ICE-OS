'use client';

import Link from 'next/link';
import styles from './inventory.module.css';
import {
  buildInventoryListHref,
  timestampOr,
  warehouseRowQuantitySummary,
  warehouseRowStatusDisplay,
  warehouseRowTitleDisplay,
  warehouseRowsCountsText,
  type InventoryQueryState,
} from '../model';
import type { InventoryWarehouseRowDto } from '../types';
import { DOMESTIC_WAREHOUSE_LABEL } from '../dual-view';
import type { WarehouseRowsPageResult } from '../dual-view';
import { useInventoryDetail } from './detail-context';

function RowDetailButton({ row }: { row: InventoryWarehouseRowDto }) {
  const api = useInventoryDetail();
  return (
    <button type="button" className={styles.rowDetailButton} onClick={() => api.openRow(row)} data-testid="inventory-row-detail-button">
      详情
    </button>
  );
}

function RowTitleButton({ row }: { row: InventoryWarehouseRowDto }) {
  const api = useInventoryDetail();
  const title = warehouseRowTitleDisplay(row);
  return (
    <button type="button" className={styles.rowNameButton} onClick={() => api.openRow(row)} title="打开该行详情">
      {title.title}
    </button>
  );
}

/** 仓库明细表：每行 = 来源账号 × 仓库 × SKU；名称主、SKU 辅；含未对应与真实 0。 */
export function WarehouseRowsTable({
  query,
  page,
}: {
  query: InventoryQueryState;
  page: WarehouseRowsPageResult;
}) {
  // 国内行排在海外行之后：用当前筛选范围的海外行总数计算跳转页码。
  const overseasRowCount = page.overseasIncluded
    ? page.counts.adopted + page.counts.unmapped + page.counts.pendingAdoption + page.counts.inactive
    : 0;
  const jumpToDomestic = Math.max(1, Math.floor(overseasRowCount / page.limit) + 1);
  const domesticFirstOnPage = page.rows.some((row) => row.source === 'domestic');
  const showDomesticJump = page.domesticIncluded && page.overseasIncluded
    && page.counts.domesticAdopted + page.counts.domesticUnmapped > 0
    && !domesticFirstOnPage;
  // 同批正常行共享同一观测时间：页面集中显示一次，不逐行重复；不同批次/旧值行仍逐行标注。
  const overseasTimes = [...new Set(page.rows
    .filter((row) => row.source === 'bigseller')
    .map((row) => row.observationAt ?? '')
    .filter(Boolean))];
  const uniformObservation = overseasTimes.length === 1 ? overseasTimes[0] : null;
  const batchTimeText = uniformObservation
    ? ` · 批次观测 ${timestampOr(uniformObservation, '—')}`
    : (overseasTimes.length > 1 ? ' · 含不同批次时间的行（逐行标注）' : '');

  return (
    <section className={styles.panelSection} data-testid="inventory-warehouse-rows">
      <div className={styles.panelBar}>
        <p className={styles.panelSummary} data-testid="inventory-warehouse-counts">
          {page.overseasIncluded ? warehouseRowsCountsText(page.counts) : '仅国内表格快照（海外数量未包含）'}
          {page.domesticIncluded
            ? ` · ${DOMESTIC_WAREHOUSE_LABEL}已核对 ${page.counts.domesticAdopted} 行 / 未纳入 ${page.counts.domesticUnmapped} 行`
            : ''}
          {' · '}共 {page.total} 行{batchTimeText}
        </p>
        {showDomesticJump ? (
          <Link
            className={styles.headerLink}
            href={buildInventoryListHref({ ...query, page: jumpToDomestic })}
            data-testid="inventory-domestic-jump"
          >
            跳到国内快照行
          </Link>
        ) : null}
      </div>

      {query.source !== 'overseas' && !page.domesticAvailable ? (
        <p className={styles.inlineError} data-testid="inventory-domestic-unavailable">
          国内表格快照未读取{page.domesticReason ? `：${page.domesticReason}` : ''}。不显示 0，也不替代为其它来源数量。
        </p>
      ) : null}

      {page.rows.length === 0 ? (
        <div className={styles.emptyState} data-testid="inventory-empty">
          <strong>{page.total === 0 ? '当前范围内没有来源行' : '本页没有行'}</strong>
          <p>
            {page.total === 0
              ? '当前筛选没有匹配的仓库来源 SKU，也没有国内表格记录。清空搜索或切换来源范围后可查看全部；这不表示库存为 0。'
              : '页码超出当前结果，已按最后一页显示。'}
          </p>
        </div>
      ) : (
        <div className={styles.tableScroll} tabIndex={0} data-testid="inventory-table-scroll">
          <table className={`${styles.table} ${styles.fixedTable}`}>
            <thead>
              <tr>
                <th className={styles.stickyCol}>商品（名称 / 来源 SKU）</th>
                <th>国家 / 仓库</th>
                <th className={styles.numericHead}>实物库存</th>
                <th className={styles.numericHead}>可售库存</th>
                <th>状态 / 数据时间</th>
                <th className={styles.actionHead}>详情</th>
              </tr>
            </thead>
            <tbody>
              {page.rows.map((row) => {
                const title = warehouseRowTitleDisplay(row);
                const status = warehouseRowStatusDisplay(row);
                const quantity = warehouseRowQuantitySummary(row);
                const focused = Boolean(query.focus) && row.itemId === query.focus;
                const isDomestic = row.source === 'domestic';
                return (
                  <tr
                    key={row.rowKey}
                    id={`inv-row-${row.rowKey}`}
                    data-testid={isDomestic ? 'inventory-domestic-row' : 'inventory-warehouse-row'}
                    data-source={row.source}
                    data-status={row.status}
                    data-focus={focused ? 'true' : undefined}
                    className={focused ? styles.focusRow : undefined}
                  >
                    <td className={styles.stickyCol}>
                      <span className={styles.rowTitle}><RowTitleButton row={row} /></span>
                      <span className={styles.rowSub}>{title.subtitle}</span>
                    </td>
                    <td>
                      <span>{row.warehouseName}</span>
                      <span className={styles.rowSub}>
                        {isDomestic ? `文件 ${row.fileDate ?? '日期见原表'}` : (row.market ? `市场 ${row.market}` : '市场待确认')}
                      </span>
                    </td>
                    <td className={styles.numCell}>
                      <strong data-testid="inventory-row-on-hand">{quantity.primary}</strong>
                      {row.rawOnHand && row.rawOnHand !== String(row.onHand ?? '') ? (
                        <span className={styles.rowSub}>原表：{row.rawOnHand}</span>
                      ) : null}
                    </td>
                    <td className={styles.numCell}>
                      <span>{quantity.secondary ?? '—'}</span>
                      {isDomestic && row.cloudAvailableText ? <span className={styles.rowSub}>云仓可用（原文）：{row.cloudAvailableText}</span> : null}
                    </td>
                    <td className={styles.wrapCell}>
                      <span className={styles.statusLine}>
                        <span className={styles.statusDot} data-tone={status.tone} aria-hidden />
                        {status.label}
                      </span>
                      {isDomestic ? (
                        <span className={styles.rowSub}>表格快照 · 原表未注明观测时间</span>
                      ) : uniformObservation === null ? (
                        <span className={styles.rowSub}>{timestampOr(row.observationAt, '尚无成功观测')}</span>
                      ) : null}
                    </td>
                    <td className={styles.actionCell}>
                      <RowDetailButton row={row} />
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
