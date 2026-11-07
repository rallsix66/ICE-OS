import type { Metadata } from 'next';
import { ShipmentReadFailurePanel } from '@/features/shipment/components/read-failure-panel';
import { InTransitView } from '@/features/shipment/components/shipment-view';
import {
  SHIPMENT_MARKET_ALL,
  classifyShipmentReadFailure,
  parseShipmentSearchParams,
  shipmentOffset,
  shortShipmentFailure,
} from '@/features/shipment/model';
import {
  getShipmentDetail,
  getShipmentGroupingReviews,
  getShipmentList,
  getShipmentMarketSummary,
  getShipmentValueOverview,
} from '@/features/shipment/server/reads';
import type {
  ShipmentDetailDto,
  ShipmentListDto,
  ShipmentMarketSummaryDto,
  ShipmentValueOverviewDto,
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
 * - 两个主视图「货票列表｜货值汇总」共用市场筛选；默认货票列表，切换视图保留市场；
 * - 列表/详情/货值/复核各自读取：任一失败只降级对应区域，不伪造 0 或空数据；
 * - 读取状态统一在「数据同步」页；本页读取失败且仍在展示旧数据时只留一行提示与入口；
 * - 详情抽屉由客户端壳按 URL 打开，关闭后回到原筛选与页码。
 */
export default async function InTransitPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const query = parseShipmentSearchParams(toUrlSearchParams(sp));
  const valueView = query.view === 'value';

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
    });
  } catch (error) {
    const kind = classifyShipmentReadFailure(error);
    return (
      <ShipmentReadFailurePanel
        kind={kind}
        backHref="/dashboard/catalog"
        backLabel="返回 ICE 商品库"
        extra={kind === 'read_failed' ? (
          <p>飞书来源读取失败时不会清空已保存的货票；可稍后重新打开本页或到「数据同步」重试。</p>
        ) : null}
      />
    );
  }

  // 详情 / 货值 / 复核互不依赖：并行读取；各自失败只降级对应区域。
  const [detailOutcome, marketOutcome, overviewOutcome, reviewsOutcome] = await Promise.all([
    query.ticket
      ? getShipmentDetail(query.ticket)
        .then((value) => ({ ok: true as const, value }))
        .catch((error: unknown) => ({ ok: false as const, error: shortShipmentFailure(error) }))
      : Promise.resolve({ ok: true as const, value: null as ShipmentDetailDto | null }),
    valueView && query.market !== SHIPMENT_MARKET_ALL
      ? getShipmentMarketSummary(query.market)
        .then((value) => ({ ok: true as const, value }))
        .catch((error: unknown) => ({ ok: false as const, error: shortShipmentFailure(error) }))
      : Promise.resolve({ ok: true as const, value: null as ShipmentMarketSummaryDto | null }),
    // 货值汇总始终读一次「全部市场」：市场下拉与票数/明细数都按同一市场范围取数，
    // 不受列表关键词筛选影响（第十三轮）。
    valueView
      ? getShipmentValueOverview()
        .then((value) => ({ ok: true as const, value }))
        .catch((error: unknown) => ({ ok: false as const, error: shortShipmentFailure(error) }))
      : Promise.resolve({ ok: true as const, value: null as ShipmentValueOverviewDto | null }),
    getShipmentGroupingReviews()
      .then((value) => ({ ok: true as const, value }))
      .catch((error: unknown) => ({ ok: false as const, error: shortShipmentFailure(error) })),
  ]);

  return (
    <InTransitView
      query={query}
      list={list}
      detail={detailOutcome.ok ? detailOutcome.value : null}
      detailError={detailOutcome.ok ? null : detailOutcome.error}
      marketSummary={marketOutcome.ok ? marketOutcome.value : null}
      marketSummaryError={marketOutcome.ok ? null : marketOutcome.error}
      valueOverview={overviewOutcome.ok ? overviewOutcome.value : null}
      valueOverviewError={overviewOutcome.ok ? null : overviewOutcome.error}
      groupingReviews={reviewsOutcome.ok ? reviewsOutcome.value : null}
      groupingReviewsError={reviewsOutcome.ok ? null : reviewsOutcome.error}
    />
  );
}
