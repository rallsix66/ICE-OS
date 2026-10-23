import type { AdoptedUnitCost } from './adopted-price';
import type { CatalogItemDto } from '../types';

export type WarehouseScopeView = {
  confirmedOnHandTotal: string | null;
  estimatedValueCny: string | null;
  valuationState: 'valued' | 'no_price' | 'no_inventory' | 'not_applicable' | 'no_warehouse_line';
  valuationReason: string | null;
  confirmedLineCount: number;
};

export type CatalogDisplayValuationState = WarehouseScopeView['valuationState'];

export interface CatalogDisplayRow {
  item: CatalogItemDto;
  specificationText: string;
  adoptedUnitCost: AdoptedUnitCost | null;
  bsSample: {
    exportLabel: string | null;
    confirmedOnHandTotal: string | null;
    confirmedLineCount: number;
    warehouseOnHand: Record<string, string | null>;
    warehouseScopes: Record<string, WarehouseScopeView>;
    /** Line-level inventory fingerprint per warehouse scope (includes `all`). */
    inventoryProjectionByWarehouse: Record<string, string>;
    estimatedValueCny: string | null;
    valuationState: CatalogDisplayValuationState;
    valuationReason: string | null;
  };
  materialStatus: string;
}

export interface CatalogDisplayOverview {
  basisDocumentSha256: string;
  exportLabel: string | null;
  warehouseOptions: string[];
  rows: CatalogDisplayRow[];
  coverage: {
    pricedItemCount: number;
    valuedItemCount: number;
    missingPriceIceCodes: string[];
    bsConfirmedLines: number;
    bsUnselectedLines: number;
  };
  warehouseCoverage: Record<string, { bsConfirmedLines: number; bsUnselectedLines: number }>;
}
