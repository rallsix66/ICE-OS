import { getCatalogOverview } from '@/features/catalog/service';
import { CatalogAdminPanel } from '@/features/catalog/components/catalog-admin-panel';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function CatalogAdminPage() {
  const overview = await getCatalogOverview().catch(() => null);
  if (!overview) {
    return <main className="p-6"><h1 className="text-xl font-semibold">管理入口不可用</h1></main>;
  }
  return <main className="p-6"><CatalogAdminPanel overview={overview} /></main>;
}
