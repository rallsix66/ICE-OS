'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { PageHeading } from '@/ui/ice-v4/data-surface';
import { useTableControls } from '@/ui/ice-v4/table-tools';
import styles from './shipment.module.css';
import {
  SHIPMENT_MARKET_ALL,
  buildShipmentDetailHref,
  buildShipmentListHref,
  shipmentLiveStamp,
  shipmentReadFailureText,
  type ShipmentQueryState,
} from '../model';
import type {
  ShipmentDetailDto,
  ShipmentGroupingReviewsDto,
  ShipmentListDto,
  ShipmentMarketSummaryDto,
  ShipmentValueOverviewDto,
} from '../types';
import { ShipmentDetailDrawer } from './shipment-detail-drawer';
import { ShipmentFilterBar } from './shipment-filter-bar';
import { ShipmentGroupingReviewEntry } from './shipment-grouping-review';
import { ShipmentLiveRefresh } from './shipment-live-refresh';
import { ShipmentPagination } from './shipment-pagination';
import { ShipmentValueView } from './shipment-value-view';
import { SHIPMENT_TABLE_STORAGE_KEY, ShipmentTable, shipmentTableColumns } from './shipment-table';

/**
 * /dashboard/in-transit 客户端壳：
 * - 两个主视图「货票列表｜货值汇总」共用市场筛选，默认货票列表；
 * - 列表视图整块主区域只放货票列表；货值汇总单独占主区域（不叠两张滚动表）；
 * - 读取状态统一在「数据同步」：本页读取失败仍展示旧数据时只留一行提示与「查看同步」；
 * - 拆票/合票复核数量可点开，面板并排显示上次/本次分组；
 * - 详情抽屉由 URL 还原，关闭后回到原筛选、视图与页码。
 */
export function InTransitView({
  query,
  list,
  detail,
  detailError,
  marketSummary,
  marketSummaryError,
  valueOverview,
  valueOverviewError,
  groupingReviews,
  groupingReviewsError,
}: {
  query: ShipmentQueryState;
  list: ShipmentListDto;
  detail: ShipmentDetailDto | null;
  detailError: string | null;
  marketSummary: ShipmentMarketSummaryDto | null;
  marketSummaryError: string | null;
  valueOverview: ShipmentValueOverviewDto | null;
  valueOverviewError: string | null;
  groupingReviews: ShipmentGroupingReviewsDto | null;
  groupingReviewsError: string | null;
}) {
  const router = useRouter();
  const columns = shipmentTableColumns();
  const controls = useTableControls({ storageKey: SHIPMENT_TABLE_STORAGE_KEY, columns });
  const lastTriggerRef = useRef<HTMLElement | null>(null);
  const pushedRef = useRef(false);
  const wasOpenRef = useRef(false);
  const restoreRef = useRef<{ tableTop: number; windowY: number } | null>(null);
  const [pendingTicket, setPendingTicket] = useState('');

  // 详情导航完成（URL 已带 ticket）后清掉本地「读取中」占位。
  useEffect(() => {
    if (pendingTicket && query.ticket === pendingTicket) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 外部（URL）状态接管后就地收尾
      setPendingTicket('');
    }
  }, [pendingTicket, query.ticket]);

  /** 关闭详情后把列表滚动位置放回打开前（焦点回焦会让原按钮滚进视野）。 */
  const restoreScroll = useCallback(() => {
    const saved = restoreRef.current;
    if (!saved) return;
    const table = document.querySelector<HTMLElement>('[data-testid="shipment-table-scroll"]');
    if (table) table.scrollTop = saved.tableTop;
    window.scrollTo(0, saved.windowY);
  }, []);

  const openTicket = useCallback((shipmentId: string, trigger: HTMLElement | null, itemId?: string) => {
    if (query.view !== 'value') {
      const table = document.querySelector<HTMLElement>('[data-testid="shipment-table-scroll"]');
      restoreRef.current = { tableTop: table?.scrollTop ?? 0, windowY: window.scrollY };
    }
    lastTriggerRef.current = trigger ?? null;
    pushedRef.current = true;
    setPendingTicket(shipmentId);
    router.push(buildShipmentDetailHref(query, shipmentId, itemId), { scroll: false });
  }, [query, router]);

  const closeTicket = useCallback(() => {
    const trigger = lastTriggerRef.current;
    lastTriggerRef.current = null;
    setPendingTicket('');
    if (pushedRef.current) {
      pushedRef.current = false;
      router.back();
    } else {
      router.replace(buildShipmentListHref(query), { scroll: false });
    }
    if (trigger) {
      window.requestAnimationFrame(() => {
        trigger.focus({ preventScroll: true });
        restoreScroll();
      });
    } else {
      window.requestAnimationFrame(restoreScroll);
    }
  }, [query, restoreScroll, router]);

  // 浏览器后退关掉抽屉：同样把滚动位置放回打开前。
  useEffect(() => {
    if (query.ticket) {
      wasOpenRef.current = true;
      return;
    }
    if (!wasOpenRef.current) return;
    wasOpenRef.current = false;
    const frame = window.requestAnimationFrame(restoreScroll);
    return () => window.cancelAnimationFrame(frame);
  }, [query.ticket, restoreScroll]);

  // 浏览器后退关掉抽屉后，恢复「不是本页 push 出来的」状态，避免下次关闭跳回上一页。
  useEffect(() => {
    if (!query.ticket && pushedRef.current && !pendingTicket) pushedRef.current = false;
  }, [query.ticket, pendingTicket]);

  const drawerOpen = Boolean(query.ticket) || Boolean(pendingTicket);
  const loading = Boolean(pendingTicket) && !query.ticket;
  const detailForTicket = detail && query.ticket ? detail : null;
  const valueView = query.view === 'value';
  // 货值汇总与列表共用市场筛选；汇总的票数/明细数/市场下拉全部取自同一市场范围，
  // 不再沿用列表关键词过滤后的「共 1 票」（第十三轮）。
  const valueScope = valueView
    ? (query.market === SHIPMENT_MARKET_ALL ? valueOverview : marketSummary)
    : null;
  const valueMarkets = valueView && valueOverview
    ? valueOverview.markets.map((row) => ({
      market: row.unknownMarket ? null : row.market,
      count: row.ticketCount,
    }))
    : list.markets;
  const compactCountText = valueView
    ? (valueScope
      ? `共 ${valueScope.ticketCount} 票 · ${valueScope.itemCount} 条明细`
      : '')
    : undefined;

  const viewHref = (view: 'list' | 'value') => buildShipmentListHref({
    ...query,
    view,
    review: false,
  });

  return (
    <div className={styles.page} data-testid="in-transit-page">
      <div className={styles.pageHeadRow}>
        <PageHeading title="物流在途" />
        <nav className={styles.viewTabs} aria-label="在途主视图" data-testid="shipment-view-tabs">
          <Link
            href={viewHref('list')}
            className={valueView ? styles.viewTab : styles.viewTabActive}
            data-active={valueView ? 'false' : 'true'}
            data-testid="shipment-view-list"
          >
            货票列表
          </Link>
          <Link
            href={viewHref('value')}
            className={valueView ? styles.viewTabActive : styles.viewTab}
            data-active={valueView ? 'true' : 'false'}
            data-testid="shipment-view-value"
          >
            货值汇总
          </Link>
        </nav>
      </div>

      <ShipmentLiveRefresh stamp={shipmentLiveStamp(list.sourceStatus)} />

      <ShipmentReadFailureNotice sourceStatus={list.sourceStatus} />

      <ShipmentFilterBar
        query={query}
        markets={valueMarkets}
        counts={list.counts}
        absentTickets={list.absentTickets}
        absentItems={list.absentItems}
        columns={columns}
        controls={controls}
        compact={valueView}
        compactCountText={compactCountText}
        reviewEntry={(
          <ShipmentGroupingReviewEntry
            reviews={groupingReviews}
            error={groupingReviewsError}
          />
        )}
      />

      {valueView ? (
        <ShipmentValueView
          query={query}
          overview={valueOverview}
          overviewError={valueOverviewError}
          summary={marketSummary}
          summaryError={marketSummaryError}
          onOpenTicket={(shipmentId, itemId) => openTicket(shipmentId, null, itemId)}
          hrefForMarket={(market) => buildShipmentListHref({ ...query, view: 'value', market, page: 1 })}
        />
      ) : (
        <ShipmentTable
          query={query}
          page={list}
          columns={columns}
          controls={controls}
          onOpen={openTicket}
          footer={<ShipmentPagination query={query} total={list.total} limit={list.limit} page={query.page} />}
        />
      )}

      {drawerOpen ? (
        <ShipmentDetailDrawer
          detail={detailForTicket}
          detailError={detailError}
          loading={loading}
          focusItemId={query.item}
          onClose={closeTicket}
        />
      ) : null}
    </div>
  );
}

/** 读取失败但仍展示旧数据：只留一行原因 + 当前数据时间 + 查看同步（成功不显示横栏）。 */
function ShipmentReadFailureNotice({ sourceStatus }: { sourceStatus: ShipmentListDto['sourceStatus'] }) {
  const text = shipmentReadFailureText(sourceStatus);
  if (!text) return null;
  return (
    <p className={styles.readFailureLine} role="status" data-testid="shipment-read-failure-line">
      <span>{text}</span>
      <Link href="/dashboard/sync#feishu-shipment" className={styles.inlineLink}>查看同步</Link>
    </p>
  );
}
