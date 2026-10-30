'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCw } from 'lucide-react';
import { FilterChip, SearchField, SelectMenu } from '@/ui/ice-v4/data-surface';
import surface from '@/ui/ice-v4/data-surface.module.css';
import { ColumnsMenu, type TableColumn, type TableControls } from '@/ui/ice-v4/table-tools';
import styles from './inventory.module.css';
import { buildInventoryListHref, UNKNOWN_MARKET_TOKEN, type InventoryQueryState } from '../model';
import type { InventoryWarehouseDto } from '../types';

const SEARCH_DEBOUNCE_MS = 300;

const SOURCE_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: 'overseas', label: 'BigSeller' },
  { value: 'domestic', label: '聚水潭' },
];

/**
 * 库存工具栏：搜索输入即查（300ms 防抖，保留旧结果，输入框内转圈），
 * 来源/仓库下拉即查，刷新为图标按钮；显示列、清空、计数与商品库同一行。
 */
export function InventoryFilterBar({
  query,
  warehouses,
  columns,
  controls,
  total,
}: {
  query: InventoryQueryState;
  warehouses: InventoryWarehouseDto[];
  /** 当前视图的列定义与布局状态（显示列菜单与表格共用）。 */
  columns: TableColumn[];
  controls: TableControls;
  /** 当前筛选范围的总条数（null = 尚未读取）。 */
  total: number | null;
}) {
  const router = useRouter();
  const [term, setTerm] = useState(query.q);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [searchPending, startSearch] = useTransition();
  const [, startFilter] = useTransition();
  const [refreshPending, startRefresh] = useTransition();
  // URL 是唯一事实：清空标签/前进后退时同步输入框；输入中的值未被导航覆盖（等值即保留）。
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 受控输入需要跟随 URL 外部变化
    setTerm((current) => (current.trim() === query.q ? current : query.q));
  }, [query.q]);

  const domesticScope = query.source === 'domestic';
  const warehouseOptions = [
    { value: 'all', label: '全部仓库' },
    ...warehouses
      .filter((warehouse) => warehouse.status === 'confirmed')
      .map((warehouse) => ({ value: warehouse.id, label: warehouse.name })),
  ];
  const selectedWarehouse = warehouses.find((warehouse) => warehouse.id === query.warehouse) ?? null;
  const hasFilters = Boolean(query.q) || query.warehouse !== 'all' || query.market !== 'all';
  const sortParams = { sort: query.sort, sortDir: query.sortDir };
  const clearHref = buildInventoryListHref({
    q: '',
    warehouse: 'all',
    market: 'all',
    view: query.view,
    source: query.source,
    page: 1,
    ...sortParams,
  });
  const chips: Array<{ key: string; label: string; href: string }> = [];
  if (query.q) {
    chips.push({
      key: 'q',
      label: `搜索「${query.q}」`,
      href: buildInventoryListHref({ q: '', warehouse: query.warehouse, market: query.market, view: query.view, source: query.source, page: 1, ...sortParams }),
    });
  }
  if (!domesticScope && query.warehouse !== 'all') {
    chips.push({
      key: 'warehouse',
      label: selectedWarehouse ? `仓库：${selectedWarehouse.name}` : '仓库：已选',
      href: buildInventoryListHref({ q: query.q, warehouse: 'all', market: query.market, view: query.view, source: query.source, page: 1, ...sortParams }),
    });
  }
  if (!domesticScope && query.market !== 'all') {
    chips.push({
      key: 'market',
      label: query.market === UNKNOWN_MARKET_TOKEN ? '未知仓' : query.market,
      href: buildInventoryListHref({ q: query.q, warehouse: query.warehouse, market: 'all', view: query.view, source: query.source, page: 1, ...sortParams }),
    });
  }

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  function applySearch(nextTerm: string) {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const href = buildInventoryListHref({
      q: nextTerm.trim(),
      warehouse: query.warehouse,
      market: query.market,
      view: query.view,
      source: query.source,
      focus: query.focus,
      page: 1,
      sort: query.sort,
      sortDir: query.sortDir,
    });
    startSearch(() => router.replace(href, { scroll: false }));
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

  function onSourceChange(next: string) {
    const nextDomestic = next === 'domestic';
    startFilter(() => router.replace(buildInventoryListHref({
      q: query.q,
      warehouse: nextDomestic ? 'all' : query.warehouse,
      market: nextDomestic ? 'all' : query.market,
      view: query.view,
      source: next === 'overseas' || next === 'domestic' ? next : 'all',
      focus: query.focus,
      page: 1,
      sort: query.sort,
      sortDir: query.sortDir,
    }), { scroll: false }));
  }

  function onWarehouseChange(next: string) {
    startFilter(() => router.replace(buildInventoryListHref({
      q: query.q,
      warehouse: next,
      market: query.market,
      view: query.view,
      source: query.source,
      focus: query.focus,
      page: 1,
      sort: query.sort,
      sortDir: query.sortDir,
    }), { scroll: false }));
  }

  function onClear() {
    if (!hasFilters) return;
    startFilter(() => router.replace(clearHref, { scroll: false }));
  }

  return (
    <section className={styles.toolbarWrap} data-testid="inventory-toolbar">
      <div className={surface.toolbar} data-testid="inventory-filters">
        <SearchField
          value={term}
          onChange={onSearchChange}
          placeholder="搜索商品名称 / 货号 / 69 编码 / 来源 SKU"
          ariaLabel="搜索商品名称、货号、69 编码或来源 SKU"
          testId="inventory-search"
          pending={searchPending}
        />
        <SelectMenu
          value={query.source}
          onChange={onSourceChange}
          options={SOURCE_OPTIONS}
          ariaLabel="来源范围"
          testId="inventory-source-scope"
        />
        {domesticScope ? null : (
          <SelectMenu
            value={query.warehouse}
            onChange={onWarehouseChange}
            options={warehouseOptions}
            ariaLabel="仓库筛选"
            testId="inventory-warehouse-filter"
          />
        )}
        <button
          type="button"
          className={`${surface.button} ${surface.buttonIcon}`}
          aria-label="刷新"
          title="刷新"
          onClick={() => startRefresh(() => router.refresh())}
          disabled={refreshPending}
          data-testid="inventory-refresh"
        >
          <RefreshCw
            className={refreshPending ? styles.refreshSpinning : undefined}
            size={16}
            strokeWidth={1.8}
            aria-hidden
          />
        </button>
        <ColumnsMenu
          columns={columns}
          controls={controls}
          testId={query.view === 'warehouse' ? 'inventory-warehouse-columns' : 'inventory-summary-columns'}
        />
        <button
          type="button"
          className={surface.button}
          onClick={onClear}
          disabled={!hasFilters}
          data-testid="inventory-clear-filters"
        >
          清空
        </button>
        <span className={surface.count} data-testid="inventory-counts">
          {total === null ? '' : `共 ${total} 条`}
        </span>
      </div>
      {chips.length > 0 ? (
        <div className={surface.chips} data-testid="inventory-filter-chips">
          {chips.map((chip) => (
            <FilterChip key={chip.key} href={chip.href} testId={`inventory-chip-${chip.key}`}>
              {chip.label}
            </FilterChip>
          ))}
        </div>
      ) : null}
    </section>
  );
}
