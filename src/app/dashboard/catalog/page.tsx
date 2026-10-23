import { getCurrentActiveUser } from '@/lib/auth';
import { getCatalogListPage } from '@/features/catalog/service';
import { CatalogShell } from '@/features/catalog/shell/catalog-shell';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function initialUrlFromSearchParams(sp: Record<string, string | string[] | undefined>) {
  const rawPage = Number(Array.isArray(sp.page) ? sp.page[0] : sp.page ?? '1');
  const detailRaw = Array.isArray(sp.detail) ? sp.detail[0] : sp.detail;
  const detail = detailRaw?.trim() ?? '';
  return {
    q: (Array.isArray(sp.q) ? sp.q[0] : sp.q)?.trim() ?? '',
    warehouse: (Array.isArray(sp.warehouse) ? sp.warehouse[0] : sp.warehouse)?.trim() || 'all',
    page: Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1,
    detail: /^[a-f\d-]{36}$/i.test(detail ?? '') ? detail! : '',
  };
}

export default async function CatalogPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const initialUrl = initialUrlFromSearchParams(sp);
  const [list, activeUser] = await Promise.all([
    getCatalogListPage().catch(() => null),
    getCurrentActiveUser(),
  ]);
  if (!list) {
    return <p>需要启用的管理员账号及本地独立资料环境。</p>;
  }
  if (list.itemsLoadFailed) {
    return <p role="alert">{list.itemsLoadError}</p>;
  }
  const cacheContext = {
    principalKey: activeUser?.id ?? 'anonymous',
    amountAllowed: list.amountAllowed,
    displayBasisSha256: list.payload?.basisDocumentSha256 ?? '',
  };
  return (
    <CatalogShell
      payload={list.payload}
      displayStatus={list.displayStatus}
      displayError={list.displayError}
      itemCount={list.itemCount}
      auxiliaryErrors={list.auxiliaryErrors ?? []}
      initialUrl={initialUrl}
      cacheContext={cacheContext}
    />
  );
}
