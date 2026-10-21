import type { CatalogDisplayOverview, CatalogDisplayRow } from './display-types';

export function applyWarehouseScopeToDisplayRow(row: CatalogDisplayRow, warehouse: string): CatalogDisplayRow {
  const scope = row.bsSample.warehouseScopes[warehouse];
  if (!scope) return row;
  return {
    ...row,
    bsSample: {
      ...row.bsSample,
      confirmedOnHandTotal: scope.confirmedOnHandTotal,
      confirmedLineCount: scope.confirmedLineCount,
      estimatedValueCny: scope.estimatedValueCny,
      valuationState: scope.valuationState,
      valuationReason: scope.valuationReason,
    },
  };
}

/** 本仓覆盖：至少一条已选 BS 样表行；不含「本仓无对应」(no_warehouse_line)。 */
function rowInWarehouseScope(row: CatalogDisplayRow) {
  return row.bsSample.confirmedLineCount > 0;
}

export function coverageForWarehouseFilter(display: CatalogDisplayOverview, warehouse: string | 'all') {
  if (warehouse === 'all') return display.coverage;
  const scopedRows = display.rows.map((row) => applyWarehouseScopeToDisplayRow(row, warehouse));
  const whCov = display.warehouseCoverage[warehouse];
  const inScope = scopedRows.filter((r) => rowInWarehouseScope(r));
  return {
    pricedItemCount: inScope.filter((r) => r.adoptedUnitCost?.state === 'priced').length,
    valuedItemCount: inScope.filter((r) => r.bsSample.valuationState === 'valued').length,
    missingPriceIceCodes: inScope
      .filter((r) => r.adoptedUnitCost?.state === 'missing' || r.adoptedUnitCost?.state === 'parse_failed' || r.bsSample.valuationState === 'no_price')
      .map((r) => r.item.iceCode ?? '(缺码)'),
    bsConfirmedLines: whCov?.bsConfirmedLines ?? 0,
    bsUnselectedLines: whCov?.bsUnselectedLines ?? 0,
  };
}
