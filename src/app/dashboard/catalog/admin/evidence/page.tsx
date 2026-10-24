import { redirect } from 'next/navigation';
import { safeCatalogReturnHref } from '@/features/catalog/shell/safe-return';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const UUID = /^[a-f\d-]{36}$/i;
const MAX_REVISION = 1_000_000_000;

/**
 * V5-05：旧商品级 sources/evidence 地址不再渲染第二层独立来源页。
 * 合法商品地址进入统一商品详情弹窗的“数据来源”子视图，并保留版本与安全返回上下文。
 */
export default async function CatalogEvidencePage({ searchParams }: {
  searchParams: Promise<{ item?: string; revision?: string; from?: string }>;
}) {
  const params = await searchParams;
  const rawItem = typeof params.item === 'string' ? params.item.trim() : '';
  if (!UUID.test(rawItem)) redirect('/dashboard/catalog');

  const query = new URLSearchParams({ detail: rawItem, evidence: '1' });
  const rawRevision = typeof params.revision === 'string' ? params.revision.trim() : '';
  if (rawRevision) {
    const revision = Number(rawRevision);
    if (Number.isInteger(revision) && revision >= 1 && revision <= MAX_REVISION) {
      query.set('revision', String(revision));
    }
  }
  const from = safeCatalogReturnHref(typeof params.from === 'string' ? params.from : undefined);
  if (from) query.set('from', from);
  redirect(`/dashboard/catalog?${query.toString()}`);
}
