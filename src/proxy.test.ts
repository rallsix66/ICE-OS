import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '..');

function readSrcFile(relativePath: string): string {
  return readFileSync(resolve(ROOT, relativePath), 'utf-8');
}

describe('NEXTJS16-PROXY-MIGRATION', () => {
  // ── 文件存在性 ──

  describe('文件存在性', () => {
    it('src/proxy.ts 存在', () => {
      expect(existsSync(resolve(ROOT, 'src/proxy.ts'))).toBe(true);
    });

    it('src/middleware.ts 已删除', () => {
      expect(existsSync(resolve(ROOT, 'src/middleware.ts'))).toBe(false);
    });
  });

  // ── proxy.ts 导出 ──

  describe('proxy.ts 导出', () => {
    const content = readSrcFile('src/proxy.ts');

    it('导出名为 proxy 的函数（非 middleware）', () => {
      expect(content).toMatch(/export\s+async\s+function\s+proxy\s*\(/);
      // 不应该再出现 export function middleware
      expect(content).not.toMatch(/export\s+(async\s+)?function\s+middleware\s*\(/);
    });

    it('导出 config 对象', () => {
      expect(content).toMatch(/export\s+const\s+config\s*=/);
    });

    it('使用 named export（非 default）', () => {
      // proxy 函数: export async function proxy
      // config: export const config
      expect(content).toMatch(/export\s+async\s+function\s+proxy/);
    });
  });

  // ── matcher 配置 ──

  describe('matcher 配置', () => {
    const content = readSrcFile('src/proxy.ts');

    it('matcher 包含 /dashboard/:path*', () => {
      expect(content).toMatch(/'\/dashboard\/:path\*'/);
    });

    it('matcher 包含 /auth/login', () => {
      expect(content).toMatch(/'\/auth\/login'/);
    });

    it('matcher 是数组', () => {
      expect(content).toMatch(/matcher:\s*\[/);
    });

    it('matcher 有且仅有 2 个路径', () => {
      // 提取 matcher 数组内的路径字符串
      const matcherMatch = content.match(/matcher:\s*\[([^\]]+)\]/);
      expect(matcherMatch).not.toBeNull();
      const insideBrackets = matcherMatch![1];
      const pathStrings = insideBrackets.match(/'[^']*'/g) ?? [];
      expect(pathStrings).toHaveLength(2);
    });
  });

  // ── 认证保护逻辑 ──

  describe('认证保护逻辑', () => {
    const proxyContent = readSrcFile('src/proxy.ts');

    it('import updateSession from @/lib/supabase/middleware', () => {
      expect(proxyContent).toMatch(
        /import\s+\{\s*updateSession\s*\}\s+from\s+['"]@\/lib\/supabase\/middleware['"]/
      );
    });

    it('proxy 函数体内调用 updateSession(request)', () => {
      expect(proxyContent).toMatch(/return\s+updateSession\s*\(\s*request\s*\)/);
    });

    it('proxy 函数签名接收 NextRequest 参数', () => {
      expect(proxyContent).toMatch(/proxy\s*\(\s*request\s*:\s*NextRequest\s*\)/);
    });
  });

  // ── updateSession 逻辑未变 ──

  describe('updateSession 逻辑完整性', () => {
    const updateSessionContent = readSrcFile('src/lib/supabase/middleware.ts');

    it('仍包含 supabase.auth.getUser() session 刷新', () => {
      expect(updateSessionContent).toMatch(/supabase\.auth\.getUser\(\)/);
    });

    it('未登录 /dashboard/* → 重定向 /auth/login', () => {
      expect(updateSessionContent).toMatch(/!user\s*&&\s*pathname\.startsWith\s*\(\s*['"]\/dashboard['"]\s*\)/);
      // 紧接着应该 redirect 到 /auth/login
      expect(updateSessionContent).toMatch(/\/auth\/login/);
    });

    it('已登录 /auth/login → 重定向 /dashboard', () => {
      expect(updateSessionContent).toMatch(/user\s*&&\s*pathname\s*===\s*['"]\/auth\/login['"]/);
      // 紧接着应该 redirect 到 /dashboard
      expect(updateSessionContent).toMatch(/URL\s*\(\s*['"]\/dashboard['"]\s*,\s*request\.url\s*\)/);
    });

    it('cookie session 刷新逻辑未丢失', () => {
      // createServerClient 调用必须包含 cookies.getAll / cookies.setAll
      expect(updateSessionContent).toMatch(/getAll\(\)\s*\{/);
      expect(updateSessionContent).toMatch(/setAll\s*\(\s*cookiesToSet\s*\)\s*\{/);
    });

    it('注释已更新为 proxy.ts', () => {
      expect(updateSessionContent).toMatch(/路由会话守卫|P0-02|proxy/);
    });
  });

  // ── server.ts 注释更新 ──

  describe('server.ts 注释更新', () => {
    const serverContent = readSrcFile('src/lib/supabase/server.ts');

    it('注释已从 middleware 更新为 proxy', () => {
      expect(serverContent).toMatch(/P0-02|独立平台|Repository 使用 app-db/);
      expect(serverContent).not.toMatch(/在 middleware 或 route handler 中处理/);
    });
  });

  // ── 架构合规 ──

  describe('架构合规', () => {
    const proxyContent = readSrcFile('src/proxy.ts');

    it('proxy.ts 未直接调用 supabase（通过 updateSession）', () => {
      // proxy.ts 本身不应直接 import createServerClient 或 supabase
      expect(proxyContent).not.toMatch(/createServerClient/);
      expect(proxyContent).not.toMatch(/createClient/);
    });

    it('proxy.ts 不导入 service_role', () => {
      expect(proxyContent).not.toMatch(/service_role/);
    });

    it('proxy.ts 不修改数据库 / Migration / RLS', () => {
      expect(proxyContent).not.toMatch(/Migration/);
      expect(proxyContent).not.toMatch(/RLS/);
      expect(proxyContent).not.toMatch(/\.from\(/);
      expect(proxyContent).not.toMatch(/\.rpc\(/);
    });
  });
});
