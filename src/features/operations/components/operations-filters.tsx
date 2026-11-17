'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { SearchField, SelectMenu } from '@/ui/ice-v4/data-surface';
import surface from '@/ui/ice-v4/data-surface.module.css';
import { buildOperationHref } from '../model';
import type { OperationActorDto } from '../types';
import { SingleDayPicker } from './single-day-picker';
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
 * 操作记录筛选：搜索（防抖 300ms）/ 记录账号 / 开始日期 / 结束日期。
 *
 * - 日期为两个独立的单日控件，共用页面内单日历弹窗，按开始、结束分别查询；
 * - 一律写回 URL（replace，不新增历史），刷新、返回与直接链接都能还原同一份筛选；
 * - 控件高度、间距与「商品库存」工具栏一致，清空按钮用系统共用样式。
 */
export function OperationsFilters({
  query,
  actors,
  total,
}: {
  query: OperationFilterQuery;
  actors: OperationActorDto[];
  /** 当前筛选结果总数（null = 读取失败或日期无效，不显示假数字）。 */
  total: number | null;
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
    <section className={styles.toolbarWrap} data-testid="operation-filters">
      <div className={surface.toolbar}>
        <SearchField
          value={q}
          onChange={setQ}
          placeholder="搜索货号、名称、来源 SKU、货票号或批次号"
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
        <div className={styles.dateGroup} data-testid="operation-date-range">
          <SingleDayPicker
            label="开始日期"
            value={query.from}
            fallback={query.to}
            testId="operation-date-from"
            onChange={(from) => apply({ from })}
          />
          <span className={styles.dateSep} aria-hidden>—</span>
          <SingleDayPicker
            label="结束日期"
            value={query.to}
            fallback={query.from}
            testId="operation-date-to"
            onChange={(to) => apply({ to })}
          />
        </div>
        <button
          type="button"
          className={surface.button}
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
          清空
        </button>
        <span className={surface.count} data-testid="operation-current-count">
          {total === null ? '' : `共 ${total} 条`}
        </span>
      </div>
    </section>
  );
}
