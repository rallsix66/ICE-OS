'use client';

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DayPicker, type ClassNames, type DateRange } from 'react-day-picker';
import { zhCN } from 'react-day-picker/locale';
import { format } from 'date-fns';
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight, X } from 'lucide-react';
import {
  beijingTodayIso,
  dateRangeLabel,
  dateToIso,
  isoToDate,
  parseDateInput,
  quickDateRange,
} from '../date-range';
import styles from './operations.module.css';

const CALENDAR_CLASS_NAMES = {
  root: styles.rdpRoot,
  months: styles.rdpMonths,
  month: styles.rdpMonth,
  month_caption: styles.rdpMonthCaption,
  caption_label: styles.rdpCaptionLabel,
  dropdowns: styles.rdpDropdowns,
  dropdown: styles.rdpDropdown,
  dropdown_root: styles.rdpDropdownRoot,
  nav: styles.rdpNav,
  button_previous: styles.rdpNavButton,
  button_next: styles.rdpNavButton,
  month_grid: styles.rdpMonthGrid,
  weekdays: styles.rdpWeekdays,
  weekday: styles.rdpWeekday,
  week: styles.rdpWeek,
  day: styles.rdpDay,
  day_button: styles.rdpDayButton,
  selected: styles.rdpSelected,
  range_start: styles.rdpRangeStart,
  range_middle: styles.rdpRangeMiddle,
  range_end: styles.rdpRangeEnd,
  today: styles.rdpToday,
  outside: styles.rdpOutside,
  focused: styles.rdpFocused,
  chevron: styles.rdpChevron,
} satisfies Partial<ClassNames>;

/**
 * 操作记录日期范围选择器。
 *
 * - 触发器只显示**已应用**的范围；面板内是待应用范围，点「应用」才改 URL。
 * - 底层使用 react-day-picker（中文 locale / 区间选择 / 键盘选日），外观沿用 ICE v4。
 * - 面板通过 portal + fixed 定位，避免被工具栏或页面容器裁切。
 * - 起止日期也可用 YYYY-MM-DD 文本输入；不调用任何系统日期弹窗。
 */
export function DateRangePicker({
  from,
  to,
  onApply,
}: {
  from: string;
  to: string;
  onApply: (from: string, to: string) => void;
}) {
  const todayIso = beijingTodayIso();
  const [open, setOpen] = useState(false);
  const [fromText, setFromText] = useState(from);
  const [toText, setToText] = useState(to);
  const [error, setError] = useState('');
  const [viewMonth, setViewMonth] = useState<Date>(isoToDate(from || to || todayIso));
  const [coords, setCoords] = useState<{ top: number; left: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const panelId = useId();

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    setError('');
    setFromText(from);
    setToText(to);
    if (restoreFocus) {
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    }
  }, [from, to, setError, setFromText, setOpen, setToText]);

  const openPanel = useCallback(() => {
    setFromText(from);
    setToText(to);
    setError('');
    setViewMonth(isoToDate(from || to || beijingTodayIso()));
    setCoords(null);
    setOpen(true);
  }, [from, to, setCoords, setError, setFromText, setOpen, setToText, setViewMonth]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      close(false);
    };
    const onDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close(true);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onDocumentKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onDocumentKeyDown);
    };
  }, [open, close]);

  const focusedOnce = useRef(false);
  useEffect(() => {
    if (!open) {
      focusedOnce.current = false;
      return;
    }
    if (!coords || focusedOnce.current) return;
    const panel = panelRef.current;
    const target = panel?.querySelector<HTMLElement>('[class*="rdpSelected"] button')
      ?? panel?.querySelector<HTMLElement>('[class*="rdpToday"] button')
      ?? panel?.querySelector<HTMLElement>('[class*="rdpDay"] button');
    if (target) {
      target.focus();
      focusedOnce.current = true;
    }
  }, [open, coords]);

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const trigger = triggerRef.current;
      const panel = panelRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const width = Math.min(368, window.innerWidth - 24);
      const panelHeight = panel?.offsetHeight ?? 500;
      const left = Math.min(Math.max(12, rect.right - width), window.innerWidth - width - 12);
      // 优先在触发器下方展开；下方空间不足时整体上移，但保证面板完整留在视口内。
      const top = Math.min(rect.bottom + 8, Math.max(12, window.innerHeight - panelHeight - 12));
      setCoords({ top, left, width });
    };
    update();
    const observer = panelRef.current ? new ResizeObserver(update) : null;
    if (panelRef.current && observer) observer.observe(panelRef.current);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open]);

  const parsedFrom = parseDateInput(fromText);
  const parsedTo = parseDateInput(toText);
  const fromIso = parsedFrom.valid ? parsedFrom.iso : '';
  const toIso = parsedTo.valid ? parsedTo.iso : '';
  const selected: DateRange | undefined = fromIso
    ? { from: isoToDate(fromIso), to: toIso ? isoToDate(toIso) : undefined }
    : toIso
      ? { from: isoToDate(toIso), to: isoToDate(toIso) }
      : undefined;

  function handleSelect(range: DateRange | undefined) {
    setError('');
    if (!range?.from) {
      setFromText('');
      setToText('');
      return;
    }
    setFromText(dateToIso(range.from));
    setToText(range.to ? dateToIso(range.to) : '');
  }

  function setQuickRange(days: number | null) {
    setError('');
    if (days === null) {
      setFromText('');
      setToText('');
      return;
    }
    const range = quickDateRange(days, todayIso);
    setFromText(range.from);
    setToText(range.to);
    setViewMonth(isoToDate(range.from));
  }

  function apply() {
    const start = parseDateInput(fromText);
    const end = parseDateInput(toText);
    if (!start.valid) {
      setError('开始日期格式应为 YYYY-MM-DD，例如 2026-11-01。');
      return;
    }
    if (!end.valid) {
      setError('结束日期格式应为 YYYY-MM-DD，例如 2026-11-17。');
      return;
    }
    if (start.iso && end.iso && start.iso > end.iso) {
      setError('开始日期不能晚于结束日期；请调整后重试。');
      return;
    }
    onApply(start.iso, end.iso);
    setOpen(false);
    setError('');
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  }

  function onPanelKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    }
  }

  const active = Boolean(from || to);
  const last7 = quickDateRange(7, todayIso);
  const last30 = quickDateRange(30, todayIso);
  const quick7Active = fromText === last7.from && toText === last7.to;
  const quick30Active = fromText === last30.from && toText === last30.to;

  return (
    <div className={styles.datePicker}>
      <button
        type="button"
        ref={triggerRef}
        className={`${styles.dateTrigger} ${active ? styles.dateTriggerActive : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={`日期范围：${dateRangeLabel(from, to)}`}
        data-testid="operation-date-trigger"
        data-value={`${from}|${to}`}
        onClick={() => (open ? close(true) : openPanel())}
      >
        <CalendarDays size={15} strokeWidth={1.8} aria-hidden />
        <span className={styles.dateTriggerText}>{dateRangeLabel(from, to)}</span>
        <ChevronDown className={styles.dateTriggerChevron} size={14} strokeWidth={1.8} aria-hidden />
      </button>

      {open && typeof document !== 'undefined' ? createPortal(
        <div
          id={panelId}
          ref={panelRef}
          role="dialog"
          aria-modal="false"
          aria-label="选择日期范围"
          className={styles.datePanel}
          data-testid="operation-date-panel"
          style={{
            top: coords?.top ?? 0,
            left: coords?.left ?? 0,
            width: coords?.width ?? 368,
            visibility: coords ? 'visible' : 'hidden',
          }}
          onKeyDown={onPanelKeyDown}
        >
          <div className={styles.datePanelHead}>
            <strong>选择日期范围</strong>
            <button
              type="button"
              className={styles.datePanelClose}
              aria-label="关闭日期范围"
              onClick={() => close(true)}
            >
              <X size={15} strokeWidth={1.9} aria-hidden />
            </button>
          </div>

          <div className={styles.dateQuick} aria-label="快捷范围">
            <button
              type="button"
              className={quick7Active ? `${styles.dateQuickButton} ${styles.dateQuickButtonActive}` : styles.dateQuickButton}
              aria-pressed={quick7Active}
              data-testid="operation-date-quick-7"
              onClick={() => setQuickRange(7)}
            >
              近 7 天
            </button>
            <button
              type="button"
              className={quick30Active ? `${styles.dateQuickButton} ${styles.dateQuickButtonActive}` : styles.dateQuickButton}
              aria-pressed={quick30Active}
              data-testid="operation-date-quick-30"
              onClick={() => setQuickRange(30)}
            >
              近 30 天
            </button>
            <button
              type="button"
              className={!fromText && !toText ? `${styles.dateQuickButton} ${styles.dateQuickButtonActive}` : styles.dateQuickButton}
              aria-pressed={!fromText && !toText}
              data-testid="operation-date-quick-none"
              onClick={() => setQuickRange(null)}
            >
              不限日期
            </button>
          </div>

          <div className={styles.calendar}>
            <DayPicker
              mode="range"
              selected={selected}
              onSelect={handleSelect}
              month={viewMonth}
              onMonthChange={setViewMonth}
              defaultMonth={viewMonth}
              startMonth={new Date(2020, 0, 1)}
              endMonth={new Date(isoToDate(todayIso).getFullYear(), isoToDate(todayIso).getMonth(), 1)}
              captionLayout="dropdown"
              navLayout="around"
              locale={zhCN}
              formatters={{
                formatMonthDropdown: (month) => format(month, 'M月'),
                formatYearDropdown: (year) => format(year, 'yyyy年'),
              }}
              weekStartsOn={1}
              showOutsideDays
              fixedWeeks
              autoFocus
              today={isoToDate(todayIso)}
              classNames={CALENDAR_CLASS_NAMES}
              components={{
                Chevron: ({ orientation }) => (
                  orientation === 'left'
                    ? <ChevronLeft size={15} strokeWidth={1.9} aria-hidden />
                    : orientation === 'right'
                      ? <ChevronRight size={15} strokeWidth={1.9} aria-hidden />
                      : <ChevronDown size={14} strokeWidth={1.9} aria-hidden />
                ),
              }}
            />
          </div>

          <div className={styles.manualRange}>
            <label className={styles.manualField}>
              <span>开始日期</span>
              <input
                type="text"
                inputMode="numeric"
                autoComplete="off"
                maxLength={10}
                placeholder="YYYY-MM-DD"
                value={fromText}
                aria-label="开始日期（YYYY-MM-DD）"
                aria-invalid={!parsedFrom.valid || undefined}
                data-testid="operation-date-from-input"
                onChange={(event) => {
                  setFromText(event.target.value);
                  if (error) setError('');
                }}
              />
            </label>
            <span className={styles.manualDash} aria-hidden>至</span>
            <label className={styles.manualField}>
              <span>结束日期</span>
              <input
                type="text"
                inputMode="numeric"
                autoComplete="off"
                maxLength={10}
                placeholder="YYYY-MM-DD"
                value={toText}
                aria-label="结束日期（YYYY-MM-DD）"
                aria-invalid={!parsedTo.valid || undefined}
                data-testid="operation-date-to-input"
                onChange={(event) => {
                  setToText(event.target.value);
                  if (error) setError('');
                }}
              />
            </label>
          </div>

          {error ? <p className={styles.dateError} role="alert" data-testid="operation-date-error">{error}</p> : null}

          <div className={styles.datePanelFoot}>
            <span className={styles.datePanelHint}>结束日期包含当天</span>
            <div className={styles.datePanelActions}>
              <button type="button" className={styles.dateCancel} data-testid="operation-date-cancel" onClick={() => close(true)}>
                取消
              </button>
              <button type="button" className={styles.dateApply} data-testid="operation-date-apply" onClick={apply}>
                应用
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
