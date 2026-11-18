'use server';

import { revalidatePath } from 'next/cache';

import { callAppRpc, withAppDb } from '@/lib/database/app-db';
import { getAccessAccount, requireAccessAdmin } from './reads';
import { deleteAuthAccount, provisionAuthAccount, setAuthAccountPassword } from './auth-accounts';
import type { AccessAccountDetailDto } from '../types';

/**
 * 权限设置 v1 的写入动作（角色 / 账号 / 范围 / 启停 / 重置密码）。
 *
 * - 一律先做「启用中的管理员」鉴权，再经既有 catalog RPC 写；数据库侧还有 require_admin 与审计；
 * - 建号分两步：先用 Better Auth 建认证账号（密码只在这里出现一次，不落业务表、不进日志），
 *   再用 catalog.create_access_account 落业务行；业务写失败时补偿删除认证账号；
 * - 错误只回中文短句：不把 SQL、参数值或哈希带到页面。
 */

export type AccessActionResult = { success: true } | { success: false; error: string };

const KNOWN_ERRORS: Record<string, string> = {
  ACCESS_ROLE_NAME_REQUIRED: '请填写角色名称。',
  ACCESS_ROLE_NAME_TOO_LONG: '角色名称最多 20 个字。',
  ACCESS_ROLE_DESCRIPTION_TOO_LONG: '角色说明最多 200 个字。',
  ACCESS_ROLE_NAME_RESERVED: '「管理员」是系统角色名，不能用作普通角色。',
  ACCESS_ROLE_AMOUNT_REQUIRES_VIEW: '要允许查看金额，必须先允许库存查看。',
  ACCESS_ROLE_NOT_FOUND: '角色不存在，已被删除或改名，请刷新后重试。',
  ACCESS_ACCOUNT_NOT_FOUND: '账号不存在，请刷新后重试。',
  ACCESS_ACCOUNT_NAME_REQUIRED: '请填写姓名。',
  ACCESS_ACCOUNT_NAME_TOO_LONG: '姓名最多 60 个字。',
  ACCESS_ACCOUNT_AUTH_USER_REQUIRED: '账号创建缺少认证账号，请重试。',
  ACCESS_ACCOUNT_AUTH_USER_TAKEN: '该登录邮箱已绑定其它账号。',
  ACCESS_ACCOUNT_EMAIL_TAKEN: '这个登录账号（邮箱）已经存在，请换一个。',
  ACCESS_ACCOUNT_EMAIL_INVALID: '登录账号需要是有效邮箱。',
  ACCESS_ACCOUNT_PASSWORD_INVALID: '密码不符合要求，请重新填写。',
  ACCESS_ACCOUNT_PASSWORD_UNAVAILABLE: '当前认证服务无法修改密码，请稍后重试。',
  ACCESS_ADMIN_ACCOUNT_IMMUTABLE: '管理员账号由系统维护，不能在这里改角色、范围或停用。',
  CATALOG_FORBIDDEN: '当前账号没有权限执行这个操作。',
  '未登录或账户已停用': '登录状态已失效，请重新登录。',
  '无权限：需要管理员角色': '当前账号没有权限执行这个操作。',
};

function messageOf(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const code = raw.split(':')[0]?.trim() ?? raw;
  if (KNOWN_ERRORS[code]) return KNOWN_ERRORS[code];
  if (raw.includes('access_role_name_unique') || /duplicate key/i.test(raw)) return '已经有同名角色，请换一个名称。';
  if (raw.includes('access_role_name_check')) return '角色名称需要 1–20 个字。';
  if (raw.includes('access_role_amount_requires_view')) return '要允许查看金额，必须先允许库存查看。';
  if (/ACCESS_ACCOUNT_AUTH_FAILED/.test(raw)) return '认证服务没有建成这个账号，请稍后重试。';
  return '操作没有完成，请刷新后重试；如果反复失败，请查看服务端日志。';
}

async function perform(fn: () => Promise<void>, mutation = true): Promise<AccessActionResult> {
  try {
    await fn();
    if (mutation) {
      try {
        revalidatePath('/dashboard/permissions', 'layout');
      } catch {
        /* 已提交的写入不因缓存刷新失败而判失败 */
      }
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: messageOf(error) };
  }
}

function cleanText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function uuidList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string => typeof entry === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entry)))];
}

function uuidOrNull(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value : null;
}

/** 物流市场是飞书来源国家原值（中文），这里只做格式收敛，是否真实存在由数据库入口校验。 */
function marketKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && entry.length <= 40))].slice(0, 20);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 编辑弹窗打开时读取账号详情（含仓库范围）；只服务管理员。 */
export async function getAccessAccountDetailAction(
  profileId: string,
): Promise<{ success: true; data: AccessAccountDetailDto } | { success: false; error: string }> {
  try {
    const profile = uuidOrNull(profileId);
    if (!profile) throw new Error('ACCESS_ACCOUNT_NOT_FOUND');
    const detail = await getAccessAccount(profile);
    if (!detail) throw new Error('ACCESS_ACCOUNT_NOT_FOUND');
    return { success: true, data: detail };
  } catch (error) {
    return { success: false, error: messageOf(error) };
  }
}

export async function saveAccessRoleAction(input: {
  roleId: string | null;
  name: string;
  description: string;
  canViewInventory: boolean;
  canViewAmount: boolean;
}): Promise<AccessActionResult> {
  return perform(async () => {
    const identity = await requireAccessAdmin();
    const roleId = uuidOrNull(input.roleId);
    const name = cleanText(input.name, 40);
    const description = cleanText(input.description, 240);
    const canViewInventory = input.canViewInventory === true;
    const canViewAmount = canViewInventory && input.canViewAmount === true;
    await callAppRpc(identity, 'catalog.save_access_role',
      [roleId, name, description, canViewInventory, canViewAmount]);
  });
}

export async function createAccessAccountAction(input: {
  displayName: string;
  email: string;
  password: string;
  roleId: string;
  warehouseIds: string[];
  marketKeys: string[];
  isActive: boolean;
}): Promise<AccessActionResult> {
  return perform(async () => {
    const identity = await requireAccessAdmin();
    const displayName = cleanText(input.displayName, 60);
    const email = cleanText(input.email, 120).toLowerCase();
    const password = typeof input.password === 'string' ? input.password : '';
    const roleId = uuidOrNull(input.roleId);
    const warehouseIds = uuidList(input.warehouseIds);
    const markets = marketKeys(input.marketKeys);
    if (!displayName) throw new Error('ACCESS_ACCOUNT_NAME_REQUIRED');
    if (!EMAIL_RE.test(email)) throw new Error('ACCESS_ACCOUNT_EMAIL_INVALID');
    if (password.length < 8) throw new Error('ACCESS_ACCOUNT_PASSWORD_INVALID');
    if (!roleId) throw new Error('ACCESS_ROLE_NOT_FOUND');
    const { authUserId } = await provisionAuthAccount({ email, password, name: displayName });
    try {
      await callAppRpc(identity, 'catalog.create_access_account',
        [authUserId, email, displayName, roleId, warehouseIds, input.isActive === true, markets]);
    } catch (error) {
      await deleteAuthAccount(authUserId);
      throw error;
    }
  });
}

export async function updateAccessAccountAction(input: {
  profileId: string;
  displayName: string;
  roleId: string;
  isActive: boolean;
  warehouseIds: string[];
  marketKeys: string[];
}): Promise<AccessActionResult> {
  return perform(async () => {
    const identity = await requireAccessAdmin();
    const profileId = uuidOrNull(input.profileId);
    const roleId = uuidOrNull(input.roleId);
    if (!profileId) throw new Error('ACCESS_ACCOUNT_NOT_FOUND');
    if (!roleId) throw new Error('ACCESS_ROLE_NOT_FOUND');
    await callAppRpc(identity, 'catalog.update_access_account', [
      profileId,
      cleanText(input.displayName, 60),
      roleId,
      input.isActive === true,
      uuidList(input.warehouseIds),
      marketKeys(input.marketKeys),
    ]);
  });
}

export async function setAccessAccountActiveAction(input: {
  profileId: string;
  isActive: boolean;
}): Promise<AccessActionResult> {
  return perform(async () => {
    const identity = await requireAccessAdmin();
    const profileId = uuidOrNull(input.profileId);
    if (!profileId) throw new Error('ACCESS_ACCOUNT_NOT_FOUND');
    await callAppRpc(identity, 'catalog.set_access_account_active', [profileId, input.isActive === true]);
  });
}

export async function resetAccessPasswordAction(input: {
  profileId: string;
  password: string;
}): Promise<AccessActionResult> {
  return perform(async () => {
    const identity = await requireAccessAdmin();
    const profileId = uuidOrNull(input.profileId);
    const password = typeof input.password === 'string' ? input.password : '';
    if (!profileId) throw new Error('ACCESS_ACCOUNT_NOT_FOUND');
    if (password.length < 8) throw new Error('ACCESS_ACCOUNT_PASSWORD_INVALID');
    // 认证账号 id 只从服务端读取，不接受客户端传入；同时用同一份账号类型标记
    // 拒绝管理员账号（页面虽已禁用编辑，服务端仍必须以现有标志为准）。
    const target = await withAppDb(identity, async (client) => {
      const result = await client.query<{
        result: { authUserId?: string | null; isSystemAdmin?: boolean } | null;
      }>('SELECT catalog.read_access_account($1) AS result', [profileId]);
      return result.rows[0]?.result ?? null;
    });
    if (!target?.authUserId) throw new Error('ACCESS_ACCOUNT_NOT_FOUND');
    if (target.isSystemAdmin === true) throw new Error('ACCESS_ADMIN_ACCOUNT_IMMUTABLE');
    await setAuthAccountPassword(target.authUserId, password);
    // 成功改密后留痕：操作者由 audit.actor_id 记录，detail 只有目标与动作，不含密码/哈希。
    await callAppRpc(identity, 'catalog.record_access_password_reset', [profileId]);
  });
}
