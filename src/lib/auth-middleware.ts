import { NextResponse, type NextRequest } from 'next/server';

// 路由会话守卫 —— 只使用 Better Auth 的 P0-02 session 探针，不再回退旧认证。
async function hasValidSession(request: NextRequest): Promise<boolean> {
  const probeUrl = new URL('/api/p0-02/session', request.url);
  try {
    const response = await fetch(probeUrl, {
      method: 'GET',
      headers: {
        cookie: request.headers.get('cookie') ?? '',
      },
      cache: 'no-store',
    });
    return response.status === 204;
  } catch {
    return false;
  }
}

export async function updateSession(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const authenticated = await hasValidSession(request);

  if (authenticated && pathname === '/auth/login') {
    return NextResponse.redirect(new URL('/dashboard', request.url));
  }
  if (!authenticated && pathname.startsWith('/dashboard')) {
    const loginUrl = new URL('/auth/login', request.url);
    loginUrl.searchParams.set('redirect', pathname);
    return NextResponse.redirect(loginUrl);
  }
  return NextResponse.next({ request });
}
