import 'server-only';

import { requireActiveAdmin, requireActiveAuth } from '@/lib/auth';
import { withReadOnlyAppDb, type DbIdentity } from '@/lib/database/app-db';
import type {
  AccessAccountDetailDto,
  AccessAccountsPageDto,
  AccessAccountDto,
  AccessMarketOptionDto,
  AccessRoleDto,
  AccessWarehouseOptionDto,
  MyInventoryAccessDto,
} from '../types';

/**
 * 权限设置的服务端读取层。
 *
 * - 管理与配置类读取一律先做「启用中的管理员」鉴权，再走 app 角色的只读事务；
 * - 成员自己的权限摘要（read_my_inventory_access）只要求启用中的登录账号；
 * - 只返回 DTO：不导出数据库行、认证 id、密码等；
 * - 金额不在这里下发：成员是否有金额权限只用 canViewAmount 布尔值表示。
 */

async function callReadRpc<T>(identity: DbIdentity | null, functionSpec: string, params: unknown[]): Promise<T> {
  const placeholders = params.map((_, index) => `$${index + 1}`).join(', ');
  const sql = params.length > 0
    ? `SELECT ${functionSpec}(${placeholders}) AS result`
    : `SELECT ${functionSpec}() AS result`;
  return withReadOnlyAppDb(identity, async (client) => {
    const result = await client.query<{ result: T }>(sql, params);
    return (result.rows[0]?.result ?? null) as T;
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function bool(value: unknown): boolean {
  return value === true;
}

function int(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value);
  return 0;
}

function normalizeRole(raw: unknown): AccessRoleDto | null {
  const row = asRecord(raw);
  const roleId = text(row.roleId);
  if (!roleId) return null;
  return {
    roleId,
    name: text(row.name),
    description: textOrNull(row.description),
    canViewInventory: bool(row.canViewInventory),
    canViewAmount: bool(row.canViewAmount),
    presetKey: textOrNull(row.presetKey),
    accountCount: int(row.accountCount),
    updatedAt: textOrNull(row.updatedAt),
  };
}

function normalizeAccount(raw: unknown): AccessAccountDto | null {
  const row = asRecord(raw);
  const profileId = text(row.profileId);
  if (!profileId) return null;
  return {
    profileId,
    displayName: text(row.displayName),
    email: textOrNull(row.email),
    isActive: bool(row.isActive),
    isSystemAdmin: bool(row.isSystemAdmin),
    roleId: textOrNull(row.roleId),
    roleName: textOrNull(row.roleName),
    canViewInventory: bool(row.canViewInventory),
    canViewAmount: bool(row.canViewAmount),
    markets: asArray(row.markets).map((entry) => text(entry)).filter(Boolean),
    logisticsMarkets: asArray(row.logisticsMarkets).map((entry) => text(entry)).filter(Boolean),
    warehouseCount: int(row.warehouseCount),
  };
}

function normalizeAccountDetail(raw: unknown): AccessAccountDetailDto | null {
  const account = normalizeAccount(raw);
  if (!account) return null;
  const row = asRecord(raw);
  return {
    ...account,
    warehouses: asArray(row.warehouses).map((entry) => {
      const warehouse = asRecord(entry);
      return {
        warehouseId: text(warehouse.warehouseId),
        externalId: text(warehouse.externalId),
        name: text(warehouse.name),
        market: textOrNull(warehouse.market),
      };
    }).filter((warehouse) => warehouse.warehouseId.length > 0),
  };
}

export async function requireAccessAdmin(): Promise<DbIdentity> {
  const actor = await requireActiveAdmin();
  return { profileUserId: actor.id };
}

/** 当前会话的库存权限（成员导航/金额列/范围提示都用这一份）。 */
export async function getMyInventoryAccess(): Promise<MyInventoryAccessDto | null> {
  const actor = await requireActiveAuth();
  const raw = await callReadRpc<unknown>({ profileUserId: actor.id }, 'catalog.read_my_inventory_access', []);
  const row = asRecord(raw);
  if (!bool(row.signedIn)) return null;
  return {
    signedIn: true,
    isAdmin: bool(row.isAdmin),
    canViewInventory: bool(row.canViewInventory),
    canViewAmount: bool(row.canViewAmount),
    roleName: textOrNull(row.roleName),
    warehouseCount: int(row.warehouseCount),
    scopeEmpty: bool(row.scopeEmpty),
    warehouses: asArray(row.warehouses).map((entry) => {
      const warehouse = asRecord(entry);
      return {
        id: text(warehouse.id),
        externalId: text(warehouse.externalId),
        name: text(warehouse.name),
        market: textOrNull(warehouse.market),
      };
    }).filter((warehouse) => warehouse.id.length > 0),
    canViewShipment: bool(row.canViewShipment),
    shipmentMarkets: asArray(row.shipmentMarkets).map((entry) => text(entry)).filter(Boolean),
  };
}

export async function getAccessRoles(): Promise<AccessRoleDto[]> {
  const identity = await requireAccessAdmin();
  const raw = await callReadRpc<unknown>(identity, 'catalog.read_access_roles', []);
  return asArray(asRecord(raw).roles)
    .map(normalizeRole)
    .filter((role): role is AccessRoleDto => role !== null);
}

export async function getAccessWarehouseOptions(): Promise<AccessWarehouseOptionDto[]> {
  const identity = await requireAccessAdmin();
  const raw = await callReadRpc<unknown>(identity, 'catalog.read_access_warehouse_options', []);
  return asArray(asRecord(raw).warehouses)
    .map((entry) => {
      const row = asRecord(entry);
      const warehouseId = text(row.warehouseId);
      if (!warehouseId) return null;
      return {
        warehouseId,
        externalId: text(row.externalId),
        name: text(row.name),
        market: textOrNull(row.market),
        marketKey: text(row.marketKey) || '__unknown__',
      } satisfies AccessWarehouseOptionDto;
    })
    .filter((entry): entry is AccessWarehouseOptionDto => entry !== null);
}

/** 账号可勾选的物流市场（来自飞书物流表里真实出现过的市场），只服务管理员。 */
export async function getAccessMarketOptions(): Promise<AccessMarketOptionDto[]> {
  const identity = await requireAccessAdmin();
  const raw = await callReadRpc<unknown>(identity, 'catalog.read_access_market_options', []);
  return asArray(asRecord(raw).markets)
    .map((entry) => {
      const row = asRecord(entry);
      const market = text(row.market);
      if (!market) return null;
      return { market, ticketCount: int(row.ticketCount) } satisfies AccessMarketOptionDto;
    })
    .filter((entry): entry is AccessMarketOptionDto => entry !== null);
}

export interface AccessAccountQuery {  search: string;
  roleId: string | null;
  status: 'active' | 'inactive' | null;
  page: number;
  limit: number;
}

export async function getAccessAccounts(query: AccessAccountQuery): Promise<AccessAccountsPageDto> {
  const identity = await requireAccessAdmin();
  const limit = Math.max(1, Math.min(Math.trunc(query.limit) || 50, 200));
  const page = Math.max(1, Math.trunc(query.page) || 1);
  const raw = await callReadRpc<unknown>(identity, 'catalog.access_account_rows', [
    query.search || null,
    query.roleId,
    query.status,
    limit,
    (page - 1) * limit,
  ]);
  const row = asRecord(raw);
  return {
    total: int(row.total),
    limit: int(row.limit) || limit,
    offset: int(row.offset),
    accounts: asArray(row.accounts)
      .map(normalizeAccount)
      .filter((account): account is AccessAccountDto => account !== null),
  };
}

export async function getAccessAccount(profileId: string): Promise<AccessAccountDetailDto | null> {
  const identity = await requireAccessAdmin();
  const raw = await callReadRpc<unknown>(identity, 'catalog.read_access_account', [profileId]);
  return normalizeAccountDetail(raw);
}
