// Dashboard 认证壳 — 所有 /dashboard/* 页面共用 ICE v4 工作台外壳（无旧侧栏/顶栏）
//
// TEAM-ACCOUNTS-INACTIVE-SESSION-GUARD:
// getCurrentActiveUser() 额外校验 profiles.is_active。
// - 未登录 → redirect('/auth/login')
// - 已登录但 is_active=false → InactiveAccountPage 阻断
// - 活跃用户 → IceV4WorkspaceShell
import { getCurrentUser, getCurrentActiveUser } from '@/lib/auth';
import { getMyInventoryAccess } from '@/features/access/server/reads';
import { redirect } from 'next/navigation';
import { InactiveAccountPage } from './_components/inactive-account-page';
import { IceV4WorkspaceShell } from '@/ui/ice-v4/workspace-shell';
import { PageTransition } from '@/ui/ice-v4/page-transition';

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

  // 权限设置 v1：导航与角色标签都按「当前账号实际权限」渲染。
  // 读不到权限摘要时按系统角色兜底（管理员仍是管理员，成员不会因此多出入口）。
  const access = await getMyInventoryAccess().catch(() => null);
  const isAdmin = access?.isAdmin ?? activeUser.roleName === 'admin';
  const canViewInventory = isAdmin || access?.canViewInventory === true;
  const canViewShipment = isAdmin || access?.canViewShipment === true;
  const displayRole = access?.isAdmin === false && access.roleName
    ? access.roleName
    : activeUser.roleName;

  return (
    <IceV4WorkspaceShell
      displayName={activeUser.displayName}
      roleName={displayRole}
      isAdmin={isAdmin}
      canViewInventory={canViewInventory}
      canViewShipment={canViewShipment}
    >
      <PageTransition>{children}</PageTransition>
    </IceV4WorkspaceShell>
  );
}
