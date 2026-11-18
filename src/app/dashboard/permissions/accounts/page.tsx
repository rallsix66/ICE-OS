import type { Metadata } from 'next';
import Link from 'next/link';

import { AccountManager } from '@/features/access/components/account-manager';
import { AccessDeniedPanel } from '@/features/access/components/denied';
import { getAccessAccounts, getAccessRoles, getAccessWarehouseOptions } from '@/features/access/server/reads';
import { PageHeading } from '@/ui/ice-v4/data-surface';
import styles from '@/features/access/components/access.module.css';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const metadata: Metadata = { title: '权限设置 · 账号管理' };

const ROLE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 权限设置 · 账号管理（仅管理员）。
 *
 * 姓名/登录账号搜索、角色与状态筛选、新增、编辑、启用停用；
 * 账号配置姓名、邮箱、角色、市场与仓库范围；密码只在「新增/重置」时提交，不落列表。
 */
export default async function PermissionsAccountsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const pick = (key: string): string => {
    const value = sp[key];
    const first = Array.isArray(value) ? value[0] : value;
    return typeof first === 'string' ? first.trim() : '';
  };
  const roleFilter = pick('role');
  const statusFilter = pick('status');
  const filters = {
    q: pick('q').slice(0, 60),
    role: ROLE_RE.test(roleFilter) ? roleFilter : '',
    status: statusFilter === 'active' || statusFilter === 'inactive' ? statusFilter : '',
  };

  let roles;
  let warehouses;
  let page;
  try {
    [roles, warehouses, page] = await Promise.all([
      getAccessRoles(),
      getAccessWarehouseOptions(),
      getAccessAccounts({
        search: filters.q,
        roleId: filters.role || null,
        status: filters.status === '' ? null : (filters.status as 'active' | 'inactive'),
        page: 1,
        limit: 100,
      }),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    return <AccessDeniedPanel message={/FORBIDDEN|管理员/.test(message) ? undefined : '账号列表暂时读取不到，请稍后重试。'} />;
  }

  return (
    <div className={styles.page}>
      <PageHeading title="权限设置" />
      <nav className={styles.tabs} aria-label="权限设置页签">
        <Link className={styles.tab} href="/dashboard/permissions">角色管理</Link>
        <Link className={`${styles.tab} ${styles.tabActive}`} href="/dashboard/permissions/accounts" aria-current="page">
          账号管理
        </Link>
      </nav>
      <AccountManager
        accounts={page.accounts}
        total={page.total}
        roles={roles}
        warehouses={warehouses}
        filters={filters}
        rolesHref="/dashboard/permissions"
      />
    </div>
  );
}
