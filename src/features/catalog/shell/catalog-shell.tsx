'use client';

import type { CatalogListClientPayload } from '../local-display/list-client-types';
import type { CatalogIssueToolbarModel } from '../issues/types';
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
  issues = null,
}: {
  payload: CatalogListClientPayload | null;
  displayStatus: 'loaded' | 'not_imported' | 'read_failed' | 'forbidden';
  displayError: string | null;
  itemCount: number;
  auxiliaryErrors: string[];
  initialUrl: CatalogUrlState;
  cacheContext: CatalogDetailCacheContext;
  /** 只读待处理索引的工具栏投影；null 表示未接线/不可用，列表只显示安静入口。 */
  issues?: CatalogIssueToolbarModel;
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
        issues={issues}
      />
      <CatalogDetailDialog payload={payload} url={url} cacheContext={cacheContext} />
    </>
  );
}
