import { getNewItemWorkspace } from '@/features/catalog/new-item/service';
import { NewItemIntake } from '@/features/catalog/components/new-item-intake';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export default async function NewItemIntakePage({ searchParams }: { searchParams: Promise<{ scope?: string }> }) {
  const { scope } = await searchParams;
  const data = await getNewItemWorkspace(scope).catch(() => null);
  return <main className="p-6">{data ? <NewItemIntake key={data.scopeId ?? 'disabled'} data={data} /> : <><h1>持续新品资料不可用</h1><p>当前账号无权访问所请求来源，或隔离模块未启用。</p></>}</main>;
}
