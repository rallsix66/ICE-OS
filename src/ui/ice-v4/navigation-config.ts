/** 现役 Dashboard 一级常驻导航 href 白名单 — 与 workspace-shell 保持一致，供测试与文档登记。 */
export const ICE_V4_ACTIVE_NAV_HREFS = [
  '/dashboard',
  '/dashboard/catalog',
  '/dashboard/inventory',
  '/dashboard/in-transit',
  '/dashboard/sync',
] as const;

/**
 * 已退出所有常驻导航、但必须保持 URL 可达的旧处理入口。
 * 页面保留原处理能力（模块启用时）或中文安全引导，不得 404、不得删后端能力。
 */
export const ICE_V4_RETAINED_ENTRY_HREFS = [
  '/dashboard/catalog/intake',
  '/dashboard/catalog/sources',
] as const;

/** 待处理只读问题索引：由列表工具栏入口进入，不是一级导航项。 */
export const CATALOG_ISSUES_HREF = '/dashboard/catalog/issues';

/** 旧入口处置：重定向或安全引导说明页（仍保留 URL 可达性以便验证，不加载旧业务）。 */
export const LEGACY_ROUTE_DISPOSITION = {
  // BUSINESS_OVERVIEW_V1：'/dashboard' 已是现役经营总览首页，不再是重定向入口。
  '/dashboard/products': { action: 'redirect', target: '/dashboard/catalog', note: 'search→q' },
  '/dashboard/products/[id]': { action: 'sealed', note: 'no uuid shape mapping' },
  '/dashboard/products/overview': { action: 'sealed' },
  // INV_SYNC_V1：/dashboard/inventory 与 /dashboard/sync 已由本包重新实现为现役入口，
  // 旧的三段库存地址安全引导到新的商品库存页；不恢复旧写入链、不补 0。
  '/dashboard/inventory/domestic': { action: 'guidance', target: '/dashboard/inventory', note: '国内库存未接入，不显示 0' },
  '/dashboard/inventory/overseas': { action: 'guidance', target: '/dashboard/inventory', note: '海外仓库存并入商品库存' },
  // SHIPMENT_IN_TRANSIT_V1：物流在途已作为独立入口 /dashboard/in-transit 接入飞书物流情况表。
  '/dashboard/inventory/in-transit': { action: 'guidance', target: '/dashboard/in-transit', note: '物流在途已接入独立入口' },
  '/dashboard/shipments': { action: 'sealed' },
  '/dashboard/variants': { action: 'sealed' },
  '/dashboard/replenishment': { action: 'sealed' },
  '/dashboard/users': { action: 'sealed' },
  '/dashboard/users/warehouses': { action: 'sealed' },
} as const;

/** @deprecated 使用 ICE_V4_ACTIVE_NAV_HREFS */
export const ICE_V4_PRIMARY_NAV_HREFS = ICE_V4_ACTIVE_NAV_HREFS;

export const LEGACY_PRODUCTS_LIST_HREF = '/dashboard/products';
