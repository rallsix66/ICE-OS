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
  unit: string | null;
  warehouseNames: Set<string>;
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

function distinctUnits(itemRows: WarehouseItemRows): Set<string> {
  return new Set(itemRows
    .map((row) => row.unit)
    .filter((unit): unit is string => typeof unit === 'string' && unit !== ''));
}

function pendingReasons(
  summaryRow: ProductSummaryRow | null,
  itemRows: WarehouseItemRows,
  crossWarehouseUnitConflict: boolean,
): string[] {
  const reasons = new Set<string>();
  if (crossWarehouseUnitConflict) reasons.add('多单位，不合计');
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
      && !crossWarehouseUnitConflict) {
      reasons.add('已知小计待核对');
    }
  }
  if (itemRows.some((row) => row.onHand === null)) reasons.add('数量缺失');
  return reasons.size > 0 ? [...reasons] : ['待核对'];
}

function addPendingRows(
  accumulator: PendingAccumulator,
  warehouseName: string,
  itemRows: WarehouseItemRows,
): void {
  accumulator.warehouseNames.add(warehouseName);
  for (const row of itemRows) {
    const key = row.unit ?? '\u0000';
    let unit = accumulator.units.get(key);
    if (!unit) {
      unit = {
        unit: row.unit,
        warehouseNames: new Set<string>(),
        onHand: 0,
        onHandKnown: 0,
        onHandMissing: false,
        available: 0,
        availableKnown: 0,
        availableMissing: false,
      };
      accumulator.units.set(key, unit);
    }
    unit.warehouseNames.add(warehouseName);
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
      unit: unit.unit,
      warehouseNames: [...unit.warehouseNames].sort(),
      pendingOnHand: unit.onHandMissing || unit.onHandKnown === 0 ? null : unit.onHand,
      pendingAvailable: unit.availableMissing || unit.availableKnown === 0 ? null : unit.available,
    }))
    .sort((left, right) => (left.unit ?? '').localeCompare(right.unit ?? '', 'zh-Hans-CN'));
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

  // 完整授权范围的单位判定：只从各仓「可明确计入」的商品汇总取单位。
  // 同款商品 A 仓 10 个、B 仓 2 箱时，单位集合为 {个, 箱}，整款不合计；
  // 各仓的原始数量与单位保留在待核明细里，不换算、不相加。
  const unitsByItem = new Map<string, Set<string>>();
  for (const { byItem, summaries } of buckets) {
    for (const [itemId, itemRows] of byItem) {
      const summaryRow = summaries.get(itemId) ?? null;
      if (warehouseItemPending(summaryRow, itemRows)) continue;
      const units = (summaryRow?.unitGroups ?? [])
        .map((group) => group.unit)
        .filter((unit): unit is string => typeof unit === 'string' && unit !== '');
      if (units.length === 0) units.push(...distinctUnits(itemRows));
      for (const unit of units) {
        const known = unitsByItem.get(itemId) ?? new Set<string>();
        known.add(unit);
        unitsByItem.set(itemId, known);
      }
    }
  }
  const crossWarehouseUnitConflict = new Set<string>();
  for (const [itemId, units] of unitsByItem) {
    if (units.size > 1) crossWarehouseUnitConflict.add(itemId);
  }

  const pendingProducts = new Map<string, PendingAccumulator>();
  const missingCostProducts = new Set<string>();
  let totalOnHand = 0;
  let totalOnHandKnown = 0;
  let totalAvailable = 0;
  let totalAvailableKnown = 0;
  let totalValue: bigint | null = null;
  let homeContributingCount = 0;
  let homeDataTime: string | null = null;

  const warehouseRows: MemberInventoryWarehouseDto[] = buckets.map(({ warehouse, own, byItem, summaries }) => {
    let onHand = 0;
    let onHandKnown = 0;
    let available = 0;
    let availableKnown = 0;
    let availableUnknownRows = 0;
    let value: bigint | null = null;
    // 逐仓本地已知合计（保留跨仓多单位商品的本地数量）；
    // 首页合计只累计非多单位商品，两者分开记，避免 10 个 + 2 箱 = 12。
    let homeOnHand = 0;
    let homeOnHandKnown = 0;
    let homeAvailable = 0;
    let homeAvailableKnown = 0;
    let homeValue: bigint | null = null;
    const missing = new Set<string>();
    const homeMissing = new Set<string>();
    const pendingItems = new Set<string>();
    let pendingOnHand = 0;
    let pendingAvailable = 0;
    let pendingUnitConflictCount = 0;
    let pendingHasUnitConflict = false;

    for (const [itemId, itemRows] of byItem) {
      const summaryRow = summaries.get(itemId) ?? null;
      const crossUnitConflict = crossWarehouseUnitConflict.has(itemId);
      const localPending = warehouseItemPending(summaryRow, itemRows);
      const pending = crossUnitConflict || localPending;
      if (pending) {
        pendingItems.add(itemId);
        const itemHasUnitConflict = crossUnitConflict
          || summaryRow?.unitConflict === true
          || distinctUnits(itemRows).size > 1;
        if (itemHasUnitConflict) {
          pendingHasUnitConflict = true;
          pendingUnitConflictCount += 1;
        } else {
          pendingOnHand += itemRows.reduce((sum, row) => sum + (row.onHand ?? 0), 0);
          pendingAvailable += itemRows.reduce((sum, row) => sum + (row.warehouseAvailable ?? 0), 0);
        }
        const reasons = pendingReasons(summaryRow, itemRows, crossUnitConflict);
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
        addPendingRows(accumulator, warehouse.name, itemRows);
        pendingProducts.set(itemId, accumulator);
        if (localPending) continue;
      }

      // pending=false（或跨仓多单位）已保证商品汇总存在且已知小计可计入；这里只做类型收窄。
      if (!summaryRow || summaryRow.knownSubtotal === null) continue;
      const knownOnHand = summaryRow.knownSubtotal;
      onHand += knownOnHand;
      onHandKnown += 1;

      const availableValues = itemRows
        .map((row) => row.warehouseAvailable)
        .filter((value): value is number => value !== null);
      availableUnknownRows += itemRows.length - availableValues.length;
      const knownAvailable = availableValues.length > 0
        ? availableValues.reduce((sum, value) => sum + value, 0)
        : null;
      if (knownAvailable !== null) {
        available += knownAvailable;
        availableKnown += 1;
      }

      const amount = costAmountOf(costMap, itemId);
      let estimated: bigint | null = null;
      if (amount !== null) {
        estimated = estimateValueScaled(knownOnHand, amount);
        if (estimated !== null) value = (value ?? BigInt(0)) + estimated;
      } else if (costMap !== null && knownOnHand > 0) {
        missing.add(itemId);
      }

      // 跨仓多单位商品的本地数量保留在仓行；首页合计不累计它。
      if (!crossUnitConflict) {
        homeOnHand += knownOnHand;
        homeOnHandKnown += 1;
        if (knownAvailable !== null) {
          homeAvailable += knownAvailable;
          homeAvailableKnown += 1;
        }
        if (estimated !== null) homeValue = (homeValue ?? BigInt(0)) + estimated;
        else if (costMap !== null && knownOnHand > 0) homeMissing.add(itemId);
      }
    }

    for (const itemId of homeMissing) missingCostProducts.add(itemId);
    if (homeValue !== null) totalValue = (totalValue ?? BigInt(0)) + homeValue;
    totalOnHand += homeOnHand;
    totalOnHandKnown += homeOnHandKnown;
    totalAvailable += homeAvailable;
    totalAvailableKnown += homeAvailableKnown;

    const state = statesById.get(warehouse.id);
    const rowTime = own.reduce<string | null>(
      (latest, row) => latestIso(latest, row.observationAt),
      null,
    );
    const dataTime = state?.observationAt ?? state?.lastSuccessAt ?? rowTime;
    if (homeOnHandKnown > 0) {
      homeContributingCount += 1;
      homeDataTime = latestIso(homeDataTime, dataTime);
    }
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
      dataTime,
    };
  });

  const pendingList: MemberPendingProductDto[] = [...pendingProducts.values()]
    .map((row) => {
      const unitGroups = pendingUnitGroups(row.units);
      const unitConflict = unitGroups.length > 1;
      const singleUnit = unitGroups.length === 1 ? unitGroups[0] : null;
      return {
        itemId: row.itemId,
        iceCode: row.iceCode,
        nameCn: row.nameCn,
        warehouseNames: [...row.warehouseNames].sort(),
        reasons: [...row.reasons],
        unitConflict,
        pendingOnHand: unitConflict ? null : (singleUnit?.pendingOnHand ?? null),
        pendingAvailable: unitConflict ? null : (singleUnit?.pendingAvailable ?? null),
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
    contributingWarehouseCount: homeContributingCount,
    dataTime: homeDataTime,
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
