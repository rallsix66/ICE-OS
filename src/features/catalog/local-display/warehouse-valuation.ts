import { adoptedUnitCostFromFinancial } from './adopted-price';
import { formatMoney, formatQuantity, multiplyMoneyByQuantity, parseMoney, parseQuantity } from './decimal';
import type { PreparedFinancial } from '../types';

export type InventoryRowSlice = {
  onHand: string | null;
  selectionState: string;
  itemId: string | null;
  warehouse: string;
};

import type { WarehouseScopeView } from './display-types';
export type { WarehouseScopeView } from './display-types';

export function sumConfirmedOnHand(rows: InventoryRowSlice[], itemId: string, warehouse?: string): bigint | null {
  let total: bigint | null = null;
  for (const row of rows) {
    if (row.itemId !== itemId || row.selectionState !== 'confirmed') continue;
    if (warehouse && row.warehouse !== warehouse) continue;
    const qty = parseQuantity(row.onHand);
    if (qty === null) return null;
    total = (total ?? BigInt(0)) + qty;
  }
  return total;
}

export function warehouseScopeView(
  rows: InventoryRowSlice[],
  itemId: string,
  warehouse: string | undefined,
  financial: PreparedFinancial | null,
  amountAllowed: boolean,
  notCreatedBs: boolean,
): WarehouseScopeView {
  const confirmedLineCount = rows.filter((r) => r.itemId === itemId && r.selectionState === 'confirmed' && (!warehouse || r.warehouse === warehouse)).length;
  const anyLine = warehouse
    ? rows.some((r) => r.itemId === itemId && r.warehouse === warehouse)
    : rows.some((r) => r.itemId === itemId);
  if (warehouse && !anyLine && rows.some((r) => r.itemId === itemId && r.selectionState === 'confirmed')) {
    return {
      confirmedOnHandTotal: null,
      estimatedValueCny: null,
      valuationState: 'no_warehouse_line',
      valuationReason: '本仓无对应 BS 样表行（不当作 0）',
      confirmedLineCount: 0,
    };
  }
  const adoptedUnitCost = amountAllowed ? adoptedUnitCostFromFinancial(financial) : null;
  const onHandTotal = sumConfirmedOnHand(rows, itemId, warehouse);
  if (notCreatedBs) {
    return { confirmedOnHandTotal: null, estimatedValueCny: null, valuationState: 'not_applicable', valuationReason: 'BS尚未建档（本批用户确认），不显示为库存0', confirmedLineCount };
  }
  /*
   * V5-01/V5-02：没有已确认行不是“已确认库存 0”。
   * 真实零库存要求至少一条 confirmed 行且数量明确为 0；未选择/未采用的样表行只保留记录，不计入库存。
   */
  if (confirmedLineCount === 0) {
    return {
      confirmedOnHandTotal: null,
      estimatedValueCny: null,
      valuationState: 'no_inventory',
      valuationReason: anyLine
        ? '本范围有 BS 样表行，但无已确认记录（不当作 0）'
        : '无已确认 BS 样表记录（不当作 0）',
      confirmedLineCount: 0,
    };
  }
  if (!amountAllowed) {
    return { confirmedOnHandTotal: onHandTotal === null ? null : formatQuantity(onHandTotal), estimatedValueCny: null, valuationState: 'not_applicable', valuationReason: '当前会话无金额读取权限', confirmedLineCount };
  }
  if (adoptedUnitCost?.state !== 'priced') {
    return {
      confirmedOnHandTotal: onHandTotal === null ? null : formatQuantity(onHandTotal),
      estimatedValueCny: null,
      valuationState: 'no_price',
      valuationReason: adoptedUnitCost?.reason ?? '缺进货价',
      confirmedLineCount,
    };
  }
  if (onHandTotal === null) {
    return {
      confirmedOnHandTotal: null,
      estimatedValueCny: null,
      valuationState: 'no_inventory',
      valuationReason: confirmedLineCount ? '已选样表行存在无法解析的现有库存' : '无已确认 BS 样表库存行',
      confirmedLineCount,
    };
  }
  const price = parseMoney(adoptedUnitCost.amountCny);
  if (price === null) {
    return {
      confirmedOnHandTotal: formatQuantity(onHandTotal),
      estimatedValueCny: null,
      valuationState: 'no_price',
      valuationReason: '进货价解析失败',
      confirmedLineCount,
    };
  }
  return {
    confirmedOnHandTotal: formatQuantity(onHandTotal),
    estimatedValueCny: formatMoney(multiplyMoneyByQuantity(price, onHandTotal)),
    valuationState: 'valued',
    valuationReason: null,
    confirmedLineCount,
  };
}