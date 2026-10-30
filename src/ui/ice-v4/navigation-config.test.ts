import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  CATALOG_ISSUES_HREF,
  ICE_V4_ACTIVE_NAV_HREFS,
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

  it('一级常驻导航只保留三个业务入口', () => {
    expect(ICE_V4_ACTIVE_NAV_HREFS).toEqual(['/dashboard/catalog', '/dashboard/inventory', '/dashboard/sync']);
    for (const href of ICE_V4_ACTIVE_NAV_HREFS) {
      expect(navBlock).toContain(`href: '${href}'`);
    }
    for (const href of [
      '/dashboard/catalog/admin',
      '/dashboard/catalog/issues',
      '/dashboard/catalog/intake',
      '/dashboard/catalog/sources',
    ]) {
      expect(navBlock).not.toContain(`href: '${href}'`);
    }
    expect(shellSrc).not.toContain('SECONDARY_ENTRIES');
    expect(shellSrc).not.toContain('data-nav-secondary');
    expect(shellSrc).not.toContain('其它处理入口');
    expect(shellSrc).not.toContain('旧入口未启用');
    expect(shellSrc).toContain('data-nav-primary="true"');
  });

  it('账户区不再出现数据维护等内部入口', () => {
    expect(shellSrc).not.toContain('ice-v4-maintenance-entry');
    expect(shellSrc).not.toContain('ICE_V4_DATA_MAINTENANCE_HREF');
    expect(shellSrc).not.toContain('ice-v4-account-menu');
    expect(shellSrc).not.toContain('accountPanel');
    expect(shellSrc).toContain('data-testid="ice-v4-account"');
    // 账户区只剩身份 + 退出，不再有下拉说明。
    for (const removed of ['amount:read', '原始权限标识', 'role.name', '受限原始证据', '已封存', '数据维护入口']) {
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

  it('待处理索引不是导航项，由列表工具栏进入', () => {
    expect(CATALOG_ISSUES_HREF).toBe('/dashboard/catalog/issues');
    expect(fs.existsSync(ISSUES_PAGE)).toBe(true);
    expect(ICE_V4_ACTIVE_NAV_HREFS).not.toContain(CATALOG_ISSUES_HREF);
    expect(shellSrc).not.toContain(`href="${CATALOG_ISSUES_HREF}"`);
    expect(fs.readFileSync(ISSUES_PAGE, 'utf8')).toContain('getCatalogIssueIndex');
  });

  it('workspace-shell 侧栏不含仍未开放的封存经营模块入口', () => {
    expect(shellSrc).not.toContain("href: '/dashboard/shipments'");
    expect(shellSrc).not.toContain('HideDashboardChrome');
    expect(shellSrc).not.toContain("href: '/dashboard/users'");
    expect(navBlock).toContain("href: '/dashboard/inventory'");
    expect(navBlock).toContain("href: '/dashboard/sync'");
  });

  it('登记 legacy 入口处置表（含本包三段旧库存地址的安全引导）', () => {
    expect(LEGACY_ROUTE_DISPOSITION['/dashboard'].target).toBe('/dashboard/catalog');
    expect(LEGACY_PRODUCTS_LIST_HREF).toBe('/dashboard/products');
    for (const href of ['/dashboard/inventory/domestic', '/dashboard/inventory/overseas', '/dashboard/inventory/in-transit']) {
      const disposition = LEGACY_ROUTE_DISPOSITION[href as keyof typeof LEGACY_ROUTE_DISPOSITION] as { action: string; target?: string };
      expect(disposition.action).toBe('guidance');
      expect(disposition.target).toBe('/dashboard/inventory');
    }
    expect(Object.keys(LEGACY_ROUTE_DISPOSITION)).not.toContain('/dashboard/sync');
  });
});
