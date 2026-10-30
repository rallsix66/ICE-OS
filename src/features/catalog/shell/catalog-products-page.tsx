'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Loader2, Package, RefreshCw } from 'lucide-react';
import {
  EmptyState,
  PageHeading,
  SearchField,
  SelectMenu,
} from '@/ui/ice-v4/data-surface';
import {
  ColumnsMenu,
  SortableTh,
  sortRows,
  useTableControls,
} from '@/ui/ice-v4/table-tools';
import type { TableColumn } from '@/ui/ice-v4/table-tools';
import sharedStyles from '@/ui/ice-v4/data-surface.module.css';
import type { CatalogListClientPayload, CatalogListClientRow } from '../local-display/list-client-types';
import { clientRowAsDisplayRow } from '../local-display/list-client-types';
import { applyWarehouseScopeToDisplayRow } from '../local-display/client-scope';
import { formatAdoptedUnitCostCell, pageEntries } from '../local-display/list-row-display';
import type { CatalogIssueToolbarModel } from '../issues/types';
import type { useCatalogUrlState } from './use-catalog-url-state';
import styles from './catalog-list.module.css';

const PAGE_SIZE = 20;
const TABLE_STORAGE_KEY = 'catalog.products.table.v2';

/** 列定义：商品 / 规格 / 采用进货价 / 库存 / 资料状态 / 操作（操作固定宽、不可隐藏）。
 *  数据列用百分比宽度：随表格宽度伸缩、铺满，列表底部留一条窄填充带作为拖拽余量；
 *  拖动某一列时只改这一列的占比，其余列宽度不变，分界线跟手。 */
const COLUMNS: TableColumn[] = [
  { key: 'identity', label: '商品', width: '29%' },
  { key: 'spec', label: '规格 / 单位', width: '13%' },
  { key: 'price', label: '采用进货价', numeric: true, width: '13%' },
  { key: 'stock', label: '库存', numeric: true, width: '19%' },
  { key: 'status', label: '资料状态', width: '12%' },
  { key: 'actions', label: '操作', hideable: false, sortable: false, resizable: false },
];

const columnOf = (key: string): TableColumn => COLUMNS.find((column) => column.key === key) ?? COLUMNS[0];

/** 排序列取值：空值排后；进价取数值；库存按覆盖仓数/占比。 */
const SORT_ACCESSORS: Record<string, (row: CatalogListClientRow) => string | number | null> = {
  identity: (row) => row.nameCn,
  spec: (row) => row.specificationText,
  status: (row) => row.materialStatus,
  price: (row) => {
    if (row.adoptedUnitCost?.state !== 'priced') return null;
    const amount = Number(row.adoptedUnitCost.amountCny);
    return Number.isFinite(amount) ? amount : null;
  },
  stock: (row) => {
    const scope = row.inventory.scopeWarehouseCount;
    if (!scope) return null;
    return row.inventory.coveredWarehouseCount / scope;
  },
};

type UrlApi = ReturnType<typeof useCatalogUrlState>;
type DisplayStatus = 'loaded' | 'not_imported' | 'read_failed' | 'forbidden';

function fieldOrPending(value: string | null | undefined, pendingLabel = '待补') {
  const trimmed = value?.trim();
  return trimmed ? trimmed : pendingLabel;
}

function pad2(value: number) {
  return String(value).padStart(2, '0');
}

/** 列表唯一的数据时间：`2026-10-29 10:00`。取不到时返回 null，不编造日期。 */
function formatDataTime(observationAt: string | null | undefined): string | null {
  if (!observationAt) return null;
  const date = new Date(observationAt);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function materialStatusChip(row: CatalogListClientRow) {
  if (row.materialStatus.includes('待补货号')) return <span className={`${styles.statusChip} ${styles.toneAmber}`}>新品，待补货号</span>;
  if (row.materialStatus.includes('尚未建档')) return <span className={`${styles.statusChip} ${styles.toneAmber}`}>BigSeller 尚未建档</span>;
  if (!row.barcodeText) return <span className={`${styles.statusChip} ${styles.toneQuiet}`}>待补 69 编码</span>;
  if (!row.unitText) return <span className={`${styles.statusChip} ${styles.toneQuiet}`}>单位待确认</span>;
  return <span className={`${styles.statusChip} ${styles.toneGreen}`}>资料已承接</span>;
}

/** 库存只给一句短状态；数量、来源与批次去商品库存页看。 */
function inventoryHint(row: CatalogListClientRow, warehouse: string, displayStatus: DisplayStatus): string {
  if (displayStatus === 'not_imported') return '库存未接入';
  if (displayStatus === 'read_failed') return '库存读取失败';
  if (displayStatus === 'forbidden') return '库存无权限';
  const inventory = row.inventory;
  if (warehouse !== 'all') {
    const scope = inventory.warehouseScopes?.[warehouse];
    if (scope?.inventoryState === 'failed') return '本仓同步失败';
    if (inventory.hasPendingTotal) return '本仓多编码合计待核对';
    if (scope?.inventoryState === 'unmapped_source') return '本仓来源待对应';
    if (scope?.inventoryState === 'unseen') return '本仓对应待下一批采用';
    if (scope?.inventoryState === 'no_source' || scope?.inventoryState === 'no_data') return '本仓暂无来源记录';
    if (scope?.confirmedLineCount && scope.confirmedLineCount > 0) return '本仓有已确认库存';
    if (inventory.hasCurrentData) return '本仓有当前库存';
    return '本仓暂无当前库存';
  }
  if (inventory.hasPendingTotal) return '部分仓合计待核对';
  if (!inventory.hasCurrentData) return '暂无当前库存';
  return `${inventory.coveredWarehouseCount} / ${inventory.scopeWarehouseCount} 仓有当前库存`;
}

/** 待处理入口：普通按钮 + 小数字徽标；读取失败可重试；无权不制造警报。 */
function IssueToolbarEntry({
  issues,
  retrying,
  onRetry,
}: {
  issues: CatalogIssueToolbarModel | undefined;
  retrying: boolean;
  onRetry: () => void;
}) {
  if (issues?.state === 'read_failed') {
    return (
      <span className={styles.issueFailed} role="status">
        待处理读取失败
        <button type="button" className={styles.issueRetry} onClick={onRetry} disabled={retrying} aria-label="重新读取待处理">
          {retrying ? '重试中' : '重试'}
        </button>
      </span>
    );
  }
  return (
    <Link className={styles.issueEntry} href="/dashboard/catalog/issues">
      待处理
      {issues?.state === 'ok' && issues.issueCount > 0 ? (
        <span className={styles.issueCountBadge}>{issues.issueCount}</span>
      ) : null}
    </Link>
  );
}

export function CatalogProductsPage({
  payload,
  displayStatus,
  displayError,
  itemCount,
  auxiliaryErrors = [],
  issues,
  url,
}: {
  payload: CatalogListClientPayload | null;
  displayStatus: DisplayStatus;
  displayError: string | null;
  itemCount: number;
  auxiliaryErrors?: string[];
  issues?: CatalogIssueToolbarModel;
  url: UrlApi;
}) {
  const { q: query, warehouse, page, setQuery, setWarehouse, setPage, normalizePage, resetFilters, openDetail } = url;
  const router = useRouter();
  const [retrying, startRetry] = useTransition();
  const paginationRef = useRef<HTMLElement | null>(null);
  const pendingPageAnchor = useRef<{ top: number | null } | null>(null);
  /** 每次需要恢复分页位置时递增；与 currentPage 解耦，使“搜索收敛但页码不变”也能触发一次恢复。 */
  const [anchorToken, setAnchorToken] = useState(0);
  const [jumpValue, setJumpValue] = useState('');
  const table = useTableControls({ storageKey: TABLE_STORAGE_KEY, columns: COLUMNS });

  const retry = useCallback(() => {
    if (retrying) return;
    startRetry(() => router.refresh());
  }, [retrying, startRetry, router]);

  const viewRows = useMemo(() => {
    const rows = payload?.rows ?? [];
    if (warehouse === 'all') return rows;
    return rows.map((row) => {
      const scoped = applyWarehouseScopeToDisplayRow(clientRowAsDisplayRow(row), warehouse);
      const clientInventory: Record<string, unknown> = { ...scoped.inventory };
      delete clientInventory.lines;
      return { ...row, inventory: clientInventory as typeof row.inventory };
    });
  }, [payload, warehouse]);

  const filtered = useMemo(() => viewRows.filter((row) => {
    const tokens = row.sourceSearchTokens?.join(' ') ?? '';
    const hay = `${row.nameCn} ${row.iceCode ?? ''} ${row.specificationText} ${row.englishName ?? ''} ${row.barcodeText ?? ''} ${tokens}`.toLowerCase();
    return hay.includes(query.toLowerCase());
  }), [viewRows, query]);

  /** 先排序再分页；默认不排序时保持服务端顺序。 */
  const sorted = useMemo(() => sortRows(filtered, table.sort, SORT_ACCESSORS), [filtered, table.sort]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const currentPage = Math.min(Math.max(1, Math.floor(page)), pageCount);
  const pageRows = sorted.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const pageButtons = pageEntries(currentPage, pageCount);

  useEffect(() => {
    if (page !== currentPage) normalizePage(pageCount);
  }, [page, currentPage, pageCount, normalizePage]);

  /**
   * 保持底部分页控件在视口中的位置。
   * - `always`：点击页码/上一页/下一页（控件必然可见）时记录；
   * - `if-visible`：搜索、切仓、清空导致页数收敛时，仅当用户当前正看着分页区才恢复。
   */
  const capturePaginationAnchor = useCallback((mode: 'always' | 'if-visible') => {
    const nav = paginationRef.current;
    if (!nav) return;
    const rect = nav.getBoundingClientRect();
    if (mode === 'if-visible' && (rect.top < 0 || rect.top > window.innerHeight)) return;
    pendingPageAnchor.current = { top: rect.top };
    setAnchorToken((token) => token + 1);
  }, []);

  useEffect(() => {
    const pending = pendingPageAnchor.current;
    if (!pending) return;
    pendingPageAnchor.current = null;
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        const nav = paginationRef.current;
        if (!nav) return;
        if (pending.top !== null) {
          const currentTop = nav.getBoundingClientRect().top;
          const delta = currentTop - pending.top;
          if (Math.abs(delta) >= 0.5) {
            const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
            const nextScroll = Math.min(Math.max(0, window.scrollY + delta), maxScroll);
            window.scrollTo({ top: nextScroll, left: 0 });
          }
        }
        const rect = nav.getBoundingClientRect();
        if (rect.top < 0) {
          window.scrollBy({ top: rect.top - 8, left: 0 });
        } else if (rect.bottom > window.innerHeight) {
          window.scrollBy({ top: rect.bottom - window.innerHeight + 8, left: 0 });
        }
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
    };
  }, [anchorToken]);

  const goToPage = useCallback((next: number) => {
    const target = Math.min(Math.max(1, Math.floor(next)), pageCount);
    if (target === currentPage) return;
    capturePaginationAnchor('always');
    setPage(target);
  }, [currentPage, pageCount, capturePaginationAnchor, setPage]);

  const handleQueryChange = useCallback((nextQuery: string) => {
    capturePaginationAnchor('if-visible');
    setQuery(nextQuery);
  }, [capturePaginationAnchor, setQuery]);

  const handleWarehouseChange = useCallback((nextWarehouse: string) => {
    capturePaginationAnchor('if-visible');
    setWarehouse(nextWarehouse);
  }, [capturePaginationAnchor, setWarehouse]);

  const handleReset = useCallback(() => {
    capturePaginationAnchor('if-visible');
    resetFilters();
  }, [capturePaginationAnchor, resetFilters]);

  const goToJump = useCallback(() => {
    const next = Number.parseInt(jumpValue, 10);
    setJumpValue('');
    if (!Number.isFinite(next)) return;
    goToPage(next);
  }, [goToPage, jumpValue]);

  const dataTime = displayStatus === 'loaded' ? formatDataTime(payload?.observationAt ?? null) : null;
  const isFiltering = query.trim().length > 0;
  /** 与库存页同一规则：没有任何筛选时「清空」置灰，不隐藏。 */
  const hasFilters = isFiltering || warehouse !== 'all';
  const warehouseOptions = [
    { value: 'all', label: '全部仓库' },
    ...(payload?.warehouseOptions.map((wh) => ({ value: wh, label: wh })) ?? []),
  ];

  return (
    <>
      <PageHeading title="商品库" />

      <div className={sharedStyles.toolbar}>
        <SearchField
          value={query}
          onChange={handleQueryChange}
          placeholder="货号 / 名称 / 69编码 / 来源SKU"
          ariaLabel="搜索货号、中英文名、69编码或已确认来源SKU"
        />
        {payload && (
          <SelectMenu
            value={warehouse}
            onChange={handleWarehouseChange}
            options={warehouseOptions}
            ariaLabel="仓库筛选"
            testId="catalog-warehouse-filter"
          />
        )}
        <button
          type="button"
          className={`${sharedStyles.button} ${sharedStyles.buttonIcon}`}
          data-testid="catalog-list-refresh"
          aria-label="刷新列表"
          disabled={retrying}
          onClick={retry}
        >
          {retrying
            ? <Loader2 className={styles.spin} size={16} strokeWidth={2} aria-hidden />
            : <RefreshCw size={16} strokeWidth={1.8} aria-hidden />}
        </button>
        <ColumnsMenu columns={COLUMNS} controls={table} testId="catalog-columns-menu" />
        <button
          type="button"
          className={`${sharedStyles.button} ${styles.toolbarButton}`}
          onClick={handleReset}
          disabled={!hasFilters}
          data-testid="catalog-clear-filters"
        >
          清空
        </button>
        <IssueToolbarEntry issues={issues} retrying={retrying} onRetry={retry} />
        <span className={sharedStyles.count} data-testid="catalog-counts">
          {filtered.length === itemCount ? `共 ${filtered.length} 款` : `共 ${filtered.length} / ${itemCount} 款`}
        </span>
        {dataTime ? <span className={styles.dataTime} data-testid="catalog-sample-date">数据时间 {dataTime}</span> : null}
      </div>

      {auxiliaryErrors.length > 0 && (
        <ul className={styles.noticeList} role="status">
          {auxiliaryErrors.map((msg) => <li key={msg}>{msg.split('；')[0]}</li>)}
        </ul>
      )}

      {displayStatus === 'read_failed' && (
        <div className={`${styles.notice} ${styles.noticeAlert}`} role="alert">
          <span className={styles.noticeTitle}>库存与价格读取失败</span>
          {displayError ? <span className={styles.noticeError} title={displayError}>{displayError}</span> : null}
          <button type="button" className={sharedStyles.button} onClick={retry} disabled={retrying}>
            {retrying ? '重试中' : '重试'}
          </button>
        </div>
      )}

      {displayStatus === 'forbidden' && (
        <div className={`${styles.notice} ${styles.noticeWarn}`} role="status">
          <span className={styles.noticeTitle}>库存无权限</span>
        </div>
      )}

      {displayStatus === 'not_imported' && (
        <div className={`${styles.notice} ${styles.noticeWarn}`} role="status">
          <span className={styles.noticeTitle}>库存未接入</span>
          {displayError ? <span className={styles.noticeError} title={displayError}>{displayError}</span> : null}
        </div>
      )}

      <section className={styles.panel} aria-label="商品库列表" data-list-scroll-anchor="catalog-list">
        <div className={styles.panelBody}>
          {filtered.length === 0 ? (
            isFiltering ? (
              <EmptyState
                title="没有符合条件的商品"
                action={<button type="button" className={sharedStyles.button} onClick={handleReset}>清空筛选</button>}
              />
            ) : (
              <EmptyState title="暂无商品资料" />
            )
          ) : (
            <>
              <div className={styles.tableShell}>
                <table className={styles.table} aria-label="商品列表">
                  <thead>
                    <tr>
                      {table.isVisible('identity') && (
                        <SortableTh column={columnOf('identity')} controls={table} className={styles.colIdentity} sticky />
                      )}
                      {table.isVisible('spec') && (
                        <SortableTh column={columnOf('spec')} controls={table} className={styles.colSpec} sticky />
                      )}
                      {table.isVisible('price') && (
                        <SortableTh column={columnOf('price')} controls={table} className={styles.numericHead} sticky />
                      )}
                      {table.isVisible('stock') && (
                        <SortableTh column={columnOf('stock')} controls={table} className={`${styles.colStock} ${styles.numericHead}`} sticky />
                      )}
                      {table.isVisible('status') && (
                        <SortableTh column={columnOf('status')} controls={table} className={styles.colStatus} sticky />
                      )}
                      {table.isVisible('actions') && (
                        <SortableTh column={columnOf('actions')} controls={table} className={`${styles.colActions} ${styles.numericHead}`} sticky />
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map((row) => {
                      const unitCostLabel = formatAdoptedUnitCostCell(row.adoptedUnitCost);
                      return (
                        <tr
                          key={row.itemId}
                          className={styles.row}
                          data-testid={row.iceCode ? `catalog-row-${row.iceCode}` : undefined}
                        >
                          {table.isVisible('identity') && (
                            <td className={`${styles.cell} ${styles.colIdentity}`} data-label="商品">
                              <div className={styles.identity}>
                                <span className={styles.art} aria-hidden>
                                  <Package size={18} strokeWidth={1.4} />
                                </span>
                                <div className={styles.identityText}>
                                  <button type="button" className={styles.nameButton} onClick={() => openDetail(row.itemId)}>
                                    {row.nameCn}
                                  </button>
                                  <span className={styles.identityMeta}>
                                    <span className={styles.identityCode}>ICE 货号：{fieldOrPending(row.iceCode, '待补货号')}</span>
                                    <span className={styles.identityDivider} aria-hidden>·</span>
                                    <span className={styles.identityBarcode}>69 编码：{fieldOrPending(row.barcodeText, '待补')}</span>
                                  </span>
                                </div>
                              </div>
                            </td>
                          )}
                          {table.isVisible('spec') && (
                            <td className={`${styles.cell} ${styles.colSpec}`} data-label="规格 / 单位">
                              <span className={styles.specText}>{fieldOrPending(row.specificationText, '规格待补')}</span>
                              <span className={styles.specUnit}>{row.unitText ? `单位：${row.unitText}` : '单位待确认'}</span>
                            </td>
                          )}
                          {table.isVisible('price') && (
                            <td className={`${styles.cell} ${styles.colPrice} ${styles.metricCell}`} data-label="采用进货价">
                              <span className={styles.priceValue} data-testid="catalog-unit-cost">{unitCostLabel}</span>
                            </td>
                          )}
                          {table.isVisible('stock') && (
                            <td className={`${styles.cell} ${styles.colStock} ${styles.metricCell}`} data-label="库存">
                              <span className={styles.stockHint} data-testid="catalog-bs-inventory">
                                {inventoryHint(row, warehouse, displayStatus)}
                              </span>
                            </td>
                          )}
                          {table.isVisible('status') && (
                            <td className={`${styles.cell} ${styles.colStatus}`} data-label="资料状态">
                              {materialStatusChip(row)}
                            </td>
                          )}
                          {table.isVisible('actions') && (
                            <td className={`${styles.cell} ${styles.colActions}`} data-label="操作">
                              <div className={styles.actionGroup}>
                                <button type="button" className={styles.actionButton} onClick={() => openDetail(row.itemId)}>详情</button>
                              </div>
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {pageCount > 1 && (
                <div className={styles.pagerRow}>
                  <nav ref={paginationRef} className={sharedStyles.pager} aria-label="商品资料分页" data-testid="catalog-pagination">
                    <span className={sharedStyles.pagerInfo} data-testid="catalog-page-label">第 {currentPage} / {pageCount} 页</span>
                    <div className={sharedStyles.pagerNav}>
                      <button
                        type="button"
                        className={`${sharedStyles.pageBtn} ${currentPage <= 1 ? sharedStyles.pageBtnDisabled : ''}`}
                        aria-label="上一页"
                        aria-disabled={currentPage <= 1}
                        disabled={currentPage <= 1}
                        onClick={() => goToPage(currentPage - 1)}
                      >
                        上一页
                      </button>
                      {pageButtons.map((entry, index) => (
                        entry === 'ellipsis' ? (
                          <span key={`ellipsis-${index}`} className={sharedStyles.pageGap} aria-hidden>…</span>
                        ) : (
                          <button
                            key={entry}
                            type="button"
                            data-page={entry}
                            className={`${sharedStyles.pageBtn} ${entry === currentPage ? sharedStyles.pageBtnCurrent : ''}`}
                            aria-label={`第 ${entry} 页`}
                            aria-current={entry === currentPage ? 'page' : undefined}
                            onClick={() => goToPage(entry)}
                          >
                            {entry}
                          </button>
                        )
                      ))}
                      <button
                        type="button"
                        className={`${sharedStyles.pageBtn} ${currentPage >= pageCount ? sharedStyles.pageBtnDisabled : ''}`}
                        aria-label="下一页"
                        aria-disabled={currentPage >= pageCount}
                        disabled={currentPage >= pageCount}
                        onClick={() => goToPage(currentPage + 1)}
                      >
                        下一页
                      </button>
                    </div>
                    <label className={sharedStyles.pagerJump}>
                      <span className={sharedStyles.srOnly}>跳转到页码</span>
                      <input
                        className={sharedStyles.pagerJumpInput}
                        type="number"
                        min={1}
                        max={pageCount}
                        value={jumpValue}
                        inputMode="numeric"
                        placeholder="页码"
                        aria-label="跳转到页码"
                        data-testid="catalog-page-jump"
                        onChange={(event) => setJumpValue(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            goToJump();
                          }
                        }}
                      />
                    </label>
                    <button
                      type="button"
                      className={sharedStyles.pagerJumpButton}
                      onClick={goToJump}
                      data-testid="catalog-page-jump-button"
                    >
                      跳转
                    </button>
                    <span className={sharedStyles.srOnly} role="status" aria-live="polite">
                      第 {currentPage} 页，共 {pageCount} 页，{filtered.length} 款
                    </span>
                  </nav>
                </div>
              )}
            </>
          )}
        </div>
      </section>
    </>
  );
}
