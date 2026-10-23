// Dashboard 认证壳 — 所有 /dashboard/* 页面共用 ICE v4 工作台外壳（无旧侧栏/顶栏）
//
// TEAM-ACCOUNTS-INACTIVE-SESSION-GUARD:
// getCurrentActiveUser() 额外校验 profiles.is_active。
// - 未登录 → redirect('/auth/login')
// - 已登录但 is_active=false → InactiveAccountPage 阻断
// - 活跃用户 → IceV4WorkspaceShell
import { getCurrentUser, getCurrentActiveUser } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { InactiveAccountPage } from './_components/inactive-account-page';
import { getCatalogWorkspaceNavState } from '@/features/catalog/workspace-nav-state';
import { IceV4WorkspaceShell } from '@/ui/ice-v4/workspace-shell';

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();

  if (!user) {
    redirect('/auth/login');
  }

  const activeUser = await getCurrentActiveUser();
  if (!activeUser) {
    return <InactiveAccountPage />;
  }

  const navModules = getCatalogWorkspaceNavState();

  return (
    <IceV4WorkspaceShell
      displayName={activeUser.displayName}
      roleName={activeUser.roleName}
      navModules={navModules}
    >
      {children}
    </IceV4WorkspaceShell>
  );
}
