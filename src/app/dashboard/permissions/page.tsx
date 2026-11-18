import type { Metadata } from 'next';
import Link from 'next/link';

import { RoleManager } from '@/features/access/components/role-manager';
import { AccessDeniedPanel } from '@/features/access/components/denied';
import { getAccessRoles } from '@/features/access/server/reads';
import { PageHeading } from '@/ui/ice-v4/data-surface';
import styles from '@/features/access/components/access.module.css';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const metadata: Metadata = { title: '权限设置 · 角色管理' };

/**
 * 权限设置 · 角色管理（仅管理员）。
 *
 * 左侧角色列表、右侧权限配置；本包只提供两项能力（库存查看 / 库存金额查看），
 * 管理员的全站管理能力不在这里配置，也不受这些角色影响。
 */
export default async function PermissionsRolesPage() {
  let roles;
  try {
    roles = await getAccessRoles();
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    return <AccessDeniedPanel message={/FORBIDDEN|管理员/.test(message) ? undefined : '权限设置暂时读取不到，请稍后重试。'} />;
  }

  return (
    <div className={styles.page}>
      <PageHeading title="权限设置" />
      <nav className={styles.tabs} aria-label="权限设置页签">
        <Link className={`${styles.tab} ${styles.tabActive}`} href="/dashboard/permissions" aria-current="page">
          角色管理
        </Link>
        <Link className={styles.tab} href="/dashboard/permissions/accounts">账号管理</Link>
      </nav>
      <RoleManager roles={roles} accountsHref="/dashboard/permissions/accounts" />
    </div>
  );
}
