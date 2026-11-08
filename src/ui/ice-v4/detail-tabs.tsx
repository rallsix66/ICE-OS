'use client';

import type { KeyboardEvent } from 'react';
import styles from './detail-tabs.module.css';

/**
 * 详情弹窗页签栏（R15）：把商品库详情既有的页签样式/交互提成共用组件，
 * 商品库、库存两处详情、物流在途详情共用同一视觉与键盘行为，不再各自复制一套。
 *
 * - 页签栏是弹窗外框里的固定行（不参与正文滚动），正文用剩余高度滚动；
 * - 加载中/读取失败时可用 disabled 渲染同一排页签占位，外框与标题位置保持稳定；
 * - 直链页（非弹窗）通过 sticky 让页签栏在长文滚动时保持可见。
 */
export type DetailTabItem = {
  key: string;
  label: string;
};

export function DetailTabs({
  tabs,
  active,
  onSelect,
  ariaLabel,
  idPrefix,
  panelIdPrefix,
  testIdPrefix,
  sticky = false,
  disabled = false,
}: {
  tabs: readonly DetailTabItem[];
  /** 当前选中的页签 key；加载占位时可传本来要停留的分区。 */
  active: string;
  /** 不可用时（加载中）不响应点击；省略时占位页签不可交互。 */
  onSelect?: (key: string) => void;
  ariaLabel: string;
  idPrefix: string;
  panelIdPrefix?: string;
  testIdPrefix?: string;
  sticky?: boolean;
  disabled?: boolean;
}) {
  const interactive = !disabled && typeof onSelect === 'function';

  const activate = (key: string) => {
    if (!interactive) return;
    onSelect?.(key);
  };

  return (
    <div
      className={styles.tabBar}
      role="tablist"
      aria-label={ariaLabel}
      data-testid={testIdPrefix ? `${testIdPrefix}-tabs` : undefined}
      data-sticky={sticky ? 'true' : undefined}
    >
      {tabs.map((entry) => {
        const selected = entry.key === active;
        return (
          <button
            key={entry.key}
            type="button"
            role="tab"
            id={`${idPrefix}-${entry.key}`}
            aria-selected={selected}
            aria-controls={panelIdPrefix ? `${panelIdPrefix}-${entry.key}` : undefined}
            aria-disabled={interactive ? undefined : true}
            tabIndex={selected && interactive ? 0 : -1}
            className={selected ? `${styles.tab} ${styles.tabActive}` : styles.tab}
            data-testid={testIdPrefix ? `${testIdPrefix}-${entry.key}` : undefined}
            onClick={() => activate(entry.key)}
            onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
              if (!interactive) return;
              if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
              event.preventDefault();
              const index = tabs.findIndex((option) => option.key === entry.key);
              const delta = event.key === 'ArrowRight' ? 1 : -1;
              const next = tabs[(index + delta + tabs.length) % tabs.length];
              activate(next.key);
              window.requestAnimationFrame(() => document.getElementById(`${idPrefix}-${next.key}`)?.focus());
            }}
          >
            {entry.label}
          </button>
        );
      })}
    </div>
  );
}
