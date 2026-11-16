'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { SearchField, SelectMenu } from '@/ui/ice-v4/data-surface';
import { buildOperationHref, OPERATION_MAX_SEARCH_LENGTH } from '../model';
import type { OperationActorDto } from '../types';
import styles from './operations.module.css';

export interface OperationFilterQuery {
  category: 'all' | 'catalog' | 'inventory' | 'shipment';
  actor: string;
  from: string;
  to: string;
  q: string;
  page: number;
}

/**
 * 操作记录筛选：搜索（防抖 300ms）/ 记录账号 / 起止日期。
 * 一律写回 URL（replace，不新增历史），刷新、返回与直接链接都能还原同一份筛选。
 */
export function OperationsFilters({
  query,
  actors,
  total,
}: {
  query: OperationFilterQuery;
  actors: OperationActorDto[];
  total: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [q, setQ] = useState(query.q);
  const [committed, setCommitted] = useState(query.q);
  // URL 里的关键词变化（浏览器返回、清空、直接链接）时同步输入框；渲染期对齐，不放 effect。
  const [lastUrlQuery, setLastUrlQuery] = useState(query.q);
  if (lastUrlQuery !== query.q) {
    setLastUrlQuery(query.q);
    setCommitted(query.q);
    setQ(query.q);
  }

  useEffect(() => {
    if (q === committed) return;
    const timer = window.setTimeout(() => {
      setCommitted(q);
      startTransition(() => {
        router.replace(buildOperationHref(query, { q, page: 1 }), { scroll: false });
      });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [q, committed, query, router]);

  function apply(patch: Partial<OperationFilterQuery>) {
    startTransition(() => {
      router.replace(buildOperationHref(query, { ...patch, page: 1 }), { scroll: false });
    });
  }

  const totalActorCount = actors.reduce((sum, actor) => sum + actor.count, 0);
  const actorOptions = [
    { value: '', label: `全部记录账号（${totalActorCount} 条）` },
    ...actors
      .filter((actor): actor is OperationActorDto & { actorId: string } => Boolean(actor.actorId))
      .map((actor) => ({ value: actor.actorId, label: `${actor.name}（${actor.count} 条）` })),
  ];

  return (
    <div className={styles.filters} data-testid="operation-filters">
      <SearchField
        value={q}
        onChange={setQ}
        placeholder="货号 / 来源 SKU / 货票号 / 名称"
        ariaLabel="搜索操作记录"
        testId="operation-search"
        pending={pending}
      />
      <SelectMenu
        value={query.actor}
        onChange={(value) => apply({ actor: value })}
        options={actorOptions}
        ariaLabel="按记录账号筛选"
        testId="operation-actor-filter"
      />
      <label className={styles.dateField}>
        <span>开始日期</span>
        <input
          type="date"
          value={query.from}
          max={query.to || undefined}
          data-testid="operation-date-from"
          onChange={(event) => apply({ from: event.target.value })}
        />
      </label>
      <label className={styles.dateField}>
        <span>结束日期</span>
        <input
          type="date"
          value={query.to}
          min={query.from || undefined}
          data-testid="operation-date-to"
          onChange={(event) => apply({ to: event.target.value })}
        />
      </label>
      <button
        type="button"
        className={styles.clearButton}
        data-testid="operation-clear-filters"
        disabled={query.category === 'all' && !query.actor && !query.from && !query.to && !q}
        onClick={() => {
          setQ('');
          setCommitted('');
          startTransition(() => {
            router.replace('/dashboard/operations', { scroll: false });
          });
        }}
      >
        清空
      </button>
      <span className={styles.count} data-testid="operation-count">
        {pending ? '查询中…' : `共 ${total} 条`}
      </span>
      <span className={styles.searchHint}>时间按中国标准时间（+08）</span>
      <span className={styles.searchHint}>最多 {OPERATION_MAX_SEARCH_LENGTH} 个字符</span>
    </div>
  );
}
