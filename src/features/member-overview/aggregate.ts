/**
 * 成员经营总览纯聚合（无 DB / 无 React）。
 *
 * 口径：
 * - 库存只统计 status=adopted（已对应且计入）的来源行；未对应/待采用/停用行不计数量；
 * - 实物与可售分别求和，缺失行只计数、不写 0；金额沿用商品库存页
 *   onHand × 采用单位成本，缺价商品只计数、不计金额；
 * - 物流只统计账号获授市场；剩余数量未知或人工数量冲突的明细归入待核；
 * - 票数按 shipmentId 去重，不把明细条数当票数。
 */

import { formatMoney } from '@/features/catalog/local-display/decimal';
import { formatCnyValue } from '@/features/catalog/local-display/money-display';
import { estimateValueScaled } from '@/features/inventory/dual-view';
import type {
  InventoryProductSummaryDto,
  InventoryWarehouseRowsDto,
} from '@/features/inventory/types';
import type { ShipmentMarketSummarySource } from '@/features/shipment/summary';
import type {
  MemberInventorySummaryDto,
  MemberInventoryWarehouseDto,
  MemberPendingProductDto,
  MemberPendingUnitGroupDto,
  MemberShipmentMarketDto,
  MemberShipmentSummaryDto,
} from './types';

export interface MemberOverviewWarehouse {
  id: string;
  externalId: string;
  name: string;
  market: string | null;
}

export interface MemberOverviewWarehouseSummary {
  warehouseId: string;
  summary: InventoryProductSummaryDto;
}

function latestIso(left: string | null, right: string | null): string | null {
  if (!left) return right;
  if (!right) return left;
  return Date.parse(right) > Date.parse(left) ? right : left;
}

function scaledText(value: bigint | null): string | null {
  return value === null ? null : formatCnyValue(formatMoney(value));
}

function costAmountOf(costMap: Record<string, string> | null, itemId: string | null): string | null {
  if (!costMap || !itemId) return null;
  const amount = costMap[itemId];
  return typeof amount === 'string' && amount.trim() !== '' ? amount : null;
}

interface PendingUnitAccumulator {
  warehouseId: string;
  warehouseName: string;
  unit: string | null;
  onHand: number;
  onHandKnown: number;
  onHandMissing: boolean;
  available: number;
  availableKnown: number;
  availableMissing: boolean;
}

interface PendingAccumulator {
  itemId: string;
  iceCode: string | null;
  nameCn: string | null;
  warehouseNames: Set<string>;
  reasons: Set<string>;
  units: Map<string, PendingUnitAccumulator>;
}

interface ItemUnitInfo {
  units: Set<string | null>;
  unitConflict: boolean;
}

type WarehouseItemRows = InventoryWarehouseRowsDto['rows'];
type ProductSummaryRow = InventoryProductSummaryDto['rows'][number];

function warehouseItemPending(summaryRow: ProductSummaryRow | null, itemRows: WarehouseItemRows): boolean {
  return !summaryRow
    || summaryRow.knownSubtotal === null
    || summaryRow.knownSubtotalComplete !== true
    || summaryRow.hasPendingTotal === true
    || summaryRow.unitConflict === true
    || itemRows.some((row) => row.onHand === null);
}

function pendingReasons(
  summaryRow: ProductSummaryRow | null,
  itemRows: WarehouseItemRows,
  itemUnitConflict: boolean,
): string[] {
  const reasons = new Set<string>();
  if (itemUnitConflict) reasons.add('多单位，不合计');
  if (!summaryRow) {
    reasons.add('商品汇总缺失');
  } else {
    if (summaryRow.hasPendingTotal) reasons.add('同仓多来源 SKU');
    if (summaryRow.unitConflict) reasons.add('多单位，不合计');
    if (summaryRow.knownSubtotal === null
      && !summaryRow.hasPendingTotal
      && !summaryRow.unitConflict) {
      reasons.add('已知小计不可用');
    }
    if (summaryRow.knownSubtotalComplete === false
      && !summaryRow.hasPendingTotal
      && !summaryRow.unitConflict
      && !itemUnitConflict) {
      reasons.add('已知小计待核对');
    }
  }
  if (itemRows.some((row) => row.onHand === null)) reasons.add('数量缺失');
  return reasons.size > 0 ? [...reasons] : ['待核对'];
}

function addPendingRows(
  accumulator: PendingAccumulator,
  warehouse: MemberOverviewWarehouse,
  itemRows: WarehouseItemRows,
): void {
  accumulator.warehouseNames.add(warehouse.name);
  for (const row of itemRows) {
    const key = `${warehouse.id}\u0000${row.unit ?? '\u0000'}`;
    let unit = accumulator.units.get(key);
    if (!unit) {
      unit = {
        warehouseId: warehouse.id,
        warehouseName: warehouse.name,
        unit: row.unit,
        onHand: 0,
        onHandKnown: 0,
        onHandMissing: false,
        available: 0,
        availableKnown: 0,
        availableMissing: false,
      };
      accumulator.units.set(key, unit);
    }
    if (row.onHand === null) {
      unit.onHandMissing = true;
    } else {
      unit.onHand += row.onHand;
      unit.onHandKnown += 1;
    }
    if (row.warehouseAvailable === null) {
      unit.availableMissing = true;
    } else {
      unit.available += row.warehouseAvailable;
      unit.availableKnown += 1;
    }
  }
}

function pendingUnitGroups(units: Map<string, PendingUnitAccumulator>): MemberPendingUnitGroupDto[] {
  return [...units.values()]
    .map((unit) => ({
      warehouseId: unit.warehouseId,
      warehouseName: unit.warehouseName,
      unit: unit.unit,
      pendingOnHand: unit.onHandMissing || unit.onHandKnown === 0 ? null : unit.onHand,
      pendingAvailable: unit.availableMissing || unit.availableKnown === 0 ? null : unit.available,
    }))
    .sort((left, right) => {
      const warehouse = left.warehouseName.localeCompare(right.warehouseName, 'zh-Hans-CN');
      return warehouse !== 0
        ? warehouse
        : (left.unit ?? '').localeCompare(right.unit ?? '', 'zh-Hans-CN');
    });
}

function sameUnitTotal(
  groups: MemberPendingUnitGroupDto[],
  field: 'pendingOnHand' | 'pendingAvailable',
): number | null {
  if (groups.length === 0) return null;
  if (new Set(groups.map((group) => group.unit)).size > 1) return null;
  let total = 0;
  for (const group of groups) {
    const value = group[field];
    if (value === null) return null;
    total += value;
  }
  return total;
}

export function summarizeMemberInventory(input: {
  rows: InventoryWarehouseRowsDto;
  warehouses: MemberOverviewWarehouse[];
  productSummaries: MemberOverviewWarehouseSummary[];
  costMap: Record<string, string> | null;
  canViewAmount: boolean;
  amountError: string | null;
}): MemberInventorySummaryDto {
  const { rows, warehouses, costMap } = input;
  const statesById = new Map(rows.warehouses.map((state) => [state.warehouseId, state]));
  const summaryByWarehouse = new Map<string, Map<string, InventoryProductSummaryDto['rows'][number]>>();
  for (const entry of input.productSummaries) {
    summaryByWarehouse.set(
      entry.warehouseId,
      new Map(entry.summary.rows.map((row) => [row.itemId, row])),
    );
  }
  const adopted = rows.rows.filter((row) => row.status === 'adopted');
  const buckets = warehouses.map((warehouse) => {
    const own = adopted.filter((row) => row.warehouseId === warehouse.id);
    const byItem = new Map<string, WarehouseItemRows>();
    for (const row of own) {
      if (!row.itemId) continue;
      const bucket = byItem.get(row.itemId) ?? [];
      bucket.push(row);
      byItem.set(row.itemId, bucket);
    }
    return {
      warehouse,
      own,
      byItem,
      summaries: summaryByWarehouse.get(warehouse.id) ?? new Map<string, ProductSummaryRow>(),
    };
  });

  // 同一商品合并所有授权仓正式商品汇总的有效 unitGroups，并保留单仓 unitConflict。
  // 正式汇总已排除的同仓同单位双 SKU 不贡献单位；其他仓的有效单位照常参与判定。
  const itemUnitInfo = new Map<string, ItemUnitInfo>();
  for (const { byItem, summaries } of buckets) {
    for (const itemId of byItem.keys()) {
      const summaryRow = summaries.get(itemId) ?? null;
      if (!summaryRow) continue;
      const info = itemUnitInfo.get(itemId) ?? { units: new Set<string | null>(), unitConflict: false };
      for (const group of summaryRow.unitGroups ?? []) info.units.add(group.unit);
      if (summaryRow.unitConflict) info.unitConflict = true;
      itemUnitInfo.set(itemId, info);
    }
  }
  const itemUnitConflict = new Set<string>();
  for (const [itemId, info] of itemUnitInfo) {
    if (info.unitConflict || info.units.size > 1) itemUnitConflict.add(itemId);
  }

  const pendingProducts = new Map<string, PendingAccumulator>();
  const missingCostProducts = new Set<string>();
  let totalOnHand = 0;
  let totalOnHandKnown = 0;
  let totalAvailable = 0;
  let totalAvailableKnown = 0;
  let totalValue: bigint | null = null;

  const warehouseRows: MemberInventoryWarehouseDto[] = buckets.map(({ warehouse, own, byItem, summaries }) => {
    let onHand = 0;
    let onHandKnown = 0;
    let available = 0;
    let availableKnown = 0;
    let availableUnknownRows = 0;
    let value: bigint | null = null;
    const missing = new Set<string>();
    const pendingItems = new Set<string>();
    let pendingOnHand = 0;
    let pendingAvailable = 0;
    let pendingUnitConflictCount = 0;
    let pendingHasUnitConflict = false;

    for (const [itemId, itemRows] of byItem) {
      const summaryRow = summaries.get(itemId) ?? null;
      const unitConflict = itemUnitConflict.has(itemId);
      const localPending = warehouseItemPending(summaryRow, itemRows);
      const pending = unitConflict || localPending;
      if (pending) {
        pendingItems.add(itemId);
        pendingUnitConflictCount += unitConflict ? 1 : 0;
        pendingHasUnitConflict = pendingHasUnitConflict || unitConflict;
        if (!unitConflict) {
          pendingOnHand += itemRows.reduce((sum, row) => sum + (row.onHand ?? 0), 0);
          pendingAvailable += itemRows.reduce((sum, row) => sum + (row.warehouseAvailable ?? 0), 0);
        }
        const reasons = pendingReasons(summaryRow, itemRows, unitConflict);
        const existing = pendingProducts.get(itemId);
        const accumulator: PendingAccumulator = existing ?? {
          itemId,
          iceCode: summaryRow?.iceCode ?? null,
          nameCn: summaryRow?.nameCn ?? itemRows[0]?.itemName ?? null,
          warehouseNames: new Set<string>(),
          reasons: new Set<string>(),
          units: new Map<string, PendingUnitAccumulator>(),
        };
        for (const reason of reasons) accumulator.reasons.add(reason);
        addPendingRows(accumulator, warehouse, itemRows);
        pendingProducts.set(itemId, accumulator);
        continue;
      }

      // 只有本仓商品汇总可明确计入、且整款没有单位冲突时，才进入本仓小计。
      if (!summaryRow || summaryRow.knownSubtotal === null) continue;
      const knownOnHand = summaryRow.knownSubtotal;
      onHand += knownOnHand;
      onHandKnown += 1;

      const availableValues = itemRows
        .map((row) => row.warehouseAvailable)
        .filter((value): value is number => value !== null);
      availableUnknownRows += itemRows.length - availableValues.length;
      if (availableValues.length > 0) {
        available += availableValues.reduce((sum, value) => sum + value, 0);
        availableKnown += 1;
      }

      const amount = costAmountOf(costMap, itemId);
      if (amount !== null) {
        const estimated = estimateValueScaled(knownOnHand, amount);
        if (estimated !== null) value = (value ?? BigInt(0)) + estimated;
      } else if (costMap !== null && knownOnHand > 0) {
        missing.add(itemId);
      }
    }

    for (const itemId of missing) missingCostProducts.add(itemId);
    if (value !== null) totalValue = (totalValue ?? BigInt(0)) + value;
    totalOnHand += onHand;
    totalOnHandKnown += onHandKnown;
    totalAvailable += available;
    totalAvailableKnown += availableKnown;

    const state = statesById.get(warehouse.id);
    const rowTime = own.reduce<string | null>(
      (latest, row) => latestIso(latest, row.observationAt),
      null,
    );
    return {
      warehouseId: warehouse.id,
      externalId: warehouse.externalId,
      name: warehouse.name,
      market: warehouse.market,
      onHand: onHandKnown > 0 ? onHand : null,
      available: availableKnown > 0 ? available : null,
      onHandUnknownRows: 0,
      availableUnknownRows,
      unmappedRows: rows.rows.filter((row) => row.warehouseId === warehouse.id && row.status === 'unmapped').length,
      pendingProductCount: pendingItems.size,
      pendingUnitConflictCount,
      pendingOnHand: pendingHasUnitConflict ? null : pendingOnHand,
      pendingAvailable: pendingHasUnitConflict ? null : pendingAvailable,
      estimatedValueCny: scaledText(value),
      missingCostProducts: missing.size,
      dataTime: state?.observationAt ?? state?.lastSuccessAt ?? rowTime,
    };
  });

  const contributing = warehouseRows.filter((row) => row.onHand !== null);
  const pendingList: MemberPendingProductDto[] = [...pendingProducts.values()]
    .map((row) => {
      const unitGroups = pendingUnitGroups(row.units);
      const unitConflict = itemUnitConflict.has(row.itemId)
        || new Set(unitGroups.map((group) => group.unit)).size > 1;
      return {
        itemId: row.itemId,
        iceCode: row.iceCode,
        nameCn: row.nameCn,
        warehouseNames: [...row.warehouseNames].sort(),
        reasons: [...row.reasons],
        unitConflict,
        pendingOnHand: unitConflict ? null : sameUnitTotal(unitGroups, 'pendingOnHand'),
        pendingAvailable: unitConflict ? null : sameUnitTotal(unitGroups, 'pendingAvailable'),
        unitGroups,
      };
    })
    .sort((left, right) => (left.iceCode ?? '').localeCompare(right.iceCode ?? '', 'zh-Hans-CN'));

  return {
    canViewAmount: input.canViewAmount,
    amountError: input.amountError,
    warehouses: warehouseRows,
    onHand: totalOnHandKnown > 0 ? totalOnHand : null,
    onHandUnknownRows: 0,
    available: totalAvailableKnown > 0 ? totalAvailable : null,
    availableUnknownRows: warehouseRows.reduce((sum, row) => sum + row.availableUnknownRows, 0),
    unmappedRows: rows.rows.filter((row) => row.status === 'unmapped').length,
    pendingProducts: pendingList,
    pendingProductCount: pendingList.length,
    pendingUnitConflictProductCount: pendingList.filter((row) => row.unitConflict).length,
    pendingOnHand: pendingList.reduce((sum, row) => sum + (row.pendingOnHand ?? 0), 0),
    pendingAvailable: pendingList.reduce((sum, row) => sum + (row.pendingAvailable ?? 0), 0),
    estimatedValueCny: scaledText(totalValue),
    missingCostProducts: missingCostProducts.size,
    contributingWarehouseCount: contributing.length,
    dataTime: contributing.length === 0
      ? null
      : contributing.reduce<string | null>(
        (latest, row) => latestIso(latest, row.dataTime),
        null,
      ),
  };
}

interface MarketAccumulator {
  tickets: Set<string>;
  items: number;
  knownRemaining: number;
  knownItems: number;
  pendingItems: number;
}

function emptyMarket(): MarketAccumulator {
  return { tickets: new Set(), items: 0, knownRemaining: 0, knownItems: 0, pendingItems: 0 };
}

export function summarizeMemberShipment(
  source: ShipmentMarketSummarySource,
  markets: string[],
): MemberShipmentSummaryDto {
  const groups = new Map<string, MarketAccumulator>();
  for (const market of markets) groups.set(market, emptyMarket());
  for (const item of source.items) {
    const market = item.market?.trim();
    if (!market) continue;
    const group = groups.get(market);
    if (!group) continue;
    group.tickets.add(item.shipmentId);
    group.items += 1;
    if (item.manualConflict
      || item.remainingState !== 'known'
      || typeof item.remainingQuantity !== 'number'
      || !Number.isFinite(item.remainingQuantity)) {
      group.pendingItems += 1;
    } else {
      group.knownRemaining += item.remainingQuantity;
      group.knownItems += 1;
    }
  }

  const result: MemberShipmentMarketDto[] = markets.map((market) => {
    const group = groups.get(market) ?? emptyMarket();
    return {
      market,
      ticketCount: group.tickets.size,
      itemCount: group.items,
      knownRemaining: group.items === 0
        ? 0
        : (group.knownItems > 0 ? group.knownRemaining : null),
      pendingItemCount: group.pendingItems,
      latestReadAt: source.latestReadAt,
    };
  });

  const ticketCount = result.reduce((sum, row) => sum + row.ticketCount, 0);
  const knownMarkets = result.filter((row) => row.itemCount > 0 && row.knownRemaining !== null);
  return {
    markets: result,
    ticketCount,
    itemCount: result.reduce((sum, row) => sum + row.itemCount, 0),
    knownRemaining: ticketCount === 0
      ? 0
      : (knownMarkets.length > 0
        ? knownMarkets.reduce((sum, row) => sum + (row.knownRemaining ?? 0), 0)
        : null),
    pendingItemCount: result.reduce((sum, row) => sum + row.pendingItemCount, 0),
    latestReadAt: source.latestReadAt,
  };
}
