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
  markets: string[];
  warehouseCount: number;
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
