'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import type {
  CatalogIssue,
  CatalogIssueCoverage,
  CatalogIssueIndex,
  CatalogIssueKind,
  CatalogIssueModuleCoverage,
  CatalogIssueModuleStatus,
} from './types';
import styles from './catalog-issues.module.css';

const STATUS_LABELS: Record<CatalogIssueModuleStatus, string> = {
  covered: '已覆盖',
  partial: '部分覆盖',
  disabled: '未启用',
  forbidden: '无权限',
  unavailable: '未就绪',
  read_failed: '读取失败',
};

/** 一句话原因：只描述事项本身，不带权限、关闭依据等术语。 */
const ISSUE_REASONS: Record<CatalogIssueKind, string> = {
  new_item_missing_code: '缺少 ICE 货号',
  brush_pending: '历史记录待确认',
  source_scope_unresolved: '来源范围未解析',
  source_identity_review: '来源记录待复核',
  source_identity_suspended: '来源记录已暂停',
  new_item_review: '分类待复核',
  new_item_pending_association: '已建议分类，未建档',
};

/** 覆盖边界只显示短模块名；模块自带的长说明不渲染。 */
const MODULE_LABELS: Record<CatalogIssueModuleCoverage['key'], string> = {
  new_item: '持续新品',
  source_identity: '来源核实',
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
      title={module.label}
    >
      <span className={statusTone(module.status)}>{STATUS_LABELS[module.status]}</span>
      <span className={styles.coverageLabel}>{MODULE_LABELS[module.key]}</span>
    </li>
  );
}

/** 覆盖边界收进默认折叠，只留一句状态行；不再展开逐条说明。 */
function CoveragePanel({ coverage }: { coverage: CatalogIssueCoverage }) {
  const summary = coverage.modules
    .map((module) => `${MODULE_LABELS[module.key]} ${STATUS_LABELS[module.status]}`)
    .join(' · ');
  return (
    <details className={styles.coverage} data-testid="catalog-issues-coverage">
      <summary className={styles.coverageSummary}>
        <span className={styles.coverageTitle}>覆盖边界</span>
        <span className={styles.coverageInline}>{summary}</span>
      </summary>
      <ul className={styles.coverageList}>
        {coverage.modules.map((module) => <ModuleCoverageItem key={module.key} module={module} />)}
      </ul>
    </details>
  );
}

function IssueCard({ issue }: { issue: CatalogIssue }) {
  const actionHref = issue.action === 'available' ? issue.actionHref : null;
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
      <div className={styles.issueMain}>
        <div className={styles.issueHead}>
          <span className={styles.issueName}>{issue.nameCn}</span>
          {issue.iceCode ? <span className={styles.issueCode}>{issue.iceCode}</span> : null}
        </div>
        <p className={styles.issueReason}>{ISSUE_REASONS[issue.kind]}</p>
      </div>
      <div className={styles.issueFoot}>
        <span className={styles.issueState} data-testid="catalog-issue-state">{issue.stateLabel}</span>
        {actionHref ? (
          <Link className={styles.issueAction} href={actionHref} data-testid="catalog-issue-action">
            去处理
          </Link>
        ) : (
          <span className={styles.issueNoAction} data-testid="catalog-issue-no-action">无处理入口</span>
        )}
      </div>
      <span className={styles.srOnly} data-testid="catalog-issue-closure">
        {issue.closure === 'defined' ? '关闭依据已定义' : '关闭依据待定义'}
      </span>
    </li>
  );
}

export function CatalogIssueIndexView({ index }: { index: CatalogIssueIndex }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const retry = () => startTransition(() => router.refresh());

  return (
    <div className={styles.page} data-testid="catalog-issues-page" data-issues-state={index.state}>
      <header className={styles.header}>
        <div className={styles.headerMain}>
          <h1 className={styles.title}>待处理</h1>
          {index.state === 'ok' ? (
            <p className={styles.headerCounts}>
              <span className={styles.count} data-testid="catalog-issues-counts">
                {index.issueCount} 项 / {index.itemCount} 款
              </span>
              <span className={styles.unlinked} data-testid="catalog-issues-unlinked">
                未关联商品 {index.unlinkedCount} 项
              </span>
            </p>
          ) : null}
        </div>
        <Link className={styles.backLink} href="/dashboard/catalog">返回商品库</Link>
      </header>

      {index.state === 'forbidden' && (
        <section className={styles.stateCard} data-testid="catalog-issues-forbidden" role="alert">
          <h2 className={styles.stateTitle}>无法查看待处理事项</h2>
          <p className={styles.stateText}>{index.error}</p>
          <div className={styles.stateActions}>
            <button type="button" className={styles.retryButton} onClick={retry} disabled={pending} data-testid="catalog-issues-retry">
              {pending ? '重试中…' : '重试'}
            </button>
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
            <h2 className={styles.stateTitle}>待处理读取失败</h2>
            <p className={styles.stateText}>{index.error}</p>
            <div className={styles.stateActions}>
              <button type="button" className={styles.retryButton} onClick={retry} disabled={pending} data-testid="catalog-issues-retry">
                {pending ? '重试中…' : '重试'}
              </button>
            </div>
          </section>
          <CoveragePanel coverage={index.coverage} />
        </>
      )}

      {index.state === 'ok' && (
        <>
          {index.issueCount === 0 ? (
            <>
              <section className={styles.stateCard} data-testid="catalog-issues-empty">
                <h2 className={styles.stateTitle}>当前没有待处理事项</h2>
                <p className={styles.stateText}>已覆盖范围内没有命中。</p>
                <div className={styles.stateActions}>
                  <button type="button" className={styles.retryButton} onClick={retry} disabled={pending} data-testid="catalog-issues-retry">
                    {pending ? '刷新中…' : '刷新'}
                  </button>
                </div>
              </section>
              <CoveragePanel coverage={index.coverage} />
            </>
          ) : (
            <>
              <ul className={styles.issueList} aria-label="待处理事项列表">
                {index.items.map((issue) => <IssueCard key={`${issue.kind}:${issue.key}`} issue={issue} />)}
              </ul>
              <CoveragePanel coverage={index.coverage} />
            </>
          )}
        </>
      )}
    </div>
  );
}
