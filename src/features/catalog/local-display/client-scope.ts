import type { CatalogDisplayOverview, CatalogDisplayRow } from './display-types';

/**
 * 列表切仓：只把“当前仓库”的库存视图投影到行上，不改变其它仓库数据，
 * 也不把“本仓无行”当成 0。数值与商品库存页同仓同口径。
 */
export function applyWarehouseScopeToDisplayRow(row: CatalogDisplayRow, warehouse: string): CatalogDisplayRow {
  const scope = row.inventory.warehouseScopes[warehouse];
  if (!scope) return row;
  const complete = Boolean(scope.knownSubtotalComplete);
  return {
    ...row,
    inventory: {
      ...row.inventory,
      knownSubtotal: scope.confirmedOnHandTotal,
      knownSubtotalComplete: complete,
      hasPendingTotal: Boolean(scope.pendingTotal),
      hasCurrentData: scope.confirmedLineCount > 0,
      coveredWarehouseCount: scope.confirmedLineCount > 0 ? 1 : 0,
      scopeWarehouseCount: 1,
      lastObservedAt: scope.lastObservedAt ?? null,
    },
    bsSample: {
      ...row.bsSample,
      confirmedOnHandTotal: scope.confirmedOnHandTotal,
      confirmedLineCount: scope.confirmedLineCount,
      estimatedValueCny: null,
      valuationState: scope.valuationState,
      valuationReason: scope.valuationReason,
      hasCurrentData: scope.confirmedLineCount > 0,
      hasPendingTotal: Boolean(scope.pendingTotal),
      knownSubtotalComplete: complete,
      coveredWarehouseCount: scope.confirmedLineCount > 0 ? 1 : 0,
      scopeWarehouseCount: 1,
      lastObservedAt: scope.lastObservedAt ?? null,
    },
  };
}

/** 本仓覆盖：至少一条已采用当前行；不含未对应/无来源/失败。 */
function rowInWarehouseScope(row: CatalogDisplayRow) {
  return row.inventory.hasCurrentData;
}

export function coverageForWarehouseFilter(display: CatalogDisplayOverview, warehouse: string | 'all') {
  if (warehouse === 'all') return display.coverage;
  const scopedRows = display.rows.map((row) => applyWarehouseScopeToDisplayRow(row, warehouse));
  const whCov = display.warehouseCoverage[warehouse];
  const inScope = scopedRows.filter((r) => rowInWarehouseScope(r));
  return {
    pricedItemCount: inScope.filter((r) => r.adoptedUnitCost?.state === 'priced').length,
    valuedItemCount: 0,
    missingPriceIceCodes: inScope
      .filter((r) => r.adoptedUnitCost?.state === 'missing' || r.adoptedUnitCost?.state === 'parse_failed')
      .map((r) => r.item.iceCode ?? '(缺码)'),
    bsConfirmedLines: whCov?.adoptedRows ?? 0,
    bsUnselectedLines: 0,
    inventoryLineCount: whCov?.adoptedRows ?? 0,
    coveredItemCount: inScope.length,
    pendingTotalItemCount: inScope.filter((r) => r.inventory.hasPendingTotal).length,
    pendingSourceRowCount: whCov?.pendingSourceRows ?? 0,
  };
}
