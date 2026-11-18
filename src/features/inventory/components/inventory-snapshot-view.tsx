'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import { RefreshCw } from 'lucide-react';
import { EmptyState, SearchField, SelectMenu } from '@/ui/ice-v4/data-surface';
import surface from '@/ui/ice-v4/data-surface.module.css';
import { marketLabel } from '@/features/overview/markets';
import styles from './inventory.module.css';
import {
  buildInventoryListHref,
  buildInventorySnapshotHref,
  formatTimestamp,
  inventoryPageNumbers,
  inventoryPageRange,
  snapshotItemText,
  snapshotQuantityText,
  snapshotUnitText,
  snapshotVersionText,
  snapshotViewedBatchId,
  type InventoryQueryState,
} from '../model';
import type {
  InventorySnapshotBatchDto,
  InventorySnapshotRowsDto,
  InventoryWarehouseDto,
} from '../types';

const SEARCH_DEBOUNCE_MS = 300;

/**
 * 商品库存 › 历史快照（只读）。
 *
 * - 选仓 + 已发布批次分页（按观测时间倒序），超过一页时可翻到更早批次；
 * - 明细按需读取明确批次，来源 SKU 搜索 + 分页；切换批次保留搜索条件；
 * - 明确批次与所选仓不一致/不存在时只给提示，不显示其他批次的数量；
 * - 数量按批次原数展示：真实 0 显示 0，来源缺失显示「未提供」；
 * - 搜索的 SKU 在本批没有记录时显示「本批未见」；
 * - 返回当前库存用原筛选链接，不改写库存列表的 q/warehouse/market/view/source/page。
 */
export function InventorySnapshotView({
  query,
  warehouses,
  warehouseId,
  warehouseSelectionLost = false,
  batches,
  batchTotal,
  batchPage,
  batchLimit,
  detail,
  batchNotice,
  batchesError,
  detailError,
}: {
  query: InventoryQueryState;
  warehouses: InventoryWarehouseDto[];
  warehouseId: string;
  /** 书签指定的仓已不在当前账号授权范围：明确提示重新选仓，不默认改选其他仓。 */
  warehouseSelectionLost?: boolean;
  batches: InventorySnapshotBatchDto[];
  batchTotal: number;
  batchPage: number;
  batchLimit: number;
  detail: InventorySnapshotRowsDto | null;
  batchNotice: {
    kind: 'not_found' | 'warehouse_mismatch' | 'no_account';
    batchWarehouseId: string;
    batchWarehouseName: string;
    observationAt: string;
  } | null;
  batchesError: string | null;
  detailError: string | null;
}) {
  const router = useRouter();
  const [term, setTerm] = useState(query.snapQ);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [searchPending, startSearch] = useTransition();
  const [, startFilter] = useTransition();
  const [refreshPending, startRefresh] = useTransition();

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 受控输入需要跟随 URL 外部变化
    setTerm((current) => (current.trim() === query.snapQ ? current : query.snapQ));
  }, [query.snapQ]);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const confirmedWarehouses = warehouses.filter((warehouse) => warehouse.status === 'confirmed');
  const warehouseOptions = confirmedWarehouses.map((warehouse) => ({
    value: warehouse.id,
    label: `${warehouse.name}${warehouse.market ? `（${marketLabel(warehouse.market)}）` : ''}`,
  }));
  const selectedWarehouse = confirmedWarehouses.find((warehouse) => warehouse.id === warehouseId) ?? null;
  const appliedSearch = detail?.search ?? query.snapQ;
  const batch = detail?.batch ?? null;
  const selectedBatchId = batch?.batchId ?? query.snapBatch;
  // 页面当前实际查看的批次：默认最新时 URL 没有 snapBatch，翻列表/明细分页必须沿用它。
  const viewedBatchId = snapshotViewedBatchId(batch?.batchId, query.snapBatch);
  // 失效书签：warehouseId 为空，但 URL 仍带原仓。搜索/清空/翻页必须保留这个“待重选”上下文，
  // 否则导航会去掉 snapWarehouse，服务端会按“首次打开”自动改选第一个授权仓。
  // 只有用户通过选仓控件主动选择有效仓（next.snapWarehouse）时才替换。
  const retainedWarehouseId = warehouseSelectionLost ? (query.snapWarehouse ?? '') : warehouseId;

  function navigate(
    next: Partial<Pick<InventoryQueryState, 'snapWarehouse' | 'snapBatch' | 'snapQ' | 'snapPage' | 'snapBPage'>>,
    transition = startFilter,
  ) {
    const href = buildInventorySnapshotHref(
      { ...query, snapWarehouse: retainedWarehouseId },
      {
        // 失效仓下没有任何可查看的批次：搜索/清空时不要把旧批次编号带进下一次导航。
        snapBatch: warehouseSelectionLost ? '' : viewedBatchId,
        snapPage: 1,
        ...next,
      },
    );
    transition(() => router.replace(href, { scroll: false }));
  }

  function onSearchChange(value: string) {
    setTerm(value);
    if (timerRef.current) clearTimeout(timerRef.current);
    if (value.trim() === '') {
      navigate({ snapQ: '', snapPage: 1 }, startSearch);
      return;
    }
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      navigate({ snapQ: value.trim(), snapPage: 1 }, startSearch);
    }, SEARCH_DEBOUNCE_MS);
  }

  /** 选批：留在当前批次列表页，只换批次与明细页。 */
  function batchHref(batchId: string): string {
    return buildInventorySnapshotHref(
      { ...query, snapWarehouse: retainedWarehouseId },
      { snapBatch: batchId, snapQ: query.snapQ, snapPage: 1, snapBPage: batchRange.page },
    );
  }

  /** 批次列表翻页：保留当前实际查看的批次与 SKU 搜索，只改左栏页码。 */
  function batchPageHref(page: number): string {
    return buildInventorySnapshotHref(
      { ...query, snapWarehouse: retainedWarehouseId },
      { snapBatch: viewedBatchId, snapQ: query.snapQ, snapPage: query.snapPage, snapBPage: page },
    );
  }

  function pageHref(page: number): string {
    return buildInventorySnapshotHref(
      { ...query, snapWarehouse: retainedWarehouseId },
      { snapBatch: viewedBatchId, snapQ: query.snapQ, snapPage: page, snapBPage: batchRange.page },
    );
  }

  const backHref = buildInventoryListHref({
    q: query.q,
    warehouse: query.warehouse,
    market: query.market,
    view: query.view,
    source: query.source,
    page: query.page,
    sort: query.sort,
    sortDir: query.sortDir,
  });

  const range = detail?.ok
    ? inventoryPageRange(detail.matched, detail.limit, query.snapPage)
    : null;
  const pages = range ? inventoryPageNumbers(range.page, range.pageCount) : [];
  const hasSearch = Boolean(appliedSearch);
  const batchRange = inventoryPageRange(batchTotal, batchLimit, batchPage);
  const selectedBatchPage = detail?.batchRank
    ? Math.ceil(detail.batchRank / Math.max(1, batchLimit))
    : null;
  const offPage = selectedBatchPage !== null
    && selectedBatchPage !== batchRange.page
    && batchRange.pageCount > 1;

  return (
    <div className={styles.snapshotWrap} data-testid="inventory-snapshot-view">
      <section className={styles.toolbarWrap}>
        <div className={surface.toolbar} data-testid="inventory-snapshot-filters">
          <SearchField
            value={term}
            onChange={onSearchChange}
            placeholder="搜索来源 SKU"
            ariaLabel="搜索来源 SKU"
            testId="inventory-snapshot-search"
            pending={searchPending}
          />
          <SelectMenu
            value={warehouseId}
            onChange={(next) => navigate({ snapWarehouse: next, snapBatch: '', snapPage: 1, snapBPage: 1 })}
            options={warehouseOptions}
            ariaLabel="选择海外仓"
            testId="inventory-snapshot-warehouse"
            disabled={warehouseOptions.length === 0}
          />
          <button
            type="button"
            className={`${surface.button} ${surface.buttonIcon}`}
            aria-label="刷新历史快照"
            title="刷新历史快照"
            onClick={() => startRefresh(() => router.refresh())}
            disabled={refreshPending}
            data-testid="inventory-snapshot-refresh"
          >
            <RefreshCw className={refreshPending ? styles.refreshSpinning : undefined} size={16} strokeWidth={1.8} aria-hidden />
          </button>
          <button
            type="button"
            className={surface.button}
            onClick={() => navigate({ snapQ: '', snapPage: 1 })}
            disabled={!query.snapQ}
            data-testid="inventory-snapshot-clear"
          >
            清空搜索
          </button>
          <Link className={surface.button} href={backHref} data-testid="inventory-snapshot-back">
            返回当前库存
          </Link>
          <span className={surface.count} data-testid="inventory-snapshot-counts">
            {detail?.ok
              ? hasSearch
                ? `匹配 ${detail.matched} 行 · 本批共 ${detail.total} 行`
                : `本批共 ${detail.total} 行`
              : ''}
          </span>
        </div>
        <p className={styles.pageStatus} data-testid="inventory-snapshot-note">
          只读 · 已发布批次不可编辑；采集时间使用来源观测时间（observation_at）。
        </p>
      </section>

      {batchesError ? (
        <p className={styles.inlineError} data-testid="inventory-snapshot-batches-error">
          批次读取失败：{batchesError}
        </p>
      ) : null}

      {warehouseSelectionLost ? (
        <p className={styles.inlineError} data-testid="inventory-snapshot-warehouse-lost">
          这个书签指向的仓库已不在当前账号的授权范围。请从上方重新选择仓库；页面不会自动改选其他仓库，
          也不会显示其他仓的批次或数量。
        </p>
      ) : null}

      <div className={styles.snapshotLayout}>
        <section className={`${styles.panel} ${styles.snapshotBatchPanel}`} data-testid="inventory-snapshot-batch-panel">
          <div className={styles.panelBar}>
            <strong>已发布批次</strong>
            <span className={styles.pageStatus}>按观测时间倒序</span>
          </div>
          {confirmedWarehouses.length === 0 ? (
            <div className={styles.snapshotEmpty}>
              <EmptyState title="当前账号没有参与仓" hint="先在数据同步页确认参与仓库。" />
            </div>
          ) : warehouseSelectionLost ? (
            <div className={styles.snapshotEmpty}>
              <EmptyState
                title="请重新选择仓库"
                hint="书签中的仓库已不在当前账号的授权范围；重新选仓后才能查看该仓的已发布批次。"
              />
            </div>
          ) : batches.length === 0 ? (
            <div className={styles.snapshotEmpty}>
              <EmptyState
                title={batchTotal > 0 ? '本页没有批次' : '该仓暂无已发布批次'}
                hint={batchTotal > 0 ? '页码超出当前批次列表；用下方翻页回到最近批次。' : '换一个仓库，或等下一次同步成功后再查看。'}
              />
            </div>
          ) : (
            <ul className={styles.snapshotBatchList} data-testid="inventory-snapshot-batch-list">
              {batches.map((entry) => {
                const active = entry.batchId === selectedBatchId;
                return (
                  <li key={entry.batchId}>
                    <Link
                      className={`${styles.snapshotBatchItem} ${active ? styles.snapshotBatchItemActive : ''}`}
                      href={batchHref(entry.batchId)}
                      aria-current={active ? 'true' : undefined}
                      data-testid={`inventory-snapshot-batch-${entry.batchId}`}
                    >
                      <strong>{formatTimestamp(entry.observationAt) || '观测时间未提供'}</strong>
                      <small>
                        {entry.rowCount} 行 · 已绑 {entry.adoptedCount} / 未绑 {entry.unmappedCount}
                      </small>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
          {offPage ? (
            <p className={styles.snapshotNote} data-testid="inventory-snapshot-batch-offpage">
              当前查看的批次在批次列表第 {selectedBatchPage} 页。
              <Link href={batchPageHref(selectedBatchPage)}>跳到该页</Link>
            </p>
          ) : null}
          {batchTotal > 0 ? (
            <div className={styles.snapshotBatchFooter} data-testid="inventory-snapshot-batch-pagination">
              <span data-testid="inventory-snapshot-batch-range">
                第 {batchRange.from}–{batchRange.to} 个 · 共 {batchRange.total} 批
              </span>
              <div className={styles.snapshotBatchPager}>
                {batchRange.hasPrev ? (
                  <Link
                    className={surface.pageBtn}
                    href={batchPageHref(batchRange.page - 1)}
                    data-testid="inventory-snapshot-batch-page-prev"
                  >
                    更新批次
                  </Link>
                ) : (
                  <span className={`${surface.pageBtn} ${surface.pageBtnDisabled}`} aria-disabled="true">更新批次</span>
                )}
                <span className={styles.snapshotBatchPage} data-testid="inventory-snapshot-batch-page-current">
                  {batchRange.page}/{batchRange.pageCount}
                </span>
                {batchRange.hasNext ? (
                  <Link
                    className={surface.pageBtn}
                    href={batchPageHref(batchRange.page + 1)}
                    data-testid="inventory-snapshot-batch-page-next"
                  >
                    更早批次
                  </Link>
                ) : (
                  <span className={`${surface.pageBtn} ${surface.pageBtnDisabled}`} aria-disabled="true">更早批次</span>
                )}
              </div>
            </div>
          ) : null}
        </section>

        <section className={`${styles.panel} ${styles.snapshotDetailPanel}`} data-testid="inventory-snapshot-detail-panel">
          {detail?.ok && batch ? (
            <>
              <div className={styles.snapshotSummary} data-testid="inventory-snapshot-summary">
                <dl>
                  <div>
                    <dt>仓库</dt>
                    <dd>
                      {batch.warehouseName || selectedWarehouse?.name || '仓库未提供'}
                      <small>{batch.market ? `市场 ${marketLabel(batch.market)}` : '市场待确认'}</small>
                    </dd>
                  </div>
                  <div>
                    <dt>来源观测时间</dt>
                    <dd>
                      {formatTimestamp(batch.observationAt) || '未提供'}
                      <small>上海时间</small>
                    </dd>
                  </div>
                  <div>
                    <dt>批次</dt>
                    <dd title={batch.batchId}>
                      {batch.batchId.slice(0, 8)}…
                      <small>发布 {formatTimestamp(batch.publishedAt) || '未提供'}</small>
                    </dd>
                  </div>
                  <div>
                    <dt>本批行数</dt>
                    <dd>
                      {batch.rowCount}
                      <small>
                        已绑 {batch.adoptedCount} / 未绑 {batch.unmappedCount}
                      </small>
                    </dd>
                  </div>
                </dl>
              </div>

              {detail.rows.length === 0 ? (
                <div className={styles.snapshotEmpty} data-testid="inventory-snapshot-empty">
                  {detail.matched === 0 && hasSearch ? (
                    <EmptyState
                      title="本批未见"
                      hint={`来源 SKU「${appliedSearch}」在这批没有记录；可以切换批次，或清空搜索后查看整批。`}
                    />
                  ) : detail.matched === 0 ? (
                    <EmptyState title="这批没有库存行" hint="换一个批次查看。" />
                  ) : (
                    <EmptyState title="本页没有行" hint="页码超出当前结果；已自动回到最后一页。" />
                  )}
                </div>
              ) : (
                <div className={styles.tableScroll} tabIndex={0} data-testid="inventory-snapshot-table-scroll">
                  <table className={`${styles.table} ${styles.snapshotTable}`}>
                    <thead>
                      <tr>
                        <th>来源 SKU</th>
                        <th>商品归属（当时）</th>
                        <th>实物数量</th>
                        <th>锁定数量</th>
                        <th>仓库可用数量</th>
                        <th>已记录单位</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.rows.map((row) => {
                        const item = snapshotItemText(row);
                        return (
                          <tr key={`${row.externalSku}:${row.excelRow ?? ''}`} data-testid="inventory-snapshot-row">
                            <td>
                              <strong className={styles.rowTitle}>{row.externalSku}</strong>
                              <small className={styles.rowSub}>
                                {row.excelRow === null ? '原文件行未提供' : `原文件行 ${row.excelRow}`}
                              </small>
                            </td>
                            <td className={styles.wrapCell}>
                              <strong className={styles.rowTitle}>{item.title}</strong>
                              <small className={styles.rowSub}>
                                {item.bound ? snapshotVersionText(row) : item.note}
                              </small>
                            </td>
                            <td>{snapshotQuantityText(row.onHand)}</td>
                            <td>{snapshotQuantityText(row.orderLocked)}</td>
                            <td>{snapshotQuantityText(row.warehouseAvailable)}</td>
                            <td>{snapshotUnitText(row.unit)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {range ? (
                <div className={styles.pagerBar}>
                  <div className={surface.pager} data-testid="inventory-snapshot-pagination">
                    <span className={surface.pagerInfo}>
                      第 {range.from}–{range.to} 条，共 {range.total} 条 · 第 {range.page}/{range.pageCount} 页
                    </span>
                    <nav className={surface.pagerNav} aria-label="历史快照明细分页">
                      {range.hasPrev ? (
                        <Link className={surface.pageBtn} href={pageHref(range.page - 1)} data-testid="inventory-snapshot-page-prev">上一页</Link>
                      ) : (
                        <span className={`${surface.pageBtn} ${surface.pageBtnDisabled}`} aria-disabled="true">上一页</span>
                      )}
                      {pages.map((value, index) => value === 'gap' ? (
                        <span key={`gap-${index}`} className={surface.pageGap}>…</span>
                      ) : value === range.page ? (
                        <span
                          key={value}
                          className={`${surface.pageBtn} ${surface.pageBtnCurrent}`}
                          aria-current="page"
                          data-testid="inventory-snapshot-page-current"
                        >
                          {value}
                        </span>
                      ) : (
                        <Link key={value} className={surface.pageBtn} href={pageHref(value)} data-testid={`inventory-snapshot-page-link-${value}`}>{value}</Link>
                      ))}
                      {range.hasNext ? (
                        <Link className={surface.pageBtn} href={pageHref(range.page + 1)} data-testid="inventory-snapshot-page-next">下一页</Link>
                      ) : (
                        <span className={`${surface.pageBtn} ${surface.pageBtnDisabled}`} aria-disabled="true">下一页</span>
                      )}
                    </nav>
                  </div>
                </div>
              ) : null}
            </>
          ) : detailError ? (
            <div className={styles.snapshotEmpty} data-testid="inventory-snapshot-detail-error">
              <EmptyState
                title="明细读取失败"
                hint={`${detailError}；没有显示数量，也不会用其他批次代替。可刷新或从左侧重新选择批次。`}
              />
            </div>
          ) : batchNotice && !warehouseSelectionLost ? (
            <div className={styles.snapshotEmpty} data-testid="inventory-snapshot-unavailable">
              {batchNotice.kind === 'warehouse_mismatch' ? (
                <>
                  <EmptyState
                    title="这批不属于所选仓库"
                    hint={`该批次属于「${batchNotice.batchWarehouseName || '其他仓库'}」${
                      batchNotice.observationAt ? `（观测 ${formatTimestamp(batchNotice.observationAt)}）` : ''
                    }，与当前所选仓库不一致；没有显示任何数量。`}
                  />
                  {batchNotice.batchWarehouseId ? (
                    <Link
                      className={surface.button}
                      href={buildInventorySnapshotHref(
                        { ...query, snapWarehouse: batchNotice.batchWarehouseId },
                        {
                          snapWarehouse: batchNotice.batchWarehouseId,
                          snapBatch: query.snapBatch,
                          snapQ: query.snapQ,
                          snapPage: 1,
                          // 不指定列表页：新仓的批次列表自动定位到该批所在页。
                          snapBPage: 0,
                        },
                      )}
                      data-testid="inventory-snapshot-switch-warehouse"
                    >
                      切换到该仓查看
                    </Link>
                  ) : null}
                </>
              ) : batchNotice.kind === 'no_account' ? (
                <EmptyState title="还没有绑定来源账号" hint="绑定 BigSeller 账号后才能读取已发布批次。" />
              ) : (
                <EmptyState
                  title="这批不存在或不可用"
                  hint="直接链接的批次编号在该账号的已发布批次里没有找到；不会用最新批次代替。请从左侧重新选择批次。"
                />
              )}
            </div>
          ) : warehouseSelectionLost ? (
            <div className={styles.snapshotEmpty} data-testid="inventory-snapshot-rechoose-warehouse">
              <EmptyState
                title="请重新选择仓库"
                hint="书签中的仓库已不在当前账号的授权范围；页面没有自动改选，也没有显示其他仓的数量。"
              />
            </div>
          ) : (
            <div className={styles.snapshotEmpty} data-testid="inventory-snapshot-unavailable">
              <EmptyState
                title={batches.length === 0 ? '选择仓库后查看历史快照' : '从左侧选择批次'}
                hint={batches.length === 0
                  ? '历史快照按已发布批次读取，不改写当前库存。'
                  : '左侧列出该仓的已发布批次；选一个批次即可查看当时的 SKU 与数量。'}
              />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
