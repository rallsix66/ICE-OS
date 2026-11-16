import Link from 'next/link';
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
  operationDetailView,
  operationPageRange,
  operationResultText,
  type OperationQueryState,
} from '../model';
import type { OperationRecordDto, OperationRecordsPageDto } from '../types';
import { OperationsFilters } from './operations-filters';
import styles from './operations.module.css';

/**
 * 操作记录页（只读）。
 *
 * 列表按时间倒序；每条默认显示 时间 / 记录账号 / 业务对象 / 动作 / 结果，
 * 展开后显示已保存依据（批次回执、对应版本与前值、人工修正前后、票面与关联商品）。
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
  return (
    <div className={styles.page} data-testid="operations-page">
      <PageHeading
        title="操作记录"
        meta="商品资料、库存对应与物流的人工业务处理记录（只读）"
      />

      <div className={styles.scopeNote} role="note" data-testid="operation-scope-note">
        <strong>这里只有已保存的人工处理。</strong>
        <span>
          自动同步过程不在本页：库存与物流后台同步结果仍在「数据同步」，库存历史快照仍在「商品库存 → 历史快照」。
          本页按时间倒序，默认显示时间、记录账号、业务对象、动作与结果；点开一条可看已保存的变化依据。
        </span>
      </div>

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
        total={page?.total ?? 0}
      />

      <nav className={styles.tabs} aria-label="按业务类别筛选" data-testid="operation-category-tabs">
        {OPERATION_CATEGORY_OPTIONS.map((option) => {
          const active = query.category === option.value;
          const count = option.value === 'all'
            ? (page ? page.total : 0)
            : (page?.categoryCounts[option.value] ?? 0);
          return (
            <Link
              key={option.value}
              href={buildOperationHref(query, { category: option.value, page: 1 })}
              className={active ? `${styles.tab} ${styles.tabActive}` : styles.tab}
              aria-current={active ? 'page' : undefined}
              data-testid={`operation-category-${option.value}`}
              data-count={count}
            >
              {option.label}
              <span>{operationCategoryCountLabel(count)}</span>
            </Link>
          );
        })}
      </nav>

      {rangeInvalid ? (
        <div className={styles.filterError} role="alert" data-testid="operation-range-error">
          <strong>开始日期不能晚于结束日期。</strong>
          <span>请调整日期范围；本次没有执行查询，也没有把范围悄悄改成别的日期。</span>
          <Link href={buildOperationHref(query, { from: '', to: '', page: 1 })}>清空日期范围</Link>
        </div>
      ) : readError ? (
        <div className={styles.failure} role="alert" data-testid="operation-read-failure">
          <strong>操作记录读取失败。</strong>
          <span>{readError}；没有显示任何旧缓存或猜测记录。稍后重试即可。</span>
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
      ) : (
        <section className={styles.panel} data-testid="operation-list">
          <div className={styles.listHeader} aria-hidden="true">
            <span>时间 / 记录账号</span>
            <span>业务对象</span>
            <span>动作</span>
            <span>结果</span>
            <span>变化依据</span>
          </div>
          {(page?.rows ?? []).map((record) => <OperationRecord key={record.id} record={record} />)}
        </section>
      )}

      {range && page && page.total > 0 ? (
        <div className={styles.pager} data-testid="operation-pagination">
          <span className={styles.pagerInfo}>
            第 {range.from}–{range.to} 条，共 {range.total} 条 · 第 {range.page}/{range.pageCount} 页
          </span>
          <nav className={styles.pagerNav} aria-label="操作记录分页">
            {range.hasPrev ? (
              <Link className={styles.pageBtn} href={buildOperationHref(query, { page: range.page - 1 })} data-testid="operation-page-prev">上一页</Link>
            ) : (
              <span className={`${styles.pageBtn} ${styles.pageBtnDisabled}`} aria-disabled="true">上一页</span>
            )}
            {range.hasPrev ? (
              <Link className={styles.pageBtn} href={buildOperationHref(query, { page: 1 })}>第 1 页</Link>
            ) : null}
            <span className={`${styles.pageBtn} ${styles.pageBtnCurrent}`} aria-current="page" data-testid="operation-page-current">
              {range.page}
            </span>
            {range.hasNext ? (
              <Link className={styles.pageBtn} href={buildOperationHref(query, { page: range.pageCount })}>第 {range.pageCount} 页</Link>
            ) : null}
            {range.hasNext ? (
              <Link className={styles.pageBtn} href={buildOperationHref(query, { page: range.page + 1 })} data-testid="operation-page-next">下一页</Link>
            ) : (
              <span className={`${styles.pageBtn} ${styles.pageBtnDisabled}`} aria-disabled="true">下一页</span>
            )}
          </nav>
        </div>
      ) : null}

      <p className={styles.footnote} data-testid="operation-footnote">
        「记录账号」是记录行上的账号，不等于已经确认的具体操作人；同账号可能由多人使用。
        历史行没有保存的内容（例如部分人工修正的旧值、分组决定的具体操作人）显示「未保存」，不用当前商品或货票数据反推。
      </p>
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
      body: '当前账号不是已启用的管理员。本页没有显示记录数量，也不当作 0 条。',
    }
    : {
      title: '操作记录功能尚未就绪',
      body: '当前实例还没有安装操作记录所需的只读查询（042）。本次没有读到任何记录，不等于没有记录。',
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

function shortId(value: string | null): string {
  if (!value) return '';
  return value.length > 14 ? `${value.slice(0, 8)}…` : value;
}

function objectMetaText(record: OperationRecordDto): string {
  const parts = [
    record.objectRef && record.objectRef !== record.objectTitle ? record.objectRef : null,
    record.iceCode,
    record.externalSku,
    record.ticketNo,
    record.market,
  ]
    .map((part) => (part && part.length > 14 ? shortId(part) : part))
    .filter((part): part is string => Boolean(part))
    .filter((part, index, list) => list.indexOf(part) === index && part !== record.objectTitle);
  return parts.join(' · ');
}

function OperationRecord({ record }: { record: OperationRecordDto }) {
  const view = operationDetailView(record);
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
          <strong>{record.objectTitle || record.objectKind}</strong>
          <small>{meta || record.objectKind}</small>
        </span>
        <span className={styles.actionCell} data-testid="operation-record-action">
          <Pill tone={operationActionTone(record.action)}>{operationActionLabel(record.action)}</Pill>
          <small>{operationCategoryLabel(record.category)}</small>
        </span>
        <span className={styles.resultCell} data-testid="operation-record-result">{operationResultText(record)}</span>
        <span className={styles.toggleCell}>查看依据</span>
      </summary>
      <div className={styles.recordBody} data-testid="operation-record-detail">
        {view.facts.length > 0 ? (
          <dl className={styles.facts}>
            {view.facts.map((fact) => (
              <div key={`${fact.label}:${fact.value}`}>
                <dt>{fact.label}</dt>
                <dd>{fact.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}

        {view.changes.length > 0 ? (
          <div className={styles.block}>
            <h3 className={styles.blockTitle}>变化（历史行保存的前后值）</h3>
            <div className={styles.tableScroll}>
              <table className={styles.table} data-testid="operation-record-changes">
                <thead>
                  <tr><th>范围</th><th>字段</th><th>前值</th><th>后值</th></tr>
                </thead>
                <tbody>
                  {view.changes.map((change, index) => (
                    <tr key={`${change.scope}:${change.field}:${index}`}>
                      <td>{change.scope}</td>
                      <td>{change.field}</td>
                      <td className={styles.beforeCell}>{change.before}</td>
                      <td>{change.after}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}

        {view.items.length > 0 ? (
          <div className={styles.block}>
            <h3 className={styles.blockTitle}>涉及明细</h3>
            <ul className={styles.itemList} data-testid="operation-detail-items">
              {view.items.map((item) => (
                <li key={item.key}>
                  <div>
                    <strong>{item.title}</strong>
                    <small>{item.meta}</small>
                    {item.change ? <small className={styles.changeText}>{item.change}</small> : null}
                  </div>
                  <span className={styles.itemLinks}>
                    {item.productHref ? <Link href={item.productHref}>商品资料</Link> : null}
                    {item.inventoryHref ? <Link href={item.inventoryHref}>商品库存</Link> : null}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {view.tickets.length > 0 ? (
          <div className={styles.block}>
            <h3 className={styles.blockTitle}>涉及货票</h3>
            <ul className={styles.itemList} data-testid="operation-detail-tickets">
              {view.tickets.map((ticket) => (
                <li key={`${ticket.ticketNo}:${ticket.meta}`}>
                  <div>
                    <strong>{ticket.ticketNo}</strong>
                    <small>{ticket.meta}</small>
                  </div>
                  <span className={styles.itemLinks}>
                    {ticket.href ? <Link href={ticket.href}>物流在途</Link> : null}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {view.links.length > 0 ? (
          <div className={styles.entryLinks} data-testid="operation-record-links">
            {view.links.map((entry) => (
              <Link key={`${entry.label}:${entry.href}`} href={entry.href}>{entry.label}</Link>
            ))}
          </div>
        ) : null}

        {view.notes.length > 0 ? (
          <ul className={styles.notes}>
            {view.notes.map((note) => <li key={note}>{note}</li>)}
          </ul>
        ) : null}
      </div>
    </details>
  );
}
