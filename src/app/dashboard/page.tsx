import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getCurrentActiveUser } from '@/lib/auth';
import { getMyInventoryAccess } from '@/features/access/server/reads';
import { ReadFailurePanel } from '@/features/inventory/components/display';
import { classifyReadFailure } from '@/features/inventory/model';
import { BusinessOverviewPage } from '@/features/overview/components/business-overview-page';
import { parseHomeSearchParams } from '@/features/overview/model';
import { getBusinessOverviewData } from '@/features/overview/server/reads';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const metadata: Metadata = { title: '经营总览' };

/**
 * /dashboard 经营总览（登录后的默认首页）。
 *
 * - 数据在服务端按完整范围汇总后再做搜索/分页，不在页面累加来源行；
 * - 商品汇总是首页数量主来源：读不到时整页明确失败，不显示 0 或假总额；
 *   国内快照、在途来源、成本各自失败只降级对应阶段/金额，并在页面说明。
 * - 三阶段来源时点不同：不提供跨阶段总资产，未知与真实零分开。
 */
export default async function DashboardHomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // 权限设置 v1：成员没有全站总览权限，登录后直接进自己能用的页面：
  // 有库存范围去商品库存；只有物流市场授权去物流在途；两者都没有仍回库存看空态提示。
  const actor = await getCurrentActiveUser();
  if (actor && actor.roleName !== 'admin') {
    const access = await getMyInventoryAccess().catch(() => null);
    redirect(access && !access.canViewInventory && access.canViewShipment
      ? '/dashboard/in-transit'
      : '/dashboard/inventory');
  }

  const sp = await searchParams;
  const query = parseHomeSearchParams(sp);

  let data;
  try {
    data = await getBusinessOverviewData();
  } catch (error) {
    return (
      <ReadFailurePanel
        kind={classifyReadFailure(error)}
        backHref="/dashboard/sync"
        backLabel="前往数据同步"
        extra={(
          <p style={{ margin: '10px 0 0', color: '#8d98a8', fontSize: '12px' }}>
            首页数量来自商品库存汇总；没有读到时不显示任何总额或“没有库存”的结论，可刷新重试。
          </p>
        )}
      />
    );
  }

  return <BusinessOverviewPage data={data} query={query} />;
}
