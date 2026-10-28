import type { AdoptedUnitCost } from './adopted-price';
import type { CatalogItemDto } from '../types';

/**
 * 库存状态（与商品库存页同一 effective-row 口径）：
 * - current：本仓有已采用的当前库存行；
 * - pending_total：本仓同商品有多个来源编码，逐行显示、合计待核对（不擅自相加）；
 * - unmapped_source：本仓最新登记批次有该商品的已知编码来源行，但尚未确认对应；
 * - no_source：本仓最新登记批次没有该商品的已知编码来源行；
 * - unseen：对应已确认，但本仓当前完整批次还没有采用行（等待下一次完整同步）；
 * - failed：本仓最近一次同步失败，现值来自上次成功批次（或暂无）；
 * - no_data：本仓还没有成功采集批次。
 */
export type InventoryWarehouseState =
  | 'current'
  | 'pending_total'
  | 'unmapped_source'
  | 'no_source'
  | 'unseen'
  | 'failed'
  | 'no_data';

export type WarehouseScopeView = {
  confirmedOnHandTotal: string | null;
  estimatedValueCny: string | null;
  valuationState: 'valued' | 'no_price' | 'no_inventory' | 'not_applicable' | 'no_warehouse_line' | 'not_computed' | 'not_available';
  valuationReason: string | null;
  confirmedLineCount: number;
  /** 新库存模块的仓状态（旧 BS 样表投影没有该字段）。 */
  inventoryState?: InventoryWarehouseState;
  /** 本仓同商品多编码：逐行显示、合计待核对。 */
  pendingTotal?: boolean;
  /** 本仓已知数量是否完整（无多码待合计、无同仓待确认来源、且已有采用行）。 */
  knownSubtotalComplete?: boolean;
  /** 本仓已知编码来源行的待核对数量（未计入合计）。 */
  pendingSourceRowCount?: number;
  lastObservedAt?: string | null;
};

export type CatalogDisplayValuationState = WarehouseScopeView['valuationState'];

/** 一条来源编码行（已采用）。多编码行逐行保留，0 库存也显示。 */
export interface CatalogInventorySourceLine {
  warehouse: string;
  warehouseExternalId: string;
  externalSku: string;
  unit: string | null;
  onHand: string | null;
  orderLocked: string | null;
  warehouseAvailable: string | null;
  activityReserved: string | null;
  inTransit: string | null;
  observedAt: string | null;
  excelRow: number | null;
  /** 仅作页面筛选/语义兼容；库存模块的行都是已采用的当前行。 */
  selectionState: 'confirmed';
}

export interface CatalogPendingTotalGroup {
  warehouseId: string;
  externalId: string;
  name: string;
  unit: string | null;
  rows: { externalSku: string; onHand: string | null; excelRow: number | null; observedAt: string | null }[];
}

export interface CatalogInventoryItemView {
  hasCurrentData: boolean;
  mapped: boolean;
  /** 单码行已知小计（多码/多单位时不擅自相加）。 */
  knownSubtotal: string | null;
  knownSubtotalComplete: boolean;
  hasPendingTotal: boolean;
  pendingTotalWarehouses: CatalogPendingTotalGroup[];
  coveredWarehouseCount: number;
  scopeWarehouseCount: number;
  lastObservedAt: string | null;
  markets: string[];
  hasUnknownMarket: boolean;
  verificationOnly: boolean;
  unitUnconfirmed: boolean;
  unitConflict: boolean;
  unitGroupCount: number;
  /** 按仓库名称键（与列表仓库筛选同一字符串）。 */
  warehouseScopes: Record<string, WarehouseScopeView>;
  /** 逐仓来源行（详情用；列表不发送到客户端）。 */
  lines: CatalogInventorySourceLine[];
  /** 列表/详情漂移指纹（含全仓）。 */
  inventoryProjectionByWarehouse: Record<string, string>;
}

export interface CatalogDisplayRow {
  item: CatalogItemDto;
  specificationText: string;
  /** 采用进货价原值（只展示，不乘新库存；本包不新做估值）。 */
  adoptedUnitCost: AdoptedUnitCost | null;
  bsSample: {
    /** 来源标签，例如 “BigSeller 自动导出”。 */
    exportLabel: string | null;
    /** 最近来源观测时间（来自本次导出完成时间，不是 now()）。 */
    lastObservedAt: string | null;
    confirmedOnHandTotal: string | null;
    confirmedLineCount: number;
    warehouseOnHand: Record<string, string | null>;
    warehouseScopes: Record<string, WarehouseScopeView>;
    /** Line-level inventory fingerprint per warehouse scope (includes `all`). */
    inventoryProjectionByWarehouse: Record<string, string>;
    estimatedValueCny: string | null;
    valuationState: CatalogDisplayValuationState;
    valuationReason: string | null;
    hasCurrentData: boolean;
    hasPendingTotal: boolean;
    knownSubtotalComplete: boolean;
    pendingTotalWarehouses: CatalogPendingTotalGroup[];
    coveredWarehouseCount: number;
    scopeWarehouseCount: number;
  };
  inventory: CatalogInventoryItemView;
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
    inventoryLineCount: number;
    coveredItemCount: number;
    pendingTotalItemCount: number;
    pendingSourceRowCount: number;
  };
  warehouseCoverage: Record<string, { adoptedRows: number; pendingSourceRows: number }>;
}
