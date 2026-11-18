'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';

import {
  createAccessAccountAction,
  getAccessAccountDetailAction,
  resetAccessPasswordAction,
  setAccessAccountActiveAction,
  updateAccessAccountAction,
} from '../server/actions';
import { marketLabel } from '../types';
import type {
  AccessAccountDetailDto,
  AccessAccountDto,
  AccessRoleDto,
  AccessWarehouseOptionDto,
} from '../types';
import styles from './access.module.css';

function groupWarehouses(options: AccessWarehouseOptionDto[]) {
  const groups = new Map<string, AccessWarehouseOptionDto[]>();
  for (const option of options) {
    const key = option.marketKey || '__unknown__';
    const list = groups.get(key) ?? [];
    list.push(option);
    groups.set(key, list);
  }
  return [...groups.entries()].sort(([left], [right]) => {
    if (left === '__unknown__') return 1;
    if (right === '__unknown__') return -1;
    return left.localeCompare(right);
  });
}

type DialogState =
  | { mode: 'create' }
  | { mode: 'edit'; account: AccessAccountDetailDto }
  | null;

/**
 * 账号管理：搜索 / 角色与状态筛选 / 新增 / 编辑 / 启用停用 / 重置密码。
 * 角色决定功能与金额权限，账号决定具体市场与仓库范围（两者分开配置、不叠加多角色）。
 */
export function AccountManager({
  accounts,
  total,
  roles,
  warehouses,
  filters,
  rolesHref,
}: {
  accounts: AccessAccountDto[];
  total: number;
  roles: AccessRoleDto[];
  warehouses: AccessWarehouseOptionDto[];
  filters: { q: string; role: string; status: string };
  rolesHref: string;
}) {
  const router = useRouter();
  const [dialog, setDialog] = useState<DialogState>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const groups = groupWarehouses(warehouses);
  const defaultRoleId = roles[0]?.roleId ?? '';

  function refreshWithNotice(text: string) {
    setNotice({ tone: 'ok', text });
    router.refresh();
  }

  function toggleActive(account: AccessAccountDto) {
    if (account.isSystemAdmin || pending) return;
    setNotice(null);
    startTransition(async () => {
      const result = await setAccessAccountActiveAction({
        profileId: account.profileId,
        isActive: !account.isActive,
      });
      if (!result.success) {
        setNotice({ tone: 'error', text: result.error });
        return;
      }
      refreshWithNotice(account.isActive ? `已停用「${account.displayName}」。` : `已启用「${account.displayName}」。`);
    });
  }

  async function openEdit(profileId: string) {
    setNotice(null);
    const result = await getAccessAccountDetailAction(profileId);
    if (!result.success) {
      setNotice({ tone: 'error', text: result.error });
      return;
    }
    setDialog({ mode: 'edit', account: result.data });
  }

  return (
    <div className={styles.page} data-testid="access-accounts">
      <section className={styles.panel}>
        <div className={styles.panelHead}>
          <span className={styles.panelTitle}>账号</span>
          <div className={styles.actions}>
            <Link className={styles.secondaryButton} href={rolesHref}>角色管理</Link>
            <button
              type="button"
              className={styles.primaryButton}
              onClick={() => { setNotice(null); setDialog({ mode: 'create' }); }}
              data-testid="account-create"
            >
              新增账号
            </button>
          </div>
        </div>

        <form className={styles.toolbar} method="get" action="/dashboard/permissions/accounts">
          <label className={styles.toolbarField}>
            <span className={styles.label}>搜索姓名或登录账号</span>
            <input
              className={styles.input}
              name="q"
              defaultValue={filters.q}
              placeholder="姓名 / 邮箱"
              data-testid="account-search"
            />
          </label>
          <label className={styles.toolbarField}>
            <span className={styles.label}>角色</span>
            <select className={styles.select} name="role" defaultValue={filters.role} data-testid="account-role-filter">
              <option value="">全部角色</option>
              {roles.map((role) => (
                <option key={role.roleId} value={role.roleId}>{role.name}</option>
              ))}
            </select>
          </label>
          <label className={styles.toolbarField}>
            <span className={styles.label}>状态</span>
            <select className={styles.select} name="status" defaultValue={filters.status} data-testid="account-status-filter">
              <option value="">全部状态</option>
              <option value="active">启用</option>
              <option value="inactive">停用</option>
            </select>
          </label>
          <button type="submit" className={styles.secondaryButton}>查询</button>
          <Link className={styles.linkButton} href="/dashboard/permissions/accounts">清空</Link>
          <span className={styles.toolbarSpacer} />
          <span className={styles.muted} data-testid="account-total">共 {total} 个账号</span>
        </form>

        {notice ? (
          <p
            className={`${styles.notice} ${notice.tone === 'ok' ? styles.noticeOk : styles.noticeError}`}
            role="status"
            data-testid="account-notice"
          >
            {notice.text}
          </p>
        ) : null}

        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>姓名</th>
                <th>登录账号</th>
                <th>角色</th>
                <th>金额</th>
                <th>数据范围</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {accounts.length === 0 ? (
                <tr>
                  <td colSpan={7} className={styles.muted}>没有符合条件的账号。</td>
                </tr>
              ) : null}
              {accounts.map((account) => (
                <tr key={account.profileId} data-testid="account-row" data-account-name={account.displayName}>
                  <td>{account.displayName}</td>
                  <td>{account.email ?? '—'}</td>
                  <td>{account.roleName ?? (account.isSystemAdmin ? '管理员' : '—')}</td>
                  <td>{account.canViewAmount ? '可见' : '不可见'}</td>
                  <td>
                    {account.isSystemAdmin
                      ? '全站'
                      : account.warehouseCount === 0
                        ? '未分配'
                        : `${account.markets.map((market) => marketLabel(market)).join('、')} · ${account.warehouseCount} 个仓`}
                  </td>
                  <td>
                    <span
                      className={`${styles.badge} ${account.isActive ? styles.badgeOn : styles.badgeOff}`}
                      data-testid="account-status"
                    >
                      {account.isActive ? '启用' : '停用'}
                    </span>
                  </td>
                  <td>
                    <div className={styles.rowActions}>
                      <button
                        type="button"
                        className={styles.linkButton}
                        onClick={() => { void openEdit(account.profileId); }}
                        disabled={account.isSystemAdmin}
                        data-testid="account-edit"
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        className={styles.linkButton}
                        onClick={() => toggleActive(account)}
                        disabled={account.isSystemAdmin}
                        data-testid="account-toggle"
                      >
                        {account.isActive ? '停用' : '启用'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {dialog ? (
        <AccountDialog
          key={dialog.mode === 'edit' ? dialog.account.profileId : 'create'}
          dialog={dialog}
          roles={roles}
          groups={groups}
          defaultRoleId={defaultRoleId}
          onClose={() => setDialog(null)}
          onSaved={(text) => { setDialog(null); refreshWithNotice(text); }}
        />
      ) : null}
    </div>
  );
}

function AccountDialog({
  dialog,
  roles,
  groups,
  defaultRoleId,
  onClose,
  onSaved,
}: {
  dialog: Exclude<DialogState, null>;
  roles: AccessRoleDto[];
  groups: Array<[string, AccessWarehouseOptionDto[]]>;
  defaultRoleId: string;
  onClose: () => void;
  onSaved: (text: string) => void;
}) {
  const editing = dialog.mode === 'edit' ? dialog.account : null;
  const [displayName, setDisplayName] = useState(editing?.displayName ?? '');
  const [email, setEmail] = useState(editing?.email ?? '');
  const [password, setPassword] = useState('');
  const [roleId, setRoleId] = useState(editing?.roleId ?? defaultRoleId);
  const [isActive, setIsActive] = useState(editing?.isActive ?? true);
  const [selected, setSelected] = useState<string[]>(editing?.warehouses.map((row) => row.warehouseId) ?? []);
  const [resetPassword, setResetPassword] = useState('');
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  function toggleWarehouse(warehouseId: string) {
    setSelected((current) => (current.includes(warehouseId)
      ? current.filter((entry) => entry !== warehouseId)
      : [...current, warehouseId]));
  }

  function toggleMarket(list: AccessWarehouseOptionDto[], allSelected: boolean) {
    const ids = list.map((option) => option.warehouseId);
    setSelected((current) => (allSelected
      ? current.filter((entry) => !ids.includes(entry))
      : [...new Set([...current, ...ids])]));
  }

  function save() {
    setNotice(null);
    startTransition(async () => {
      const result = editing
        ? await updateAccessAccountAction({
          profileId: editing.profileId,
          displayName,
          roleId,
          isActive,
          warehouseIds: selected,
        })
        : await createAccessAccountAction({
          displayName,
          email,
          password,
          roleId,
          warehouseIds: selected,
          isActive,
        });
      if (!result.success) {
        setNotice({ tone: 'error', text: result.error });
        return;
      }
      onSaved(editing ? `已保存「${displayName}」的账号设置。` : `已创建账号「${displayName}」。`);
    });
  }

  function resetPasswordNow() {
    if (!editing) return;
    setNotice(null);
    startTransition(async () => {
      const result = await resetAccessPasswordAction({ profileId: editing.profileId, password: resetPassword });
      if (!result.success) {
        setNotice({ tone: 'error', text: result.error });
        return;
      }
      setResetPassword('');
      setNotice({ tone: 'ok', text: '已重置密码，请把新密码线下告知本人。' });
    });
  }

  return (
    <div className={styles.dialogBackdrop} role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-label={editing ? '编辑账号' : '新增账号'}>
        <div className={styles.dialogHead}>
          <span>{editing ? `编辑账号 · ${editing.displayName}` : '新增账号'}</span>
          <button type="button" className={styles.linkButton} onClick={onClose} aria-label="关闭">关闭</button>
        </div>
        <div className={styles.dialogBody}>
          {notice ? (
            <p className={`${styles.notice} ${notice.tone === 'ok' ? styles.noticeOk : styles.noticeError}`} role="status">
              {notice.text}
            </p>
          ) : null}
          <div className={styles.twoCols}>
            <label className={styles.field}>
              <span className={styles.label}>姓名</span>
              <input
                className={styles.input}
                value={displayName}
                maxLength={60}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="例如：王小明"
                data-testid="account-name"
              />
            </label>
            <label className={styles.field}>
              <span className={styles.label}>登录账号（邮箱）</span>
              <input
                className={styles.input}
                value={email}
                disabled={Boolean(editing)}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="name@company.com"
                data-testid="account-email"
              />
            </label>
            {!editing ? (
              <label className={styles.field}>
                <span className={styles.label}>初始密码（至少 8 位）</span>
                <input
                  className={styles.input}
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="new-password"
                  data-testid="account-password"
                />
              </label>
            ) : null}
            <label className={styles.field}>
              <span className={styles.label}>角色</span>
              <select
                className={styles.select}
                value={roleId}
                onChange={(event) => setRoleId(event.target.value)}
                data-testid="account-role"
              >
                {roles.map((role) => (
                  <option key={role.roleId} value={role.roleId}>
                    {role.name}{role.canViewAmount ? '（含金额）' : '（不含金额）'}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div>
            <p className={styles.label}>数据范围：选择市场后勾选仓库</p>
            <div className={styles.scopeGrid} data-testid="account-scope">
              {groups.map(([marketKey, list]) => {
                const allSelected = list.every((option) => selected.includes(option.warehouseId));
                return (
                  <div key={marketKey} className={styles.marketBlock}>
                    <div className={styles.marketHead}>
                      <span>{marketLabel(marketKey)}（{list.length} 个仓）</span>
                      <button
                        type="button"
                        className={styles.linkButton}
                        onClick={() => toggleMarket(list, allSelected)}
                      >
                        {allSelected ? '取消本市场' : '全选本市场'}
                      </button>
                    </div>
                    <div className={styles.marketChoices}>
                      {list.map((option) => (
                        <label key={option.warehouseId} className={styles.choice}>
                          <input
                            type="checkbox"
                            checked={selected.includes(option.warehouseId)}
                            onChange={() => toggleWarehouse(option.warehouseId)}
                            data-testid="account-warehouse"
                            data-warehouse-name={option.name}
                          />
                          <span>{option.name}</span>
                          <span className={styles.muted}>{option.externalId}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
            <p className={styles.muted}>
              已选 {selected.length} 个仓；不选任何仓时该账号登录后显示「暂无授权库存」。
            </p>
          </div>

          <label className={styles.checkRow}>
            <input
              type="checkbox"
              checked={isActive}
              onChange={(event) => setIsActive(event.target.checked)}
              data-testid="account-active"
            />
            <span>
              账号启用
              <span className={styles.checkHint}>停用后立即不能登录使用；原有操作归属保留。</span>
            </span>
          </label>

          {editing ? (
            <div className={styles.marketBlock}>
              <div className={styles.marketHead}><span>重置密码</span></div>
              <div className={styles.twoCols} style={{ marginTop: 8 }}>
                <input
                  className={styles.input}
                  type="password"
                  value={resetPassword}
                  onChange={(event) => setResetPassword(event.target.value)}
                  placeholder="新密码（至少 8 位）"
                  autoComplete="new-password"
                  data-testid="account-reset-password"
                />
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={resetPasswordNow}
                  disabled={pending || resetPassword.length < 8}
                  data-testid="account-reset-submit"
                >
                  重置密码
                </button>
              </div>
            </div>
          ) : null}
        </div>
        <div className={styles.dialogFoot}>
          <button type="button" className={styles.secondaryButton} onClick={onClose}>取消</button>
          <button
            type="button"
            className={styles.primaryButton}
            onClick={save}
            disabled={pending}
            data-testid="account-save"
          >
            {pending ? '保存中…' : editing ? '保存' : '创建账号'}
          </button>
        </div>
      </div>
    </div>
  );
}
