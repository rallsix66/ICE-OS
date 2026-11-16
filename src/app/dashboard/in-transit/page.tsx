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
  // 货值汇总（第十七轮）：一次 028 读取同时产出全部市场汇总、各市场展开数据、
  // 选中市场的完整汇总与未关联明细的商品建议；点市场不再跳转/整页刷新。
  const [detailOutcome, valueOutcome, reviewsOutcome] = await Promise.all([
    query.ticket
      ? getShipmentDetail(query.ticket)
        .then((value) => ({ ok: true as const, value }))
        .catch((error: unknown) => ({ ok: false as const, error: shortShipmentFailure(error) }))
      : Promise.resolve({ ok: true as const, value: null as ShipmentDetailDto | null }),
    valueView
      ? getShipmentValuePage(query.market)
        .then((value) => ({ ok: true as const, value }))
        .catch((error: unknown) => ({ ok: false as const, error: shortShipmentFailure(error) }))
      : Promise.resolve({ ok: true as const, value: null as ShipmentValuePageDto | null }),
    getShipmentGroupingReviews()
      .then((value) => ({ ok: true as const, value }))
      .catch((error: unknown) => ({ ok: false as const, error: shortShipmentFailure(error) })),
  ]);
  const valuePage = valueOutcome.ok ? valueOutcome.value : null;

  return (
    <InTransitView
      query={query}
      list={list}
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
