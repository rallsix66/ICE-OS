'use client';

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DayPicker, type ClassNames } from 'react-day-picker';
import { zhCN } from 'react-day-picker/locale';
import { addMonths, addYears, format } from 'date-fns';
import { CalendarDays, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, X } from 'lucide-react';
import { beijingTodayIso, dateToIso, isoToDate } from '../calendar-date';
import styles from './operations.module.css';

const CALENDAR_CLASS_NAMES = {
  root: styles.rdpRoot,
  months: styles.rdpMonths,
  month: styles.rdpMonth,
  month_caption: styles.rdpMonthCaption,
  month_grid: styles.rdpMonthGrid,
  weekdays: styles.rdpWeekdays,
  weekday: styles.rdpWeekday,
  week: styles.rdpWeek,
  day: styles.rdpDay,
  day_button: styles.rdpDayButton,
  selected: styles.rdpSelected,
  today: styles.rdpToday,
  outside: styles.rdpOutside,
  focused: styles.rdpFocused,
  nav: styles.rdpNav,
} satisfies Partial<ClassNames>;

const PANEL_WIDTH = 312;

/**
 * 操作记录的单日选择控件：输入框外观 + 页面内单日历弹窗。
 *
 * - 开始日期、结束日期各用一个实例，共用同一个组件；
 * - 打开时定位到已选日期（没有则看另一侧日期，再没有则今天），可切年/月；
 * - 点某天立即回调并关闭，没有“应用/取消”；
 * - 输入框内可单独清空这一侧；
 * - 弹窗 portal 到 body、fixed 定位，桌面与 760 宽都保证完整落在视口内。
 */
export function SingleDayPicker({
  label,
  value,
  onChange,
  testId,
  fallback = '',
}: {
  label: string;
  /** 'YYYY-MM-DD'，'' = 未选择。 */
  value: string;
  /** 选中某天或清空时立即回调。 */
  onChange: (iso: string) => void;
  testId: string;
  /** 本侧未选时，用另一侧日期决定首次打开的月份。 */
  fallback?: string;
}) {
  const [open, setOpen] = useState(false);
  const [viewMonth, setViewMonth] = useState<Date>(() => isoToDate(value || fallback || beijingTodayIso()));
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const panelId = useId();
  const todayIso = beijingTodayIso();

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    setCoords(null);
    if (restoreFocus) {
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    }
  }, []);

  const openPanel = useCallback(() => {
    setViewMonth(isoToDate(value || fallback || beijingTodayIso()));
    setCoords(null);
    setOpen(true);
  }, [value, fallback]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      close(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close(true);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, close]);

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const trigger = triggerRef.current;
      const panel = panelRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const width = Math.min(PANEL_WIDTH, window.innerWidth - 24);
      const panelHeight = panel?.offsetHeight ?? 360;
      const left = Math.min(Math.max(12, rect.left), window.innerWidth - width - 12);
      // 优先在输入框下方展开；下方放不下时改到上方，最后再夹在视口内。
      const below = rect.bottom + 8;
      const above = rect.top - panelHeight - 8;
      const top = below + panelHeight <= window.innerHeight - 12
        ? below
        : Math.min(Math.max(12, above), Math.max(12, window.innerHeight - panelHeight - 12));
      setCoords({ top, left });
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

  useEffect(() => {
    if (!open || !coords) return;
    const frame = window.requestAnimationFrame(() => {
      const panel = panelRef.current;
      const target = panel?.querySelector<HTMLButtonElement>('td[data-selected="true"] button')
        ?? panel?.querySelector<HTMLButtonElement>('td[data-today="true"] button')
        ?? panel?.querySelector<HTMLButtonElement>('td[data-day] button');
      target?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, coords]);

  function choose(date: Date | undefined) {
    if (!date) return;
    const iso = dateToIso(date);
    if (iso !== value) onChange(iso);
    close(true);
  }

  function clearValue() {
    if (!value) return;
    onChange('');
    close(false);
  }

  return (
    <div className={styles.dateControl} data-open={open ? 'true' : undefined}>
      <button
        type="button"
        ref={triggerRef}
        className={styles.dateTrigger}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={`${label}：${value || '未选择'}`}
        data-testid={testId}
        data-value={value}
        onClick={() => (open ? close(true) : openPanel())}
      >
        <CalendarDays className={styles.dateIcon} size={15} strokeWidth={1.8} aria-hidden />
        <span className={styles.dateLabel}>{label}</span>
        <span className={value ? styles.dateValue : styles.datePlaceholder}>{value || '选择日期'}</span>
      </button>
      {value ? (
        <button
          type="button"
          className={styles.dateClear}
          aria-label={`清空${label}`}
          data-testid={`${testId}-clear`}
          onClick={clearValue}
        >
          <X size={13} strokeWidth={2} aria-hidden />
        </button>
      ) : null}

      {open && typeof document !== 'undefined'
        ? createPortal(
            <div
              id={panelId}
              ref={panelRef}
              role="dialog"
              aria-modal="false"
              aria-label={`选择${label}`}
              className={styles.datePanel}
              data-testid={`${testId}-panel`}
              style={{
                top: coords?.top ?? 0,
                left: coords?.left ?? 0,
                width: PANEL_WIDTH,
                visibility: coords ? 'visible' : 'hidden',
              }}
            >
              <div className={styles.calHeader}>
                <div className={styles.calNavGroup}>
                  <button
                    type="button"
                    className={styles.calNavButton}
                    aria-label="上一年"
                    onClick={() => setViewMonth(addYears(viewMonth, -1))}
                  >
                    <ChevronsLeft size={15} strokeWidth={1.9} aria-hidden />
                  </button>
                  <button
                    type="button"
                    className={styles.calNavButton}
                    aria-label="上个月"
                    onClick={() => setViewMonth(addMonths(viewMonth, -1))}
                  >
                    <ChevronLeft size={15} strokeWidth={1.9} aria-hidden />
                  </button>
                </div>
                <span className={styles.calTitle} data-testid="calendar-title">
                  {format(viewMonth, 'yyyy年M月')}
                </span>
                <div className={styles.calNavGroup}>
                  <button
                    type="button"
                    className={styles.calNavButton}
                    aria-label="下个月"
                    onClick={() => setViewMonth(addMonths(viewMonth, 1))}
                  >
                    <ChevronRight size={15} strokeWidth={1.9} aria-hidden />
                  </button>
                  <button
                    type="button"
                    className={styles.calNavButton}
                    aria-label="下一年"
                    onClick={() => setViewMonth(addYears(viewMonth, 1))}
                  >
                    <ChevronsRight size={15} strokeWidth={1.9} aria-hidden />
                  </button>
                </div>
              </div>

              <div className={styles.calendar}>
                <DayPicker
                  mode="single"
                  required
                  selected={value ? isoToDate(value) : undefined}
                  onSelect={choose}
                  month={viewMonth}
                  onMonthChange={setViewMonth}
                  defaultMonth={viewMonth}
                  startMonth={new Date(2020, 0, 1)}
                  endMonth={new Date(2035, 11, 1)}
                  locale={zhCN}
                  weekStartsOn={1}
                  showOutsideDays
                  fixedWeeks
                  today={isoToDate(todayIso)}
                  classNames={CALENDAR_CLASS_NAMES}
                />
              </div>

              <div className={styles.calFoot}>
                <span>北京时间</span>
                <button
                  type="button"
                  className={styles.calToday}
                  data-testid={`${testId}-today`}
                  onClick={() => {
                    if (todayIso !== value) onChange(todayIso);
                    close(true);
                  }}
                >
                  今天
                </button>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
