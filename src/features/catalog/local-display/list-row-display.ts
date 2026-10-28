import type { CatalogListClientRow } from './list-client-types';
import { applyWarehouseScopeToDisplayRow } from './client-scope';
import { clientRowAsDisplayRow } from './list-client-types';
import { formatCnyPrice } from './money-display';
import type { AdoptedUnitCost } from './adopted-price';

export type DisplayAvailability = 'not_imported' | 'read_failed' | 'forbidden';

function pad2(value: number) {
  return String(value).padStart(2, '0');
}

/**
 * 列表上唯一的库存来源标识：`BigSeller 库存 · 最近来源 2026-10-26 21:11`。
 * 时间来自本次导出完成时间；取不到时只显示来源名，不编造日期。
 */
export function formatSampleLabel(observationAt: string | null | undefined): string {
  if (!observationAt) return 'BigSeller 库存';
  const date = new Date(observationAt);
  if (Number.isNaN(date.getTime())) return 'BigSeller 库存';
  return `BigSeller 库存 · 最近来源 ${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** 列表当前上下文 URL（q / warehouse / page 的规范形式）；用于新标签页的 from 回跳。 */
export function buildListContextHref(query: string, warehouse: string, page: number): string {
  const params = new URLSearchParams();
  if (query.trim()) params.set('q', query.trim());
  if (warehouse && warehouse !== 'all') params.set('warehouse', warehouse);
  if (page > 1) params.set('page', String(page));
  const qs = params.toString();
  return qs ? `/dashboard/catalog?${qs}` : '/dashboard/catalog';
}

/** 直接选页最多显示的页码位置数（含首尾）；超过时窗口化 + 省略号。 */
export const MAX_PAGE_SLOTS = 7;

export type PageEntry = number | 'ellipsis';

/**
 * 页码直选窗口：≤7 页全部显示；更多时保留首尾与当前页 ±1，其余用省略号。
 * 当前页一定在结果里，保证换页后被点击的页码按钮仍在 DOM 中（焦点不被换页拆掉）。
 */
export function pageEntries(current: number, total: number): PageEntry[] {
  const safeTotal = Math.max(1, Math.floor(total));
  const safeCurrent = Math.min(Math.max(1, Math.floor(current)), safeTotal);
  if (safeTotal <= MAX_PAGE_SLOTS) {
    return Array.from({ length: safeTotal }, (_, index) => index + 1);
  }
  const pages = new Set<number>([1, safeTotal, safeCurrent]);
  if (safeCurrent - 1 >= 1) pages.add(safeCurrent - 1);
  if (safeCurrent + 1 <= safeTotal) pages.add(safeCurrent + 1);
  const sorted = [...pages].sort((a, b) => a - b);
  const entries: PageEntry[] = [];
  for (let index = 0; index < sorted.length; index += 1) {
    const page = sorted[index];
    if (index > 0 && page - sorted[index - 1] > 1) entries.push('ellipsis');
    entries.push(page);
  }
  return entries;
}

/**
 * 当前仓库库存单元格：
 * - 已采用的单码行显示已知小计；不完整时明确标“（不完整）”；
 * - 同仓多编码显示“合计待核对”，不擅自相加，也不选一条充当完整库存；
 * - 本仓无当前行时按库存模块的缺口原因显示，不当作 0。
 */
export function formatInventoryCell(row: CatalogListClientRow, warehouse: string, displayUnavailable?: DisplayAvailability) {
  if (displayUnavailable === 'not_imported') return '库存未接入';
  if (displayUnavailable === 'read_failed') return '库存读取失败';
  if (displayUnavailable === 'forbidden') return '库存无权限';
  const display = clientRowAsDisplayRow(row);
  const scoped = warehouse === 'all' ? display : applyWarehouseScopeToDisplayRow(display, warehouse);
  const view = scoped.inventory;
  const warehouseScope = warehouse !== 'all' ? view.warehouseScopes[warehouse] : undefined;
  if (warehouseScope?.inventoryState === 'failed' && warehouseScope.confirmedLineCount === 0) return '本仓同步失败';
  if (view.unitConflict) return '多单位待核对';
  if (view.hasPendingTotal) return '合计待核对';
  if (warehouseScope && warehouseScope.confirmedOnHandTotal !== null) {
    return warehouseScope.knownSubtotalComplete ? warehouseScope.confirmedOnHandTotal : `${warehouseScope.confirmedOnHandTotal}（不完整）`;
  }
  if (view.knownSubtotal !== null) {
    return view.knownSubtotalComplete ? view.knownSubtotal : `${view.knownSubtotal}（不完整）`;
  }
  if (!view.hasCurrentData) {
    if (warehouseScope?.inventoryState === 'unmapped_source') return '来源待核对';
    if (warehouseScope?.inventoryState === 'unseen') return '本次未见';
    if (warehouseScope?.inventoryState === 'no_source') return '无来源记录';
    if (warehouseScope?.inventoryState === 'no_data') return '本仓尚未同步';
    return '暂无库存记录';
  }
  return '—';
}

/**
 * 采用进货价单元格：人民币单品、保留原始小数位（千分位只加在整数部分）。
 * 底层 Decimal/计算不动；缺价或解析失败仍显示“成本待补充”，不写成 0。
 */
export function formatAdoptedUnitCostCell(adopted: AdoptedUnitCost | null) {
  if (!adopted) return '—';
  if (adopted.state !== 'priced') return '成本待补充';
  return formatCnyPrice(adopted.amountCny) ?? `¥${adopted.amountCny}`;
}

/**
 * 当前货值：本包不新做估值。旧样表价格不得乘新库存冒充当前货值；
 * 没有适用成本口径时明确显示“暂未计算”，不写 0、不沿用旧金额。
 */
export function formatEstimatedValueCell(_row?: CatalogListClientRow, _warehouse?: string, displayUnavailable?: DisplayAvailability) {
  if (displayUnavailable === 'not_imported') return '—';
  if (displayUnavailable === 'read_failed' || displayUnavailable === 'forbidden') return '—';
  return '暂未计算';
}

export { formatSampleLabel as formatInventorySourceLabel };
