import { redirect } from 'next/navigation';
import { safeCatalogReturnHref } from '@/features/catalog/shell/safe-return';
import { isCatalogDetailId, normalizeRevisionParam } from '@/features/catalog/shell/catalog-url-params';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * V3-01：商品详情只有一套“商品库背景 + 固定弹窗”体验。
 *
 * 旧收藏/直链/新标签 `/dashboard/catalog/<id>?revision=&warehouse=&from=` 兼容重定向到同一弹窗：
 * - 合法版本进入弹窗内只读历史视图；
 * - 非法版本保留 `revision=invalid` 让弹窗显示明确错误，不静默退回当前资料；
 * - 只透传安全站内 from，不放宽为任意外站回跳。
 */
export default async function CatalogLegacyDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ revision?: string; warehouse?: string; from?: string }>;
}) {
  const { id } = await params;
  const { revision, warehouse, from } = await searchParams;
  if (!isCatalogDetailId(id)) {
    redirect('/dashboard/catalog');
  }

  const query = new URLSearchParams();
  query.set('detail', id);
  const warehouseValue = typeof warehouse === 'string' ? warehouse.trim() : '';
  if (warehouseValue && warehouseValue !== 'all') query.set('warehouse', warehouseValue);
  if (typeof revision === 'string' && revision.trim() !== '') {
    const parsed = normalizeRevisionParam(revision.trim());
    query.set('revision', parsed > 0 ? String(parsed) : 'invalid');
  }
  const safeFrom = safeCatalogReturnHref(typeof from === 'string' ? from : undefined);
  if (safeFrom) query.set('from', safeFrom);
  redirect(`/dashboard/catalog?${query.toString()}`);
}
