import { getCatalogIssuePendingPreview } from '@/features/catalog/issues/service';
import { CatalogPendingPage } from '@/features/catalog/issues/catalog-pending-page';

// 只读派生：每次请求按当前事实重算，不做跨请求缓存，也不写任何业务数据。
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * 完整待处理页：与商品库顶部「待处理」弹窗、经营总览数字同一份数据
 * （getCatalogIssuePendingPreview → buildCatalogPendingItems）。
 * 两条刷子历史只在商品详情查看，不计入本页数量。
 */
export default async function CatalogIssuesPage() {
  const preview = await getCatalogIssuePendingPreview();
  return <CatalogPendingPage preview={preview} />;
}
