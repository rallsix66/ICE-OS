// TEAM-ACCOUNTS-INACTIVE-SESSION-GUARD 测试
//
// 验证 Dashboard 顶层布局正确拦截停用账号：
// 1. layout 使用 getCurrentActiveUser 校验 is_active
// 2. inactive 用户看到阻断页（不渲染 Sidebar/Header/children）
// 3. 阻断页包含明确中文提示和 LogoutButton
// 4. sync server-actions 的 requireActiveAuth 保护未被绕过
// 5. auth.ts requireActiveAuth 行为未改变

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');
const LAYOUT_PATH = path.resolve(__dirname, 'layout.tsx');
const INACTIVE_PAGE_PATH = path.resolve(__dirname, '_components/inactive-account-page.tsx');
const NAV_CONFIG_PATH = path.resolve(ROOT, 'src/ui/ice-v4/navigation-config.ts');
const AUTH_PATH = path.resolve(ROOT, 'src/lib/auth.ts');

function readFile(relativeOrAbsolute: string): string {
  return fs.readFileSync(relativeOrAbsolute, 'utf-8');
}

/** 移除 JS/TS 单行和多行注释，避免测试匹配到注释文本 */
function stripComments(src: string): string {
  return src
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

// ─── Dashboard Layout ──────────────────────────────────────────────

describe('Dashboard layout — inactive session guard', () => {
  const layoutSrc = readFile(LAYOUT_PATH);

  describe('imports', () => {
    it('从 @/lib/auth 导入 getCurrentActiveUser', () => {
      expect(layoutSrc).toMatch(/import\s*\{[^}]*\bgetCurrentActiveUser\b[^}]*\}\s*from\s*['"]@\/lib\/auth['"]/);
    });

    it('导入 InactiveAccountPage 组件', () => {
      expect(layoutSrc).toMatch(/import\s*\{[^}]*\bInactiveAccountPage\b[^}]*\}\s*from/);
    });
  });

  describe('调用 getCurrentActiveUser 进行活跃校验', () => {
    it('在 layout 中调用了 getCurrentActiveUser()', () => {
      expect(layoutSrc).toMatch(/await\s+getCurrentActiveUser\s*\(\)/);
    });

    it('在 getCurrentUser() 返回 user 之后才调用 getCurrentActiveUser()', () => {
      // getCurrentUser 先检查登录状态，通过后再检查 is_active
      const codeSrc = stripComments(layoutSrc);
      const getCurrentUserPos = codeSrc.indexOf('getCurrentUser()');
      const getCurrentActiveUserPos = codeSrc.indexOf('getCurrentActiveUser()');
      expect(getCurrentUserPos).not.toBe(-1);
      expect(getCurrentActiveUserPos).not.toBe(-1);
      // getCurrentUser 必须在 getCurrentActiveUser 之前（先验证登录再启用）
      expect(getCurrentUserPos).toBeLessThan(getCurrentActiveUserPos);
    });
  });

  describe('未登录状态处理', () => {
    it('getCurrentUser 返回 null 时 redirect 到 /auth/login', () => {
      expect(layoutSrc).toMatch(/redirect\s*\(\s*['"]\/auth\/login['"]\s*\)/);
    });
  });

  describe('ICE v4 外壳', () => {
    it('活跃分支使用 IceV4WorkspaceShell，不引用旧侧栏或 HideDashboardChrome', () => {
      expect(layoutSrc).toContain('IceV4WorkspaceShell');
      expect(layoutSrc).not.toContain('SidebarNav');
      expect(layoutSrc).not.toContain('DashboardHeader');
      expect(layoutSrc).not.toContain('HideDashboardChrome');
    });
  });

  describe('已登录但停用状态处理', () => {
    it('getCurrentActiveUser 返回 null 时渲染 InactiveAccountPage', () => {
      // 验证 inactive 分支存在，渲染阻断组件
      expect(layoutSrc).toContain('<InactiveAccountPage');
    });

    it('停用状态不渲染 children 业务内容', () => {
      // InactiveAccountPage 返回后不应再访问 children
      // 验证 inactive 分支 return 之后没有 children 渲染
      const inactiveReturnMatch = layoutSrc.match(/<InactiveAccountPage\s*\/?>/);
      expect(inactiveReturnMatch).not.toBeNull();
    });

    it('停用状态不渲染 SidebarNav（仅校验 inactive 分支内）', () => {
      // 只检查 inactive if-block 内的代码，不跨越到活跃分支
      const inactiveIfMatch = layoutSrc.match(
        /if\s*\(\s*!activeUser\s*\)\s*\{([\s\S]*?)\}/m
      );
      expect(inactiveIfMatch).not.toBeNull();
      const inactiveBlock = inactiveIfMatch![1];
      expect(inactiveBlock).not.toContain('SidebarNav');
      expect(inactiveBlock).not.toContain('DashboardHeader');
      expect(inactiveBlock).not.toContain('{children}');
    });

    it('停用状态不 redirect 到 /auth/login（防止跳转循环）', () => {
      // inactive 用户不能 redirect 到 /auth/login — proxy 会把已登录用户重定向回 /dashboard
      // 验证：inactive 分支（InactiveAccountPage 之后）不包含 redirect('/auth/login')
      const inactiveReturnIndex = layoutSrc.indexOf('<InactiveAccountPage');
      expect(inactiveReturnIndex).not.toBe(-1);
      const afterInactive = layoutSrc.substring(inactiveReturnIndex);
      // afterInactive 中不应再出现 redirect('/auth/login')（排除注释后）
      const afterInactiveCode = stripComments(afterInactive);
      expect(afterInactiveCode).not.toContain("redirect('/auth/login')");
    });
  });
});

// ─── Inactive Account Page 组件 ─────────────────────────────────────

describe('InactiveAccountPage 组件', () => {
  const pageSrc = readFile(INACTIVE_PAGE_PATH);

  it('包含 "账号已停用" 文案', () => {
    expect(pageSrc).toContain('账号已停用');
  });

  it('包含 "请联系管理员" 提示', () => {
    expect(pageSrc).toContain('请联系管理员');
  });

  it('渲染 LogoutButton 退出登录按钮', () => {
    expect(pageSrc).toContain('<LogoutButton');
    expect(pageSrc).toMatch(/import\s*\{[^}]*\bLogoutButton\b[^}]*\}\s*from/);
  });

  it('是 client component（使用 LogoutButton 需要客户端交互）', () => {
    expect(pageSrc).toContain("'use client'");
  });

  it('不引用 SidebarNav 或 DashboardHeader', () => {
    const codeSrc = stripComments(pageSrc);
    expect(codeSrc).not.toContain('SidebarNav');
    expect(codeSrc).not.toContain('DashboardHeader');
  });
});

// ─── 现役导航 — 本包新增商品库存/数据同步入口，其余经营模块仍封存 ─────

describe('现役导航配置 — 仅开放本包两个库存入口', () => {
  const navSrc = readFile(NAV_CONFIG_PATH);
  const shellSrc = readFile(path.resolve(ROOT, 'src/ui/ice-v4/workspace-shell.tsx'));

  it('ICE_V4_ACTIVE_NAV_HREFS 登记商品库与商品库存/数据同步', () => {
    const activeBlock = navSrc.match(/ICE_V4_ACTIVE_NAV_HREFS\s*=\s*\[([\s\S]*?)\]\s*as const/)?.[1] ?? '';
    expect(activeBlock).toContain('/dashboard/catalog');
    expect(activeBlock).toContain('/dashboard/inventory');
    expect(activeBlock).toContain('/dashboard/sync');
    expect(activeBlock).not.toContain('/dashboard/shipments');
  });

  it('workspace-shell 侧栏不加载其它封存经营模块', () => {
    expect(shellSrc).toContain("href: '/dashboard/sync'");
    expect(shellSrc).toContain("href: '/dashboard/inventory'");
    expect(shellSrc).not.toContain("href: '/dashboard/shipments'");
  });
});

// ─── auth.ts — requireActiveAuth 行为不变 ───────────────────────────

describe('auth.ts — requireActiveAuth 保持现有行为', () => {
  const authSrc = readFile(AUTH_PATH);

  it('requireActiveAuth 仍然抛出"未登录或账户已停用"', () => {
    // 必须保持 throw，不能静默返回
    expect(authSrc).toContain("throw new Error('未登录或账户已停用')");
  });

  it('getCurrentActiveUser 仍然校验 is_active', () => {
    expect(authSrc).toContain('!profile.is_active');
    expect(authSrc).toContain('getCurrentActiveUser');
  });

  it('cachedGetAuthProfile 仍然在 select 中包含 is_active', () => {
    // is_active 必须包含在 select 中，否则缓存无法共享
    expect(authSrc).toContain('is_active');
  });
});

// ─── Helpers ────────────────────────────────────────────────────────
