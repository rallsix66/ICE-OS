import type { CatalogListClientRow } from './list-client-types';
import { clientRowAsDisplayRow } from './list-client-types';
import { applyWarehouseScopeToDisplayRow } from './client-scope';
import { formatCnyPrice, formatCnyValue } from './money-display';
import type { AdoptedUnitCost } from './adopted-price';

export type DisplayAvailability = 'not_imported' | 'read_failed' | 'forbidden';

/** 从导出来源标签里取样表日期（YYYY-MM-DD）；取不到返回 null，不编造日期。 */
export function sampleDateFromLabel(exportLabel: string | null | undefined): string | null {
  const raw = exportLabel?.trim();
  if (!raw) return null;
  const match = raw.match(/\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : null;
}

/**
 * 列表上唯一一处紧凑样表标识：`样表 · 2026-10-15`。
 * 日期取自 exportLabel；解析不到时原样回退 exportLabel 文本，绝不编造日期。
 */
export function formatSampleLabel(exportLabel: string | null | undefined): string {
  const raw = exportLabel?.trim();
  if (!raw) return '样表';
  const date = sampleDateFromLabel(raw);
  return date ? `样表 · ${date}` : `样表 · ${raw}`;
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

export function formatInventoryCell(row: CatalogListClientRow, warehouse: string, displayUnavailable?: DisplayAvailability) {
  if (displayUnavailable === 'not_imported') return '样表未导入';
  if (displayUnavailable === 'read_failed') return '样表读取失败';
  if (displayUnavailable === 'forbidden') return '样表无权限';
  const display = clientRowAsDisplayRow(row);
  const scoped = warehouse === 'all' ? display : applyWarehouseScopeToDisplayRow(display, warehouse);
  const sample = scoped.bsSample;
  if (sample.valuationState === 'no_warehouse_line') return '本仓无对应';
  if (sample.confirmedOnHandTotal !== null) return sample.confirmedOnHandTotal;
  if (sample.valuationReason?.includes('尚未建档')) return '未建档';
  if (sample.valuationState === 'no_inventory' && sample.confirmedLineCount === 0) return '无已确认库存';
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

export function formatEstimatedValueCell(row: CatalogListClientRow, warehouse: string, displayUnavailable?: DisplayAvailability) {
  if (displayUnavailable === 'not_imported') return '样表未导入';
  if (displayUnavailable === 'read_failed') return '样表读取失败';
  if (displayUnavailable === 'forbidden') return '样表无权限';
  const display = clientRowAsDisplayRow(row);
  const scoped = warehouse === 'all' ? display : applyWarehouseScopeToDisplayRow(display, warehouse);
  const sample = scoped.bsSample;
  if (sample.valuationState === 'valued' && sample.estimatedValueCny !== null) {
    return formatCnyValue(sample.estimatedValueCny) ?? `¥${sample.estimatedValueCny}`;
  }
  if (sample.valuationState === 'no_warehouse_line') return '本仓无对应';
  if (sample.valuationReason?.includes('尚未建档')) return '未建档';
  if (sample.valuationState === 'no_price') return sample.valuationReason ?? '缺价';
  if (sample.valuationState === 'not_applicable' && sample.valuationReason?.includes('金额')) return '无金额权限';
  if (sample.valuationState === 'no_inventory' && sample.confirmedOnHandTotal === '0') return '¥0.00';
  return sample.valuationReason ?? '—';
}
