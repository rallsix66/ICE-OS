'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  ChevronRight,
  LayoutDashboard,
  Package,
  Boxes,
  RefreshCw,
  Truck,
  History,
  ShieldCheck,
} from 'lucide-react';
import { LogoutButton } from '@/app/dashboard/_components/logout-button';
import styles from './ice-v4.module.css';
import shellStyles from './shell.module.css';

type NavItem = {
  href: string;
  label: string;
  icon: typeof Package;
  match?: (pathname: string) => boolean;
  /** admin：只有管理员看得到；inventory：有库存查看权限（管理员或成员）即可；
   *  shipment：有物流在途权限（管理员或至少获授一个物流市场）即可。 */
  requires?: 'admin' | 'inventory' | 'shipment';
};

/**
 * 一级常驻导航：经营总览 → 商品库 → 商品库存 → 物流在途 → 操作记录 → 数据同步。
 * 数据维护/待处理等内部页面不放进日常界面，URL 仍保留可达。
 * 权限设置只对管理员显示；成员登录后只保留其真正能用的入口（商品库存）。
 */
const NAV: NavItem[] = [
  {
    href: '/dashboard',
    label: '经营总览',
    icon: LayoutDashboard,
    requires: 'admin',
    match: (pathname) => pathname === '/dashboard' || pathname.startsWith('/dashboard?'),
  },
  {
    href: '/dashboard/catalog',
    label: 'ICE 商品库',
    icon: Package,
    requires: 'admin',
    match: (pathname) =>
      pathname === '/dashboard/catalog'
      || /^\/dashboard\/catalog\/[0-9a-f-]{36}$/i.test(pathname)
      || pathname.startsWith('/dashboard/catalog/issues'),
  },
  {
    href: '/dashboard/inventory',
    label: '商品库存',
    icon: Boxes,
    requires: 'inventory',
  },
  {
    href: '/dashboard/in-transit',
    label: '物流在途',
    icon: Truck,
    requires: 'shipment',
  },
  {
    href: '/dashboard/operations',
    label: '操作记录',
    icon: History,
    requires: 'admin',
  },
  {
    href: '/dashboard/sync',
    label: '数据同步',
    icon: RefreshCw,
    requires: 'admin',
  },
  {
    href: '/dashboard/permissions',
    label: '权限设置',
    icon: ShieldCheck,
    requires: 'admin',
  },
];

function roleLabel(roleName: string): string {
  const labels: Record<string, string> = {
    admin: '管理员',
    operator: '运营人员',
    viewer: '只读查看',
  };
  return labels[roleName] ?? roleName ?? '受限角色';
}

function resolveActive(pathname: string, items: NavItem[]) {
  return (
    items.find((item) => (
      item.match?.(pathname)
      ?? (pathname === item.href || pathname.startsWith(`${item.href}/`))
    )) ?? items[0]
  );
}

/** 面包屑文案：子页面不改一级导航归属，只改当前页标签。 */
function pageLabel(pathname: string, fallback: string): string {
  if (pathname === '/dashboard') return '经营总览';
  if (pathname.startsWith('/dashboard/sync')) return '数据同步';
  if (pathname.startsWith('/dashboard/operations')) return '操作记录';
  if (pathname.startsWith('/dashboard/in-transit')) return '物流在途';
  if (pathname.startsWith('/dashboard/inventory')) return '商品库存';
  if (pathname.startsWith('/dashboard/permissions/accounts')) return '权限设置 · 账号管理';
  if (pathname.startsWith('/dashboard/permissions')) return '权限设置 · 角色管理';
  if (pathname.startsWith('/dashboard/catalog/issues')) return '待处理';
  if (pathname.startsWith('/dashboard/catalog/intake')) return '持续新品（旧入口）';
  if (pathname.startsWith('/dashboard/catalog/sources')) return '来源核实（旧入口）';
  if (pathname.startsWith('/dashboard/catalog/admin/evidence')) return '数据来源';
  if (pathname.startsWith('/dashboard/catalog/admin')) return '数据维护';
  if (/^\/dashboard\/catalog\/[0-9a-f-]{36}$/i.test(pathname)) return '商品详情';
  return fallback;
}

export function IceV4WorkspaceShell({
  displayName,
  roleName,
  isAdmin,
  canViewInventory,
  canViewShipment,
  children,
}: {
  displayName: string;
  roleName: string;
  isAdmin: boolean;
  canViewInventory: boolean;
  canViewShipment: boolean;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const items = NAV.filter((item) => {
    if (item.requires === 'admin') return isAdmin;
    if (item.requires === 'inventory') return isAdmin || canViewInventory;
    if (item.requires === 'shipment') return isAdmin || canViewShipment;
    return true;
  });
  const currentRole = roleLabel(roleName);
  const active = resolveActive(pathname, items) ?? items[0];
  const currentPage = pageLabel(pathname, active?.label ?? '工作台');
  const initials = displayName.slice(0, 2).toUpperCase();

  return (
    <div className={styles.app} style={{ minHeight: '100vh', width: '100%' }}>
      <aside className={styles.sidebar}>
        <div className={styles.brand}>
          <span className={styles.brandMark}>i</span>
          <span>ICE</span>
        </div>
        <nav aria-label="工作台导航" className={styles.navigation}>
          {items.map((item) => {
            const isActive = item.href === active?.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={isActive ? styles.navActive : undefined}
                aria-current={isActive ? 'page' : undefined}
                data-nav-primary="true"
              >
                <item.icon size={19} strokeWidth={1.6} aria-hidden />
                <span className={styles.navLinkText}>
                  <span>{item.label}</span>
                </span>
                {isActive && <span className={styles.navDot} aria-hidden />}
              </Link>
            );
          })}
        </nav>
      </aside>
      <div className={styles.workspace}>
        <header className={styles.topbar}>
          <div className={styles.breadcrumb}>
            工作台<ChevronRight size={13} aria-hidden /><strong>{currentPage}</strong>
          </div>
          <div className={styles.topbarRight}>
            <div className={shellStyles.accountStatic} data-testid="ice-v4-account">
              <span className={styles.avatar} aria-hidden>{initials}</span>
              <span className={shellStyles.accountIdentity}>
                <strong className={shellStyles.accountName}>{displayName}</strong>
                <small className={shellStyles.accountRole}>{currentRole}</small>
              </span>
            </div>
            <LogoutButton />
          </div>
        </header>
        <main className={styles.main} id="ice-v4-main">
          {children}
        </main>
      </div>
    </div>
  );
}
