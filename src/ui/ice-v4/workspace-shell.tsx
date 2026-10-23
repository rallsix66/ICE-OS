'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  ChevronRight,
  Package,
  Settings,
  ClipboardList,
  Sparkles,
} from 'lucide-react';
import { LogoutButton } from '@/app/dashboard/_components/logout-button';
import styles from './ice-v4.module.css';

type NavModuleState = 'available' | 'disabled';

type NavItem = {
  href: string;
  label: string;
  caption: string;
  icon: typeof Package;
  adminOnly?: boolean;
  moduleKey?: 'intake' | 'sources';
  match?: (pathname: string) => boolean;
};

const NAV: NavItem[] = [
  {
    href: '/dashboard/catalog',
    label: 'ICE 商品库',
    caption: '真实主资料与样表库存',
    icon: Package,
    match: (pathname) =>
      pathname === '/dashboard/catalog'
      || /^\/dashboard\/catalog\/[0-9a-f-]{36}$/i.test(pathname),
  },
  {
    href: '/dashboard/catalog/intake',
    label: '持续新品',
    caption: '来源范围新品资料工作区',
    icon: Sparkles,
    moduleKey: 'intake',
    match: (pathname) => pathname.startsWith('/dashboard/catalog/intake'),
  },
  {
    href: '/dashboard/catalog/sources',
    label: '来源核实',
    caption: '来源身份与观测核实',
    icon: ClipboardList,
    moduleKey: 'sources',
    match: (pathname) => pathname.startsWith('/dashboard/catalog/sources'),
  },
  {
    href: '/dashboard/catalog/admin',
    label: '管理与审计',
    caption: '基线、样表与审计入口',
    icon: Settings,
    adminOnly: true,
    match: (pathname) => pathname.startsWith('/dashboard/catalog/admin'),
  },
];

function resolveActive(pathname: string, items: NavItem[]) {
  return (
    items.find((item) => (
      item.match?.(pathname)
      ?? (pathname === item.href || pathname.startsWith(`${item.href}/`))
    )) ?? NAV[0]
  );
}

function moduleAvailabilityLabel(state: NavModuleState | undefined) {
  if (!state) return null;
  return state === 'available' ? '可用' : '未启用';
}

export function IceV4WorkspaceShell({
  displayName,
  roleName,
  navModules,
  children,
}: {
  displayName: string;
  roleName: string;
  navModules?: { intake: NavModuleState; sources: NavModuleState };
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const isAdmin = roleName === 'admin';
  const visibleNav = NAV.filter((item) => !item.adminOnly || isAdmin);
  const active = resolveActive(pathname, visibleNav);
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
          {visibleNav.map((item) => {
            const isActive = item.href === active.href;
            const moduleState = item.moduleKey && navModules ? navModules[item.moduleKey] : undefined;
            const availability = moduleAvailabilityLabel(moduleState);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={isActive ? styles.navActive : undefined}
                aria-current={isActive ? 'page' : undefined}
                data-nav-module={item.moduleKey}
                data-nav-availability={availability ?? undefined}
              >
                <item.icon size={19} strokeWidth={1.6} aria-hidden />
                <span className={styles.navLinkText}>
                  <span>{item.label}</span>
                  {availability && (
                    <small className={moduleState === 'available' ? styles.navBadgeOn : styles.navBadgeOff}>
                      {availability}
                    </small>
                  )}
                </span>
                {isActive && <span className={styles.navDot} aria-hidden />}
              </Link>
            );
          })}
        </nav>
        <div className={styles.sidebarBottom}>
          <strong>本地独立平台</strong>
          <p>仅开放已验收商品库能力；旧经营模块已封存。演示数据见 /demo/ice-v4。</p>
          <span>权限由服务端校验</span>
        </div>
      </aside>
      <div className={styles.workspace}>
        <header className={styles.topbar}>
          <div className={styles.breadcrumb}>
            工作台<ChevronRight size={13} aria-hidden /><strong>{active.label}</strong>
          </div>
          <div className={styles.topbarRight}>
            <span className={styles.demoTag} style={{ background: '#eef1ff', color: '#4057c0' }}>
              <span style={{ background: '#5266d7' }} aria-hidden />真实资料
            </span>
            <details className={styles.accountMenu}>
              <summary className={styles.avatar} aria-label={`当前账户 ${displayName}，角色 ${roleName}`}>
                {initials}
              </summary>
              <div className={styles.accountPanel} role="region" aria-label="账户与可用能力">
                <strong>{displayName}</strong>
                <p>角色：{roleName === 'admin' ? '管理员（catalog:admin）' : roleName}</p>
                <p className={styles.subtle}>已启用：商品库浏览、样表库存投影、管理与审计（管理员）。金额读取需 amount:read。完整用户/权限矩阵属后续功能包。</p>
              </div>
            </details>
            <span className={styles.subtle} style={{ fontSize: 12 }}>{displayName}</span>
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
