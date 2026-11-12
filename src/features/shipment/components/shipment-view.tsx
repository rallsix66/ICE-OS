'use client';

import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { PageHeading } from '@/ui/ice-v4/data-surface';
import { PendingEntry } from '@/ui/ice-v4/pending-entry';
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
  ShipmentAssociationSuggestionDto,
  ShipmentDetailDto,
  ShipmentGroupingReviewsDto,
  ShipmentListDto,
  ShipmentMarketSummaryDto,
  ShipmentValueMarketDetailDto,
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
  valueOverview,
  valueDetails,
  valueError,
  associationSuggestions,
  groupingReviews,
  groupingReviewsError,
}: {
  query: ShipmentQueryState;
  list: ShipmentListDto;
  detail: ShipmentDetailDto | null;
  detailError: string | null;
  /** 选中单个市场时的完整汇总（含逐商品明细）；全部市场时为 null。 */
  marketSummary: ShipmentMarketSummaryDto | null;
  valueOverview: ShipmentValueOverviewDto | null;
  /** 各市场的就地展开数据（商品构成 + 未计入明细）。 */
  valueDetails: ShipmentValueMarketDetailDto[] | null;
  /** 货值汇总读取失败原因（一个读取链，失败即整块降级，不伪造 0）。 */
  valueError: string | null;
  /** 未关联明细 itemId → 同市场同品名可选商品建议。 */
  associationSuggestions: Record<string, ShipmentAssociationSuggestionDto[]> | null;
  groupingReviews: ShipmentGroupingReviewsDto | null;
  groupingReviewsError: string | null;
}) {
  const router = useRouter();
  const columns = shipmentTableColumns();
  const controls = useTableControls({ storageKey: SHIPMENT_TABLE_STORAGE_KEY, columns });
  const lastTriggerRef = useRef<HTMLElement | null>(null);
  const pushedRef = useRef(false);
  const wasOpenRef = useRef(false);
  /** 快速关闭（URL 还没带上 ticket）时先把列表地址 replace 上去，等 in-flight push 落地后再次收起。 */
  const suppressPushRef = useRef(false);
  const restoreRef = useRef<{ tableTop: number; windowY: number } | null>(null);
  const [pendingTicket, setPendingTicket] = useState('');

  // 详情导航完成（URL 已带 ticket）后清掉本地「读取中」占位。
  useEffect(() => {
    if (pendingTicket && query.ticket === pendingTicket) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 外部（URL）状态接管后就地收尾
      setPendingTicket('');
    }
  }, [pendingTicket, query.ticket]);

  // 快速关闭时 push 可能晚于关闭落地：URL 一旦带上 ticket 立即收回列表地址，
  // 避免“关掉详情却回到上一页（例如商品库）”并让展开市场/滚动位置丢失。
  useEffect(() => {
    if (!suppressPushRef.current || !query.ticket) return;
    suppressPushRef.current = false;
    router.replace(buildShipmentListHref(query), { scroll: false });
  }, [query, router]);

  /** 关闭详情后把列表滚动位置放回打开前（焦点回焦会让原按钮滚进视野）。 */
  const restoreScroll = useCallback(() => {
    const saved = restoreRef.current;
    if (!saved) return;
    const table = document.querySelector<HTMLElement>('[data-testid="shipment-table-scroll"]');
    if (table) table.scrollTop = saved.tableTop;
    window.scrollTo(0, saved.windowY);
  }, []);

  const openTicket = useCallback((shipmentId: string, trigger: HTMLElement | null, itemId?: string) => {
    // 列表与货值汇总都要恢复：窗口滚动位置两边都记；表格内部滚动只有列表视图有。
    const table = document.querySelector<HTMLElement>('[data-testid="shipment-table-scroll"]');
    restoreRef.current = { tableTop: table?.scrollTop ?? 0, windowY: window.scrollY };
    lastTriggerRef.current = trigger ?? null;
    pushedRef.current = true;
    setPendingTicket(shipmentId);
    router.push(buildShipmentDetailHref(query, shipmentId, itemId), { scroll: false });
  }, [query, router]);

  const closeTicket = useCallback(() => {
    const trigger = lastTriggerRef.current;
    lastTriggerRef.current = null;
    setPendingTicket('');
    if (pushedRef.current && query.ticket) {
      // 地址已经是详情：正常回退到打开前的列表地址（保留市场筛选与视图）。
      pushedRef.current = false;
      router.back();
    } else {
      // 地址还没提交（快速关闭）：用列表地址替换当前项，绝不 back 到上一页；
      // 若 in-flight 的 push 之后才落地，交给上面的 effect 再收回。
      suppressPushRef.current = pushedRef.current;
      pushedRef.current = false;
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
        <ViewTabs view={valueView ? 'value' : 'list'} hrefFor={viewHref} />
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
            variant="custom"
            trigger={(openModal, pendingCount) => (
              <PendingEntry
                count={pendingCount}
                state={groupingReviews ? 'ok' : 'failed'}
                onOpen={openModal}
                testId="shipment-pending-open"
              />
            )}
          />
        )}
      />

      {valueView ? (
        <div id="shipment-panel-value" role="tabpanel" aria-label="货值汇总">
          <ShipmentValueView
            query={query}
            overview={valueOverview}
            details={valueDetails}
            summary={marketSummary}
            suggestions={associationSuggestions}
            error={valueError}
            initialExcludedOpen={query.excludedOpen}
            onOpenTicket={(shipmentId, itemId) => openTicket(shipmentId, null, itemId)}
          />
        </div>
      ) : (
        <div id="shipment-panel-list" role="tabpanel" aria-label="货票列表">
          <ShipmentTable
            query={query}
            page={list}
            columns={columns}
            controls={controls}
            onOpen={openTicket}
            footer={<ShipmentPagination query={query} total={list.total} limit={list.limit} page={query.page} />}
          />
        </div>
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

/**
 * 主视图页签：选中态明确（aria-selected + 高亮样式），方向键/Home/End 可切换。
 * 仍用链接导航（保留可点击地址与前进后退），但按 WAI-ARIA tabs 语义标注。
 */
function ViewTabs({
  view,
  hrefFor,
}: {
  view: 'list' | 'value';
  hrefFor: (view: 'list' | 'value') => string;
}) {
  const router = useRouter();
  const listRef = useRef<HTMLAnchorElement | null>(null);
  const valueRef = useRef<HTMLAnchorElement | null>(null);
  const focusTab = (target: 'list' | 'value') => {
    window.requestAnimationFrame(() => {
      (target === 'list' ? listRef : valueRef).current?.focus();
    });
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = event.key === 'ArrowRight' || event.key === 'End'
      ? 'value'
      : event.key === 'ArrowLeft' || event.key === 'Home'
        ? 'list'
        : null;
    if (target === null) return;
    event.preventDefault();
    if (target === view) {
      focusTab(target);
      return;
    }
    router.push(hrefFor(target), { scroll: false });
    focusTab(target);
  };
  return (
    <div
      className={styles.viewTabs}
      role="tablist"
      aria-label="在途主视图"
      data-testid="shipment-view-tabs"
      onKeyDown={onKeyDown}
    >
      <Link
        ref={listRef}
        href={hrefFor('list')}
        role="tab"
        aria-selected={view === 'list'}
        aria-controls="shipment-panel-list"
        tabIndex={view === 'list' ? 0 : -1}
        className={view === 'list' ? styles.viewTabActive : styles.viewTab}
        data-active={view === 'list'}
        data-testid="shipment-view-list"
      >
        货票列表
      </Link>
      <Link
        ref={valueRef}
        href={hrefFor('value')}
        role="tab"
        aria-selected={view === 'value'}
        aria-controls="shipment-panel-value"
        tabIndex={view === 'value' ? 0 : -1}
        className={view === 'value' ? styles.viewTabActive : styles.viewTab}
        data-active={view === 'value'}
        data-testid="shipment-view-value"
      >
        货值汇总
      </Link>
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
