import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  CATALOG_ISSUES_HREF,
  ICE_V4_ACCOUNT_MENU_ENTRY_HREFS,
  ICE_V4_ACTIVE_NAV_HREFS,
  ICE_V4_DATA_MAINTENANCE_HREF,
  ICE_V4_EVIDENCE_HREF,
  ICE_V4_RETAINED_ENTRY_HREFS,
  LEGACY_PRODUCTS_LIST_HREF,
  LEGACY_ROUTE_DISPOSITION,
} from './navigation-config';

const ROOT = path.resolve(__dirname, '../..');
const WORKSPACE_SHELL = path.join(ROOT, 'ui/ice-v4/workspace-shell.tsx');
const INTAKE_PAGE = path.join(ROOT, 'app/dashboard/catalog/intake/page.tsx');
const SOURCES_PAGE = path.join(ROOT, 'app/dashboard/catalog/sources/page.tsx');
const ISSUES_PAGE = path.join(ROOT, 'app/dashboard/catalog/issues/page.tsx');

describe('ICE v4 导航合同（U7 / R9）', () => {
  const shellSrc = fs.readFileSync(WORKSPACE_SHELL, 'utf8');
  const navBlock = shellSrc.match(/const NAV: NavItem\[\] = \[([\s\S]*?)\n\];/)?.[1] ?? '';
  const sourcesSrc = fs.readFileSync(SOURCES_PAGE, 'utf8');
  const intakeSrc = fs.readFileSync(INTAKE_PAGE, 'utf8');

  it('一级常驻导航只有 ICE 商品库', () => {
    expect(ICE_V4_ACTIVE_NAV_HREFS).toEqual(['/dashboard/catalog']);
    expect(navBlock).toContain("href: '/dashboard/catalog'");
    for (const href of [
      '/dashboard/catalog/admin',
      '/dashboard/catalog/issues',
      '/dashboard/catalog/intake',
      '/dashboard/catalog/sources',
    ]) {
      expect(navBlock).not.toContain(`href: '${href}'`);
    }
    // 侧栏不再出现“其它处理入口 / 旧入口未启用”整块
    expect(shellSrc).not.toContain('SECONDARY_ENTRIES');
    expect(shellSrc).not.toContain('data-nav-secondary');
    expect(shellSrc).not.toContain('其它处理入口');
    // “旧入口”只允许出现在面包屑文案（pageLabel 的“（旧入口）”说明），不得作为侧栏入口/链接标签
    expect(shellSrc).not.toContain('旧入口未启用');
    expect(shellSrc).not.toContain('label: \'持续新品资料工作区\'');
    expect(shellSrc).not.toContain('label: \'来源身份与观测\'');
    expect(shellSrc).toContain('data-nav-primary="true"');
  });

  it('数据维护按管理员权限收进账户菜单，不是一级导航', () => {
    expect(ICE_V4_DATA_MAINTENANCE_HREF).toBe('/dashboard/catalog/admin');
    expect(ICE_V4_EVIDENCE_HREF).toBe('/dashboard/catalog/admin/evidence');
    expect(ICE_V4_ACCOUNT_MENU_ENTRY_HREFS).toEqual(['/dashboard/catalog/admin']);
    // 维护入口必须位于账户面板内、并在退出按钮之前
    expect(shellSrc).toContain('data-testid="ice-v4-account-menu"');
    expect(shellSrc).toContain('data-testid="ice-v4-maintenance-entry"');
    expect(shellSrc).toContain('href={ICE_V4_DATA_MAINTENANCE_HREF}');
    expect(shellSrc).not.toContain('ice-v4-evidence-entry');
    expect(shellSrc).not.toContain('ICE_V4_EVIDENCE_HREF');
    const accountPanelIndex = shellSrc.indexOf('data-testid="ice-v4-account-panel"');
    const maintenanceIndex = shellSrc.indexOf('data-testid="ice-v4-maintenance-entry"');
    const logoutIndex = shellSrc.indexOf('<LogoutButton');
    expect(accountPanelIndex).toBeGreaterThan(-1);
    expect(maintenanceIndex).toBeGreaterThan(accountPanelIndex);
    expect(logoutIndex).toBeGreaterThan(maintenanceIndex);
    // 单一事实源：常量来自 navigation-config，且仍以既有 roleName === 'admin' 作前端展示开关
    expect(shellSrc).toContain('ICE_V4_DATA_MAINTENANCE_HREF');
    expect(shellSrc).toContain("roleName === 'admin'");
    expect(shellSrc).toContain('isAdmin &&');
    expect(shellSrc).toContain('当前角色');
    // V5-05：账户区不再显示权限实现标识、技术说明或封存说明。
    for (const removed of ['amount:read', '原始权限标识', 'role.name', '受限原始证据', '已封存']) {
      expect(shellSrc).not.toContain(removed);
    }
  });

  it('旧入口退出全部常驻导航，但旧 URL 仍可达并有安全引导', () => {
    expect(ICE_V4_RETAINED_ENTRY_HREFS).toEqual([
      '/dashboard/catalog/intake',
      '/dashboard/catalog/sources',
    ]);
    for (const href of ICE_V4_RETAINED_ENTRY_HREFS) {
      expect(ICE_V4_ACTIVE_NAV_HREFS).not.toContain(href);
      expect(ICE_V4_ACCOUNT_MENU_ENTRY_HREFS).not.toContain(href);
      expect(shellSrc).not.toContain(`href: '${href}'`);
      expect(shellSrc).not.toContain(`href="${href}"`);
    }
    for (const file of [INTAKE_PAGE, SOURCES_PAGE]) {
      expect(fs.existsSync(file)).toBe(true);
      const src = fs.readFileSync(file, 'utf8');
      expect(src).toContain('LegacyEntryGuidance');
      expect(src).toContain("export const dynamic = 'force-dynamic'");
      expect(src).toContain('classifyCatalogReadFailure');
      expect(src).toContain('safeInternalReturnHref');
      expect(src).toMatch(/data\.enabled|view\.enabled/);
    }
  });

  it('旧入口启用态真实消费 item / record / observation / from（R8）', () => {
    expect(sourcesSrc).toContain('record');
    expect(sourcesSrc).toContain('getSourceIdentityWorkspace');
    expect(sourcesSrc).toContain('fromHref={returnHref}');
    expect(sourcesSrc).toContain('data-testid="identity-record-locate"');
    expect(sourcesSrc).toContain('getCatalogItemLabel');
    expect(intakeSrc).toContain('observation');
    expect(intakeSrc).toContain('getNewItemWorkspace(scopeId, observationId)');
    expect(intakeSrc).toContain('data-testid="intake-observation-locate"');
    expect(intakeSrc).toContain('getCatalogItemLabel');
  });

  it('待处理索引不是导航项，由列表工具栏与数据维护进入', () => {
    expect(CATALOG_ISSUES_HREF).toBe('/dashboard/catalog/issues');
    expect(fs.existsSync(ISSUES_PAGE)).toBe(true);
    expect(ICE_V4_ACTIVE_NAV_HREFS).not.toContain(CATALOG_ISSUES_HREF);
    expect(ICE_V4_ACCOUNT_MENU_ENTRY_HREFS).not.toContain(CATALOG_ISSUES_HREF);
    expect(shellSrc).not.toContain(`href="${CATALOG_ISSUES_HREF}"`);
    expect(fs.readFileSync(ISSUES_PAGE, 'utf8')).toContain('getCatalogIssueIndex');
  });

  it('workspace-shell 侧栏不含封存经营模块入口', () => {
    expect(shellSrc).not.toContain("href: '/dashboard/sync'");
    expect(shellSrc).not.toContain("href: '/dashboard/shipments'");
    expect(shellSrc).not.toContain('HideDashboardChrome');
    expect(shellSrc).not.toContain("href: '/dashboard/users'");
  });

  it('登记 legacy 入口处置表', () => {
    expect(LEGACY_ROUTE_DISPOSITION['/dashboard'].target).toBe('/dashboard/catalog');
    expect(LEGACY_PRODUCTS_LIST_HREF).toBe('/dashboard/products');
  });
});
