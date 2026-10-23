/** 现役 Dashboard 导航 href 白名单 — 与 workspace-shell 保持一致，供测试与文档登记。 */
export const ICE_V4_ACTIVE_NAV_HREFS = [
  '/dashboard/catalog',
  '/dashboard/catalog/intake',
  '/dashboard/catalog/sources',
  '/dashboard/catalog/admin',
] as const;

/** 旧入口处置：重定向或封存说明页（仍保留 URL 可达性以便验证，不加载旧业务）。 */
export const LEGACY_ROUTE_DISPOSITION = {
  '/dashboard': { action: 'redirect', target: '/dashboard/catalog' },
  '/dashboard/products': { action: 'redirect', target: '/dashboard/catalog', note: 'search→q' },
  '/dashboard/products/[id]': { action: 'sealed', note: 'no uuid shape mapping' },
  '/dashboard/products/overview': { action: 'sealed' },
  '/dashboard/inventory/domestic': { action: 'sealed' },
  '/dashboard/inventory/overseas': { action: 'sealed' },
  '/dashboard/inventory/in-transit': { action: 'sealed' },
  '/dashboard/shipments': { action: 'sealed' },
  '/dashboard/sync': { action: 'sealed' },
  '/dashboard/variants': { action: 'sealed' },
  '/dashboard/replenishment': { action: 'sealed' },
  '/dashboard/users': { action: 'sealed' },
  '/dashboard/users/warehouses': { action: 'sealed' },
} as const;

/** @deprecated 使用 ICE_V4_ACTIVE_NAV_HREFS */
export const ICE_V4_PRIMARY_NAV_HREFS = ICE_V4_ACTIVE_NAV_HREFS;

export const LEGACY_PRODUCTS_LIST_HREF = '/dashboard/products';
