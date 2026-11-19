import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getCurrentActiveUser } from '@/lib/auth';
import { getMyInventoryAccess } from '@/features/access/server/reads';
import { ReadFailurePanel } from '@/features/inventory/components/display';
import { classifyReadFailure } from '@/features/inventory/model';
import { BusinessOverviewPage } from '@/features/overview/components/business-overview-page';
import { parseHomeSearchParams } from '@/features/overview/model';
import { getBusinessOverviewData } from '@/features/overview/server/reads';
import { MemberOverviewPage } from '@/features/member-overview/components/member-overview-page';
import { getMemberOverviewSections } from '@/features/member-overview/server/reads';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const metadata: Metadata = { title: '经营总览' };

/**
 * /dashboard 经营总览（登录后的默认首页）。
 *
 * - 管理员：沿用原经营总览（三阶段、货值、待处理、商品概览），口径不变；
 * - 成员：只渲染「成员经营总览 v1」——海外库存按获授仓库汇总、物流按获授市场汇总，
 *   两块分别读取、分别失败；只获授一类时只显示可用板块，两类都无授权显示空态；
 * - 成员不再被重定向到商品库存/物流页，登录后就在 /dashboard 看自己负责的货。
 */
export default async function DashboardHomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await getCurrentActiveUser();
  if (!actor) redirect('/auth/login');

  const access = await getMyInventoryAccess().catch(() => null);
  const isAdmin = actor.roleName === 'admin' || access?.isAdmin === true;

  if (!isAdmin) {
    if (!access) {
      return (
        <MemberOverviewPage
          canViewInventory={false}
          canViewShipment={false}
          inventory={{ data: null, error: null }}
          shipment={{ data: null, error: null }}
          accessError="权限读取失败，暂时无法确认可查看的库存与物流范围；请刷新重试。"
        />
      );
    }
    const canViewInventory = access.canViewInventory && access.warehouses.length > 0;
    const canViewShipment = access.canViewShipment && access.shipmentMarkets.length > 0;
    if (!canViewInventory && !canViewShipment) {
      return (
        <MemberOverviewPage
          canViewInventory={false}
          canViewShipment={false}
          inventory={{ data: null, error: null }}
          shipment={{ data: null, error: null }}
        />
      );
    }
    const sections = await getMemberOverviewSections({ ...access, canViewInventory, canViewShipment });
    return (
      <MemberOverviewPage
        canViewInventory={canViewInventory}
        canViewShipment={canViewShipment}
        inventory={sections.inventory}
        shipment={sections.shipment}
      />
    );
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
