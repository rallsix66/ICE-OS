import Link from 'next/link';
import { ChevronDown, ChevronLeft, ChevronRight, History } from 'lucide-react';
import { EmptyState, PageHeading } from '@/ui/ice-v4/data-surface';
import { Pill } from '@/ui/ice-v4/primitives';
import {
  buildOperationHref,
  formatOperationTime,
  OPERATION_CATEGORY_OPTIONS,
  operationActionLabel,
  operationActionTone,
  operationActorText,
  operationCategoryCountLabel,
  operationCategoryLabel,
  operationCategoryTotal,
  operationPageRange,
  operationResultText,
  type OperationQueryState,
} from '../model';
import type { OperationRecordDto, OperationRecordsPageDto } from '../types';
import { OperationsFilters } from './operations-filters';
import { OperationRecordDetail } from './operation-record-detail';
import styles from './operations.module.css';

/**
 * 操作记录页（只读）。
 *
 * 列表按时间倒序；每条默认显示 时间/账号、业务对象与动作、处理结果，
 * 展开后先看处理结果与业务变化，再按商品追溯；批次号/快照/请求号收进「来源信息」。
 * 所有筛选与页码都在 URL 里：刷新、返回、直接链接都还原同一份结果。
 */
export function OperationsView({
  query,
  page,
  rangeInvalid,
  readError,
  retryHref,
}: {
  query: OperationQueryState;
  page: OperationRecordsPageDto | null;
  rangeInvalid: boolean;
  readError: string | null;
  retryHref: string;
}) {
  const range = page ? operationPageRange(page.total, page.limit, query.page) : null;
  const counts = page?.categoryCounts ?? null;
  const allCount = operationCategoryTotal(counts);
  const currentCount = page ? page.total : null;
  const failed = Boolean(readError) || rangeInvalid;
  return (
    <div className={styles.page} data-testid="operations-page">
      <PageHeading
        title="操作记录"
        meta="查看商品资料、库存对应与物流中已经保存的人工处理，以及它们带来的变化。"
        actions={<span className={styles.headingBadge}><History size={14} strokeWidth={1.8} aria-hidden />只读</span>}
      />

      <details className={styles.guide} data-testid="operation-guide">
        <summary>
          <span>记录说明</span>
          <ChevronDown className={styles.guideChevron} size={15} strokeWidth={1.8} aria-hidden />
        </summary>
        <div className={styles.guideBody}>
          <p>这里汇总商品资料、库存对应与物流中<strong>已经保存的人工处理</strong>，按处理时间倒序。后台自动同步不在这里：同步结果看「数据同步」，库存历史数量看「商品库存 → 历史快照」。</p>
          <p><strong>记录账号</strong>是写入这条记录时使用的账号，不一定是实际点击的人。历史行没有保存的内容显示「历史未保存 / 未提供」，不用当前商品或货票数据反推。</p>
          <p>日期筛选按 +08 自然日；关键词匹配货号、商品名称、来源 SKU、货票号与批次号。</p>
        </div>
      </details>

      <OperationsFilters
        query={{
          category: query.category,
          actor: query.actor,
          from: query.from,
          to: query.to,
          q: query.q,
          page: query.page,
        }}
        actors={page?.actors ?? []}
      />

      <nav className={styles.tabs} aria-label="按业务类别筛选" data-testid="operation-category-tabs">
        {OPERATION_CATEGORY_OPTIONS.map((option) => {
          const active = query.category === option.value;
          const count = option.value === 'all'
            ? allCount
            : counts && typeof counts[option.value] === 'number'
              ? counts[option.value]!
              : page ? 0 : null;
          return (
            <Link
              key={option.value}
              href={buildOperationHref(query, { category: option.value, page: 1 })}
              className={active ? `${styles.tab} ${styles.tabActive}` : styles.tab}
              aria-current={active ? 'page' : undefined}
              data-testid={`operation-category-${option.value}`}
              data-count={count === null ? undefined : count}
            >
              {option.label}
              <span className={styles.tabCount}>{operationCategoryCountLabel(count)}</span>
            </Link>
          );
        })}
      </nav>

      {rangeInvalid ? (
        <div className={styles.filterError} role="alert" data-testid="operation-range-error">
          <strong>开始日期不能晚于结束日期。</strong>
          <span>调整日期后再查询；也可以直接清空日期范围。</span>
          <Link href={buildOperationHref(query, { from: '', to: '', page: 1 })}>清空日期范围</Link>
        </div>
      ) : readError ? (
        <div className={styles.failure} role="alert" data-testid="operation-read-failure">
          <strong>操作记录读取失败。</strong>
          <span>{readError}。请稍后重试；如果持续失败，请联系管理员检查读取权限或实例是否就绪。</span>
          <Link href={retryHref}>重新读取</Link>
        </div>
      ) : page && page.rows.length === 0 ? (
        <EmptyState
          title={page.total === 0 ? '没有符合条件的记录' : '这一页没有记录'}
          hint={page.total === 0
            ? '换一个货号、来源 SKU 或货票号，或清空类别、账号与日期筛选。'
            : '页码超出当前结果；用下面的上一页回到最后一页。'}
          action={<Link className={styles.emptyAction} href="/dashboard/operations" data-testid="operation-empty-clear">清空筛选</Link>}
        />
      ) : page ? (
        <>
          <div className={styles.resultBar} data-testid="operation-result-bar">
            <span className={styles.resultCategory}>{query.category === 'all' ? '全部业务' : operationCategoryLabel(query.category)}</span>
            <span className={styles.resultCount} data-testid="operation-current-count">
              {currentCount === null ? '—' : `${currentCount} 条记录`}
            </span>
            <span className={styles.resultHint}>按处理时间倒序</span>
          </div>
          <section className={styles.panel} data-testid="operation-list">
            <div className={styles.listHeader} aria-hidden="true">
              <span>时间 / 账号</span>
              <span>业务对象与动作</span>
              <span>处理结果</span>
              <span>详情</span>
            </div>
            {page.rows.map((record) => <OperationRecord key={record.id} record={record} />)}
          </section>
        </>
      ) : null}

      {range && page && page.total > 0 && !failed ? (
        <div className={styles.pager} data-testid="operation-pagination">
          <span className={styles.pagerInfo}>
            第 {range.from}–{range.to} 条，共 {range.total} 条 · 第 {range.page}/{range.pageCount} 页
          </span>
          <nav className={styles.pagerNav} aria-label="操作记录分页">
            {range.hasPrev ? (
              <Link className={styles.pageBtn} href={buildOperationHref(query, { page: range.page - 1 })} data-testid="operation-page-prev">
                <ChevronLeft size={14} aria-hidden />上一页
              </Link>
            ) : (
              <span className={`${styles.pageBtn} ${styles.pageBtnDisabled}`} aria-disabled="true">
                <ChevronLeft size={14} aria-hidden />上一页
              </span>
            )}
            {range.hasPrev ? <Link className={styles.pageBtn} href={buildOperationHref(query, { page: 1 })}>第 1 页</Link> : null}
            <span className={`${styles.pageBtn} ${styles.pageBtnCurrent}`} aria-current="page" data-testid="operation-page-current">
              {range.page}
            </span>
            {range.hasNext ? (
              <Link className={styles.pageBtn} href={buildOperationHref(query, { page: range.pageCount })}>第 {range.pageCount} 页</Link>
            ) : null}
            {range.hasNext ? (
              <Link className={styles.pageBtn} href={buildOperationHref(query, { page: range.page + 1 })} data-testid="operation-page-next">
                下一页<ChevronRight size={14} aria-hidden />
              </Link>
            ) : (
              <span className={`${styles.pageBtn} ${styles.pageBtnDisabled}`} aria-disabled="true">
                下一页<ChevronRight size={14} aria-hidden />
              </span>
            )}
          </nav>
        </div>
      ) : null}
    </div>
  );
}

/**
 * 未登录/无权限/实例未就绪时的页面级降级：明确说「没读到」，不显示 0 条。
 */
export function OperationsUnavailable({ kind }: { kind: 'forbidden' | 'unavailable' }) {
  const text = kind === 'forbidden'
    ? {
      title: '没有访问权限',
      body: '当前账号不是已启用的管理员，无法查看操作记录。',
    }
    : {
      title: '操作记录功能尚未就绪',
      body: '当前实例还没有安装操作记录所需的只读查询（042）。',
    };
  return (
    <div className={styles.page}>
      <PageHeading title="操作记录" />
      <div className={styles.failure} role="alert" data-testid="operation-unavailable" data-kind={kind}>
        <strong>{text.title}</strong>
        <span>{text.body}</span>
      </div>
    </div>
  );
}

function objectMetaText(record: OperationRecordDto): string {
  if (record.action === 'source_batch_applied') {
    const detail = record.detail ?? {};
    const counts = detail.counts && typeof detail.counts === 'object' ? detail.counts as Record<string, unknown> : {};
    const businessRows = typeof counts.businessRows === 'number' ? counts.businessRows : null;
    const status = typeof detail.status === 'string' ? detail.status : null;
    const statusLabel = status === 'partial' ? '部分完成' : status === 'applied' ? '已采用' : null;
    return [
      statusLabel,
      businessRows === null ? null : `业务行 ${businessRows}`,
    ].filter(Boolean).join(' · ');
  }
  const parts: Array<string | null> = [];
  if (record.action === 'inventory_confirm' || record.action === 'inventory_rebind') {
    const detail = record.detail ?? {};
    const items = Array.isArray(detail.items) ? detail.items : [];
    const skus = [...new Set(items
      .map((item) => (item && typeof item === 'object' ? (item as Record<string, unknown>).externalSku : null))
      .filter((sku): sku is string => typeof sku === 'string' && sku.length > 0))];
    if (skus.length > 0 && skus.length <= 3) parts.push(`来源 SKU ${skus.join('、')}`);
    else if (skus.length > 3) parts.push(`${skus.length} 条来源 SKU`);
    else parts.push(record.objectRef);
  } else {
    parts.push(record.objectRef && record.objectRef !== record.objectTitle ? record.objectRef : null);
  }
  parts.push(record.iceCode, record.externalSku, record.ticketNo, record.market);
  return parts
    .filter((part): part is string => Boolean(part))
    .filter((part, index, list) => list.indexOf(part) === index)
    .join(' · ');
}

function OperationRecord({ record }: { record: OperationRecordDto }) {
  const meta = objectMetaText(record);
  return (
    <details
      className={styles.record}
      data-testid="operation-record"
      data-action={record.action}
      data-category={record.category}
      data-record-id={record.id}
    >
      <summary className={styles.recordSummary}>
        <span className={styles.timeCell} data-testid="operation-record-time">
          <strong>{formatOperationTime(record.at) || '时间未保存'}</strong>
          <small data-testid="operation-record-actor">{operationActorText(record)}</small>
        </span>
        <span className={styles.objectCell} data-testid="operation-record-object">
          <span className={styles.objectTitle}>{record.objectTitle || record.objectKind}</span>
          <span className={styles.objectAction} data-testid="operation-record-action">
            <Pill tone={operationActionTone(record.action)}>{operationActionLabel(record.action)}</Pill>
            <small>{operationCategoryLabel(record.category)}</small>
          </span>
          <span className={styles.objectMeta}>{meta || record.objectKind}</span>
        </span>
        <span className={styles.resultCell} data-testid="operation-record-result">{operationResultText(record)}</span>
        <span className={styles.toggleCell}>
          <span className={styles.toggleLabel}>
            <span className={styles.toggleOpen}>查看详情</span>
            <span className={styles.toggleClose}>收起详情</span>
          </span>
          <ChevronDown className={styles.toggleChevron} size={15} strokeWidth={2} aria-hidden />
        </span>
      </summary>
      <OperationRecordDetail record={record} />
    </details>
  );
}
