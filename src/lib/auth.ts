// 服务端认证工具 — 获取当前用户、角色、权限校验
import { cache } from 'react';
import { createClient } from '@/lib/supabase/server';
import { unwrapJoin } from '@/lib/supabase/helpers';
import { isIndependentPlatformRuntime } from '@/lib/database/runtime';
import { withAppDb } from '@/lib/database/app-db';
import { getP002AuthSessionUser, getP002ProfileUserId } from '@/lib/independent-platform/p0-02-session';

export interface CurrentUser {
  id: string;
  email: string | undefined;
  displayName: string;
  roleName: string;
}

interface CachedAuthProfile {
  authUser: { id: string; email?: string } | null;
  profile: { display_name: string | null; is_active: boolean; role: unknown } | null;
  profileError: string | null;
}

async function loadProfileForUser(profileUserId: string): Promise<{
  profile: CachedAuthProfile['profile'];
  profileError: string | null;
}> {
  return withAppDb({ profileUserId }, async (client) => {
    const result = await client.query<{
      display_name: string;
      is_active: boolean;
      role_name: string | null;
    }>(
      `SELECT p.display_name, p.is_active, r.name AS role_name
       FROM profiles p
       JOIN role r ON r.id = p.role_id
       WHERE p.id = $1
       LIMIT 1`,
      [profileUserId],
    );
    if (result.rowCount === 0) {
      return { profile: null, profileError: null };
    }
    const row = result.rows[0]!;
    return {
      profile: {
        display_name: row.display_name,
        is_active: row.is_active,
        role: { name: row.role_name ?? 'operator' },
      },
      profileError: null,
    };
  });
}

const cachedGetAuthProfile = cache(async (): Promise<CachedAuthProfile> => {
  if (isIndependentPlatformRuntime()) {
    const sessionUser = await getP002AuthSessionUser();
    if (!sessionUser) {
      return { authUser: null, profile: null, profileError: null };
    }
    const profileUserId = await getP002ProfileUserId();
    if (!profileUserId) {
      return { authUser: null, profile: null, profileError: null };
    }
    try {
      const { profile, profileError } = await loadProfileForUser(profileUserId);
      return {
        authUser: { id: profileUserId, email: sessionUser.email },
        profile,
        profileError,
      };
    } catch {
      return {
        authUser: { id: profileUserId, email: sessionUser.email },
        profile: null,
        profileError: '数据库错误：无法获取用户资料',
      };
    }
  }

  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    return { authUser: null, profile: null, profileError: null };
  }

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('display_name, is_active, role:role_id (name)')
    .eq('id', user.id)
    .single();

  if (profileError && profileError.code !== 'PGRST116') {
    return {
      authUser: { id: user.id, email: user.email },
      profile: null,
      profileError: '数据库错误：无法获取用户资料',
    };
  }

  return {
    authUser: { id: user.id, email: user.email },
    profile: profile as CachedAuthProfile['profile'] | null,
    profileError: null,
  };
});

export async function getCurrentUser(): Promise<CurrentUser | null> {
  const { authUser, profile } = await cachedGetAuthProfile();
  if (!authUser) return null;

  const role = unwrapJoin<{ name: string }>(profile?.role);
  const roleName = role?.name ?? 'operator';

  return {
    id: authUser.id,
    email: authUser.email,
    displayName: profile?.display_name ?? authUser.email?.split('@')[0] ?? '用户',
    roleName,
  };
}

export async function requireAdmin(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) throw new Error('未登录');
  if (user.roleName !== 'admin') throw new Error('无权限：需要管理员角色');
  return user;
}

export async function requireAuth(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) throw new Error('未登录');
  return user;
}

export interface CurrentActiveUser extends CurrentUser {
  isActive: true;
}

export async function getCurrentActiveUser(): Promise<CurrentActiveUser | null> {
  const { authUser, profile, profileError } = await cachedGetAuthProfile();
  if (!authUser) return null;

  if (profileError) throw new Error(profileError);

  if (!profile || !profile.is_active) return null;

  const role = unwrapJoin<{ name: string }>(profile.role);
  const roleName = role?.name ?? 'operator';

  return {
    id: authUser.id,
    email: authUser.email,
    displayName: profile.display_name ?? authUser.email?.split('@')[0] ?? '用户',
    roleName,
    isActive: true,
  };
}

export async function requireActiveAuth(): Promise<CurrentActiveUser> {
  const user = await getCurrentActiveUser();
  if (!user) throw new Error('未登录或账户已停用');
  return user;
}

export async function requireActiveAdmin(): Promise<CurrentActiveUser> {
  const user = await getCurrentActiveUser();
  if (!user) throw new Error('未登录或账户已停用');
  if (user.roleName !== 'admin') throw new Error('无权限：需要管理员角色');
  return user;
}
