import { getCatalogIssueIndex } from '@/features/catalog/issues/service';
import { CatalogIssueIndexView } from '@/features/catalog/issues/issue-index-view';

// 只读派生索引：每次请求按当前事实重算，不做跨请求缓存，也不写任何业务数据。
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function CatalogIssuesPage() {
  const index = await getCatalogIssueIndex();
  return <CatalogIssueIndexView index={index} />;
}
