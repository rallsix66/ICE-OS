// Next.js Proxy — 路由守卫
// 所有 /dashboard/* 请求需登录，/auth/login 已登录用户自动跳转
import { updateSession } from '@/lib/auth-middleware';
import type { NextRequest } from 'next/server';

export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: ['/dashboard/:path*', '/auth/login'],
};
