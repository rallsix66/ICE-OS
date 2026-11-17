'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { X } from 'lucide-react';
import { SearchField, SelectMenu } from '@/ui/ice-v4/data-surface';
import { buildOperationHref } from '../model';
import type { OperationActorDto } from '../types';
import { DateRangePicker } from './date-range-picker';
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
 * 操作记录筛选：搜索（防抖 300ms）/ 记录账号 / 日期范围（面板内选好再应用）。
 * 一律写回 URL（replace，不新增历史），刷新、返回与直接链接都能还原同一份筛选。
 */
export function OperationsFilters({
  query,
  actors,
}: {
  query: OperationFilterQuery;
  actors: OperationActorDto[];
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
    // 日期/账号变更时把输入框里尚未到防抖时间的关键词一起带上，避免刚输入就被旧 URL 覆盖。
    setCommitted(q);
    startTransition(() => {
      router.replace(buildOperationHref(query, { ...patch, q, page: 1 }), { scroll: false });
    });
  }

  const actorOptions = [
    { value: '', label: '全部记录账号' },
    ...actors
      .filter((actor): actor is OperationActorDto & { actorId: string } => Boolean(actor.actorId))
      .map((actor) => ({ value: actor.actorId, label: actor.name })),
  ];
  const dirty = query.category !== 'all' || Boolean(query.actor) || Boolean(query.from) || Boolean(query.to) || Boolean(q);

  return (
    <div className={styles.toolbarWrap}>
      <div className={styles.filters} data-testid="operation-filters">
        <div className={styles.searchWrap}>
          <SearchField
            value={q}
            onChange={setQ}
            placeholder="搜索货号、名称、来源 SKU、货票号或批次号"
            ariaLabel="搜索操作记录"
            testId="operation-search"
            pending={pending}
          />
        </div>
        <div className={styles.actorWrap}>
          <SelectMenu
            value={query.actor}
            onChange={(value) => apply({ actor: value })}
            options={actorOptions}
            ariaLabel="按记录账号筛选"
            testId="operation-actor-filter"
          />
        </div>
        <DateRangePicker
          from={query.from}
          to={query.to}
          onApply={(from, to) => apply({ from, to })}
        />
        <button
          type="button"
          className={styles.clearButton}
          data-testid="operation-clear-filters"
          disabled={!dirty}
          onClick={() => {
            setQ('');
            setCommitted('');
            startTransition(() => {
              router.replace('/dashboard/operations', { scroll: false });
            });
          }}
        >
          <X size={13} strokeWidth={2} aria-hidden />清空
        </button>
      </div>
    </div>
  );
}
