import type { CatalogListClientRow } from './list-client-types';
import { clientRowAsDisplayRow } from './list-client-types';
import { applyWarehouseScopeToDisplayRow } from './client-scope';

export function formatInventoryCell(row: CatalogListClientRow, warehouse: string, displayUnavailable?: 'not_imported' | 'read_failed' | 'forbidden') {
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

export function formatEstimatedValueCell(row: CatalogListClientRow, warehouse: string, displayUnavailable?: 'not_imported' | 'read_failed' | 'forbidden') {
  if (displayUnavailable === 'not_imported') return '样表未导入';
  if (displayUnavailable === 'read_failed') return '样表读取失败';
  if (displayUnavailable === 'forbidden') return '样表无权限';
  const display = clientRowAsDisplayRow(row);
  const scoped = warehouse === 'all' ? display : applyWarehouseScopeToDisplayRow(display, warehouse);
  const sample = scoped.bsSample;
  if (sample.valuationState === 'valued' && sample.estimatedValueCny !== null) return `¥${sample.estimatedValueCny}`;
  if (sample.valuationState === 'no_warehouse_line') return '本仓无对应';
  if (sample.valuationReason?.includes('尚未建档')) return '未建档';
  if (sample.valuationState === 'no_price') return sample.valuationReason ?? '缺价';
  if (sample.valuationState === 'not_applicable' && sample.valuationReason?.includes('金额')) return '无金额权限';
  if (sample.valuationState === 'no_inventory' && sample.confirmedOnHandTotal === '0') return '¥0.00';
  return sample.valuationReason ?? '—';
}
