'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { Check, ChevronDown, ChevronRight, Loader2, Search, X } from 'lucide-react';
import styles from './data-surface.module.css';

export type SurfaceTone = 'green' | 'amber' | 'red' | 'blue' | 'neutral';

/** 页面主标题：一页只出现一次，替代原来外壳里的 eyebrow + 副标题。 */
export function PageHeading({
  title,
  meta,
  actions,
}: {
  title: string;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className={styles.pageHeading}>
      <div>
        <h1 className={styles.pageTitle}>{title}</h1>
        {meta ? <p className={styles.pageMeta}>{meta}</p> : null}
      </div>
      {actions ? <div className={styles.pageActions}>{actions}</div> : null}
    </header>
  );
}

/** 统一搜索框：输入即回调，可清空；pending 时只显示转圈图标，不写“搜索中”小字。 */
export function SearchField({
  value,
  onChange,
  placeholder,
  ariaLabel,
  testId,
  pending = false,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  ariaLabel: string;
  testId?: string;
  pending?: boolean;
}) {
  return (
    <label className={styles.search} data-testid={testId}>
      <Search size={16} strokeWidth={1.7} aria-hidden />
      <input
        className={styles.searchInput}
        type="search"
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel}
        maxLength={120}
        autoComplete="off"
        onChange={(event) => onChange(event.target.value)}
      />
      {pending ? <Loader2 className={styles.searchBusy} size={14} strokeWidth={2} aria-hidden /> : null}
      {value ? (
        <button
          type="button"
          className={styles.searchClear}
          aria-label="清空搜索"
          onClick={() => onChange('')}
        >
          <X size={14} strokeWidth={2} aria-hidden />
        </button>
      ) : null}
    </label>
  );
}

/** 统一下拉框：原生 select 保留键盘与可访问性，只统一外观。 */
export function ToolbarSelect({
  value,
  onChange,
  ariaLabel,
  testId,
  children,
}: {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <span className={styles.selectWrap}>
      <select
        className={styles.select}
        value={value}
        aria-label={ariaLabel}
        data-testid={testId}
        onChange={(event) => onChange(event.target.value)}
      >
        {children}
      </select>
      <ChevronDown className={styles.selectIcon} size={15} strokeWidth={1.8} aria-hidden />
    </span>
  );
}

export type SelectMenuOption = {
  value: string;
  label: string;
  /** 同组选项渲染在一个小标题下；不传则平铺。 */
  group?: string;
  disabled?: boolean;
};

/**
 * 系统内统一的自定义下拉：按钮 + 弹出列表（不再用原生 select 弹窗）。
 * - 键盘：↑↓ 移动、Home/End、Enter/空格选择、Esc 关闭并回焦；
 * - 选项可分组；选中项带勾；点击外部关闭；
 * - 触发器保留 aria-label，测试用 data-testid 不变。
 */
export function SelectMenu({
  value,
  onChange,
  options,
  ariaLabel,
  testId,
  disabled = false,
  align = 'start',
}: {
  value: string;
  onChange: (value: string) => void;
  options: SelectMenuOption[];
  ariaLabel: string;
  testId?: string;
  disabled?: boolean;
  align?: 'start' | 'end';
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();
  const selected = options.find((option) => option.value === value) ?? null;

  const close = useCallback((focusTrigger: boolean) => {
    setOpen(false);
    setActiveIndex(-1);
    if (focusTrigger) triggerRef.current?.focus();
  }, []);

  /** 打开时直接把高亮定位到当前值（不在 effect 里 setState）。 */
  const openMenu = useCallback(() => {
    const index = options.findIndex((option) => option.value === value);
    setActiveIndex(index >= 0 ? index : options.findIndex((option) => !option.disabled));
    setOpen(true);
  }, [options, value]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, close]);

  useEffect(() => {
    if (!open || activeIndex < 0) return;
    const frame = window.requestAnimationFrame(() => {
      listRef.current?.querySelector<HTMLElement>(`[data-option-index="${activeIndex}"]`)?.scrollIntoView({ block: 'nearest' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, activeIndex]);

  function moveActive(step: number) {
    if (options.length === 0) return;
    let next = activeIndex;
    for (let guard = 0; guard < options.length; guard += 1) {
      next = (next + step + options.length) % options.length;
      if (!options[next].disabled) break;
    }
    setActiveIndex(next);
    listRef.current?.querySelector<HTMLElement>(`[data-option-index="${next}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  function choose(option: SelectMenuOption) {
    if (option.disabled) return;
    if (option.value !== value) onChange(option.value);
    close(true);
  }

  function onTriggerKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (!open) {
        openMenu();
        return;
      }
    }
    if (!open) return;
    if (event.key === 'ArrowDown') moveActive(1);
    else if (event.key === 'ArrowUp') moveActive(-1);
    else if (event.key === 'Home') setActiveIndex(0);
    else if (event.key === 'End') setActiveIndex(options.length - 1);
    else if (event.key === 'Escape') close(true);
    else if (event.key === 'Tab') close(false);
    else if ((event.key === 'Enter' || event.key === ' ') && activeIndex >= 0) {
      const option = options[activeIndex];
      if (option) choose(option);
    }
  }

  return (
    <span className={styles.menuWrap} ref={rootRef} data-testid={testId ? `${testId}-wrap` : undefined}>
      <button
        type="button"
        ref={triggerRef}
        className={styles.menuTrigger}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        data-testid={testId}
        data-value={value}
        disabled={disabled}
        onClick={() => (open ? close(true) : openMenu())}
        onKeyDown={onTriggerKeyDown}
      >
        <span className={styles.menuTriggerText}>{selected?.label ?? '请选择'}</span>
        <ChevronDown className={styles.menuTriggerIcon} size={15} strokeWidth={1.8} aria-hidden />
      </button>
      {open ? (
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={ariaLabel}
          className={`${styles.menuPanel} ${align === 'end' ? styles.menuPanelEnd : ''}`}
          data-testid={testId ? `${testId}-listbox` : undefined}
        >
          {options.map((option, index) => {
            const previousGroup = index > 0 ? options[index - 1].group : undefined;
            const heading = option.group && option.group !== previousGroup ? option.group : null;
            const isActive = index === activeIndex;
            const isSelected = option.value === value;
            return (
              <div key={`${option.group ?? ''}:${option.value}`} className={styles.menuItemWrap}>
                {heading ? <p className={styles.menuGroup}>{heading}</p> : null}
                <button
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  aria-disabled={option.disabled || undefined}
                  data-option-index={index}
                  data-value={option.value}
                  className={[
                    styles.menuOption,
                    isActive ? styles.menuOptionActive : '',
                    isSelected ? styles.menuOptionSelected : '',
                  ].filter(Boolean).join(' ')}
                  onPointerEnter={() => setActiveIndex(index)}
                  onClick={() => choose(option)}
                >
                  <span className={styles.menuOptionLabel}>{option.label}</span>
                  {isSelected ? <Check className={styles.menuOptionCheck} size={14} strokeWidth={2.2} aria-hidden /> : null}
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
    </span>
  );
}

/** 自绘勾选：保留原生 input 的语义与键盘行为，只改外观。 */
export function Checkbox({
  checked,
  onChange,
  label,
  ariaLabel,
  testId,
  disabled = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  ariaLabel?: string;
  testId?: string;
  disabled?: boolean;
}) {
  return (
    <label className={styles.checkboxLine} data-disabled={disabled ? 'true' : undefined}>
      <input
        type="checkbox"
        className={styles.checkboxInput}
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        data-testid={testId}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className={styles.checkboxBox} aria-hidden />
      {label ? <span className={styles.checkboxLabel}>{label}</span> : null}
    </label>
  );
}

/** 折叠区：原生 details 语义 + 自绘箭头，不再出现系统三角和说明句。 */
export function Disclosure({
  summary,
  count,
  children,
  defaultOpen = false,
  testId,
  tone = 'neutral',
}: {
  summary: ReactNode;
  count?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  testId?: string;
  tone?: 'neutral' | 'warn';
}) {
  return (
    <details className={styles.disclosure} data-tone={tone} open={defaultOpen} data-testid={testId}>
      <summary className={styles.disclosureSummary}>
        <ChevronRight className={styles.disclosureChevron} size={15} strokeWidth={2} aria-hidden />
        <span className={styles.disclosureLabel}>{summary}</span>
        {count !== undefined ? <span className={styles.disclosureCount}>{count}</span> : null}
      </summary>
      <div className={styles.disclosureBody}>{children}</div>
    </details>
  );
}

/** 状态点 + 短状态文字；状态只用词，不用句子解释。 */
export function StatusDot({ tone = 'neutral', children }: { tone?: SurfaceTone; children: ReactNode }) {
  return (
    <span className={styles.statusLine}>
      <span className={styles.statusDot} data-tone={tone} aria-hidden />
      <span>{children}</span>
    </span>
  );
}

/** 空态：一句标题 + 一句短提示，不放长解释。 */
export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className={styles.empty} role="status">
      <strong>{title}</strong>
      {hint ? <p>{hint}</p> : null}
      {action}
    </div>
  );
}

/** 简单筛选标签（可点击清除）；各页面自己拼 href。 */
export function FilterChip({ href, children, testId }: { href: string; children: ReactNode; testId?: string }) {
  return (
    <Link className={styles.chip} href={href} data-testid={testId}>
      {children}
      <X className={styles.chipClear} size={12} strokeWidth={2} aria-hidden />
    </Link>
  );
}
