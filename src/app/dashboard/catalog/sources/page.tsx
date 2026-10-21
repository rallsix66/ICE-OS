import Link from 'next/link';
import { getSourceIdentityWorkspace } from '@/features/catalog/source-identity/service';
import { SourceIdentityWorkspace } from '@/features/catalog/components/source-identity-panel';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function SourceIdentityPage({ searchParams }: { searchParams: Promise<{ scope?: string }> }) {
  const { scope } = await searchParams;
  const view = await getSourceIdentityWorkspace(scope).catch(() => null);
  return <main className="p-6 space-y-5">
    <Link className="underline text-sm" href="/dashboard/catalog">返回商品资料</Link>
    <h1 className="text-2xl font-semibold">来源身份与观测</h1>
    {view ? <SourceIdentityWorkspace key={view.scopeId ?? 'disabled'} view={view} /> : <p data-testid="identity-unavailable">无权访问或来源范围不可用。</p>}
  </main>;
}
