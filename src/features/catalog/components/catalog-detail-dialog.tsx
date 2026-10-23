'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { X } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import demoStyles from '@/ui/ice-v4/ice-v4.module.css';
import { fetchCatalogDetailViewAction } from '../actions';
import type { CatalogListClientPayload, CatalogListClientRow } from '../local-display/list-client-types';
import type { useCatalogUrlState } from '../shell/use-catalog-url-state';
import {
  authoritativeExpectedFromList,
  detailScopeFromView,
  expectedScopeFromListRow,
  listAuthorityMatchesLoadedScope,
  scopesMatch,
  invalidateDetailCacheItem,
  markDetailCacheStale,
  normalizeDetailWarehouse,
  readDetailCache,
  resolveBackgroundDetailFetch,
  writeDetailCache,
  type CatalogDetailCacheContext,
  type CatalogDetailScope,
  type CatalogDetailView,
} from '../shell/catalog-detail-cache';
import { CatalogDetail } from './catalog-detail';

type UrlApi = ReturnType<typeof useCatalogUrlState>;

function CatalogDetailLoader({
  detailId,
  warehouseFilter,
  listRow,
  cacheContext,
}: {
  detailId: string;
  warehouseFilter?: string;
  listRow?: CatalogListClientRow;
  cacheContext: CatalogDetailCacheContext;
}) {
  const warehouseNorm = normalizeDetailWarehouse(warehouseFilter);
  const scopeProbe = { itemId: detailId, warehouse: warehouseNorm };
  const listExpected = expectedScopeFromListRow(detailId, warehouseFilter, listRow, cacheContext);
  const initialCache = readDetailCache(scopeProbe, cacheContext, listExpected ?? undefined);
  const [view, setView] = useState<CatalogDetailView | null>(() => initialCache?.view ?? null);
  const [loadedScope, setLoadedScope] = useState<CatalogDetailScope | null>(() => initialCache?.scope ?? null);
  const [contentFresh, setContentFresh] = useState(() => Boolean(initialCache));
  const [error, setError] = useState<string | null>(null);
  const [staleNotice, setStaleNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const requestSeq = useRef(0);

  const router = useRouter();
  const listAuthority = authoritativeExpectedFromList(detailId, warehouseFilter, listRow, cacheContext);
  const listHasInventoryAuthority = Boolean(
    listRow?.inventoryProjectionByWarehouse
    && Object.keys(listRow.inventoryProjectionByWarehouse).length > 0,
  );
  const scopeFresh = Boolean(
    view
    && loadedScope
    && listAuthority
    && (listHasInventoryAuthority
      ? listAuthorityMatchesLoadedScope(loadedScope, listAuthority)
      : scopesMatch(loadedScope, listAuthority)),
  );
  /** Server action returned success for the current in-flight request (not a stale cache pose). */
  const authoritativeDetail = Boolean(view && loadedScope && contentFresh && !error);
  const listProjectionOutOfSync = Boolean(authoritativeDetail && listAuthority && !scopeFresh);
  const displayReady = authoritativeDetail && !staleNotice;
  const contentFreshForMetrics = authoritativeDetail && scopeFresh && !staleNotice;

  const applySuccess = (data: CatalogDetailView, wh: string | undefined, seq: number) => {
    if (seq !== requestSeq.current) return;
    const scope = detailScopeFromView(data, wh, cacheContext);
    writeDetailCache(data, wh, cacheContext);
    setView(data);
    setLoadedScope(scope);
    setError(null);
    setStaleNotice(null);
    setContentFresh(true);
    if (listRow && listRow.itemRevision !== data.item.revision) {
      router.refresh();
    }
  };

  const runFetch = (wh: string | undefined, background: boolean, seq: number) => {
    const whNorm = normalizeDetailWarehouse(wh);
    if (!background) {
      setError(null);
      setStaleNotice(null);
    }
    startTransition(async () => {
      try {
        const result = await fetchCatalogDetailViewAction(detailId, whNorm === 'all' ? undefined : whNorm);
        if (seq !== requestSeq.current) return;
        if (!result.success || !result.data) {
          const resolution = resolveBackgroundDetailFetch({
            success: false,
            error: result.error,
            cachedView: view,
          });
          if (background) {
            markDetailCacheStale(detailId, whNorm);
            if (resolution.kind === 'failure' && resolution.failure === 'forbidden') {
              invalidateDetailCacheItem(detailId);
            }
            if (resolution.kind === 'failure' && resolution.retainMasked) {
              setView(resolution.retainMasked);
              setLoadedScope(detailScopeFromView(resolution.retainMasked, wh, cacheContext));
              setError(resolution.error);
              setStaleNotice(null);
              setContentFresh(false);
              return;
            }
            setStaleNotice(resolution.kind === 'failure' ? resolution.error : '详情读取失败，请重试。');
            setContentFresh(false);
            return;
          }
          setView(null);
          setLoadedScope(null);
          setError(resolution.kind === 'failure' ? resolution.error : '详情读取失败，请重试。');
          setContentFresh(false);
          return;
        }
        applySuccess(result.data, wh, seq);
      } catch {
        if (seq !== requestSeq.current) return;
        const resolution = resolveBackgroundDetailFetch({
          success: false,
          error: '详情读取失败，请重试。',
          cachedView: view,
          failureKind: 'network',
        });
        if (background) {
          markDetailCacheStale(detailId, whNorm);
          setStaleNotice(resolution.kind === 'failure' ? resolution.error : '详情读取失败，请重试。');
          setContentFresh(false);
          return;
        }
        setView(null);
        setLoadedScope(null);
        setError(resolution.kind === 'failure' ? resolution.error : '详情读取失败，请重试。');
        setContentFresh(false);
      }
    });
  };

  useEffect(() => {
    requestSeq.current += 1;
    const seq = requestSeq.current;
    const expected = expectedScopeFromListRow(detailId, warehouseFilter, listRow, cacheContext);
    const auth = authoritativeExpectedFromList(detailId, warehouseFilter, listRow, cacheContext);
    const hit = readDetailCache(scopeProbe, cacheContext, expected ?? undefined);
    const hitMatchesList = Boolean(
      hit?.scope
      && auth
      && (listHasInventoryAuthority
        ? listAuthorityMatchesLoadedScope(hit.scope, auth)
        : scopesMatch(hit.scope, auth)),
    );
    runFetch(warehouseFilter, Boolean(hit?.view && hitMatchesList && view), seq);
    return () => {
      requestSeq.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch keyed by detailId + warehouseNorm + cacheContext + list projection
  }, [detailId, warehouseNorm, warehouseFilter, listRow?.itemRevision, listRow?.bsSample.confirmedOnHandTotal, listRow?.bsSample.estimatedValueCny, listRow?.inventoryProjectionByWarehouse, cacheContext.principalKey, cacheContext.amountAllowed, cacheContext.displayBasisSha256]);

  const summaryTitle = listRow
    ? `${listRow.iceCode ?? '待补货号'} · ${listRow.nameCn}`
    : view
      ? `${view.item.iceCode ?? '待补货号'} · ${view.item.nameCn}`
      : '商品详情';

  const description = error
    ? '详情读取失败，可重试或关闭后返回列表。'
    : staleNotice
      ? '详情可能已过期，正在尝试刷新；金额与估值暂不可作为当前依据。'
      : displayReady
        ? listProjectionOutOfSync
          ? `资料版本 ${view!.item.revision} · 详情已更新，列表投影同步中`
          : `资料版本 ${view!.item.revision} · 真实商品档案与当前仓库投影`
        : listRow
          ? '列表已授权摘要 · 正在补齐详情核心'
          : '真实商品档案 · 列表上下文保留';

  return (
    <>
      <div className={demoStyles.detailHeader}>
        <div>
          <DialogTitle>{summaryTitle}</DialogTitle>
          <DialogDescription id="catalog-detail-desc">{description}</DialogDescription>
        </div>
      </div>
      {listRow && !displayReady && (
        <section className={demoStyles.panel} aria-label="列表摘要" data-testid="catalog-detail-list-summary">
          <p><strong>{listRow.nameCn}</strong> · {listRow.iceCode ?? '待补货号'} · 69 {listRow.barcodeText ?? '待补'}</p>
          <p className={demoStyles.subtle} role="status">{pending || !view ? '正在补齐详情核心…' : '正在切换仓库投影…'}</p>
        </section>
      )}
      {listProjectionOutOfSync && (
        <p role="status" data-testid="catalog-detail-list-sync-notice">
          列表仓库投影与详情不一致，正在同步列表…
          {' '}
          <button type="button" className={demoStyles.textLink} onClick={() => router.refresh()}>刷新列表</button>
        </p>
      )}
      {!listRow && pending && !displayReady && <p className={demoStyles.subtle} role="status">加载商品详情…</p>}
      {staleNotice && (
        <p role="status" data-testid="catalog-detail-stale-notice">
          {staleNotice}
          {' '}
          <button type="button" className={demoStyles.textLink} onClick={() => runFetch(warehouseFilter, false, ++requestSeq.current)}>重试</button>
        </p>
      )}
      {error && (
        <p role="alert" data-testid="catalog-detail-fetch-error">
          {error}
          {' '}
          <button type="button" className={demoStyles.textLink} onClick={() => runFetch(warehouseFilter, false, ++requestSeq.current)}>重试</button>
        </p>
      )}
      {displayReady && view && (
        <div
          data-testid="catalog-detail-core-ready"
          data-warehouse={warehouseNorm}
          data-content-fresh={contentFreshForMetrics ? 'true' : 'false'}
          data-list-projection-synced={scopeFresh ? 'true' : 'false'}
        >
          <CatalogDetail
            key={`${view.item.itemId}-${view.item.revision}-${warehouseNorm}`}
            core={view}
            bsSample={view.bsSample}
            bsSampleError={view.bsSampleError}
            warehouseFilter={warehouseFilter}
            embedded
            onRevisionSaved={() => {
              invalidateDetailCacheItem(detailId);
              runFetch(warehouseFilter, false, ++requestSeq.current);
            }}
          />
        </div>
      )}
    </>
  );
}

export function CatalogDetailDialog({
  payload,
  url,
  cacheContext,
}: {
  payload: CatalogListClientPayload | null;
  url: UrlApi;
  cacheContext: CatalogDetailCacheContext;
}) {
  const { detail: detailId, warehouse, closeDetail } = url;
  const open = Boolean(detailId);
  const warehouseFilter = warehouse !== 'all' ? warehouse : undefined;
  const warehouseNorm = normalizeDetailWarehouse(warehouseFilter);
  const listRow: CatalogListClientRow | undefined = payload?.rows.find((row) => row.itemId === detailId);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeDetail();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, closeDetail]);

  if (!open || !detailId) return null;

  const shareHref = `/dashboard/catalog/${detailId}${warehouseFilter ? `?warehouse=${encodeURIComponent(warehouseFilter)}` : ''}`;

  return (
    <Dialog open onOpenChange={(next) => { if (!next) closeDetail(); }}>
      <DialogContent className={`sm:max-w-5xl ${demoStyles.detailDialog}`} showCloseButton={false} aria-describedby="catalog-detail-desc">
        <div className={demoStyles.buttonRow} style={{ justifyContent: 'flex-end' }}>
          <Link href={shareHref} className={demoStyles.textLink} target="_blank" rel="noreferrer">新标签打开</Link>
          <button type="button" aria-label="关闭商品详情" className={demoStyles.iconButton} onClick={closeDetail}><X size={20} /></button>
        </div>
        <CatalogDetailLoader
          key={`${detailId}-${warehouseNorm}-${cacheContext.principalKey}-${cacheContext.amountAllowed ? '1' : '0'}-${cacheContext.displayBasisSha256}-${listRow?.itemRevision ?? 0}-${listRow?.bsSample.confirmedOnHandTotal ?? ''}-${listRow?.bsSample.estimatedValueCny ?? ''}-${JSON.stringify(listRow?.inventoryProjectionByWarehouse ?? {})}`}
          detailId={detailId}
          warehouseFilter={warehouseFilter}
          listRow={listRow}
          cacheContext={cacheContext}
        />
      </DialogContent>
    </Dialog>
  );
}
