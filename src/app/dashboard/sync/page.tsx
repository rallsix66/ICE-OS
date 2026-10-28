import type { Metadata } from 'next';
import { ReadFailurePanel } from '@/features/inventory/components/display';
import { SyncView } from '@/features/inventory/components/sync-view';
import {
  classifyReadFailure,
  errorMessageOf,
  parseSyncSearchParams,
} from '@/features/inventory/model';
import {
  getInventorySyncOverview,
  getInventorySyncRun,
  getInventoryWarehouseStates,
  requireInventoryAdmin,
} from '@/features/inventory/server/reads';
import { getInventoryDomesticSnapshot } from '@/features/inventory/server/domestic-reads';
import type {
  InventoryDomesticSnapshotDto,
  InventoryOverviewDto,
  InventoryRunDetailDto,
  InventoryWarehouseReadStateV2Dto,
} from '@/features/inventory/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const metadata: Metadata = { title: '数据同步 · BigSeller' };

/** 服务端 searchParams（可能为数组）→ URLSearchParams。 */
function toUrlSearchParams(sp: Record<string, string | string[] | undefined>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) {
    if (value === undefined) continue;
    const first = Array.isArray(value) ? value[0] : value;
    if (first !== undefined) params.set(key, first);
  }
  return params;
}

/**
 * 数据同步页（R6 紧凑来源总览）：首屏按数据来源一行展示真实状态、最后成功数据时间、
 * 下次计划、待处理对应与关键操作；逐仓结果/任务历史/失败详情/原请求核对收进同一来源「详情」，
 * 频率/参与仓/保存与后台诊断收进「设置」，均按需展开。
 * 数据仍走既有只读入口：总览、逐仓最后完整成功批次、国内冻结表格快照；不新增 API 或权限。
 */
export default async function SyncPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const query = parseSyncSearchParams(toUrlSearchParams(sp));

  let identity;
  try {
    identity = await requireInventoryAdmin();
  } catch (error) {
    return <ReadFailurePanel kind={classifyReadFailure(error)} backHref="/dashboard/catalog" backLabel="返回 ICE 商品库" />;
  }

  // 总览、逐仓状态与国内快照并行读取：首屏来源行优先，互不拖慢。
  const [overviewSettled, warehouseStatesSettled, domesticSettled] = await Promise.allSettled([
    getInventorySyncOverview(identity),
    getInventoryWarehouseStates(identity),
    getInventoryDomesticSnapshot(identity),
  ]);
  if (overviewSettled.status === 'rejected') {
    return (
      <ReadFailurePanel
        kind={classifyReadFailure(overviewSettled.reason)}
        backHref="/dashboard/catalog"
        backLabel="返回 ICE 商品库"
        extra={<p style={{ margin: '10px 0 0', color: '#8d98a8', fontSize: '12px' }}>同步总览没有读到，因此不显示任何任务数量或“全部成功”状态。</p>}
      />
    );
  }
  const overview: InventoryOverviewDto = overviewSettled.value;
  const warehouseStates: InventoryWarehouseReadStateV2Dto[] | null = warehouseStatesSettled.status === 'fulfilled'
    ? warehouseStatesSettled.value
    : null;
  const warehouseStatesError = warehouseStatesSettled.status === 'rejected'
    ? (classifyReadFailure(warehouseStatesSettled.reason) === 'forbidden' ? '当前账号无权读取逐仓状态' : '逐仓状态读取失败（网络或后台异常）')
    : null;
  // 国内快照读取失败时保持 null：来源行显示“未读取/文件日期见库存页”，不显示 0 或假成功。
  const domesticSnapshot: InventoryDomesticSnapshotDto | null = domesticSettled.status === 'fulfilled'
    ? domesticSettled.value
    : null;

  // 只有显式 ?run= 才读取历史任务详情；日常首屏不额外读任务详情。
  let runDetail: InventoryRunDetailDto | null = null;
  let runError: string | null = null;
  if (query.run) {
    try {
      runDetail = await getInventorySyncRun(identity, query.run);
    } catch (error) {
      const notFound = /INVENTORY_RUN_NOT_FOUND/.test(errorMessageOf(error));
      if (!notFound) {
        runError = classifyReadFailure(error) === 'forbidden' ? '当前账号无权读取该任务' : '网络或后台异常';
      }
    }
  }

  return (
    <SyncView
      overview={overview}
      query={query}
      warehouseStates={warehouseStates}
      warehouseStatesError={warehouseStatesError}
      runDetail={runDetail}
      runError={runError}
      domesticSnapshot={domesticSnapshot}
      viewer={{ actorId: identity.profileUserId, accountId: overview.account.accountId ?? '' }}
    />
  );
}
