import Link from 'next/link';
import { getCatalogOverview } from '@/features/catalog/service';
import { classifyCatalogReadFailure } from '@/features/catalog/issues/entry-state';
import { CatalogAdminPanel } from '@/features/catalog/components/catalog-admin-panel';
import { DetailRetryButton } from '@/features/catalog/components/detail-retry-button';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const FAILURE_COPY: Record<string, { title: string; body: string; retry: boolean }> = {
  forbidden: {
    title: '管理入口不可用',
    body: '账号没有访问权限，或所请求的管理资料不存在。',
    retry: false,
  },
  unavailable: {
    title: '管理入口不可用',
    body: '商品库当前未启用（本地独立资料环境未连接）。',
    retry: false,
  },
  read_failed: {
    title: '管理资料读取失败',
    body: '读取失败（网络或传输异常），可重试；这不是“没有数据”。',
    retry: true,
  },
};

export default async function CatalogAdminPage() {
  let overview: Awaited<ReturnType<typeof getCatalogOverview>> | null = null;
  let failureKind: string | null = null;
  try {
    overview = await getCatalogOverview();
  } catch (error) {
    failureKind = classifyCatalogReadFailure(error);
  }
  if (!overview) {
    const copy = FAILURE_COPY[failureKind ?? 'read_failed'] ?? FAILURE_COPY.read_failed;
    return <main className="p-6 space-y-3">
      <h1 className="text-xl font-semibold">{copy.title}</h1>
      <p role="alert" data-testid="catalog-admin-unavailable">{copy.body}</p>
      <p className="text-sm"><Link className="underline" href="/dashboard/catalog">返回商品资料浏览</Link></p>
      {copy.retry && <p className="text-sm"><DetailRetryButton label="重试读取管理资料" /></p>}
    </main>;
  }
  return <main className="p-6"><CatalogAdminPanel overview={overview} /></main>;
}
