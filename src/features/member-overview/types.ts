/** 成员经营总览 v1 的页面 DTO：只包含当前账号获授范围，不携带金额权限以外的成本。 */

export interface MemberPendingProductDto {
  itemId: string;
  iceCode: string | null;
  nameCn: string | null;
  /** 该商品在哪些授权仓被判定为待核。 */
  warehouseNames: string[];
  /** 待核原因：同仓多来源 SKU / 单位冲突 / 已知小计不可用。 */
  reasons: string[];
  /** 被排除、未计入首页已知合计的原始数量（仅用于说明差额）。 */
  pendingOnHand: number;
  pendingAvailable: number;
}

export interface MemberInventoryWarehouseDto {
  warehouseId: string;
  externalId: string;
  name: string;
  market: string | null;
  /** 已对应且可明确计入的来源行实物合计；没有可计入行时为 null。 */
  onHand: number | null;
  /** 已对应且可明确计入的来源行可售合计；没有可计入行时为 null。 */
  available: number | null;
  /** 有已采用行但实物/可售缺失的条数（原样保留，不写 0）。 */
  onHandUnknownRows: number;
  availableUnknownRows: number;
  /** 当前授权仓已采用、未对应来源行条数（不计入数量）。 */
  unmappedRows: number;
  /** 因同仓多来源 SKU / 单位冲突 / 已知小计不可用而排除的商品款数。 */
  pendingProductCount: number;
  /** 被排除的原始实物/可售数量，仅用于说明待核差额。 */
  pendingOnHand: number;
  pendingAvailable: number;
  /** 已知估算货值；无金额权限 / 读取失败 / 没有可计价行时为 null。 */
  estimatedValueCny: string | null;
  /** 已采用但缺采用进货价的商品款数（同一商品多行只算一款）。 */
  missingCostProducts: number;
  /** 该仓最近一次有效库存数据时间。 */
  dataTime: string | null;
}

export interface MemberInventorySummaryDto {
  canViewAmount: boolean;
  /** 金额读取失败时的短说明；没权限时为 null。 */
  amountError: string | null;
  warehouses: MemberInventoryWarehouseDto[];
  onHand: number | null;
  onHandUnknownRows: number;
  available: number | null;
  availableUnknownRows: number;
  unmappedRows: number;
  /** 待核商品（已从已知实物/可售/货值中排除）。 */
  pendingProducts: MemberPendingProductDto[];
  pendingProductCount: number;
  pendingOnHand: number;
  pendingAvailable: number;
  estimatedValueCny: string | null;
  missingCostProducts: number;
  /** 实际参与汇总的授权仓数量（只有存在可计入商品行的仓）。 */
  contributingWarehouseCount: number;
  /** 实际参与汇总的授权仓中最近的库存数据时间。 */
  dataTime: string | null;
}


export interface MemberShipmentMarketDto {
  market: string;
  ticketCount: number;
  itemCount: number;
  /** 已知剩余在途合计；该市场有票但全部数量待核时为 null（不是 0）。 */
  knownRemaining: number | null;
  /** 数量未知或人工数量冲突的明细条数（归入待核）。 */
  pendingItemCount: number;
  latestReadAt: string | null;
}

export interface MemberShipmentSummaryDto {
  markets: MemberShipmentMarketDto[];
  ticketCount: number;
  itemCount: number;
  knownRemaining: number | null;
  pendingItemCount: number;
  latestReadAt: string | null;
}
