'use client';

// 侧边栏导航 — 完整 Phase 导航结构，未实现页面灰显
import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  Package,
  Globe,
  Tag,
  List,
  Barcode,
  Ship,
  Users,
  ChevronDown,
  RefreshCw,
  Warehouse,
  PackageCheck,
  TrendingUp,
  type LucideIcon,
} from 'lucide-react';

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Phase 标记，'0' 表示当前 Phase 已实现 */
  phase: string;
}

interface NavGroup {
  label: string;
  icon: LucideIcon;
  items: NavItem[];
}

// 完整导航结构 — 来自 structure.md + page-specification.md
const NAV_GROUPS: NavGroup[] = [
  {
    label: '库存管理',
    icon: Package,
    items: [
      { href: '/dashboard/inventory/domestic', label: '国内库存', icon: Globe, phase: '2' },
      { href: '/dashboard/inventory/overseas', label: '海外库存', icon: Globe, phase: '0' },
      { href: '/dashboard/replenishment', label: '预测式补货', icon: TrendingUp, phase: '0' },
    ],
  },
  {
    label: '产品管理',
    icon: Tag,
    items: [
      { href: '/dashboard/products', label: '产品列表', icon: List, phase: '0' },
      { href: '/dashboard/products/overview', label: '全球库存作战室', icon: Globe, phase: '0' },
      { href: '/dashboard/variants', label: 'SKU 管理', icon: Barcode, phase: '0' },
    ],
  },
  {
    label: '物流',
    icon: Ship,
    items: [
      { href: '/dashboard/shipments', label: '在途管理', icon: Ship, phase: '0' },
    ],
  },
  {
    label: '数据同步',
    icon: RefreshCw,
    items: [
      { href: '/dashboard/sync', label: '库存同步', icon: RefreshCw, phase: '0' },
    ],
  },
];

// 顶级首页导航
const HOME_ITEM = { href: '/dashboard', label: '首页', icon: LayoutDashboard };

// 团队账号 — 仅管理员可见
const USERS_ITEM: NavItem = {
  href: '/dashboard/users',
  label: '团队账号',
  icon: Users,
  phase: '0',
};

// 仓库分配 — 仅管理员可见（P5-SY13B）
const WAREHOUSE_ASSIGN_ITEM: NavItem = {
  href: '/dashboard/users/warehouses',
  label: '仓库分配',
  icon: Warehouse,
  phase: '0',
};

export function SidebarNav({ roleName }: { roleName: string }) {
  const pathname = usePathname();
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
    // 默认展开包含当前页面的组
    new Set(NAV_GROUPS.filter((g) => g.items.some((item) => pathname.startsWith(item.href))).map((g) => g.label))
  );

  function toggleGroup(label: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(label)) {
        next.delete(label);
      } else {
        next.add(label);
      }
      return next;
    });
  }

  const isActive = (href: string) => {
    if (href === '/dashboard/products' && pathname.startsWith('/dashboard/products/overview')) {
      return false;
    }
    return pathname === href || (href !== '/dashboard' && pathname.startsWith(href));
  };
  const isAvailable = (phase: string) => phase === '0';
  const isAdmin = roleName === 'admin';

  function renderItem(item: NavItem) {
    const available = isAvailable(item.phase);
    const active = isActive(item.href);

    const linkContent = (
      <>
        <item.icon className="w-4 h-4 shrink-0" />
        <span className="truncate">{item.label}</span>
        {!available && (
          <span className="text-[10px] text-gray-400 ml-auto shrink-0">P{item.phase}</span>
        )}
      </>
    );

    const classes =
      `flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors ` +
      (available
        ? active
          ? 'bg-gray-200 text-gray-900 font-medium'
          : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
        : 'text-gray-400 cursor-not-allowed');

    if (!available) {
      return (
        <span key={item.href} className={classes}>
          {linkContent}
        </span>
      );
    }

    return (
      <Link key={item.href} href={item.href} className={classes}>
        {linkContent}
      </Link>
    );
  }

  return (
    <aside className="w-[220px] shrink-0 bg-white border-r border-gray-200 flex flex-col">
      {/* Logo */}
      <div className="h-14 flex items-center gap-2.5 px-4 border-b border-gray-200">
        <div className="w-7 h-7 rounded-md bg-gray-900 flex items-center justify-center">
          <Package className="w-4 h-4 text-white" />
        </div>
        <span className="font-semibold text-sm text-gray-900">库存看板系统</span>
      </div>

      {/* 导航列表 */}
      <nav className="flex-1 overflow-y-auto px-3 py-3 space-y-0.5">
        {/* 首页 */}
        {renderItem({ ...HOME_ITEM, phase: '0' })}

        {/* 分组 */}
        {NAV_GROUPS.map((group) => {
          const expanded = expandedGroups.has(group.label);
          const hasActiveChild = group.items.some((item) => isActive(item.href));

          return (
            <div key={group.label}>
              {/* 分组标题 — 可点击折叠 */}
              <button
                onClick={() => toggleGroup(group.label)}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors ${
                  hasActiveChild
                    ? 'text-gray-900 font-medium'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                <group.icon className="w-4 h-4 shrink-0" />
                <span className="truncate flex-1 text-left">{group.label}</span>
                <ChevronDown
                  className={`w-3.5 h-3.5 shrink-0 transition-transform ${
                    expanded ? 'rotate-0' : '-rotate-90'
                  }`}
                />
              </button>

              {/* 子项 */}
              {expanded && (
                <div className="ml-3 mt-0.5 space-y-0.5 border-l border-gray-200 pl-3">
                  {group.items.map(renderItem)}
                  {/* P3-S5B4: 批量入仓 — Admin-only，物流组下 */}
                  {group.label === '物流' && isAdmin && renderItem({
                    href: '/dashboard/shipments/batch',
                    label: '批量入仓',
                    icon: PackageCheck,
                    phase: '0',
                  })}
                </div>
              )}
            </div>
          );
        })}

        {/* 管理区域 — 仅管理员 */}
        {isAdmin && (
          <div className="mt-0.5 space-y-0.5">
            {renderItem({ href: '/dashboard/catalog', label: '商品资料', icon: List, phase: '0' })}
            {renderItem(USERS_ITEM)}
            {renderItem(WAREHOUSE_ASSIGN_ITEM)}
          </div>
        )}
      </nav>

      {/* 底部用户简版信息 */}
      <div className="px-4 py-3 border-t border-gray-200">
        <span
          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${
            isAdmin ? 'bg-purple-50 text-purple-700' : 'bg-blue-50 text-blue-700'
          }`}
        >
          {isAdmin ? '管理员' : '运营'}
        </span>
      </div>
    </aside>
  );
}
