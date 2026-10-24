/** 现役 Dashboard 一级常驻导航 href 白名单 — 与 workspace-shell 保持一致，供测试与文档登记。 */
export const ICE_V4_ACTIVE_NAV_HREFS = [
  '/dashboard/catalog',
] as const;

/**
 * 账户菜单里的数据维护入口（仅管理员角色显示；服务端仍按既有权限校验）。
 * 不是一级业务导航项，也不新增维护能力。
 */
export const ICE_V4_DATA_MAINTENANCE_HREF = '/dashboard/catalog/admin';
export const ICE_V4_EVIDENCE_HREF = '/dashboard/catalog/admin/evidence';
/* V5-05：账户菜单只保留“数据维护”；商品来源从维护页按商品进入统一详情弹窗。 */
export const ICE_V4_ACCOUNT_MENU_ENTRY_HREFS = [
  ICE_V4_DATA_MAINTENANCE_HREF,
] as const;

/**
 * 已退出所有常驻导航、但必须保持 URL 可达的旧处理入口。
 * 页面保留原处理能力（模块启用时）或中文安全引导，不得 404、不得删后端能力。
 */
export const ICE_V4_RETAINED_ENTRY_HREFS = [
  '/dashboard/catalog/intake',
  '/dashboard/catalog/sources',
] as const;

/** 待处理只读问题索引：由列表工具栏入口与数据维护页进入，不是一级导航项。 */
export const CATALOG_ISSUES_HREF = '/dashboard/catalog/issues';

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
