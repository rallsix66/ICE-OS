'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, X } from 'lucide-react';
import { lockPageScroll } from './scroll-lock';
import styles from './pending-entry.module.css';

/**
 * 五个主页面统一的「待处理」入口（以 ICE 商品库原有按钮为样板）。
 *
 * - 整块可点；同一图标、字号、按钮样式与数量徽标；
 * - 有待办显示数量；确实为零保留按钮，点开弹窗显示「暂无待处理事项」；
 * - 读取失败显示「读取失败」，弹窗内可重试；
 * - 点击一律打开**整页居中弹窗**（与物流复核弹窗同一视觉语言）：遮罩覆盖整页、
 *   标题与关闭按钮固定、正文独立滚动、Esc/点遮罩关闭、关闭后焦点回到按钮；
 * - 内容由调用方以 render prop（`panel`）提供；入口本身也支持 `onOpen` 交给页面
 *   打开已有弹窗（物流在途整页居中复核弹窗）。
 */

export type PendingEntryState = 'ok' | 'failed';

export interface PendingEntryPanelContext {
  close: () => void;
}

export interface PendingEntryProps {
  /** 待办数量；state='ok' 且 >0 时显示数字徽标，0 不显示数字（按钮保留）。 */
  count: number | null;
  /** ok = 已读到数量；failed = 读取失败（显示「读取失败」）。 */
  state?: PendingEntryState;
  label?: string;
  /** 覆盖徽标文案（经营总览写「N 类」、数据同步卡片写「N 项」）。 */
  badgeText?: string;
  /** 动作模式：点击执行（如打开页面已有的物流复核弹窗），不弹本组件的弹窗。 */
  onOpen?: () => void;
  /** 弹窗内容；`close` 用于内容里的动作先关弹窗。 */
  panel?: (context: PendingEntryPanelContext) => ReactNode;
  /** 弹窗标题（默认「待处理」）。 */
  panelTitle?: string;
  panelHint?: string;
  /** 弹窗宽度（默认 920）。 */
  panelWidth?: number;
  testId: string;
  emptyText?: string;
  failureText?: string;
  /** 读取失败时的重试入口（弹窗内显示）。 */
  onRetry?: () => void;
  retrying?: boolean;
  /**
   * 数量为 0 时仍然渲染 panel（调用方自己给「已清空」空态）。
   * 商品库待处理需要它：处理完最后一项时，成功提示与「待处理已清空」必须同时可见。
   */
  renderPanelWhenEmpty?: boolean;
}

export function PendingEntry({
  count,
  state = 'ok',
  label = '待处理',
  badgeText,
  onOpen,
  panel,
  panelTitle,
  panelHint,
  panelWidth = 920,
  testId,
  emptyText = '暂无待处理事项',
  failureText = '读取失败',
  onRetry,
  retrying = false,
  renderPanelWhenEmpty = false,
}: PendingEntryProps) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- portal 只能在客户端挂载后渲染
    setMounted(true);
  }, []);

  const close = useCallback(() => setOpen(false), []);

  const openDialog = useCallback(() => {
    if (onOpen && !panel) {
      onOpen();
      return;
    }
    setOpen(true);
  }, [onOpen, panel]);

  useEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    // 锁滚动时补上滚动条宽度：开关弹窗时背景不横移；关闭后回到原滚动位置。
    const releaseScroll = lockPageScroll();
    const frame = requestAnimationFrame(() => closeRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close();
    };
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && dialogRef.current?.contains(target)) return;
      close();
    };
    window.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown, true);
      releaseScroll();
      requestAnimationFrame(() => trigger?.focus({ preventScroll: true }));
    };
  }, [open, close]);

  const accessibleLabel = label.trim() || panelTitle || '待处理';
  const badge = state === 'failed'
    ? <span className={styles.failure}>{failureText}</span>
    : count !== null && count > 0
      ? <span className={styles.badge} data-testid={`${testId}-count`}>{badgeText ?? count}</span>
      : null;

  const dialog = mounted && open && typeof document !== 'undefined'
    ? createPortal((
      <div className={styles.backdrop} data-testid={`${testId}-backdrop`}>
        <section
          ref={dialogRef}
          className={styles.dialog}
          style={{ width: `min(${panelWidth}px, calc(100vw - 40px))` }}
          role="dialog"
          aria-modal="true"
          aria-labelledby={`${testId}-title`}
          data-testid={`${testId}-panel`}
        >
          <header className={styles.dialogHead}>
            <div>
              <h2 id={`${testId}-title`} className={styles.dialogTitle}>{panelTitle ?? accessibleLabel}</h2>
              <p className={styles.dialogSub}>
                {state === 'failed'
                  ? failureText
                  : count !== null && count > 0
                    ? panelHint ?? `${count} 项待处理`
                    : emptyText}
              </p>
            </div>
            <button
              type="button"
              ref={closeRef}
              className={styles.dialogClose}
              onClick={close}
              aria-label={`关闭${accessibleLabel}`}
              data-testid={`${testId}-close`}
            >
              <X size={18} aria-hidden />
            </button>
          </header>
          <div className={styles.dialogBody}>
            {state === 'failed' ? (
              <div className={styles.dialogEmpty}>
                <p>{failureText}</p>
                {onRetry ? (
                  <button type="button" className={styles.retry} onClick={onRetry} disabled={retrying}>
                    {retrying ? '重试中' : '重试读取'}
                  </button>
                ) : null}
              </div>
            ) : count === null || (count === 0 && !renderPanelWhenEmpty) || !panel ? (
              <p className={styles.emptyText}>{emptyText}</p>
            ) : (
              panel({ close })
            )}
          </div>
        </section>
      </div>
    ), document.body)
    : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={styles.entry}
        onClick={openDialog}
        data-testid={testId}
        aria-haspopup="dialog"
        aria-label={accessibleLabel}
        title={count !== null && count > 0 ? `${accessibleLabel} ${badgeText ?? count}` : emptyText}
      >
        <AlertCircle size={15} strokeWidth={1.8} aria-hidden />
        {label.trim() ? <span>{label}</span> : null}
        {badge}
      </button>
      {dialog}
    </>
  );
}

/** 弹窗分组：标题 + 说明 + 子项。 */
export function PendingGroup({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className={styles.group}>
      <header className={styles.groupHead}>
        <h3>{title}</h3>
        {hint ? <p>{hint}</p> : null}
      </header>
      <ul className={styles.groupItems}>{children}</ul>
    </section>
  );
}

/** 弹窗单项：主文案 + 说明 + 右侧动作（链接或按钮）。 */
export function PendingItem({
  title,
  detail,
  meta,
  action,
}: {
  title: ReactNode;
  detail?: ReactNode;
  meta?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <li className={styles.item}>
      <div className={styles.itemInfo}>
        <span className={styles.itemTitle}>{title}</span>
        {detail ? <span className={styles.itemDetail}>{detail}</span> : null}
        {meta ? <span className={styles.itemMeta}>{meta}</span> : null}
      </div>
      {action ? <div className={styles.itemAction}>{action}</div> : null}
    </li>
  );
}
