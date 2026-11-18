/** 权限设置 v1（角色 / 账号 / 数据范围）DTO：页面只消费这些字段，不接触数据库行。 */

export interface AccessRoleDto {
  roleId: string;
  name: string;
  description: string | null;
  canViewInventory: boolean;
  canViewAmount: boolean;
  presetKey: string | null;
  accountCount: number;
  updatedAt: string | null;
}

export interface AccessWarehouseOptionDto {
  warehouseId: string;
  externalId: string;
  name: string;
  market: string | null;
  marketKey: string;
}

export interface AccessAccountDto {
  profileId: string;
  displayName: string;
  email: string | null;
  isActive: boolean;
  isSystemAdmin: boolean;
  roleId: string | null;
  roleName: string | null;
  canViewInventory: boolean;
  canViewAmount: boolean;
  /** 库存仓库范围所属市场（由仓库范围推导，保持原语义）。 */
  markets: string[];
  /** 物流市场授权（与仓库范围独立；空数组=没有物流在途权限）。 */
  logisticsMarkets: string[];
  warehouseCount: number;
}

/** 账号可勾选的物流市场：来自飞书物流表里真实出现过的市场。 */
export interface AccessMarketOptionDto {
  market: string;
  ticketCount: number;
}

export interface AccessAccountScopeWarehouseDto {
  warehouseId: string;
  externalId: string;
  name: string;
  market: string | null;
}

export interface AccessAccountDetailDto extends AccessAccountDto {
  warehouses: AccessAccountScopeWarehouseDto[];
}

export interface AccessAccountsPageDto {
  total: number;
  limit: number;
  offset: number;
  accounts: AccessAccountDto[];
}

/** 当前会话的库存权限（成员导航与金额列都以此为准）。 */
export interface MyInventoryAccessDto {
  signedIn: boolean;
  isAdmin: boolean;
  canViewInventory: boolean;
  canViewAmount: boolean;
  roleName: string | null;
  warehouseCount: number;
  scopeEmpty: boolean;
  warehouses: Array<{ id: string; externalId: string; name: string; market: string | null }>;
  /** 物流在途读取权限：管理员或至少获授一个物流市场。 */
  canViewShipment: boolean;
  /** 获授的物流市场（飞书来源国家原值，如「越南」）。 */
  shipmentMarkets: string[];
}

/** 市场中文名：与页面其它位置一致；未知市场（market IS NULL）单列。 */
export const MARKET_LABELS: Record<string, string> = {
  TH: '泰国',
  ID: '印尼',
  MY: '马来西亚',
  PH: '菲律宾',
  VN: '越南',
  CN: '中国',
  __unknown__: '市场待确认',
};

export function marketLabel(market: string | null | undefined): string {
  if (!market) return MARKET_LABELS.__unknown__;
  return MARKET_LABELS[market] ?? market;
}
