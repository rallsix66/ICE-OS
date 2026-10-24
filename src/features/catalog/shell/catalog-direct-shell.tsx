'use client';

import Link from 'next/link';
import { CatalogDetailDialog } from '../components/catalog-detail-dialog';
import type { CatalogDetailCacheContext } from './catalog-detail-cache';
import { useCatalogUrlState } from './use-catalog-url-state';
import type { CatalogUrlState } from './catalog-url-params';

type ListFailureKind = 'unavailable' | 'forbidden' | 'read_failed';

const TITLES: Record<ListFailureKind, string> = {
  unavailable: '商品资料暂未启用',
  forbidden: '商品资料不可用',
  read_failed: '商品列表读取失败（网络或传输异常）',
};

/**
 * V3-01.8：旧直链/收藏进入“商品库背景 + 弹窗”时，背景列表读取失败不得阻断本来可读的商品详情。
 * 这里保留明确的列表失败提示，同时用最小背景渲染同一套商品弹窗；不复制第二套详情壳。
 */
export function CatalogDirectShell({
  initialUrl,
  cacheContext,
  errorKind,
}: {
  initialUrl: CatalogUrlState;
  cacheContext: CatalogDetailCacheContext;
  errorKind: ListFailureKind;
}) {
  const url = useCatalogUrlState(initialUrl);
  return (
    <main className="mx-auto w-full max-w-[1200px] px-4 py-4" aria-label="商品库直链">
      <section
        className="rounded-xl border border-amber-200 bg-amber-50/70 px-4 py-3 text-sm leading-6 text-amber-900"
        data-testid="catalog-list-error"
        data-error-kind={errorKind}
        role="status"
      >
        <strong className="mr-2 font-semibold">{TITLES[errorKind]}。</strong>
        {errorKind === 'read_failed'
          ? '本次列表读取因网络或传输异常中断；这不等于资料不存在或无权限。已打开的商品详情仍可独立读取。'
          : errorKind === 'forbidden'
            ? '当前账户没有列表访问权限；已打开的商品详情仍按服务端权限独立读取。'
            : '独立本地平台模式未启用列表读取；已打开的商品详情仍按服务端权限独立读取。'}
        {' '}
        <Link className="underline underline-offset-4" href="/dashboard/catalog">返回商品库</Link>
      </section>
      <CatalogDetailDialog payload={null} url={url} cacheContext={cacheContext} />
    </main>
  );
}
