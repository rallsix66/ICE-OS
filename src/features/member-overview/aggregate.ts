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
import type { InventoryWarehouseRowsDto } from '@/features/inventory/types';
import type { ShipmentMarketSummarySource } from '@/features/shipment/summary';
import type {
  MemberInventorySummaryDto,
  MemberInventoryWarehouseDto,
  MemberShipmentMarketDto,
  MemberShipmentSummaryDto,
} from './types';

export interface MemberOverviewWarehouse {
  id: string;
  externalId: string;
  name: string;
  market: string | null;
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

export function summarizeMemberInventory(input: {
  rows: InventoryWarehouseRowsDto;
  warehouses: MemberOverviewWarehouse[];
  costMap: Record<string, string> | null;
  canViewAmount: boolean;
  amountError: string | null;
}): MemberInventorySummaryDto {
  const { rows, warehouses, costMap } = input;
  const statesById = new Map(rows.warehouses.map((state) => [state.warehouseId, state]));
  const adopted = rows.rows.filter((row) => row.status === 'adopted');
  const missingCostProducts = new Set<string>();
  let totalOnHand = 0;
  let totalOnHandKnown = 0;
  let totalAvailable = 0;
  let totalAvailableKnown = 0;
  let totalValue: bigint | null = null;

  const warehouseRows: MemberInventoryWarehouseDto[] = warehouses.map((warehouse) => {
    const own = adopted.filter((row) => row.warehouseId === warehouse.id);
    let onHand = 0;
    let onHandKnown = 0;
    let available = 0;
    let availableKnown = 0;
    let value: bigint | null = null;
    const missing = new Set<string>();
    for (const row of own) {
      if (row.onHand !== null) {
        onHand += row.onHand;
        onHandKnown += 1;
      }
      if (row.warehouseAvailable !== null) {
        available += row.warehouseAvailable;
        availableKnown += 1;
      }
      const amount = costAmountOf(costMap, row.itemId);
      if (amount !== null && row.onHand !== null) {
        const estimated = estimateValueScaled(row.onHand, amount);
        if (estimated !== null) value = (value ?? BigInt(0)) + estimated;
      } else if (costMap !== null && row.itemId && (row.onHand ?? 0) > 0) {
        missing.add(row.itemId);
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
      onHandUnknownRows: own.length - onHandKnown,
      availableUnknownRows: own.length - availableKnown,
      unmappedRows: rows.rows.filter((row) => row.warehouseId === warehouse.id && row.status === 'unmapped').length,
      estimatedValueCny: scaledText(value),
      missingCostProducts: missing.size,
      dataTime: state?.observationAt ?? state?.lastSuccessAt ?? rowTime,
    };
  });

  return {
    canViewAmount: input.canViewAmount,
    amountError: input.amountError,
    warehouses: warehouseRows,
    onHand: totalOnHandKnown > 0 ? totalOnHand : null,
    onHandUnknownRows: warehouseRows.reduce((sum, row) => sum + row.onHandUnknownRows, 0),
    available: totalAvailableKnown > 0 ? totalAvailable : null,
    availableUnknownRows: warehouseRows.reduce((sum, row) => sum + row.availableUnknownRows, 0),
    unmappedRows: rows.rows.filter((row) => row.status === 'unmapped').length,
    estimatedValueCny: scaledText(totalValue),
    missingCostProducts: missingCostProducts.size,
    dataTime: rows.scope.lastAllSuccessAt
      ?? warehouseRows.reduce<string | null>((latest, row) => latestIso(latest, row.dataTime), null),
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
