// 用户模块数据访问层 — 封装 profiles + role + email 查询
// legacy: email 来自 Supabase auth.admin；P0-02: auth.users 镜像表
import { callAppRpc, queryAppRows } from '@/lib/database/app-db';
import { requireAppDbIdentity } from '@/lib/database/app-identity';
import { isIndependentPlatformRuntime } from '@/lib/database/runtime';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { unwrapJoin } from '@/lib/supabase/helpers';
import { UserError } from './types';
import type { UserItem, UserListFilters } from './types';
import type { PaginatedResult } from '@/types/common';

const PAGE_SIZE = 20;

// ─── 内部 helper ─────────────────────────────────────────────

async function fetchEmailMapIndependent(
  identity: { profileUserId: string },
  userIds: string[],
): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();
  const raw = await callAppRpc<unknown>(
    identity,
    'public.get_profile_emails_for_active_admin',
    [userIds],
  );
  const rows = (Array.isArray(raw) ? raw : JSON.parse(String(raw))) as Array<{
    id: string;
    email: string | null;
  }>;
  const map = new Map<string, string>();
  for (const row of rows) {
    if (row.email) map.set(String(row.id), row.email);
  }
  return map;
}

async function fetchUserEmailIndependent(
  identity: { profileUserId: string },
  userId: string,
): Promise<string> {
  const email = await callAppRpc<string>(
    identity,
    'public.get_profile_email_for_active_admin',
    [userId],
  );
  return email ?? '';
}

/** 通过 service_role admin API 批量获取 email 映射 */
async function fetchEmailMap(userIds: string[]): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();

  const serviceClient = await createServiceClient();
  const map = new Map<string, string>();

  // auth.admin.listUsers() 默认每页 50，最多 500。循环拉取直到覆盖全部 id。
  let page = 1;
  const perPage = 500; // 单次最大
  const targetIds = new Set(userIds);
  const found = new Set<string>();

  while (found.size < targetIds.size && page <= 10) {
    const { data, error } = await serviceClient.auth.admin.listUsers({
      page,
      perPage,
    });

    if (error) {
      throw new UserError('DB_ERROR', '获取用户邮箱失败，请稍后重试');
    }
    if (!data?.users) break; // 无更多用户，正常结束

    for (const u of data.users) {
      if (targetIds.has(u.id) && u.email) {
        map.set(u.id, u.email);
        found.add(u.id);
      }
    }

    if (data.users.length < perPage) break; // 最后一页
    page++;
  }

  return map;
}

/** 通过 service_role admin API 获取单个用户 email */
async function fetchUserEmail(userId: string): Promise<string> {
  const serviceClient = await createServiceClient();
  const { data, error } = await serviceClient.auth.admin.getUserById(userId);

  if (error) {
    throw new UserError('DB_ERROR', '获取用户邮箱失败，请稍后重试');
  }
  // auth user 不存在时 data.user 为空，返回空字符串
  if (!data?.user?.email) return '';
  return data.user.email;
}

// ─── Repository ──────────────────────────────────────────────

export const userRepository = {
  /** 分页列表（profiles + role join + auth.users email） */
  async list(filters: UserListFilters = {}): Promise<PaginatedResult<UserItem>> {
    const { roleId, isActive, page = 1, pageSize = PAGE_SIZE } = filters;

    if (isIndependentPlatformRuntime()) {
      const identity = await requireAppDbIdentity();
      const params: unknown[] = [];
      const where: string[] = ['1=1'];
      if (roleId) {
        params.push(roleId);
        where.push(`p.role_id = $${params.length}::uuid`);
      }
      if (isActive !== undefined) {
        params.push(isActive);
        where.push(`p.is_active = $${params.length}`);
      }
      const countRows = await queryAppRows<{ count: string }>(
        identity,
        `SELECT COUNT(*)::text AS count FROM public.profiles p WHERE ${where.join(' AND ')}`,
        params,
      );
      const total = Number(countRows[0]?.count ?? 0);
      const offset = (page - 1) * pageSize;
      params.push(pageSize, offset);
      const rows = await queryAppRows<{
        id: string;
        display_name: string;
        is_active: boolean;
        created_at: string;
        role_id: string;
        role_name: string;
      }>(
        identity,
        `SELECT p.id::text AS id, p.display_name, p.is_active, p.created_at,
                r.id::text AS role_id, r.name AS role_name
         FROM public.profiles p
         JOIN public.role r ON r.id = p.role_id
         WHERE ${where.join(' AND ')}
         ORDER BY p.created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      if (rows.length === 0) {
        return { data: [], total, page, pageSize };
      }
      const emailMap = await fetchEmailMapIndependent(
        identity,
        rows.map((r) => r.id),
      );
      return {
        data: rows.map((row) => ({
          id: row.id,
          email: emailMap.get(row.id) ?? '',
          displayName: row.display_name,
          roleId: row.role_id,
          roleName: row.role_name,
          isActive: row.is_active,
          createdAt: row.created_at,
        })),
        total,
        page,
        pageSize,
      };
    }

    const supabase = await createClient();
    let query = supabase.from('profiles').select(
      `id, display_name, is_active, created_at, role:role_id (id, name)`,
      { count: 'exact' },
    );

    if (roleId) query = query.eq('role_id', roleId);
    if (isActive !== undefined) query = query.eq('is_active', isActive);

    const from = (page - 1) * pageSize;
    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .range(from, from + pageSize - 1);

    if (error) {
      throw new UserError('DB_ERROR', '查询用户列表失败，请稍后重试');
    }

    if (!data || data.length === 0) {
      return { data: [], total: count ?? 0, page, pageSize };
    }

    const userIds = data.map((r) => r.id);
    const emailMap = await fetchEmailMap(userIds);

    return {
      data: data.map((row) => {
        const role = unwrapJoin<{ id: string; name: string }>(row.role);
        return {
          id: row.id,
          email: emailMap.get(row.id) ?? '',
          displayName: row.display_name,
          roleId: role?.id ?? '',
          roleName: role?.name ?? 'operator',
          isActive: row.is_active,
          createdAt: row.created_at,
        };
      }),
      total: count ?? 0,
      page,
      pageSize,
    };
  },

  /** 获取单个用户 */
  async getById(id: string): Promise<UserItem | null> {
    if (isIndependentPlatformRuntime()) {
      const identity = await requireAppDbIdentity();
      const rows = await queryAppRows<{
        id: string;
        display_name: string;
        is_active: boolean;
        created_at: string;
        role_id: string;
        role_name: string;
      }>(
        identity,
        `SELECT p.id::text AS id, p.display_name, p.is_active, p.created_at,
                r.id::text AS role_id, r.name AS role_name
         FROM public.profiles p
         JOIN public.role r ON r.id = p.role_id
         WHERE p.id = $1::uuid
         LIMIT 1`,
        [id],
      );
      const row = rows[0];
      if (!row) return null;
      const email = await fetchUserEmailIndependent(identity, id);
      return {
        id: row.id,
        email,
        displayName: row.display_name,
        roleId: row.role_id,
        roleName: row.role_name,
        isActive: row.is_active,
        createdAt: row.created_at,
      };
    }

    const supabase = await createClient();
    const { data, error } = await supabase
      .from('profiles')
      .select(`id, display_name, is_active, created_at, role:role_id (id, name)`)
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      throw new UserError('DB_ERROR', '查询用户信息失败，请稍后重试');
    }

    if (!data) return null;

    const role = unwrapJoin<{ id: string; name: string }>(data.role);
    const email = await fetchUserEmail(id);

    return {
      id: data.id,
      email,
      displayName: data.display_name,
      roleId: role?.id ?? '',
      roleName: role?.name ?? 'operator',
      isActive: data.is_active,
      createdAt: data.created_at,
    };
  },

  /** 查询角色名（按 roleId） */
  async getRoleName(roleId: string): Promise<string | null> {
    if (isIndependentPlatformRuntime()) {
      const identity = await requireAppDbIdentity();
      const rows = await queryAppRows<{ name: string }>(
        identity,
        `SELECT name FROM public.role WHERE id = $1::uuid LIMIT 1`,
        [roleId],
      );
      return rows[0]?.name ?? null;
    }

    const supabase = await createClient();
    const { data, error } = await supabase
      .from('role')
      .select('name')
      .eq('id', roleId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      throw new UserError('DB_ERROR', '查询角色信息失败，请稍后重试');
    }
    return data?.name ?? null;
  },

  /** 统计拥有指定角色名的活跃用户数（先查 roleId，再 count profiles） */
  async countByRole(roleName: string): Promise<number> {
    if (isIndependentPlatformRuntime()) {
      const identity = await requireAppDbIdentity();
      const rows = await queryAppRows<{ count: string }>(
        identity,
        `SELECT COUNT(*)::text AS count
         FROM public.profiles p
         JOIN public.role r ON r.id = p.role_id
         WHERE r.name = $1 AND p.is_active = true`,
        [roleName],
      );
      return Number(rows[0]?.count ?? 0);
    }

    const supabase = await createClient();
    const { data: roleData, error: roleError } = await supabase
      .from('role')
      .select('id')
      .eq('name', roleName)
      .single();

    if (roleError) {
      if (roleError.code === 'PGRST116') return 0;
      throw new UserError('DB_ERROR', '查询角色统计失败，请稍后重试');
    }

    const { count, error } = await supabase
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('role_id', roleData.id)
      .eq('is_active', true);

    if (error) {
      throw new UserError('DB_ERROR', '查询角色统计失败，请稍后重试');
    }

    return count ?? 0;
  },

  /** 切换用户角色（通过原子 RPC 保护，消除 TOCTOU 竞态） */
  async updateRole(userId: string, roleId: string, operatorId: string): Promise<void> {
    if (isIndependentPlatformRuntime()) {
      try {
        await callAppRpc(
          { profileUserId: operatorId },
          'public.update_user_role_protected',
          [userId, roleId, operatorId],
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : '更新角色失败，请稍后重试';
        throw new UserError('DB_ERROR', message);
      }
      return;
    }

    const supabase = await createClient();
    const { error } = await supabase.rpc('update_user_role_protected', {
      p_target_user_id: userId,
      p_new_role_id: roleId,
      p_operator_user_id: operatorId,
    });

    if (error) {
      throw new UserError('DB_ERROR', error.message || '更新角色失败，请稍后重试');
    }
  },

  /** 启用/禁用用户（通过原子 RPC 保护，消除 TOCTOU 竞态） */
  async toggleActive(userId: string, isActive: boolean, operatorId: string): Promise<void> {
    if (isIndependentPlatformRuntime()) {
      try {
        await callAppRpc(
          { profileUserId: operatorId },
          'public.toggle_user_active_protected',
          [userId, isActive, operatorId],
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : '操作失败，请稍后重试';
        throw new UserError('DB_ERROR', message);
      }
      return;
    }

    const supabase = await createClient();
    const { error } = await supabase.rpc('toggle_user_active_protected', {
      p_target_user_id: userId,
      p_is_active: isActive,
      p_operator_user_id: operatorId,
    });

    if (error) {
      throw new UserError('DB_ERROR', error.message || '操作失败，请稍后重试');
    }
  },

  /** 列出所有角色（供筛选下拉使用） */
  async listRoles(): Promise<{ id: string; name: string }[]> {
    if (isIndependentPlatformRuntime()) {
      const identity = await requireAppDbIdentity();
      return queryAppRows<{ id: string; name: string }>(
        identity,
        `SELECT id::text AS id, name FROM public.role ORDER BY name`,
      );
    }

    const supabase = await createClient();
    const { data, error } = await supabase
      .from('role')
      .select('id, name')
      .order('name');

    if (error) {
      throw new UserError('DB_ERROR', '查询角色列表失败，请稍后重试');
    }

    return data ?? [];
  },
};
