'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { countIssuesByKind, isEmptyIssueIndex, issueKindLabel, issueModuleLabel } from './issue-index';
import type {
  CatalogIssue,
  CatalogIssueCoverage,
  CatalogIssueIndex,
  CatalogIssueModuleCoverage,
  CatalogIssueModuleStatus,
} from './types';
import styles from './catalog-issues.module.css';

/** 固定按 Asia/Shanghai 输出（UTC+8），避免服务端与浏览器时区不一致造成水合差异。 */
function formatGeneratedAt(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return '—';
  const shanghai = new Date(parsed + 8 * 60 * 60 * 1000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${shanghai.getUTCFullYear()}-${pad(shanghai.getUTCMonth() + 1)}-${pad(shanghai.getUTCDate())} `
    + `${pad(shanghai.getUTCHours())}:${pad(shanghai.getUTCMinutes())}`;
}

const STATUS_LABELS: Record<CatalogIssueModuleStatus, string> = {
  covered: '已覆盖',
  partial: '部分覆盖',
  disabled: '当前未启用',
  forbidden: '无读取权限',
  unavailable: '环境未就绪',
  read_failed: '读取失败',
};

function statusTone(status: CatalogIssueModuleStatus): string {
  if (status === 'covered') return styles.coverageBadgeOn;
  if (status === 'partial') return styles.coverageBadgePartial;
  if (status === 'read_failed') return styles.coverageBadgeFailed;
  return styles.coverageBadgeOff;
}

function ModuleCoverageItem({ module }: { module: CatalogIssueModuleCoverage }) {
  return (
    <li
      className={styles.coverageItem}
      data-module-key={module.key}
      data-module-enabled={module.enabled ? 'true' : 'false'}
      data-module-status={module.status}
    >
      <span className={statusTone(module.status)}>{STATUS_LABELS[module.status]}</span>
      <div>
        <p className={styles.coverageItemText}>{module.label}</p>
        {(module.covered.length > 0 || module.uncovered.length > 0) && (
          <details className={styles.coverageDetails}>
            <summary>纳入 / 未覆盖明细</summary>
            {module.covered.length > 0 && (
              <>
                <p className={styles.coverageSubTitle}>已纳入（现有状态）</p>
                <ul className={styles.coverageSubList}>{module.covered.map((entry) => <li key={entry}>{entry}</li>)}</ul>
              </>
            )}
            {module.uncovered.length > 0 && (
              <>
                <p className={styles.coverageSubTitle}>明确未覆盖</p>
                <ul className={styles.coverageSubList}>{module.uncovered.map((entry) => <li key={entry}>{entry}</li>)}</ul>
              </>
            )}
          </details>
        )}
      </div>
    </li>
  );
}

function CoveragePanel({ coverage }: { coverage: CatalogIssueCoverage }) {
  return (
    <section className={styles.coverage} data-testid="catalog-issues-coverage" aria-label="覆盖边界">
      <h2 className={styles.coverageTitle}>覆盖边界</h2>
      <ul className={styles.coverageList}>
        {coverage.modules.map((module) => <ModuleCoverageItem key={module.key} module={module} />)}
      </ul>
      <p className={styles.coverageNote}>{coverage.note}</p>
    </section>
  );
}

function IssueCard({ issue }: { issue: CatalogIssue }) {
  const referenceLabel = issue.module === 'catalog' ? '查看相关商品（只读）' : '查看相关范围（只读）';
  return (
    <li
      className={styles.issueCard}
      data-testid="catalog-issue-row"
      data-issue-key={issue.key}
      data-issue-kind={issue.kind}
      data-issue-module={issue.module}
      data-issue-action={issue.action}
      data-issue-closure={issue.closure}
      data-item-id={issue.itemId ?? ''}
      data-has-item={issue.itemId ? 'true' : 'false'}
    >
      <div className={styles.issueTop}>
        <span className={styles.issueKind}>{issueKindLabel(issue.kind)}</span>
        <span className={styles.moduleTag}>{issueModuleLabel(issue.module)}</span>
        <h3 className={styles.issueTitle}>{issue.nameCn}</h3>
        {issue.iceCode && <span className={styles.issueIce}>{issue.iceCode}</span>}
      </div>
      <p className={styles.issueSummary}>{issue.summary}</p>
      <p className={styles.issueState} data-testid="catalog-issue-state">当前状态：{issue.stateLabel}</p>
      <p className={styles.issueActionNote} data-testid="catalog-issue-closure">{issue.closureNote}</p>
      <p className={styles.issuePermission}>可见权限：{issue.permissionLabel}</p>
      <div className={styles.issueActions}>
        {issue.action === 'available' && issue.actionHref ? (
          <Link className={styles.issueLink} href={issue.actionHref} data-testid="catalog-issue-action">
            打开处理页
          </Link>
        ) : (
          <span className={styles.issueNoAction} data-testid="catalog-issue-no-action">
            当前无处理入口：{issue.actionNote}
          </span>
        )}
        {issue.referenceHref && (
          <Link className={styles.issueReference} href={issue.referenceHref} data-testid="catalog-issue-reference">
            {referenceLabel}
          </Link>
        )}
      </div>
    </li>
  );
}

export function CatalogIssueIndexView({ index }: { index: CatalogIssueIndex }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const retry = () => startTransition(() => router.refresh());

  const byKind = index.state === 'ok' ? countIssuesByKind(index.items) : null;
  const nonZeroKinds = byKind
    ? (Object.entries(byKind) as [keyof typeof byKind, number][]).filter(([, count]) => count > 0)
    : [];
  const empty = index.state === 'ok' ? isEmptyIssueIndex(index) : false;

  return (
    <div className={styles.page} data-testid="catalog-issues-page" data-issues-state={index.state}>
      <header className={styles.header}>
        <p className={styles.eyebrow}>商品库 / 待处理</p>
        <h1 className={styles.title}>待处理</h1>
        <p className={styles.lede}>
          这里汇总商品库里需要人工确认的事项：新品待补货号、两刷子历史保留、来源范围与记录状态、来源观测的分类与关联。
          每项都写明当前状态、可见权限和关闭依据；没有现役处理能力的事项会直接说明，不提供无效按钮。
        </p>
        <div className={styles.headerActions}>
          <Link href="/dashboard/catalog">返回商品库</Link>
        </div>
      </header>

      {index.state === 'forbidden' && (
        <section className={styles.stateCard} data-testid="catalog-issues-forbidden" role="alert">
          <h2 className={styles.stateTitle}>无法查看待处理事项</h2>
          <p className={styles.stateText}>{index.error}</p>
          <p className={styles.stateMeta}>未读取任何事项：不显示 0 项，也不代表没有待处理事项。</p>
          <div className={styles.guidanceActions}>
            <Link href="/dashboard/catalog">返回商品库</Link>
          </div>
        </section>
      )}

      {index.state === 'read_failed' && (
        <>
          <section
            className={`${styles.stateCard} ${styles.stateCardAlert}`}
            data-testid="catalog-issues-read-failed"
            role="alert"
          >
            <h2 className={styles.stateTitle}>待处理索引读取失败</h2>
            <p className={styles.stateText}>{index.error}</p>
            <p className={styles.stateMeta}>
              本次没有读到事项，因此不显示“0 项”，也不把失败当成“没有问题”。
            </p>
            <p>
              <button type="button" className={styles.retryButton} onClick={retry} disabled={pending} data-testid="catalog-issues-retry">
                {pending ? '重试中…' : '重试读取'}
              </button>
            </p>
          </section>
          <CoveragePanel coverage={index.coverage} />
        </>
      )}

      {index.state === 'ok' && (
        <>
          <section className={styles.summaryBar} aria-label="事项统计">
            <span className={styles.count} data-testid="catalog-issues-counts">
              {index.issueCount} 项 / {index.itemCount} 款
            </span>
            <span className={styles.countMeta} data-testid="catalog-issues-unlinked">
              未关联商品 {index.unlinkedCount} 项 · 生成时间 {formatGeneratedAt(index.generatedAt)}（Asia/Shanghai）
            </span>
            {nonZeroKinds.length > 0 && (
              <ul className={styles.breakdown}>
                {nonZeroKinds.map(([kind, count]) => (
                  <li key={kind} className={styles.breakdownItem} data-kind-count={kind}>{issueKindLabel(kind)} {count} 项</li>
                ))}
              </ul>
            )}
          </section>

          <CoveragePanel coverage={index.coverage} />

          {empty ? (
            <section className={styles.empty} data-testid="catalog-issues-empty">
              <h2 className={styles.emptyTitle}>当前没有待处理事项</h2>
              <p className={styles.emptyText}>
                0 项 / 0 款 / 未关联 0 项：只代表上表“已覆盖”范围内没有命中现有事实。
                未启用、无读取权限、读取失败或未覆盖的部分不计为 0 项，也不代表已查全。
              </p>
              <div className={styles.guidanceActions}>
                <Link href="/dashboard/catalog">返回商品库</Link>
              </div>
            </section>
          ) : (
            <ul className={styles.issueList} aria-label="待处理事项列表">
              {index.items.map((issue) => <IssueCard key={`${issue.kind}:${issue.key}`} issue={issue} />)}
            </ul>
          )}
        </>
      )}

      <p className={styles.footnote}>
        只读汇总：不写业务数据；事项随原资料变化自动出现或消失，没有单独的“已受理 / 忽略”状态。
        关闭局部提示只会隐藏提示，事项仍在本页集中可找回。
      </p>
    </div>
  );
}
