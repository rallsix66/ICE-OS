import { getCatalogOverview } from '@/features/catalog/service';
import { CatalogTable } from '@/features/catalog/components/catalog-table';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function CatalogPage() {
  const overview = await getCatalogOverview().catch(() => null);
  if (overview) {
    return <main className="p-6 space-y-5"><h1 className="text-2xl font-semibold">商品资料</h1>
      <p className="text-sm text-gray-600">本地真实商品资料、BS 2026-10-15 导出样表库存与采用进货价估算。正式长期关系与实时库存未启用。</p>
      <CatalogTable overview={overview} />
    </main>;
  }
  return <main className="p-6"><h1 className="text-xl font-semibold">商品资料不可用</h1><p>需要启用的管理员账号及本地独立资料环境。</p></main>;
}
