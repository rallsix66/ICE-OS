import { CatalogDisplayReadError } from '@/features/catalog/local-display/service';
import { getCatalogDetailCore, getCatalogItemBsSample } from '@/features/catalog/service';
import { CatalogDetail } from '@/features/catalog/components/catalog-detail';
import { getSourceIdentityPanel } from '@/features/catalog/source-identity/service';
import { SourceIdentityAttachment } from '@/features/catalog/components/source-identity-panel';
import { getNewItemDetailPanel } from '@/features/catalog/new-item/service';
import { NewItemDetailAttachment } from '@/features/catalog/components/new-item-intake';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function CatalogDetailPage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ revision?: string; warehouse?: string }>;
}) {
  const { id } = await params;
  const { revision, warehouse } = await searchParams;
  const requestedRevision = revision === undefined ? undefined : Number(revision);
  const validRevision = requestedRevision === undefined || (Number.isInteger(requestedRevision) && requestedRevision >= 1);
  const warehouseFilter = warehouse?.trim() ? warehouse.trim() : undefined;
  const core = validRevision ? await getCatalogDetailCore(id, { revision: requestedRevision }).catch(() => null) : null;
  if (core) {
    const identityPanel = await getSourceIdentityPanel(id).catch(() => null);
    const productPanel = await getNewItemDetailPanel(core.item).catch(() => null);
    let bsSample: Awaited<ReturnType<typeof getCatalogItemBsSample>> | null = null;
    let bsSampleError: CatalogDisplayReadError | null = null;
    if (requestedRevision === undefined) {
      try {
        bsSample = await getCatalogItemBsSample(id, warehouseFilter);
      } catch (error) {
        bsSampleError = error instanceof CatalogDisplayReadError ? error : new CatalogDisplayReadError('read_failed', 'BS 样表库存投影读取失败', error);
      }
    }
    return <>
      <CatalogDetail
        key={core.item.itemId}
        core={core}
        bsSample={requestedRevision === undefined ? bsSample : null}
        bsSampleError={requestedRevision === undefined ? bsSampleError : null}
        warehouseFilter={warehouseFilter}
      />
      {identityPanel?.enabled && <SourceIdentityAttachment panel={identityPanel} />}
      {productPanel?.enabled && <NewItemDetailAttachment panel={productPanel} />}
    </>;
  }
  return <main className="p-6"><h1 className="text-xl font-semibold">商品资料不可用</h1><p>账号没有访问权限，或所请求资料、版本不存在。</p></main>;
}
