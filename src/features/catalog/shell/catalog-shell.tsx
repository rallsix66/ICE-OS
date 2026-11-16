'use client';

import type { CatalogListClientPayload } from '../local-display/list-client-types';
import type { CatalogPendingPreview } from '../issues/service';
import type { CatalogDetailCacheContext } from './catalog-detail-cache';
import { CatalogDetailDialog } from '../components/catalog-detail-dialog';
import { CatalogProductsPage } from './catalog-products-page';
import { useCatalogUrlState, type CatalogUrlState } from './use-catalog-url-state';

export function CatalogShell({
  payload,
  displayStatus,
  displayError,
  itemCount,
  auxiliaryErrors,
  initialUrl,
  cacheContext,
  pendingPreview = null,
  autoOpenPending = false,
}: {
  payload: CatalogListClientPayload | null;
  displayStatus: 'loaded' | 'not_imported' | 'read_failed' | 'forbidden';
  displayError: string | null;
  itemCount: number;
  auxiliaryErrors: string[];
  initialUrl: CatalogUrlState;
  cacheContext: CatalogDetailCacheContext;
  /** 待处理索引的只读投影（弹窗内容）；null = 未接线/不可用，入口显示读取失败。 */
  pendingPreview?: CatalogPendingPreview | null;
  /** /dashboard/catalog?pending=open：首屏自动打开待处理弹窗一次（不新增历史记录）。 */
  autoOpenPending?: boolean;
}) {
  const url = useCatalogUrlState(initialUrl);
  return (
    <>
      <CatalogProductsPage
        payload={payload}
        displayStatus={displayStatus}
        displayError={displayError}
        itemCount={itemCount}
        auxiliaryErrors={auxiliaryErrors}
        url={url}
        issuesPreview={pendingPreview}
        autoOpenPending={autoOpenPending}
      />
      <CatalogDetailDialog payload={payload} url={url} cacheContext={cacheContext} />
    </>
  );
}
