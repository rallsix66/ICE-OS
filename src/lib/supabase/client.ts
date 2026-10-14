// 浏览器端认证客户端 — P0-02 Better Auth 或遗留 Supabase
import { createBrowserClient } from '@supabase/ssr';
import type { Database } from '@/types/database';

type AuthError = { message: string };

function independentBrowserClient() {
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
            // ignore
          }
          return { error: { message } as AuthError, data: { user: null, session: null } };
        }
        return { error: null, data: { user: {}, session: {} } };
      },
      async signOut() {
        await fetch('/api/auth/sign-out', { method: 'POST', credentials: 'include' });
        return { error: null };
      },
    },
  };
}

export function createClient() {
  if (process.env.NEXT_PUBLIC_ICE_USE_BETTER_AUTH === 'true') {
    return independentBrowserClient();
  }

  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
