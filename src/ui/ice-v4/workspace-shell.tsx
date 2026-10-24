'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronRight, ChevronDown, Package } from 'lucide-react';
import { LogoutButton } from '@/app/dashboard/_components/logout-button';
import { ICE_V4_DATA_MAINTENANCE_HREF } from './navigation-config';
import styles from './ice-v4.module.css';
import shellStyles from './shell.module.css';

type NavItem = {
  href: string;
  label: string;
  caption: string;
  icon: typeof Package;
  match?: (pathname: string) => boolean;
};

/**
 * 一级常驻导航：只保留「ICE 商品库」。
 * 数据维护（基线/冻结观测/人工决定/原始证据）按既有管理员权限收进账户菜单；
 * 新品/来源旧 URL 保留安全引导与后端能力，但不再常驻侧栏。
 */
const NAV: NavItem[] = [
  {
    href: '/dashboard/catalog',
    label: 'ICE 商品库',
    caption: '真实主资料与样表库存',
    icon: Package,
    match: (pathname) =>
      pathname === '/dashboard/catalog'
      || /^\/dashboard\/catalog\/[0-9a-f-]{36}$/i.test(pathname)
      || pathname.startsWith('/dashboard/catalog/issues'),
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
  /** @deprecated 侧栏已不展示模块可用性；保留入参仅为兼容既有布局接线。 */
  navModules?: { intake: 'available' | 'disabled'; sources: 'available' | 'disabled' };
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const isAdmin = roleName === 'admin';
  const currentRole = roleLabel(roleName);
  const active = resolveActive(pathname, NAV);
  const currentPage = pageLabel(pathname, active.label);
  const initials = displayName.slice(0, 2).toUpperCase();
  const showPageHeading = pathname === '/dashboard/catalog';

  return (
    <div className={styles.app} style={{ minHeight: '100vh', width: '100%' }}>
      <aside className={styles.sidebar}>
        <div className={styles.brand}>
          <span className={styles.brandMark}>i</span>
          <span>ICE<small>INVENTORY & OPERATIONS</small></span>
        </div>
        <div className={styles.workspaceLabel}><span className={styles.workspaceDot} />经营工作台 <span>v4</span></div>
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
        <div className={styles.sidebarBottom}>
          <strong>本地独立资料环境</strong>
          <p>商品库使用本地样表资料；演示数据见 /demo/ice-v4。</p>
        </div>
      </aside>
      <div className={styles.workspace}>
        <header className={styles.topbar}>
          <div className={styles.breadcrumb}>
            工作台<ChevronRight size={13} aria-hidden /><strong>{currentPage}</strong>
          </div>
          <div className={styles.topbarRight}>
            <span className={styles.demoTag} style={{ background: '#eef1ff', color: '#4057c0' }}>
              <span style={{ background: '#5266d7' }} aria-hidden />真实资料
            </span>
            <details className={`${styles.accountMenu} ${shellStyles.accountMenu}`} data-testid="ice-v4-account-menu">
              <summary
                className={shellStyles.accountSummary}
                aria-label={`当前账户 ${displayName}，角色${currentRole}`}
              >
                <span className={styles.avatar} aria-hidden>{initials}</span>
                <span className={shellStyles.accountIdentity}>
                  <strong className={shellStyles.accountName}>{displayName}</strong>
                  <small className={shellStyles.accountRole}>{currentRole}</small>
                </span>
                <ChevronDown size={14} aria-hidden className={shellStyles.accountCaret} />
              </summary>
              <div className={styles.accountPanel} role="region" aria-label="账户与可用操作" data-testid="ice-v4-account-panel">
                <strong>{displayName}</strong>
                <p className={shellStyles.accountPanelRole}>当前角色：{currentRole}</p>
                <p className={shellStyles.accountPanelText}>
                  可查看商品资料、库存明细、变更记录和已授权的数据来源。
                </p>
                {isAdmin && (
                  <div className={shellStyles.accountMaintenance} data-testid="ice-v4-maintenance-block">
                    <Link
                      className={shellStyles.accountMaintenanceLink}
                      href={ICE_V4_DATA_MAINTENANCE_HREF}
                      data-testid="ice-v4-maintenance-entry"
                    >
                      数据维护
                    </Link>
                  </div>
                )}
              </div>
            </details>
            <LogoutButton />
          </div>
        </header>
        <main className={styles.main} id="ice-v4-main">
          {showPageHeading && (
            <div className={styles.pageHeading}>
              <div>
                <p className={styles.eyebrow}>ICE / BUSINESS WORKSPACE</p>
                <h1>{active.label}<span>{active.caption}</span></h1>
              </div>
            </div>
          )}
          {children}
          <footer className={styles.footer}>
            <span>ICE v4 · 本地经营工作台</span>
            <span>样表库存非实时 · 估值不含运费 · 演示见 /demo/ice-v4</span>
          </footer>
        </main>
      </div>
    </div>
  );
}
