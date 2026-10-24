'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import {
  ISSUES_RETURN_HREF,
  appendReturnContext,
  isIssuesReturnHref,
  safeInternalReturnHref,
} from './context';
import styles from './catalog-issues.module.css';

/**
 * 旧入口（持续新品 / 来源核实）安全引导页的共享视图。
 *
 * 说明：
 * - 旧 URL 仍然可达，原处理能力与权限校验不下线、不 404；
 * - 四种状态分开表达：模块未启用 / 无权限 / 读取失败（可重试），以及模块启用时的原处理页（由页面自己渲染）；
 * - 未启用不写成 0 项、不伪造处理状态，也不称“已检查完整”；
 * - 页顶“入口调整提示”可关闭，但只隐藏本页说明，事项仍在商品库「待处理」索引中集中可找回；
 * - V3-05：返回点与商品详情链接都携带安全站内返回路径，不嵌套 from、不产生返回循环。
 */
export type LegacyEntryState = 'disabled' | 'forbidden' | 'read_failed';

const MODULE_TITLES: Record<'new_item' | 'source_identity', string> = {
  new_item: '持续新品资料',
  source_identity: '来源身份核实',
};

export function LegacyEntryGuidance({
  moduleKey,
  title,
  lede,
  state,
  itemId,
  itemContext,
  returnHref,
}: {
  moduleKey: 'new_item' | 'source_identity';
  title: string;
  lede: string;
  state: LegacyEntryState;
  itemId?: string;
  itemContext?: { label: string | null; issueCount: number | null } | null;
  /** 安全返回点（仅接受站内 /dashboard/… 相对路径）；缺省退回商品库首页。 */
  returnHref?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [hintDismissed, setHintDismissed] = useState(false);
  const moduleName = MODULE_TITLES[moduleKey];
  const safeReturn = safeInternalReturnHref(returnHref);
  const backHref = safeReturn ?? '/dashboard/catalog';
  const backLabel = isIssuesReturnHref(safeReturn) ? '返回待处理' : safeReturn ? '返回原处' : '返回商品库';
  const detailHref = itemId
    ? appendReturnContext(`/dashboard/catalog?detail=${encodeURIComponent(itemId)}`, safeReturn ?? ISSUES_RETURN_HREF)
    : null;

  return (
    <div className={styles.page} data-testid="legacy-entry-guidance" data-entry-module={moduleKey} data-entry-state={state}>
      <header className={styles.header}>
        <p className={styles.eyebrow}>旧入口 · 安全引导</p>
        <h1 className={styles.title}>{title}</h1>
        <p className={styles.lede}>{lede}</p>
      </header>

      {!hintDismissed && (
        <div className={styles.hint} data-testid="legacy-entry-hint" role="note">
          <p className={styles.hintText}>
            入口调整：持续新品与来源核实已退出常驻一级导航。相关工作集中到商品库「待处理」索引，便于集中找回；
            每个事项是否可处理以事项自身的说明为准。关闭此提示只会隐藏本页说明，不会关闭任何事项。
          </p>
          <button
            type="button"
            className={styles.hintClose}
            aria-label="关闭入口调整提示"
            data-testid="legacy-entry-hint-close"
            onClick={() => setHintDismissed(true)}
          >
            ×
          </button>
        </div>
      )}

      {state === 'disabled' && (
        <section className={styles.stateCard} data-testid="legacy-entry-disabled">
          <h2 className={styles.stateTitle}>当前未启用 / 未覆盖</h2>
          <p className={styles.stateText}>
            {moduleName}当前未启用：本页没有读取该模块的现有数据，也没有打开任何模块开关。
          </p>
          <p className={styles.stateMeta}>
            未启用不代表“0 项”，也不代表来源或新品资料已经检查完整；本页不会显示推测的数量或伪造的处理状态。
          </p>
        </section>
      )}

      {state === 'forbidden' && (
        <section className={styles.stateCard} data-testid="identity-unavailable" role="alert">
          <h2 className={styles.stateTitle}>账号没有访问权限，或所请求对象不存在</h2>
          <p className={styles.stateText}>账号没有访问权限，或所请求的来源范围 / 商品不存在。</p>
          <p className={styles.stateMeta}>
            本次没有读取到任何状态：既不显示“0 项”，也不把无权限说成“模块未启用”。
          </p>
        </section>
      )}

      {state === 'read_failed' && (
        <section className={`${styles.stateCard} ${styles.stateCardAlert}`} data-testid="legacy-entry-read-failed" role="alert">
          <h2 className={styles.stateTitle}>读取失败（网络、传输或环境异常）</h2>
          <p className={styles.stateText}>
            本次没有读到任何状态，因此不显示数量，也不把失败当成“没有问题”或“模块未启用”。
          </p>
          <p>
            <button
              type="button"
              className={styles.retryButton}
              onClick={() => startTransition(() => router.refresh())}
              disabled={pending}
              data-testid="legacy-entry-retry"
            >
              {pending ? '重试中…' : '重试读取'}
            </button>
          </p>
        </section>
      )}

      {state === 'disabled' && itemId && (
        <section className={styles.stateCard} data-testid="legacy-entry-item-context">
          <h2 className={styles.stateTitle}>关联商品</h2>
          <p className={styles.stateText}>
            {itemContext?.label
              ? `商品：${itemContext.label}`
              : '未读取到该商品摘要（商品不存在或无权读取）；不显示推测信息。'}
          </p>
          <p className={styles.stateMeta}>
            {itemContext?.issueCount == null
              ? '待处理事项数：未读取（不显示 0）'
              : itemContext.issueCount > 0
                ? `该商品在待处理索引中有 ${itemContext.issueCount} 项待处理`
                : '该商品当前不在待处理索引的已启用范围内'}
          </p>
        </section>
      )}

      <nav className={styles.guidanceActions} aria-label="旧入口引导" data-testid="legacy-entry-nav">
        <Link href={backHref} data-testid="legacy-entry-return">{backLabel}</Link>
        <Link href={ISSUES_RETURN_HREF}>打开待处理索引</Link>
        {detailHref && <Link href={detailHref} data-testid="legacy-entry-detail">查看该商品详情</Link>}
      </nav>

      <p className={styles.footnote}>
        原处理能力与权限校验保留：模块启用并被授权后，本页恢复原有处理界面；旧链接不会因导航调整而 404。
        只读事项集中记录在「待处理」，不在这里提供改动历史记录的入口。
      </p>
    </div>
  );
}
