import Link from 'next/link';
import { DetailRetryButton } from '@/features/catalog/components/detail-retry-button';
import { getCurrentActiveUser } from '@/lib/auth';
import { getCatalogListPage } from '@/features/catalog/service';
import { getCatalogIssueToolbarModel } from '@/features/catalog/issues/service';
import { CatalogShell } from '@/features/catalog/shell/catalog-shell';
import { CatalogDirectShell } from '@/features/catalog/shell/catalog-direct-shell';
import {
  parseCatalogSearchParams,
  searchParamsToUrlSearchParams,
  type CatalogUrlState,
} from '@/features/catalog/shell/catalog-url-params';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type ListFailureKind = 'unavailable' | 'forbidden' | 'read_failed';

/**
 * R6：主查询失败不再 catch 成 null 后吞成一句“需要启用的管理员账号…”。
 * 未启用 / 无权限 / 读取失败三种原因分开表达，读取失败给出重试；每种都保留安全返回。
 */
function classifyListFailure(error: unknown): ListFailureKind {
  const message = error instanceof Error ? error.message : '';
  if (message === 'CATALOG_UNAVAILABLE') return 'unavailable';
  if (message === 'CATALOG_FORBIDDEN') return 'forbidden';
  if (message.includes('未登录') || message.includes('停用') || message.includes('无权限') || message.includes('权限')) return 'forbidden';
  return 'read_failed';
}

function classifyItemsLoadFailure(errorText: string | null | undefined): ListFailureKind {
  const message = errorText ?? '';
  // service 把 SQLSTATE 42501 归为“读取被拒绝（权限不足）”；其余按网络/传输失败处理。
  if (message.includes('权限') || message.includes('拒绝')) return 'forbidden';
  return 'read_failed';
}

function ListErrorState({ kind }: { kind: ListFailureKind }) {
  const readFailed = kind === 'read_failed';
  const title = readFailed
    ? '商品资料读取失败（网络或传输异常）'
    : kind === 'unavailable'
      ? '商品资料暂未启用'
      : '商品资料不可用';
  const message = readFailed
    ? '本次读取因网络或传输异常中断；这不等于资料不存在或无权限。可重试，或返回商品库继续浏览。'
    : kind === 'unavailable'
      ? '商品资料仅在独立本地平台模式中可用；当前运行环境未启用该能力。这不是“没有记录”，也不当作 0 项。'
      : '账号没有访问权限，或所请求的资料不存在。';
  return (
    <main
      className="mx-auto w-full max-w-2xl px-1 py-6"
      data-testid="catalog-list-error"
      data-error-kind={kind}
      aria-label="商品资料读取状态"
    >
      <section className="rounded-xl border border-slate-200 bg-white p-6">
        <h1 className="text-lg font-semibold text-slate-800">{title}</h1>
        <p className="mt-3 text-sm leading-7 text-slate-600">{message}</p>
        <div className="mt-5 flex flex-wrap items-center gap-3">
          {readFailed && <DetailRetryButton />}
          <Link href="/dashboard/catalog" className="text-sm text-indigo-700 underline underline-offset-4 hover:text-indigo-600">
            返回商品库
          </Link>
        </div>
      </section>
    </main>
  );
}

export default async function CatalogPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const initialUrl: CatalogUrlState = parseCatalogSearchParams(searchParamsToUrlSearchParams(sp));

  // 三个读取并行：主资料失败只进入明确错误页，不拖慢/吞掉其它读取；主资料成功时等它们完成再渲染。
  const [listResult, activeUser, issues] = await Promise.all([
    getCatalogListPage().then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    ),
    // 只用于缓存上下文；读取失败不影响已经成功的主资料列表。
    getCurrentActiveUser().catch(() => null),
    // 只读派生索引（不得抛错）：未启用/无权限/读取失败只影响工具栏入口提示，不影响列表本体。
    getCatalogIssueToolbarModel().catch(() => null),
  ]);

  const cacheContext = {
    principalKey: activeUser?.id ?? 'anonymous',
    amountAllowed: false,
    displayBasisSha256: '',
  };

  if (!listResult.ok) {
    /* V3-01.8：旧直链转入“商品库背景 + 弹窗”时，背景列表失败不得阻断本来可读的商品详情。 */
    if (initialUrl.detail) {
      return (
        <CatalogDirectShell
          initialUrl={initialUrl}
          cacheContext={cacheContext}
          errorKind={classifyListFailure(listResult.error)}
        />
      );
    }
    return <ListErrorState kind={classifyListFailure(listResult.error)} />;
  }
  const list = listResult.value;
  if (list.itemsLoadFailed) {
    if (initialUrl.detail) {
      return (
        <CatalogDirectShell
          initialUrl={initialUrl}
          cacheContext={cacheContext}
          errorKind={classifyItemsLoadFailure(list.itemsLoadError)}
        />
      );
    }
    return <ListErrorState kind={classifyItemsLoadFailure(list.itemsLoadError)} />;
  }

  const listCacheContext = {
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
      cacheContext={listCacheContext}
      issues={issues}
    />
  );
}
