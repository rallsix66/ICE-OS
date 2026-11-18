'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { saveAccessRoleAction } from '../server/actions';
import type { AccessRoleDto } from '../types';
import styles from './access.module.css';

/**
 * 角色管理：左侧角色列表、右侧权限配置（新增/编辑普通角色）。
 * 只暴露本包真正接通的两项能力：库存查看、库存金额查看；管理员全站能力不在角色里配置。
 * 表单按键重建（key=角色ID），不用 effect 同步 props → state。
 */
export function RoleManager({
  roles,
  accountsHref,
}: {
  roles: AccessRoleDto[];
  accountsHref: string;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(roles[0]?.roleId ?? null);
  const [creating, setCreating] = useState(roles.length === 0);
  // 提示放在容器层：保存后表单按键重建（key=角色ID），提示不会随之消失。
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const selected = roles.find((role) => role.roleId === selectedId) ?? null;

  return (
    <div className={styles.grid} data-testid="access-roles">
      <section className={styles.panel} aria-label="角色列表">
        <div className={styles.panelHead}>
          <span className={styles.panelTitle}>角色</span>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={() => setCreating(true)}
            data-testid="role-create"
          >
            新增角色
          </button>
        </div>
        <ul className={styles.roleList}>
          {roles.map((role) => (
            <li key={role.roleId}>
              <button
                type="button"
                className={`${styles.roleItem} ${!creating && role.roleId === selectedId ? styles.roleItemActive : ''}`}
                onClick={() => { setCreating(false); setSelectedId(role.roleId); }}
                aria-current={!creating && role.roleId === selectedId ? 'true' : undefined}
                data-testid="role-item"
                data-role-name={role.name}
              >
                <span>{role.name}</span>
                <span className={styles.roleMeta}>{role.accountCount} 个账号</span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className={styles.panel} aria-label="权限配置">
        <div className={styles.panelHead}>
          <span className={styles.panelTitle}>{creating ? '新增角色' : `权限配置 · ${selected?.name ?? ''}`}</span>
          <Link className={styles.secondaryButton} href={accountsHref}>账号管理</Link>
        </div>
        <div className={styles.panelBody}>
          {notice ? (
            <p
              className={`${styles.notice} ${notice.tone === 'ok' ? styles.noticeOk : styles.noticeError}`}
              role="status"
              data-testid="role-notice"
            >
              {notice.text}
            </p>
          ) : null}
          <RoleForm
            key={creating ? 'create' : selected?.roleId ?? 'none'}
            role={creating ? null : selected}
            onCreated={() => { setCreating(false); }}
            onSelectRole={setSelectedId}
            onNotice={setNotice}
          />
        </div>
      </section>
    </div>
  );
}

function RoleForm({
  role,
  onCreated,
  onSelectRole,
  onNotice,
}: {
  role: AccessRoleDto | null;
  onCreated: () => void;
  onSelectRole: (roleId: string) => void;
  onNotice: (notice: { tone: 'ok' | 'error'; text: string } | null) => void;
}) {
  const router = useRouter();
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [canViewInventory, setCanViewInventory] = useState(role?.canViewInventory ?? true);
  const [canViewAmount, setCanViewAmount] = useState(role?.canViewAmount ?? false);
  const [pending, startTransition] = useTransition();

  function submit() {
    onNotice(null);
    startTransition(async () => {
      const result = await saveAccessRoleAction({
        roleId: role?.roleId ?? null,
        name,
        description,
        canViewInventory,
        canViewAmount: canViewInventory && canViewAmount,
      });
      if (!result.success) {
        onNotice({ tone: 'error', text: result.error });
        return;
      }
      onNotice({ tone: 'ok', text: role ? '已保存角色权限。' : `已新增角色「${name.trim()}」。` });
      if (role) onSelectRole(role.roleId);
      else onCreated();
      router.refresh();
    });
  }

  return (
    <>
      <div className={styles.fieldGrid}>
        <label className={styles.field}>
          <span className={styles.label}>角色名称</span>
          <input
            className={styles.input}
            value={name}
            maxLength={20}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如：仓库负责人"
            data-testid="role-name"
          />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>角色说明（可选）</span>
          <textarea
            className={styles.textarea}
            value={description}
            maxLength={200}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="写清这个角色负责什么"
            data-testid="role-description"
          />
        </label>
        <div className={styles.checkRow}>
          <input
            id="role-can-view-inventory"
            type="checkbox"
            checked={canViewInventory}
            onChange={(event) => {
              setCanViewInventory(event.target.checked);
              if (!event.target.checked) setCanViewAmount(false);
            }}
            data-testid="role-can-view-inventory"
          />
          <label htmlFor="role-can-view-inventory">
            库存查看
            <span className={styles.checkHint}>仓库明细、商品汇总、历史快照，以及商品与来源行详情。</span>
          </label>
        </div>
        <div className={styles.checkRow}>
          <input
            id="role-can-view-amount"
            type="checkbox"
            checked={canViewAmount}
            disabled={!canViewInventory}
            onChange={(event) => setCanViewAmount(event.target.checked)}
            data-testid="role-can-view-amount"
          />
          <label htmlFor="role-can-view-amount">
            库存金额查看
            <span className={styles.checkHint}>
              在库存查看之上额外显示估算货值；不勾选时服务端不读成本、不下发金额。
            </span>
          </label>
        </div>
        <p className={styles.muted}>
          管理员账号始终拥有全站管理能力，不受这些角色影响；每个账号只分配一个角色。
        </p>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.primaryButton}
            onClick={submit}
            disabled={pending || (!role && name.trim().length === 0)}
            data-testid="role-save"
          >
            {pending ? '保存中…' : role ? '保存权限' : '创建角色'}
          </button>
          {role ? (
            <span className={styles.muted}>当前有 {role.accountCount} 个账号使用这个角色</span>
          ) : null}
        </div>
      </div>
    </>
  );
}
