// 仓库分配权限模块 — 数据访问层
// P5-SY13A: 封装 user_warehouses 表查询，提供仓库/变体访问权限检查
// P5-SY13B: 扩展 operator 列表、仓库分配读写、可分配仓库查询
//
// Admin 不受仓库分配限制（getUserRole() === 'admin' 时返回全部仓库）。
// Operator 仅可访问 user_warehouses 中分配的仓库。
import { cache } from 'react';
import { callAppRpc, queryAppRows } from '@/lib/database/app-db';
import { requireAppDbIdentity } from '@/lib/database/app-identity';
import { isIndependentPlatformRuntime } from '@/lib/database/runtime';
import { createClient } from '@/lib/supabase/server';
import { unwrapJoin } from '@/lib/supabase/helpers';
import type { WarehouseAccessRepository, OperatorItem, AssignableWarehouse } from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateUUID(id: string): boolean {
  return UUID_RE.test(id);
}

// ─── Request-scope cached helpers ────────────────────────────────────
// 内部函数返回 string[]（不可变），避免缓存可变 Set。

const cachedGetAccessibleWarehouseIds = cache(
  async (userId: string): Promise<string[]> => {
    if (!validateUUID(userId)) return [];

    if (isIndependentPlatformRuntime()) {
      const identity = { profileUserId: userId };
      const roleRows = await queryAppRows<{ name: string }>(
        identity,
        `SELECT r.name FROM public.profiles p
         JOIN public.role r ON r.id = p.role_id
         WHERE p.id = $1 LIMIT 1`,
        [userId],
      );
      const roleName = roleRows[0]?.name;
      if (roleName === 'admin') {
        const wh = await queryAppRows<{ id: string }>(
          identity,
          `SELECT id FROM public.warehouse WHERE type = 'overseas' AND is_active = true`,
        );
        return wh.map((w) => w.id);
      }
      const assigned = await queryAppRows<{ warehouse_id: string }>(
        identity,
        `SELECT warehouse_id FROM public.user_warehouses WHERE user_id = $1`,
        [userId],
      );
      return assigned.map((r) => r.warehouse_id);
    }

    const supabase = await createClient();

    const { data: profile } = await supabase
      .from('profiles')
      .select('role:role_id(name)')
      .eq('id', userId)
      .single();

    const roleName = (profile as unknown as { role: { name: string } } | null)?.role?.name;
    if (roleName === 'admin') {
      const { data: allWh } = await supabase
        .from('warehouse')
        .select('id')
        .eq('type', 'overseas')
        .eq('is_active', true);

      return (allWh ?? []).map((w) => w.id);
    }

    const { data } = await supabase
      .from('user_warehouses')
      .select('warehouse_id')
      .eq('user_id', userId);

    return (data ?? []).map((r) => r.warehouse_id);
  },
);

export const warehouseAccessRepository: WarehouseAccessRepository = {
  /**
   * 获取用户可访问的仓库 ID 集合。
   * Admin 返回所有 active overseas warehouse；Operator 返回 user_warehouses 中分配的。
   * 每次调用返回新的 Set（基于同一请求内缓存的 string[]），避免调用方修改共享状态。
   */
  async getAccessibleWarehouseIds(userId: string): Promise<Set<string>> {
    return new Set(await cachedGetAccessibleWarehouseIds(userId));
  },

  /** 检查用户是否有某个仓库的访问权限 */
  async canAccessWarehouse(userId: string, warehouseId: string): Promise<boolean> {
    const ids = await this.getAccessibleWarehouseIds(userId);
    return ids.has(warehouseId);
  },

  /**
   * 检查用户是否有某个 variant 的访问权限。
   * 判断依据：variant 在用户已分配仓库中是否有 inventory。
   * Admin 始终有权限。
   */
  async canAccessVariant(userId: string, variantId: string): Promise<boolean> {
    if (!validateUUID(userId) || !validateUUID(variantId)) return false;

    const identity = { profileUserId: userId };
    if (isIndependentPlatformRuntime()) {
      const roleRows = await queryAppRows<{ name: string }>(
        identity,
        `SELECT r.name FROM public.profiles p
         JOIN public.role r ON r.id = p.role_id
         WHERE p.id = $1 LIMIT 1`,
        [userId],
      );
      if (roleRows[0]?.name === 'admin') return true;

      const accessibleIds = await this.getAccessibleWarehouseIds(userId);
      if (accessibleIds.size === 0) return false;

      const rows = await queryAppRows<{ id: string }>(
        identity,
        `SELECT id::text AS id FROM public.inventory
         WHERE variant_id = $1::uuid AND warehouse_id = ANY($2::uuid[])
         LIMIT 1`,
        [variantId, [...accessibleIds]],
      );
      return rows.length > 0;
    }

    const supabase = await createClient();
    const { data: profile } = await supabase
      .from('profiles')
      .select('role:role_id(name)')
      .eq('id', userId)
      .single();

    const roleName = (profile as unknown as { role: { name: string } } | null)?.role?.name;
    if (roleName === 'admin') return true;

    const accessibleIds = await this.getAccessibleWarehouseIds(userId);
    if (accessibleIds.size === 0) return false;

    const { data } = await supabase
      .from('inventory')
      .select('id')
      .eq('variant_id', variantId)
      .in('warehouse_id', [...accessibleIds])
      .limit(1);

    return (data?.length ?? 0) > 0;
  },

  // ─── P5-SY13B: 管理端仓库分配读写 ────────────────────────────────────

  /** 获取所有活跃 operator 用户 */
  async listOperators(): Promise<OperatorItem[]> {
    if (isIndependentPlatformRuntime()) {
      const identity = await requireAppDbIdentity();
      const rows = await queryAppRows<{
        id: string;
        display_name: string;
        is_active: boolean;
        created_at: string;
        role_name: string;
      }>(
        identity,
        `SELECT p.id::text AS id, p.display_name, p.is_active, p.created_at, r.name AS role_name
         FROM public.profiles p
         JOIN public.role r ON r.id = p.role_id
         WHERE p.is_active = true
         ORDER BY p.created_at ASC`,
      );
      return rows
        .filter((row) => row.role_name === 'operator')
        .map((row) => ({
          id: row.id,
          email: '',
          displayName: row.display_name,
          isActive: row.is_active,
          createdAt: row.created_at,
        }));
    }

    const supabase = await createClient();
    const { data } = await supabase
      .from('profiles')
      .select('id, display_name, is_active, created_at, role:role_id (name)')
      .eq('is_active', true)
      .order('created_at', { ascending: true });

    if (!data) return [];

    return data
      .filter((row) => {
        const role = unwrapJoin<{ name: string }>(row.role);
        return role?.name === 'operator';
      })
      .map((row) => ({
        id: row.id,
        email: '',
        displayName: row.display_name,
        isActive: row.is_active,
        createdAt: row.created_at,
      }));
  },

  /** 获取某用户的已分配仓库 ID 集合 */
  async getUserWarehouseAssignments(userId: string): Promise<Set<string>> {
    if (!validateUUID(userId)) return new Set();

    if (isIndependentPlatformRuntime()) {
      const identity = await requireAppDbIdentity();
      const rows = await queryAppRows<{ warehouse_id: string }>(
        identity,
        `SELECT warehouse_id::text AS warehouse_id FROM public.user_warehouses WHERE user_id = $1::uuid`,
        [userId],
      );
      return new Set(rows.map((r) => r.warehouse_id));
    }

    const supabase = await createClient();
    const { data } = await supabase
      .from('user_warehouses')
      .select('warehouse_id')
      .eq('user_id', userId);

    return new Set((data ?? []).map((r) => r.warehouse_id));
  },

  /**
   * 替换某用户的仓库分配。
   *
   * 写入前完成全部业务校验 → 通过 Migration 00016 RPC 事务性写入。
   * 校验失败不会删除旧分配。
   *
   * 校验规则：
   * - userId 必须是启用的 operator（非 admin / 非停用 / 不存在）
   * - warehouseIds 去重后写入
   * - warehouseIds 非空时，每个 ID 必须对应 active overseas warehouse
   * - 空 warehouseIds 表示清空该 operator 的所有分配
   */
  async updateUserWarehouses(
    userId: string,
    warehouseIds: string[],
  ): Promise<{ success: boolean; error?: string }> {
    // ── UUID 校验 ──────────────────────────────────────────────
    if (!validateUUID(userId)) {
      return { success: false, error: '无效的用户 ID' };
    }
    for (const whId of warehouseIds) {
      if (!validateUUID(whId)) {
        return { success: false, error: '无效的仓库 ID' };
      }
    }

    const dedupedIds = [...new Set(warehouseIds)];

    if (isIndependentPlatformRuntime()) {
      const identity = await requireAppDbIdentity();
      const targetRows = await queryAppRows<{
        id: string;
        is_active: boolean;
        role_name: string | null;
      }>(
        identity,
        `SELECT p.id::text AS id, p.is_active, r.name AS role_name
         FROM public.profiles p
         LEFT JOIN public.role r ON r.id = p.role_id
         WHERE p.id = $1::uuid LIMIT 1`,
        [userId],
      );
      const targetProfile = targetRows[0];
      if (!targetProfile) {
        return { success: false, error: '用户不存在' };
      }
      if (!targetProfile.is_active || targetProfile.role_name !== 'operator') {
        return { success: false, error: '只能为启用的操作员分配仓库' };
      }

      if (dedupedIds.length > 0) {
        const validWh = await queryAppRows<{ id: string }>(
          identity,
          `SELECT id::text AS id FROM public.warehouse
           WHERE type = 'overseas' AND is_active = true AND id = ANY($1::uuid[])`,
          [dedupedIds],
        );
        if (validWh.length !== dedupedIds.length) {
          return { success: false, error: '只能分配启用的海外仓库' };
        }
      }

      const rpcResult = await callAppRpc<{ success: boolean; error?: string } | null>(
        identity,
        'public.update_user_warehouses',
        [userId, dedupedIds.length > 0 ? dedupedIds : null],
      );
      if (!rpcResult) {
        return { success: false, error: '更新仓库分配失败，请稍后重试' };
      }
      return rpcResult;
    }

    const supabase = await createClient();
    const { data: targetProfile, error: targetErr } = await supabase
      .from('profiles')
      .select('id, is_active, role:role_id(name)')
      .eq('id', userId)
      .single();

    if (targetErr || !targetProfile) {
      return { success: false, error: '用户不存在' };
    }

    const targetRole = unwrapJoin<{ name: string }>(targetProfile.role);
    if (!targetRole || targetRole.name !== 'operator') {
      return { success: false, error: '只能为启用的操作员分配仓库' };
    }

    if (!targetProfile.is_active) {
      return { success: false, error: '只能为启用的操作员分配仓库' };
    }

    if (dedupedIds.length > 0) {
      const { data: validWh, error: whErr } = await supabase
        .from('warehouse')
        .select('id')
        .eq('type', 'overseas')
        .eq('is_active', true)
        .in('id', dedupedIds);

      if (whErr || !validWh) {
        return { success: false, error: '查询仓库信息失败，请稍后重试' };
      }

      if (validWh.length !== dedupedIds.length) {
        return { success: false, error: '只能分配启用的海外仓库' };
      }
    }

    const { data: rpcResult, error: rpcErr } = await supabase.rpc(
      'update_user_warehouses',
      {
        p_user_id: userId,
        p_warehouse_ids: dedupedIds.length > 0 ? dedupedIds : null,
      },
    );

    if (rpcErr) {
      return { success: false, error: '更新仓库分配失败，请稍后重试' };
    }

    const result = rpcResult as { success: boolean; error?: string } | null;
    if (!result) {
      return { success: false, error: '更新仓库分配失败，请稍后重试' };
    }

    return result;
  },

  /** 获取可分配的活跃海外仓库列表 */
  async getAssignableWarehouses(): Promise<AssignableWarehouse[]> {
    if (isIndependentPlatformRuntime()) {
      const identity = await requireAppDbIdentity();
      const rows = await queryAppRows<{ id: string; name: string; country: string }>(
        identity,
        `SELECT id::text AS id, name, country FROM public.warehouse
         WHERE type = 'overseas' AND is_active = true
         ORDER BY name ASC`,
      );
      return rows;
    }

    const supabase = await createClient();
    const { data } = await supabase
      .from('warehouse')
      .select('id, name, country')
      .eq('type', 'overseas')
      .eq('is_active', true)
      .order('name', { ascending: true });

    return (data ?? []).map((w) => ({
      id: w.id,
      name: w.name,
      country: w.country,
    }));
  },
};
