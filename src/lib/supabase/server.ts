// 遗留 Supabase 服务端客户端 — P0-02 隔离运行时禁用（Repository 使用 app-db）
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import type { Database } from '@/types/database';

import { loadP002Config } from '@/lib/independent-platform/p0-02-config';

function rejectIndependentPlatformClient(): never {
  throw new Error(
    'P0-02 独立平台已启用：禁止 createClient/createServiceClient；请使用 Feature Repository 的参数化 SQL 实现',
  );
}

export async function createClient() {
  if (loadP002Config()) {
    rejectIndependentPlatformClient();
  }

  const cookieStore = await cookies();

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Server Component 中不能设置 cookie
          }
        },
      },
    },
  );
}

export async function createServiceClient() {
  if (typeof window !== 'undefined') {
    throw new Error('createServiceClient 禁止在浏览器端调用');
  }

  if (loadP002Config()) {
    rejectIndependentPlatformClient();
  }

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      cookies: {
        getAll() {
          return [];
        },
        setAll() {},
      },
    },
  );
}
