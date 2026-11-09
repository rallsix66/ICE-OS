'use client';

// Better Auth 浏览器端认证客户端 —— 仅使用本地 PostgreSQL 上的 Better Auth。
// 旧 Supabase 登录回退已移除；认证统一走 /api/auth/*。

type AuthError = { message: string };

export function createClient() {
  return {
    auth: {
      async signInWithPassword(credentials: { email: string; password: string }) {
        const response = await fetch('/api/auth/sign-in/email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(credentials),
        });
        if (!response.ok) {
          let message = '登录失败';
          try {
            const body = (await response.json()) as { message?: string; error?: string };
            message = body.message ?? body.error ?? message;
          } catch {
            // ignore non-JSON error bodies
          }
          return { error: { message } as AuthError, data: { user: null, session: null } };
        }
        return { error: null, data: { user: {}, session: {} } };
      },
      async signOut() {
        // Better Auth 的 sign-out 需要 JSON 请求体，空 POST 会返回 415。
        const response = await fetch('/api/auth/sign-out', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          cache: 'no-store',
          body: '{}',
        });
        if (!response.ok) return { error: { message: '退出登录失败' } as AuthError };
        return { error: null };
      },
    },
  };
}
