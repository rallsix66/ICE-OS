'use client';

import Link from 'next/link';
import styles from './inventory.module.css';
import {
  buildInventoryListHref,
  marketScopeLabel,
  type InventoryQueryState,
} from '../model';
import type { InventoryWarehouseDto } from '../types';

interface WarehouseGroup {
  key: string;
  label: string;
  warehouses: InventoryWarehouseDto[];
}

function groupWarehouses(warehouses: InventoryWarehouseDto[]): WarehouseGroup[] {
  const groups = new Map<string, InventoryWarehouseDto[]>();
  for (const warehouse of warehouses) {
    if (warehouse.status !== 'confirmed') continue;
    const key = warehouse.market ?? '';
    const list = groups.get(key) ?? [];
    list.push(warehouse);
    groups.set(key, list);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
    .map(([market, list]) => ({
      key: market || '__unknown__',
      label: market ? `市场 ${market}（${list.length} 仓）` : `市场待确认（${list.length} 仓）`,
      warehouses: list.sort((a, b) => a.name.localeCompare(b.name)),
    }));
}

/**
 * 库存工具栏：搜索（回车）+ 来源 + 仓库（按市场分组），选中后直接更新。
 * 独立市场下拉已删除；只有存在国家下钻时显示一个可清除的范围标签。
 */
export function InventoryFilterBar({
  query,
  warehouses,
}: {
  query: InventoryQueryState;
  warehouses: InventoryWarehouseDto[];
}) {
  const domesticScope = query.source === 'domestic';
  const groups = groupWarehouses(warehouses);
  const selectedWarehouse = warehouses.find((warehouse) => warehouse.id === query.warehouse) ?? null;
  const hasFilters = Boolean(query.q) || query.warehouse !== 'all' || query.market !== 'all';
  const clearHref = buildInventoryListHref({
    q: '',
    warehouse: 'all',
    market: 'all',
    view: query.view,
    source: query.source,
    page: 1,
  });
  const chips: Array<{ key: string; label: string; href: string }> = [];
  if (query.q) {
    chips.push({
      key: 'q',
      label: `搜索「${query.q}」`,
      href: buildInventoryListHref({ q: '', warehouse: query.warehouse, market: query.market, view: query.view, source: query.source, page: 1 }),
    });
  }
  if (!domesticScope && query.warehouse !== 'all') {
    chips.push({
      key: 'warehouse',
      label: selectedWarehouse ? `仓库：${selectedWarehouse.name}` : '仓库：已选',
      href: buildInventoryListHref({ q: query.q, warehouse: 'all', market: query.market, view: query.view, source: query.source, page: 1 }),
    });
  }
  if (!domesticScope && query.market !== 'all') {
    chips.push({
      key: 'market',
      label: marketScopeLabel(query.market),
      href: buildInventoryListHref({ q: query.q, warehouse: query.warehouse, market: 'all', view: query.view, source: query.source, page: 1 }),
    });
  }

  return (
    <section className={styles.toolbar} data-testid="inventory-toolbar">
      <form className={styles.toolbarForm} method="get" action="/dashboard/inventory" data-testid="inventory-filters">
        <input type="hidden" name="view" value={query.view === 'product' ? 'product' : 'warehouse'} />
        {query.focus ? <input type="hidden" name="focus" value={query.focus} /> : null}
        <label className={styles.toolbarSearch}>
          <span className={styles.srOnly}>搜索</span>
          <input
            type="search"
            name="q"
            defaultValue={query.q}
            placeholder="搜索商品名称 / 货号 / 69 编码 / 来源 SKU（回车）"
            maxLength={120}
            aria-label="搜索商品名称、货号、69 编码或来源 SKU"
          />
        </label>
        <label className={styles.toolbarField}>
          <span>来源</span>
          <select
            name="source"
            defaultValue={query.source}
            onChange={(event) => event.currentTarget.form?.requestSubmit()}
            data-testid="inventory-source-scope"
          >
            <option value="all">全部来源</option>
            <option value="overseas">仅海外 BigSeller</option>
            <option value="domestic">仅国内表格快照</option>
          </select>
        </label>
        {domesticScope ? null : (
          <label className={styles.toolbarField}>
            <span>仓库</span>
            <select
              name="warehouse"
              defaultValue={query.warehouse}
              onChange={(event) => event.currentTarget.form?.requestSubmit()}
              data-testid="inventory-warehouse-filter"
            >
              <option value="all">全部参与仓</option>
              {groups.map((group) => (
                <optgroup key={group.key} label={group.label}>
                  {group.warehouses.map((warehouse) => (
                    <option key={warehouse.id} value={warehouse.id}>
                      {warehouse.name}{warehouse.market ? `（${warehouse.market}）` : ''}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
        )}
        <button type="submit" className={styles.secondaryButton}>查询</button>
        {hasFilters ? <Link className={styles.clearLink} href={clearHref} data-testid="inventory-clear-filters">清空</Link> : null}
      </form>
      {chips.length > 0 ? (
        <div className={styles.chipRow} data-testid="inventory-filter-chips">
          {chips.map((chip) => (
            <Link key={chip.key} className={styles.chip} href={chip.href} data-testid={`inventory-chip-${chip.key}`}>
              {chip.label}
              <span aria-hidden>✕</span>
            </Link>
          ))}
        </div>
      ) : null}
      {domesticScope ? (
        <p className={styles.toolbarNote}>国内表格快照没有仓库/市场维度；仓库筛选只作用于海外来源。</p>
      ) : null}
    </section>
  );
}
