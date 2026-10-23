import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  ICE_V4_ACTIVE_NAV_HREFS,
  LEGACY_ROUTE_DISPOSITION,
  LEGACY_PRODUCTS_LIST_HREF,
} from './navigation-config';

const ROOT = path.resolve(__dirname, '../..');
const WORKSPACE_SHELL = path.join(ROOT, 'ui/ice-v4/workspace-shell.tsx');

describe('ICE v4 active navigation contract', () => {
  it('现役白名单仅包含商品库相关入口', () => {
    expect(ICE_V4_ACTIVE_NAV_HREFS).toEqual([
      '/dashboard/catalog',
      '/dashboard/catalog/intake',
      '/dashboard/catalog/sources',
      '/dashboard/catalog/admin',
    ]);
  });

  it('workspace-shell 侧栏 href 与现役白名单一致', () => {
    const src = fs.readFileSync(WORKSPACE_SHELL, 'utf8');
    for (const href of ICE_V4_ACTIVE_NAV_HREFS) {
      expect(src).toContain(`href: '${href}'`);
    }
    expect(src).not.toContain('/dashboard/sync');
    expect(src).not.toContain('/dashboard/shipments');
    expect(src).not.toContain('HideDashboardChrome');
  });

  it('登记 legacy 入口处置表', () => {
    expect(LEGACY_ROUTE_DISPOSITION['/dashboard'].target).toBe('/dashboard/catalog');
    expect(LEGACY_PRODUCTS_LIST_HREF).toBe('/dashboard/products');
  });
});
