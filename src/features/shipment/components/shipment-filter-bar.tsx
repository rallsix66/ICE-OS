'use client';

import { useEffect, useRef, useState, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { FilterChip, SearchField, SelectMenu } from '@/ui/ice-v4/data-surface';
import surface from '@/ui/ice-v4/data-surface.module.css';
import { ColumnsMenu, type TableColumn, type TableControls } from '@/ui/ice-v4/table-tools';
import styles from './shipment.module.css';
import {
  SHIPMENT_PAGE_SIZES,
  SHIPMENT_SEARCH_ARIA,
  SHIPMENT_SEARCH_PLACEHOLDER,
  SHIPMENT_STATUS_CLASSES,
  UNKNOWN_MARKET_TOKEN,
  buildShipmentListHref,
  marketOptionValue,
  marketText,
  shipmentStatusLabel,
  type ShipmentQueryState,
} from '../model';
import type { ShipmentListCountsDto, ShipmentMarketCountDto } from '../types';

const SEARCH_DEBOUNCE_MS = 300;

const ABSENT_OPTIONS = [
  { value: 'current', label: '仅当前来源' },
  { value: 'absent', label: '包含本次来源未见' },
];

/**
 * 市场 / 业务状态（5 类）/ 关键词 / 是否包含本次来源未见 / 每页条数：输入即查，全部写进 URL。
 * 关键词提示与列表、详情统一为「采购单号 / 运单号 / 商品名称」。
 * 货值汇总视图只保留市场筛选（两个主视图共用同一个市场）。
 */
export function ShipmentFilterBar({
  query,
  markets,
  counts,
  absentTickets,
  absentItems,
  columns,
  controls,
  compact = false,
  compactCountText,
  reviewEntry,
}: {
  query: ShipmentQueryState;
  markets: ShipmentMarketCountDto[];
  counts: ShipmentListCountsDto | null;
  /** 本次来源未见（已退出当前列表）的票数/明细数；与筛选无关。 */
  absentTickets: number;
  absentItems: number;
  columns: TableColumn[];
  controls: TableControls;
  /** true = 货值汇总视图：只显示市场筛选。 */
  compact?: boolean;
  /** 货值汇总的票数/明细数：与市场下拉、明细范围、金额取同一市场范围。 */
  compactCountText?: string;
  /** 「待复核」弹窗入口（工具栏右侧；列表与货值汇总都显示）。 */
  reviewEntry?: ReactNode;
}) {
  const router = useRouter();
  const [term, setTerm] = useState(query.q);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [searchPending, startSearch] = useTransition();
  const [, startFilter] = useTransition();

  // URL 是唯一事实：清空标签/前进后退时同步输入框。
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 受控输入需要跟随 URL 外部变化
    setTerm((current) => (current.trim() === query.q ? current : query.q));
  }, [query.q]);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const marketOptions = [
    { value: 'all', label: '全部市场' },
    ...markets.map((entry) => ({
      value: marketOptionValue(entry.market),
      label: `${marketText(entry.market)}（${entry.count}）`,
    })),
  ];
  const statusOptions = [
    { value: 'all', label: '全部状态' },
    ...SHIPMENT_STATUS_CLASSES.map((status) => ({ value: status, label: shipmentStatusLabel(status) })),
  ];
  const limitOptions = SHIPMENT_PAGE_SIZES.map((size) => ({ value: String(size), label: `每页 ${size}` }));
  const hasFilters = Boolean(query.q)
    || query.market !== 'all'
    || query.status !== 'all'
    || Boolean(query.product)
    || query.includeAbsent;
  const clearHref = buildShipmentListHref({
    market: 'all',
    status: 'all',
    q: '',
    product: '',
    includeAbsent: false,
    page: 1,
    limit: query.limit,
  });

  const chips: Array<{ key: string; label: string; href: string }> = [];
  if (query.q) {
    chips.push({
      key: 'q',
      label: `搜索「${query.q}」`,
      href: buildShipmentListHref({ ...query, q: '', page: 1 }),
    });
  }
  if (query.market !== 'all') {
    chips.push({
      key: 'market',
      label: `市场：${query.market === UNKNOWN_MARKET_TOKEN ? '未提供' : query.market}`,
      href: buildShipmentListHref({ ...query, market: 'all', page: 1 }),
    });
  }
  if (query.status !== 'all') {
    chips.push({
      key: 'status',
      label: `状态：${shipmentStatusLabel(query.status)}`,
      href: buildShipmentListHref({ ...query, status: 'all', page: 1 }),
    });
  }
  if (query.product) {
    chips.push({
      key: 'product',
      label: '商品筛选：指定商品',
      href: buildShipmentListHref({ ...query, product: '', page: 1 }),
    });
  }
  if (query.includeAbsent) {
    chips.push({
      key: 'absent',
      label: '包含本次来源未见',
      href: buildShipmentListHref({ ...query, includeAbsent: false, page: 1 }),
    });
  }

  function applySearch(nextTerm: string) {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    startSearch(() => router.replace(
      buildShipmentListHref({ ...query, q: nextTerm.trim(), page: 1 }),
      { scroll: false },
    ));
  }

  function onSearchChange(value: string) {
    setTerm(value);
    if (timerRef.current) clearTimeout(timerRef.current);
    if (value.trim() === '') {
      applySearch('');
      return;
    }
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      applySearch(value);
    }, SEARCH_DEBOUNCE_MS);
  }

  function navigate(patch: Partial<ShipmentQueryState>) {
    startFilter(() => router.replace(
      buildShipmentListHref({ ...query, ...patch, page: 1 }),
      { scroll: false },
    ));
  }

  function onClear() {
    if (!hasFilters) return;
    startFilter(() => router.replace(clearHref, { scroll: false }));
  }

  const absentText = absentTickets > 0
    ? `本次来源未见 ${absentTickets} 票 / ${absentItems} 条明细（历史保留）`
    : '';

  if (compact) {
    return (
      <section className={styles.toolbarWrap} data-testid="shipment-toolbar">
        <div className={surface.toolbar} data-testid="shipment-filters">
          <SelectMenu
            value={query.market}
            onChange={(next) => navigate({ market: next })}
            options={marketOptions}
            ariaLabel="市场筛选"
            testId="shipment-market-filter"
          />
          <span className={surface.count} data-testid="shipment-counts">
            {compactCountText !== undefined
              ? compactCountText
              : counts ? `共 ${counts.total} 票` : ''}
          </span>
          {reviewEntry ?? null}
        </div>
      </section>
    );
  }

  return (
    <section className={styles.toolbarWrap} data-testid="shipment-toolbar">
      <div className={surface.toolbar} data-testid="shipment-filters">
        <SearchField
          value={term}
          onChange={onSearchChange}
          placeholder={SHIPMENT_SEARCH_PLACEHOLDER}
          ariaLabel={SHIPMENT_SEARCH_ARIA}
          testId="shipment-search"
          pending={searchPending}
        />
        <SelectMenu
          value={query.market}
          onChange={(next) => navigate({ market: next })}
          options={marketOptions}
          ariaLabel="市场筛选"
          testId="shipment-market-filter"
        />
        <SelectMenu
          value={query.status}
          onChange={(next) => navigate({ status: next === 'all' ? 'all' : next as ShipmentQueryState['status'] })}
          options={statusOptions}
          ariaLabel="业务状态筛选"
          testId="shipment-status-filter"
        />
        <SelectMenu
          value={query.includeAbsent ? 'absent' : 'current'}
          onChange={(next) => navigate({ includeAbsent: next === 'absent' })}
          options={ABSENT_OPTIONS}
          ariaLabel="是否包含本次来源未见"
          testId="shipment-absent-filter"
        />
        <SelectMenu
          value={String(query.limit)}
          onChange={(next) => navigate({ limit: Number(next) })}
          options={limitOptions}
          ariaLabel="每页条数"
          testId="shipment-limit-filter"
        />
        <ColumnsMenu columns={columns} controls={controls} testId="shipment-columns" />
        <button
          type="button"
          className={surface.button}
          onClick={onClear}
          disabled={!hasFilters}
          data-testid="shipment-clear-filters"
        >
          清空
        </button>
        <span className={surface.count} data-testid="shipment-counts">
          {counts ? `共 ${counts.total} 票` : ''}
        </span>
        {reviewEntry ?? null}
      </div>
      {chips.length > 0 ? (
        <div className={surface.chips} data-testid="shipment-filter-chips">
          {chips.map((chip) => (
            <FilterChip key={chip.key} href={chip.href} testId={`shipment-chip-${chip.key}`}>
              {chip.label}
            </FilterChip>
          ))}
        </div>
      ) : null}
      {absentText ? (
        <p className={styles.pageNotice} data-testid="shipment-absent-note">{absentText}</p>
      ) : null}
    </section>
  );
}
