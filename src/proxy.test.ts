import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '..');

function readSrcFile(relativePath: string): string {
  return readFileSync(resolve(ROOT, relativePath), 'utf-8');
}

describe('NEXTJS16-PROXY-MIGRATION', () => {
  describe('文件存在性', () => {
    it('src/proxy.ts 存在', () => {
      expect(existsSync(resolve(ROOT, 'src/proxy.ts'))).toBe(true);
    });

    it('src/middleware.ts 已删除', () => {
      expect(existsSync(resolve(ROOT, 'src/middleware.ts'))).toBe(false);
    });
  });

  describe('proxy.ts 导出', () => {
    const content = readSrcFile('src/proxy.ts');

    it('导出名为 proxy 的函数（非 middleware）', () => {
      expect(content).toMatch(/export\s+async\s+function\s+proxy\s*\(/);
      expect(content).not.toMatch(/export\s+(async\s+)?function\s+middleware\s*\(/);
    });

    it('导出 config 对象', () => {
      expect(content).toMatch(/export\s+const\s+config\s*=/);
    });
  });

  describe('matcher 配置', () => {
    const content = readSrcFile('src/proxy.ts');

    it('matcher 有且仅有 /dashboard/:path* 与 /auth/login', () => {
      const matcherMatch = content.match(/matcher:\s*\[([^\]]+)\]/);
      expect(matcherMatch).not.toBeNull();
      const pathStrings = (matcherMatch![1].match(/'[^']*'/g) ?? []).map((value) => value.slice(1, -1));
      expect(pathStrings).toHaveLength(2);
      expect(pathStrings).toContain('/dashboard/:path*');
      expect(pathStrings).toContain('/auth/login');
    });
  });

  describe('认证保护逻辑', () => {
    const proxyContent = readSrcFile('src/proxy.ts');

    it('使用 Better Auth 会话守卫（本地 PostgreSQL），不再引用 Supabase', () => {
      expect(proxyContent).toMatch(/from\s+['"]@\/lib\/auth-middleware['"]/);
      expect(proxyContent).not.toMatch(/supabase/i);
    });

    it('proxy 函数体内调用 updateSession(request)', () => {
      expect(proxyContent).toMatch(/return\s+updateSession\s*\(\s*request\s*\)/);
    });
  });

  describe('会话守卫实现', () => {
    const middleware = readSrcFile('src/lib/auth-middleware.ts');

    it('通过 /api/p0-02/session 探针校验会话', () => {
      expect(middleware).toMatch(/\/api\/p0-02\/session/);
      expect(middleware).toMatch(/response\.status\s*===\s*204/);
    });

    it('未登录访问 /dashboard/* → 重定向 /auth/login', () => {
      expect(middleware).toMatch(/!authenticated\s*&&\s*pathname\.startsWith\(\s*['"]\/dashboard['"]\s*\)/);
      expect(middleware).toMatch(/\/auth\/login/);
    });

    it('已登录访问 /auth/login → 重定向 /dashboard', () => {
      expect(middleware).toMatch(/authenticated\s*&&\s*pathname\s*===\s*['"]\/auth\/login['"]/);
      expect(middleware).toMatch(/new URL\(\s*['"]\/dashboard['"]\s*,\s*request\.url\s*\)/);
    });

    it('不包含 Supabase 客户端或 cookie 刷新逻辑', () => {
      expect(middleware).not.toMatch(/supabase|createServerClient|createClient/i);
    });
  });

  describe('旧认证入口清理', () => {
    it('Supabase 服务端客户端目录已删除', () => {
      expect(existsSync(resolve(ROOT, 'src/lib/supabase'))).toBe(false);
    });

    it('旧 auth/callback 路由已删除', () => {
      expect(existsSync(resolve(ROOT, 'src/app/auth/callback'))).toBe(false);
    });
  });
});
