import type { Metadata } from 'next';
import {
  buildOperationHref,
  operationDateBounds,
  OPERATION_PAGE_SIZE,
  parseOperationSearchParams,
} from '@/features/operations/model';
import { getOperationRecords, requireOperationsAdmin } from '@/features/operations/server/reads';
import { OperationsUnavailable, OperationsView } from '@/features/operations/components/operations-view';
import type { OperationRecordsPageDto } from '@/features/operations/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const metadata: Metadata = { title: '操作记录' };

function toUrlSearchParams(sp: Record<string, string | string[] | undefined>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) {
    if (value === undefined) continue;
    const first = Array.isArray(value) ? value[0] : value;
    if (first !== undefined) params.set(key, first);
  }
  return params;
}

/** 读取失败的短原因：分类说明，不把 SQL/连接串带到页面。 */
function shortReadError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (/CATALOG_FORBIDDEN|未登录|无权/.test(message)) return '当前账号无权读取操作记录';
  if (/does not exist|not found|OPERATION_RECORDS_INVALID/i.test(message)) return '当前实例还没有安装操作记录查询';
  return '网络或后台读取异常';
}

/**
 * 操作记录页（只读）。
 *
 * - 三类记录来自 042 只读函数（商品资料 / 库存对应 / 物流），不读业务表、不写数据；
 * - 筛选（类别、记录账号、日期、关键词）与页码全部在 URL 上：刷新、返回、直链一致；
 * - 日期是 +08 自然日；开始晚于结束时不查询，只提示；
 * - 页码超出末页时回读最后一页（不显示空页），页码以实际返回结果为准。
 */
export default async function OperationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const query = parseOperationSearchParams(toUrlSearchParams(sp));
  const bounds = operationDateBounds(query);

  let identity;
  try {
    identity = await requireOperationsAdmin();
  } catch {
    return <OperationsUnavailable kind="forbidden" />;
  }

  let page: OperationRecordsPageDto | null = null;
  let readError: string | null = null;
  let rangeInvalid = false;
  if (bounds.invalid) {
    rangeInvalid = true;
  } else {
    try {
      page = await getOperationRecords(identity, {
        category: query.category,
        actor: query.actor,
        from: bounds.from,
        to: bounds.to,
        search: query.q,
        limit: OPERATION_PAGE_SIZE,
        offset: (query.page - 1) * OPERATION_PAGE_SIZE,
      });
      if (page.total > 0 && page.rows.length === 0) {
        // 页码超出末页：回读最后一页；不伪造空页。
        const lastPage = Math.max(1, Math.ceil(page.total / OPERATION_PAGE_SIZE));
        page = await getOperationRecords(identity, {
          category: query.category,
          actor: query.actor,
          from: bounds.from,
          to: bounds.to,
          search: query.q,
          limit: OPERATION_PAGE_SIZE,
          offset: (lastPage - 1) * OPERATION_PAGE_SIZE,
        });
      }
    } catch (error) {
      readError = shortReadError(error);
    }
  }

  return (
    <OperationsView
      query={query}
      page={page}
      rangeInvalid={rangeInvalid}
      readError={readError}
      retryHref={buildOperationHref(query)}
    />
  );
}
