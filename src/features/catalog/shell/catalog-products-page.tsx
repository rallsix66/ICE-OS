'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Package, Search } from 'lucide-react';
import { EmptyState } from '@/ui/ice-v4/primitives';
import type { CatalogListClientPayload, CatalogListClientRow } from '../local-display/list-client-types';
import { clientRowAsDisplayRow } from '../local-display/list-client-types';
import { applyWarehouseScopeToDisplayRow } from '../local-display/client-scope';
import {
  formatAdoptedUnitCostCell,
  formatSampleLabel,
  pageEntries,
} from '../local-display/list-row-display';
import type { CatalogIssueToolbarModel } from '../issues/types';
import type { useCatalogUrlState } from './use-catalog-url-state';
import styles from './catalog-list.module.css';

const PAGE_SIZE = 20;

type UrlApi = ReturnType<typeof useCatalogUrlState>;
type DisplayStatus = 'loaded' | 'not_imported' | 'read_failed' | 'forbidden';

function fieldOrPending(value: string | null | undefined, pendingLabel = '待补') {
  const trimmed = value?.trim();
  return trimmed ? trimmed : pendingLabel;
}

/**
 * UI-01：主表以商品资料为主（名称、身份、规格、资料状态），
 * 价格按现有金额权限保留但退居次要；库存与货值只保留一句提示 + 定位到库存页。
 */
function materialStatusChip(row: CatalogListClientRow) {
  if (row.materialStatus.includes('待补货号')) return <span className={`${styles.statusChip} ${styles.toneAmber}`}>新品，待补货号</span>;
  if (row.materialStatus.includes('尚未建档')) return <span className={`${styles.statusChip} ${styles.toneAmber}`}>BigSeller 尚未建档</span>;
  if (!row.barcodeText) return <span className={`${styles.statusChip} ${styles.toneQuiet}`}>待补 69 编码</span>;
  if (!row.unitText) return <span className={`${styles.statusChip} ${styles.toneQuiet}`}>单位待确认</span>;
  return <span className={`${styles.statusChip} ${styles.toneGreen}`}>资料已承接</span>;
}

function inventoryHint(row: CatalogListClientRow, warehouse: string, displayStatus: DisplayStatus): string {
  if (displayStatus === 'not_imported') return '库存未接入';
  if (displayStatus === 'read_failed') return '库存读取失败';
  if (displayStatus === 'forbidden') return '库存无权限';
  const inventory = row.inventory;
  if (warehouse !== 'all') {
    const scope = inventory.warehouseScopes?.[warehouse];
    if (scope?.inventoryState === 'failed') return '本仓同步失败，沿用上次成功值';
    if (inventory.hasPendingTotal) return '本仓多编码合计待核对';
    if (scope?.inventoryState === 'unmapped_source') return '本仓来源待对应';
    if (scope?.inventoryState === 'unseen') return '本仓对应待下一批采用';
    if (scope?.inventoryState === 'no_source' || scope?.inventoryState === 'no_data') return '本仓暂无来源记录';
    if (scope?.confirmedLineCount && scope.confirmedLineCount > 0) return '本仓有已确认库存';
    if (inventory.hasCurrentData) return '本仓有当前库存';
    return '本仓暂无当前库存';
  }
  if (inventory.hasPendingTotal) return '部分仓合计待核对';
  if (!inventory.hasCurrentData) return '暂无当前库存（不是 0）';
  return `${inventory.coveredWarehouseCount} / ${inventory.scopeWarehouseCount} 仓有当前库存`;
}

function inventoryHrefFor(row: CatalogListClientRow): string {
  const query = (row.iceCode ?? row.nameCn).trim();
  return `/dashboard/inventory?q=${encodeURIComponent(query)}`;
}

/** 工具栏固定“待处理”入口：有真实问题才显示计数；读取失败可重试；无权不显示计数、不制造警报。 */
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
          {retrying ? '重试中…' : '重试'}
        </button>
      </span>
    );
  }
  if (issues?.state === 'ok' && issues.issueCount > 0) {
    return (
      <Link className={styles.issueEntryAlert} href="/dashboard/catalog/issues">
        <AlertTriangle size={14} strokeWidth={1.8} aria-hidden />
        待处理 {issues.issueCount} 项 / {issues.itemCount} 款
      </Link>
    );
  }
  // ok && 0 项、forbidden、未接线（null/undefined）都只保留安静入口，不制造警报。
  return (
    <Link className={styles.issueEntry} href="/dashboard/catalog/issues">
      待处理
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
  const [expandedItemId, setExpandedItemId] = useState<string | null>(null);
  const [retrying, startRetry] = useTransition();
  const paginationRef = useRef<HTMLElement | null>(null);
  const pendingPageAnchor = useRef<{ top: number | null } | null>(null);
  /** 每次需要恢复分页位置时递增；与 currentPage 解耦，使“搜索收敛但页码不变”也能触发一次恢复。 */
  const [anchorToken, setAnchorToken] = useState(0);

  const retry = useCallback(() => {
    if (retrying) return; // 防止重复发起并发刷新
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

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  // 渲染即用有效页：越界页码（page=999 等）不会出现“第999/7页 + 空表”，随后由 effect 规范化 URL。
  const currentPage = Math.min(Math.max(1, Math.floor(page)), pageCount);
  const pageRows = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const pageButtons = pageEntries(currentPage, pageCount);

  useEffect(() => {
    if (page !== currentPage) normalizePage(pageCount);
  }, [page, currentPage, pageCount, normalizePage]);

  /**
   * U6/V3-05：保持底部分页控件在视口中的位置。
   * - `always`：点击页码/上一页/下一页（控件必然可见）时记录；
   * - `if-visible`：搜索、切仓、清空导致页数收敛时，仅当用户当前正看着分页区才恢复，
   *   避免把停在页面顶部的用户强行拽到底部。
   */
  const capturePaginationAnchor = useCallback((mode: 'always' | 'if-visible') => {
    const nav = paginationRef.current;
    if (!nav) return;
    const rect = nav.getBoundingClientRect();
    if (mode === 'if-visible' && (rect.top < 0 || rect.top > window.innerHeight)) return;
    pendingPageAnchor.current = { top: rect.top };
    setAnchorToken((token) => token + 1);
  }, []);

  /**
   * 换页/页数收敛后把同一分页控件调回原视口位置：
   * 等一帧渲染 + 再一帧布局稳定，按 rect.top 差值回调 scrollY，夹取到合法 document 范围；
   * 末页条目变少导致文档变矮时允许上移，但不回页面顶部。
   * 关闭详情恢复阅读位置仍由 useCatalogUrlState 的 scrollY 机制负责，这里不与之竞争。
   */
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
        // 兜底：位置调整后分页控件仍需在视口内（夹取后极端情况下也不留在屏外）。
        const rect = nav.getBoundingClientRect();
        if (rect.top < 0) {
          window.scrollBy({ top: rect.top - 8, left: 0 });
        } else if (rect.bottom > window.innerHeight) {
          window.scrollBy({ top: rect.bottom - window.innerHeight + 8, left: 0 });
        }
        // 焦点不在此处搬动：页码按钮按 page number 稳定 keyed，被点的页码按钮换页后仍是当前页并保持焦点；
        // 结果变化只用 aria-live 通知，不自动聚焦表头或其它控件。
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

  const sampleLabel = formatSampleLabel(payload?.observationAt ?? null);
  const isFiltering = query.trim().length > 0;
  const moreId = (itemId: string) => `catalog-row-more-${itemId}`;

  return (
    <>
      <header className={styles.pageIntro} data-testid="catalog-page-intro">
        <div className={styles.introText}>
          <h2 className={styles.introTitle}>商品资料</h2>
          <p className={styles.introLead}>
            以商品名称和身份资料为主；数量与货值请到「商品库存」查看。
            来源 SKU 的绑定与更换在商品库存详情的对应仓库行内完成，不再单独维护。
          </p>
        </div>
        <div className={styles.introLinks}>
          <Link className={styles.quietLink} href="/dashboard/inventory">
            商品库存
          </Link>
        </div>
      </header>

      <div className={styles.toolbar}>
        <label className={styles.searchField}>
          <Search size={16} aria-hidden />
          <input
            type="search"
            aria-label="搜索货号、中英文名、69编码或已确认来源SKU"
            placeholder="货号 / 名称 / 69编码 / 来源SKU"
            value={query}
            onChange={(e) => handleQueryChange(e.target.value)}
          />
        </label>
        {payload && (
          <select className={styles.select} aria-label="仓库筛选" data-testid="catalog-warehouse-filter" value={warehouse} onChange={(e) => handleWarehouseChange(e.target.value)}>
            <option value="all">全部仓库</option>
            {payload.warehouseOptions.map((wh) => <option key={wh} value={wh}>{wh}</option>)}
          </select>
        )}
        {/* 明确的手动刷新：读取失败时可重试，正常浏览也可主动刷新同一筛选结果（不改变 q/warehouse/page）。 */}
        <button
          type="button"
          className={styles.toolbarButton}
          data-testid="catalog-list-refresh"
          aria-label="刷新列表（重新读取系统已保存的库存，不会重新导出 BigSeller）"
          title="刷新只重新读取系统已保存的数据；重新导出 BigSeller 请到“数据同步”页点“立即同步”"
          disabled={retrying}
          onClick={retry}
        >
          {retrying ? '刷新中…' : '刷新'}
        </button>
        <button type="button" className={styles.toolbarButton} onClick={handleReset}>清空</button>
        <IssueToolbarEntry issues={issues} retrying={retrying} onRetry={retry} />
      </div>

      {auxiliaryErrors.length > 0 && (
        <ul className={styles.noticeList} role="status">
          {auxiliaryErrors.map((msg) => <li key={msg} className={styles.noticeItem}>{msg}</li>)}
        </ul>
      )}

      {displayStatus === 'read_failed' && (
        <div className={`${styles.notice} ${styles.noticeAlert}`} role="alert">
          <div className={styles.noticeText}>
            <strong>库存与价格资料读取失败（网络或传输异常）</strong>
            <p>商品主资料仍可浏览；库存与采用进货价暂不可用，不回退旧样表。{displayError ? <span className={styles.noticeDetail}>（{displayError}）</span> : null}</p>
          </div>
          <button type="button" className={styles.retryButton} onClick={retry} disabled={retrying}>
            {retrying ? '正在重新读取…' : '重试'}
          </button>
        </div>
      )}

      {displayStatus === 'forbidden' && (
        <div className={`${styles.notice} ${styles.noticeWarn}`} role="status">
          <div className={styles.noticeText}>
            <strong>无权读取库存数据</strong>
            <p>当前账号无权读取 BigSeller 库存；主商品资料仍可浏览，库存与金额不显示。</p>
          </div>
        </div>
      )}

      {displayStatus === 'not_imported' && (
        <div className={`${styles.notice} ${styles.noticeWarn}`} role="status">
          <div className={styles.noticeText}>
            <strong>库存模块当前未接入 / 未覆盖</strong>
            <p>{displayError ?? '尚未读取到 BigSeller 库存；库存显示“未接入”，不当作 0，也不回退旧样表。'}</p>
          </div>
        </div>
      )}

      {displayStatus === 'loaded' && (
        <p className={styles.sampleDate} data-testid="catalog-sample-date">{sampleLabel}</p>
      )}

      <section className={styles.panel} aria-label="商品资料列表" data-list-scroll-anchor="catalog-list">
        <div className={styles.panelHead}>
          <h2 className={styles.panelTitle} data-testid="catalog-counts">
            商品资料 · {filtered.length === itemCount ? filtered.length : `${filtered.length} / ${itemCount}`} 款
          </h2>
        </div>

        <div className={styles.panelBody}>
          {filtered.length === 0 ? (
            isFiltering ? (
              <EmptyState onReset={handleReset} />
            ) : (
              <div className={styles.emptyPanel} role="status">
                <Package size={26} strokeWidth={1.4} aria-hidden />
                <h3>暂无可展示的真实商品资料</h3>
                <p>当前资料库还没有已承接的基线商品；这不是“筛选无结果”。</p>
              </div>
            )
          ) : (
            <>
              <div className={styles.tableShell}>
                <table className={styles.table} aria-label="商品资料列表">
                  <thead>
                    <tr>
                      <th scope="col" className={styles.colIdentity}>商品资料（图片 / 名称 / ICE 货号 / 69 编码）</th>
                      <th scope="col" className={styles.colSpec}>规格 / 单位</th>
                      <th scope="col" className={styles.colStatus}>资料状态</th>
                      <th scope="col" className={`${styles.colPrice} ${styles.numericHead}`}>采用进货价</th>
                      <th scope="col" className={styles.colStock}>库存与货值</th>
                      <th scope="col" className={styles.colActions}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map((row) => {
                      const expanded = expandedItemId === row.itemId;
                      const unitCostLabel = formatAdoptedUnitCostCell(row.adoptedUnitCost);
                      const choices = row.humanChoices.bigseller + row.humanChoices.jushuitan;
                      return [
                        <tr
                          key={row.itemId}
                          className={styles.row}
                          data-testid={row.iceCode ? `catalog-row-${row.iceCode}` : undefined}
                          data-expanded={expanded ? 'true' : 'false'}
                        >
                          <td className={`${styles.cell} ${styles.colIdentity}`} data-label="商品资料">
                            <div className={styles.identity}>
                              <span className={styles.art} aria-label="图片占位" title="图片占位（本页暂不展示商品图）">
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
                                <button
                                  type="button"
                                  className={styles.moreButton}
                                  aria-expanded={expanded}
                                  aria-controls={moreId(row.itemId)}
                                  onClick={() => setExpandedItemId(expanded ? null : row.itemId)}
                                >
                                  {expanded ? '收起资料' : '更多资料'}
                                </button>
                              </div>
                            </div>
                          </td>
                          <td className={`${styles.cell} ${styles.colSpec}`} data-label="规格 / 单位">
                            <span className={styles.specText}>{fieldOrPending(row.specificationText, '规格待补')}</span>
                            <span className={styles.specUnit}>{row.unitText ? `单位：${row.unitText}` : '单位待确认'}</span>
                          </td>
                          <td className={`${styles.cell} ${styles.colStatus}`} data-label="资料状态">
                            {materialStatusChip(row)}
                          </td>
                          <td className={`${styles.cell} ${styles.colPrice} ${styles.metricCell}`} data-label="采用进货价">
                            <span className={styles.priceValue} data-testid="catalog-unit-cost">{unitCostLabel}</span>
                            <span className={styles.priceNote}>人民币 / 单品</span>
                          </td>
                          <td className={`${styles.cell} ${styles.colStock}`} data-label="库存与货值">
                            <span className={styles.stockHint} data-testid="catalog-bs-inventory">
                              {inventoryHint(row, warehouse, displayStatus)}
                            </span>
                            <Link
                              className={styles.stockLink}
                              href={inventoryHrefFor(row)}
                              data-testid="catalog-inventory-link"
                              title="到「商品库存」查看该商品各仓数量、来源时间与批次"
                            >
                              查看库存
                            </Link>
                            <span className={styles.valueHint} data-testid="catalog-estimated-value">货值暂未计算</span>
                          </td>
                          <td className={`${styles.cell} ${styles.colActions}`} data-label="操作">
                            <div className={styles.actionGroup}>
                              <button type="button" className={styles.actionButton} onClick={() => openDetail(row.itemId)}>查看详情</button>
                            </div>
                          </td>
                        </tr>,
                        <tr
                          key={`${row.itemId}-more`}
                          id={moreId(row.itemId)}
                          className={styles.moreRow}
                          data-expanded={expanded ? 'true' : 'false'}
                        >
                          <td colSpan={6} className={styles.moreCell}>
                            <dl className={styles.moreGrid}>
                              <div className={styles.moreItem}><dt>69编码</dt><dd>{fieldOrPending(row.barcodeText)}</dd></div>
                              <div className={styles.moreItem}><dt>英文名称</dt><dd>{fieldOrPending(row.englishName)}</dd></div>
                              <div className={styles.moreItem}><dt>分类</dt><dd>{fieldOrPending(row.categoryText)}</dd></div>
                              <div className={styles.moreItem}><dt>单位</dt><dd>{fieldOrPending(row.unitText, '—')}</dd></div>
                              <div className={styles.moreItem}><dt>来源对应</dt><dd>{choices} 条本批已确认</dd></div>
                              <div className={styles.moreItem}><dt>库存覆盖</dt><dd>{row.inventory.coveredWarehouseCount} / {row.inventory.scopeWarehouseCount} 仓有当前库存</dd></div>
                              <div className={styles.moreItem}><dt>最近来源</dt><dd>{row.inventory.lastObservedAt ? new Date(row.inventory.lastObservedAt).toLocaleString('zh-CN', { hour12: false }) : '未读取到'}</dd></div>
                              {row.inventory.hasPendingTotal && (
                                <div className={styles.moreItem}>
                                  <dt>合计待核对</dt>
                                  <dd>{row.inventory.pendingTotalWarehouses.map((group) => `${group.name}：${group.rows.map((line) => `${line.externalSku}=${line.onHand ?? '未知'}`).join('、')}`).join('；')}（逐行显示，未相加）</dd>
                                </div>
                              )}
                              <div className={styles.moreItem}>
                                <dt>采用进货价原值</dt>
                                <dd>{row.adoptedUnitCost?.state === 'priced' ? row.adoptedUnitCost.amountCny : '无'}</dd>
                              </div>
                              <div className={styles.moreItem}>
                                <dt>当前货值</dt>
                                <dd>暂未计算（本包不新做估值）</dd>
                              </div>
                              <div className={styles.moreItem}>
                                <dt>库存与来源</dt>
                                <dd><Link href={inventoryHrefFor(row)}>到「商品库存」查看</Link></dd>
                              </div>
                            </dl>
                          </td>
                        </tr>,
                      ];
                    })}
                  </tbody>
                </table>
              </div>

              {pageCount > 1 && (
                <nav ref={paginationRef} className={styles.pagination} aria-label="商品资料分页" data-testid="catalog-pagination">
                  <button
                    type="button"
                    className={styles.pageButton}
                    aria-label="上一页"
                    aria-disabled={currentPage <= 1}
                    disabled={currentPage <= 1}
                    onClick={() => goToPage(currentPage - 1)}
                  >
                    上一页
                  </button>
                  <span className={styles.pageNumbers}>
                    {pageButtons.map((entry, index) => (
                      entry === 'ellipsis' ? (
                        <span key={`ellipsis-${index}`} className={styles.pageEllipsis} aria-hidden>…</span>
                      ) : (
                        <button
                          key={entry}
                          type="button"
                          data-page={entry}
                          className={`${styles.pageButton} ${styles.pageNumber} ${entry === currentPage ? styles.pageNumberCurrent : ''}`}
                          aria-label={`第 ${entry} 页`}
                          aria-current={entry === currentPage ? 'page' : undefined}
                          onClick={() => goToPage(entry)}
                        >
                          {entry}
                        </button>
                      )
                    ))}
                  </span>
                  <button
                    type="button"
                    className={styles.pageButton}
                    aria-label="下一页"
                    aria-disabled={currentPage >= pageCount}
                    disabled={currentPage >= pageCount}
                    onClick={() => goToPage(currentPage + 1)}
                  >
                    下一页
                  </button>
                  <span className={styles.pageStatus} data-testid="catalog-page-label">第 {currentPage} / {pageCount} 页</span>
                  <span className={styles.liveStatus} role="status" aria-live="polite">
                    第 {currentPage} 页，共 {pageCount} 页，{filtered.length} 款
                  </span>
                </nav>
              )}
            </>
          )}
        </div>
      </section>
    </>
  );
}
