import type { Metadata } from 'next';
import { ShipmentReadFailurePanel } from '@/features/shipment/components/read-failure-panel';
import { InTransitView } from '@/features/shipment/components/shipment-view';
import {
  classifyShipmentReadFailure,
  parseShipmentSearchParams,
  shipmentOffset,
  shortShipmentFailure,
} from '@/features/shipment/model';
import {
  getShipmentDetail,
  getShipmentGroupingReviews,
  getShipmentList,
  getShipmentValuePage,
} from '@/features/shipment/server/reads';
import { getMyInventoryAccess } from '@/features/access/server/reads';
import type {
  ShipmentDetailDto,
  ShipmentListDto,
  ShipmentValuePageDto,
} from '@/features/shipment/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const metadata: Metadata = { title: '物流在途' };

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
 * 物流在途（货票）页：飞书物流情况表的只读投影。
 *
 * - 管理员：两个主视图「货票列表｜货值汇总」共用市场筛选，可做拆合票复核；
 * - 成员（045）：只读「货票列表」，范围由服务端按账号获授的物流市场收窄；
 *   页面不传市场范围，也不显示货值、改票、商品绑定等管理员能力；
 * - 列表/详情各自读取：任一失败只降级对应区域，不伪造 0 或空数据；
 * - 详情抽屉由客户端壳按 URL 打开，关闭后回到原筛选与页码（成员同一套行为）。
 */
export default async function InTransitPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const query = parseShipmentSearchParams(toUrlSearchParams(sp));
  const access = await getMyInventoryAccess().catch(() => null);
  const isAdmin = access?.isAdmin === true;
  const member = !isAdmin;
  if (!isAdmin && access?.canViewShipment !== true) {
    return (
      <ShipmentReadFailurePanel
        kind="forbidden"
        backHref="/dashboard/inventory"
        backLabel="返回商品库存"
        extra={<p>当前账号还没有任何物流市场授权，请联系管理员在「权限设置 → 账号管理」勾选可查看的物流市场。</p>}
      />
    );
  }
  const valueView = isAdmin && query.view === 'value';

  let list: ShipmentListDto;
  try {
    list = await getShipmentList({
      market: query.market,
      status: query.status,
      q: query.q,
      product: query.product,
      includeAbsent: query.includeAbsent,
      limit: query.limit,
      offset: shipmentOffset(query.page, query.limit),
    }, { includeAdminMeta: isAdmin });
  } catch (error) {
    const kind = classifyShipmentReadFailure(error);
    return (
      <ShipmentReadFailurePanel
        kind={kind}
        backHref={member ? '/dashboard/inventory' : '/dashboard/catalog'}
        backLabel={member ? '返回商品库存' : '返回 ICE 商品库'}
        extra={kind === 'read_failed' ? (
          <p>飞书来源读取失败时不会清空已保存的货票；可稍后重新打开本页或到「数据同步」重试。</p>
        ) : null}
      />
    );
  }

  // 管理员的货值/复核与详情互不依赖：并行读取；各自失败只降级对应区域。
  // 成员只读列表与授权票详情：不读货值、不读拆合票复核、不算货值。
  const detailOutcomePromise = query.ticket
    ? getShipmentDetail(query.ticket, { member })
      .then((value) => ({ ok: true as const, value }))
      .catch((error: unknown) => ({ ok: false as const, error: shortShipmentFailure(error) }))
    : Promise.resolve({ ok: true as const, value: null as ShipmentDetailDto | null });
  const adminOutcomePromise = isAdmin
    ? Promise.all([
      valueView
        ? getShipmentValuePage(query.market)
          .then((value) => ({ ok: true as const, value }))
          .catch((error: unknown) => ({ ok: false as const, error: shortShipmentFailure(error) }))
        : Promise.resolve({ ok: true as const, value: null as ShipmentValuePageDto | null }),
      getShipmentGroupingReviews()
        .then((value) => ({ ok: true as const, value }))
        .catch((error: unknown) => ({ ok: false as const, error: shortShipmentFailure(error) })),
    ])
    : Promise.resolve([
      { ok: true as const, value: null as ShipmentValuePageDto | null },
      { ok: true as const, value: null },
    ] as const);
  const [detailOutcome, [valueOutcome, reviewsOutcome]] = await Promise.all([
    detailOutcomePromise,
    adminOutcomePromise,
  ]);
  const valuePage = valueOutcome.ok ? valueOutcome.value : null;

  return (
    <InTransitView
      query={query}
      list={list}
      isAdmin={isAdmin}
      detail={detailOutcome.ok ? detailOutcome.value : null}
      detailError={detailOutcome.ok ? null : detailOutcome.error}
      marketSummary={valuePage?.selected ?? null}
      valueOverview={valuePage?.overview ?? null}
      valueDetails={valuePage?.markets ?? null}
      valueError={valueOutcome.ok ? null : valueOutcome.error}
      associationSuggestions={valuePage?.suggestions ?? null}
      groupingReviews={reviewsOutcome.ok ? reviewsOutcome.value : null}
      groupingReviewsError={reviewsOutcome.ok ? null : reviewsOutcome.error}
    />
  );
}
