import type { TableColumn } from '@/ui/ice-v4/table-tools';
import type { ProductSummaryMergeResult } from '../dual-view';

/**
 * 列定义与工具栏「显示列」共用；列顺序：商品身份 → 属性 → 数值 → 状态 → 操作。
 * 数据列用百分比宽度：随表格宽度伸缩、铺满，列表底部留一条窄填充带作为拖拽余量；
 * 拖动某一列时只改这一列的占比，其余列宽度不变，分界线跟手。
 */

export const WAREHOUSE_TABLE_STORAGE_KEY = 'ice-inventory-warehouse-rows.v2';
export const SUMMARY_TABLE_STORAGE_KEY = 'ice-inventory-product-summary.v2';

/** 操作列：不可隐藏、不可排序、不可拖拽；不写宽度，由它吸收剩余宽度（状态列右边界就是操作列左边界）。 */
export const ACTION_COLUMN: TableColumn = {
  key: 'actions',
  label: '操作',
  hideable: false,
  sortable: false,
  resizable: false,
};

export function warehouseTableColumns(showValue: boolean): TableColumn[] {
  return [
    { key: 'name', label: '商品', hideable: false, width: '28%' },
    { key: 'warehouse', label: '仓库', width: '22%' },
    { key: 'available', label: '可售', numeric: true, width: '11%' },
    ...(showValue ? [{ key: 'value', label: '估算货值', numeric: true, width: '11%' }] : []),
    { key: 'status', label: '状态', width: '11%' },
    ACTION_COLUMN,
  ];
}

export function summaryTableColumns(input: {
  merged: ProductSummaryMergeResult | null;
  domesticOnlyScope: boolean;
  showValue: boolean;
}): TableColumn[] {
  const marketColumns = input.merged?.marketColumns ?? [];
  return [
    { key: 'name', label: '商品', hideable: false, width: '17%' },
    ...(input.merged?.domesticIncluded
      ? [{ key: 'domestic', label: '国内', numeric: true, width: '7%' }]
      : []),
    ...marketColumns.map((column) => ({
      key: column.key,
      label: column.market === null ? '未知仓' : column.label,
      numeric: true,
      width: '6.5%',
    })),
    ...(input.domesticOnlyScope ? [] : [{ key: 'total', label: '海外合计', numeric: true, width: '8.5%' }]),
    ...(input.showValue ? [{ key: 'value', label: '估算货值', numeric: true, width: '9.5%' }] : []),
    { key: 'status', label: '状态', width: '7%' },
    ACTION_COLUMN,
  ];
}

export function columnOf(columns: TableColumn[], key: string): TableColumn {
  return columns.find((column) => column.key === key) ?? columns[0];
}
