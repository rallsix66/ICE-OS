'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronRight, Package, Boxes, RefreshCw } from 'lucide-react';
import { LogoutButton } from '@/app/dashboard/_components/logout-button';
import styles from './ice-v4.module.css';
import shellStyles from './shell.module.css';

type NavItem = {
  href: string;
  label: string;
  icon: typeof Package;
  match?: (pathname: string) => boolean;
};

/**
 * 一级常驻导航：三个业务入口。
 * 数据维护/待处理等内部页面不放进日常界面，URL 仍保留可达。
 */
const NAV: NavItem[] = [
  {
    href: '/dashboard/catalog',
    label: 'ICE 商品库',
    icon: Package,
    match: (pathname) =>
      pathname === '/dashboard/catalog'
      || /^\/dashboard\/catalog\/[0-9a-f-]{36}$/i.test(pathname)
      || pathname.startsWith('/dashboard/catalog/issues'),
  },
  {
    href: '/dashboard/inventory',
    label: '商品库存',
    icon: Boxes,
  },
  {
    href: '/dashboard/sync',
    label: '数据同步',
    icon: RefreshCw,
  },
];

const ROLE_LABELS: Record<string, string> = {
  admin: '管理员',
  operator: '运营人员',
  viewer: '只读查看',
};

function roleLabel(roleName: string): string {
  return ROLE_LABELS[roleName] ?? '受限角色';
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
  if (pathname.startsWith('/dashboard/sync')) return '数据同步';
  if (pathname.startsWith('/dashboard/inventory')) return '商品库存';
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
  children,
}: {
  displayName: string;
  roleName: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const currentRole = roleLabel(roleName);
  const active = resolveActive(pathname, NAV);
  const currentPage = pageLabel(pathname, active.label);
  const initials = displayName.slice(0, 2).toUpperCase();

  return (
    <div className={styles.app} style={{ minHeight: '100vh', width: '100%' }}>
      <aside className={styles.sidebar}>
        <div className={styles.brand}>
          <span className={styles.brandMark}>i</span>
          <span>ICE</span>
        </div>
        <nav aria-label="工作台导航" className={styles.navigation}>
          {NAV.map((item) => {
            const isActive = item.href === active.href;
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
