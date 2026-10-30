'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronsLeftRight, ChevronsUpDown, SlidersHorizontal } from 'lucide-react';
import { Checkbox } from './data-surface';
import styles from './table-tools.module.css';

export type SortDir = 'asc' | 'desc';
export type SortState = { key: string; dir: SortDir } | null;

export type TableColumn = {
  key: string;
  label: string;
  /** 数值列：排序箭头默认从大到小，单元格右对齐由页面样式负责。 */
  numeric?: boolean;
  /** 操作/主标识列可设为 false，不出现在「显示列」里也不允许隐藏。 */
  hideable?: boolean;
  /** 不可排序列（如「操作」）：保留表头与列宽拖拽，但不显示排序按钮。 */
  sortable?: boolean;
  /** 固定宽度列（如「操作」）不显示拖拽分界线。 */
  resizable?: boolean;
  /** 默认列宽：px 数字，或百分比字符串（如 '33%'）。百分比列随表格宽度伸缩，拖拽后覆盖为 px。 */
  width?: number | string;
};

type StoredLayout = {
  hidden: string[];
  /** 列宽：百分比字符串（默认/跟随表格宽度）或像素数字（拖拽后即时值）。 */
  widths: Record<string, number | string>;
  /** undefined = 用户从未改过排序（用调用方的 defaultSort）；null = 用户显式取消排序。 */
  sort?: SortState;
};

const SERVER_LAYOUT: StoredLayout = { hidden: [], widths: {} };
/** 布局记忆版本：v2 起列宽默认是百分比，旧的像素布局不再兼容（读到时回默认值）。 */
const STORAGE_VERSION = 2;

const layoutCache = new Map<string, StoredLayout>();
const layoutListeners = new Map<string, Set<() => void>>();

function readLayout(storageKey: string): StoredLayout {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return SERVER_LAYOUT;
    const parsed = JSON.parse(raw) as Partial<StoredLayout> & { version?: number };
    if (parsed.version !== STORAGE_VERSION) return SERVER_LAYOUT;
    return {
      hidden: Array.isArray(parsed.hidden) ? parsed.hidden : [],
      widths: parsed.widths && typeof parsed.widths === 'object' ? parsed.widths : {},
      sort: parsed.sort === undefined ? undefined : parsed.sort,
    };
  } catch {
    return SERVER_LAYOUT;
  }
}

function getLayout(storageKey: string): StoredLayout {
  const cached = layoutCache.get(storageKey);
  if (cached) return cached;
  const loaded = readLayout(storageKey);
  layoutCache.set(storageKey, loaded);
  return loaded;
}

function emitLayout(storageKey: string) {
  for (const listener of layoutListeners.get(storageKey) ?? []) listener();
}

function setLayout(storageKey: string, patch: Partial<StoredLayout>) {
  const next = { ...getLayout(storageKey), ...patch };
  layoutCache.set(storageKey, next);
  try {
    window.localStorage.setItem(storageKey, JSON.stringify({ ...next, version: STORAGE_VERSION }));
  } catch {
    // 隐私模式/配额满：布局照常生效，只是不记忆。
  }
  emitLayout(storageKey);
}

function subscribeLayout(storageKey: string, listener: () => void) {
  const set = layoutListeners.get(storageKey) ?? new Set<() => void>();
  set.add(listener);
  layoutListeners.set(storageKey, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) layoutListeners.delete(storageKey);
  };
}

/**
 * 表格基础能力：排序、显示列、列宽。三张表共用同一套状态与记忆规则。
 *
 * - 排序按列循环：未排 → 升序 → 降序 → 未排；
 * - 显示列与列宽写 localStorage（按 storageKey 区分表/视图）；
 * - 布局状态放在组件外的 store 里（useSyncExternalStore），避免 effect 里 setState 造成的二次渲染，
 *   也避免服务端首帧读到 null 后在客户端闪烁；
 * - columns 传入当前表所有列（含不可隐藏列，hideable=false）。
 */
export function useTableControls({
  storageKey,
  columns,
  defaultSort = null,
}: {
  storageKey: string;
  columns: TableColumn[];
  defaultSort?: SortState;
}) {
  const stored = useSyncExternalStore(
    useCallback((onStoreChange: () => void) => subscribeLayout(storageKey, onStoreChange), [storageKey]),
    useCallback(() => getLayout(storageKey), [storageKey]),
    useCallback(() => SERVER_LAYOUT, []),
  );

  const keys = new Set(columns.map((column) => column.key));
  const hideable = new Set(columns.filter((column) => column.hideable !== false).map((column) => column.key));
  const hidden = stored.hidden.filter((key) => keys.has(key) && hideable.has(key));
  const widths = Object.fromEntries(Object.entries(stored.widths).filter(([key]) => keys.has(key)));
  const fallbackSort = defaultSort && keys.has(defaultSort.key) ? defaultSort : null;
  const sort: SortState = stored.sort === undefined
    ? fallbackSort
    : stored.sort === null
      ? null
      : keys.has(stored.sort.key) ? stored.sort : null;

  const toggleSort = useCallback((key: string) => {
    const current = getLayout(storageKey).sort;
    const effective = current === undefined ? fallbackSort : current;
    const column = columns.find((entry) => entry.key === key);
    const next: SortState = !effective || effective.key !== key
      ? { key, dir: column?.numeric ? 'desc' : 'asc' }
      : effective.dir === 'asc' ? { key, dir: 'desc' } : null;
    setLayout(storageKey, { sort: next });
  }, [columns, fallbackSort, storageKey]);

  /** 拖拽结果：像素数字或百分比字符串。百分比列随表格宽度伸缩，拖动时按表格宽度换算。 */
  const setWidth = useCallback((key: string, width: number | string) => {
    const current = getLayout(storageKey).widths;
    const value = typeof width === 'number'
      ? Math.round(Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, width)))
      : width;
    setLayout(storageKey, { widths: { ...current, [key]: value } });
  }, [storageKey]);

  const resetWidths = useCallback(() => setLayout(storageKey, { widths: {} }), [storageKey]);

  /** 双击表头分界线：只清掉这一列的记住宽度，回落到列定义里的默认宽度。 */
  const resetWidth = useCallback((key: string) => {
    const current = getLayout(storageKey).widths;
    if (!(key in current)) return;
    const next = { ...current };
    delete next[key];
    setLayout(storageKey, { widths: next });
  }, [storageKey]);

  const isVisible = useCallback((key: string) => !hidden.includes(key), [hidden]);

  const toggleVisible = useCallback((key: string) => {
    const next = hidden.includes(key) ? hidden.filter((entry) => entry !== key) : [...hidden, key];
    setLayout(storageKey, { hidden: next });
  }, [hidden, storageKey]);

  const visibleColumns = columns.filter((column) => isVisible(column.key));

  return {
    sort,
    toggleSort,
    hidden,
    isVisible,
    visibleColumns,
    toggleVisible,
    hiddenCount: hidden.length,
    widths,
    setWidth,
    resetWidth,
    resetWidths,
    resetLayout: useCallback(() => {
      setLayout(storageKey, { hidden: [], widths: {}, sort: undefined });
    }, [storageKey]),
  };
}

export type TableControls = ReturnType<typeof useTableControls>;

const MIN_COLUMN_WIDTH = 88;
const MAX_COLUMN_WIDTH = 560;

/** 可排序表头：点击排序，右缘拖拽改列宽，双击恢复该列默认宽，聚焦后 ←/→ 微调。
 *
 * 拖拽只改当前表头的内联宽度（rAF 节流，一帧最多重排一次）并画一条竖向引导线，
 * 松手才写入记忆；宽度变化会让右侧列整体平移、拖拽线跟手，不会和排序点击互相抢事件。
 *
 * 两种排序来源：
 * - 默认用 controls（客户端排序，localStorage 记忆）；
 * - 传入 onSort 时改用外部排序（如 URL 参数、服务端先排序再分页），此时 sort 由调用方给出。
 */
export function SortableTh({
  column,
  controls,
  sort,
  onSort,
  className,
  sticky = false,
  children,
}: {
  column: TableColumn;
  controls?: TableControls;
  sort?: SortState;
  onSort?: (key: string) => void;
  className?: string;
  sticky?: boolean;
  children?: ReactNode;
}) {
  const active = onSort ? (sort?.key === column.key ? sort.dir : null) : controls?.sort?.key === column.key ? controls.sort.dir : null;
  const sortable = column.sortable !== false;
  const resizable = Boolean(controls) && column.resizable !== false;
  const width = controls?.widths[column.key] ?? column.width;
  const dragRef = useRef<{
    startX: number;
    startWidth: number;
    width: number;
    maxWidth: number;
    tableWidth: number;
  } | null>(null);
  const thRef = useRef<HTMLTableCellElement | null>(null);
  const pendingX = useRef(0);
  const frameRef = useRef<number | null>(null);
  const [guideLeft, setGuideLeft] = useState<number | null>(null);

  const restoreBody = useCallback(() => {
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);

  const cancelFrame = useCallback(() => {
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      cancelFrame();
      restoreBody();
    };
  }, [cancelFrame, restoreBody]);

  /** 当前可增长的上限：自身宽度 + 操作列可让出的宽度（操作列不写宽、吸收剩余空间，最小 76px）。
   *  其它数据列是百分比，拖拽时保持原宽不动；这样拖动任何一列（含状态列）分界线都跟手。 */
  const measureDragBounds = useCallback((th: HTMLTableCellElement | null, startWidth: number) => {
    const table = th?.closest('table');
    const tableWidth = table?.getBoundingClientRect().width ?? 0;
    const actionsTh = table?.querySelector<HTMLElement>('thead th[data-sort-key="actions"]')
      ?? table?.querySelector<HTMLElement>('thead th:not([data-sort-key])')
      ?? null;
    const slack = Math.max(0, Math.round((actionsTh?.getBoundingClientRect().width ?? 0) - 76));
    return { tableWidth, maxWidth: Math.min(MAX_COLUMN_WIDTH, startWidth + slack) };
  }, []);

  /** 一帧只改一次宽度：拖动时不必每个 pointermove 都触发排版。 */
  const scheduleWidth = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      const drag = dragRef.current;
      if (!drag) return;
      const next = Math.round(Math.max(MIN_COLUMN_WIDTH, Math.min(drag.maxWidth, drag.startWidth + (pendingX.current - drag.startX))));
      drag.width = next;
      if (thRef.current) thRef.current.style.width = `${next}px`;
      setGuideLeft(pendingX.current);
    });
  }, []);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLSpanElement>) => {
    if (!resizable) return;
    event.preventDefault();
    event.stopPropagation();
    const th = event.currentTarget.closest('th');
    thRef.current = th;
    const startWidth = Math.round(th?.getBoundingClientRect().width ?? (typeof width === 'number' ? width : 160));
    const { tableWidth, maxWidth } = measureDragBounds(th, startWidth);
    pendingX.current = event.clientX;
    dragRef.current = { startX: event.clientX, startWidth, width: startWidth, maxWidth, tableWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
    setGuideLeft(event.clientX);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [measureDragBounds, resizable, width]);

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLSpanElement>) => {
    if (!dragRef.current) return;
    pendingX.current = event.clientX;
    scheduleWidth();
  }, [scheduleWidth]);

  const finishDrag = useCallback((event: React.PointerEvent<HTMLSpanElement>) => {
    const drag = dragRef.current;
    pendingX.current = event.clientX;
    cancelFrame();
    // 松手时把最后一帧的宽度真正落到表头上，再按表格宽度换算成百分比写入记忆。
    if (drag) {
      const next = Math.round(Math.max(MIN_COLUMN_WIDTH, Math.min(drag.maxWidth, drag.startWidth + (event.clientX - drag.startX))));
      if (thRef.current) thRef.current.style.width = `${next}px`;
      drag.width = next;
    }
    dragRef.current = null;
    thRef.current = null;
    setGuideLeft(null);
    restoreBody();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!drag || !controls || drag.width === drag.startWidth) return;
    const percent = drag.tableWidth > 0 ? Math.round((drag.width / drag.tableWidth) * 10000) / 100 : 0;
    controls.setWidth(column.key, percent > 0 ? `${percent}%` : drag.width);
  }, [cancelFrame, column.key, controls, restoreBody]);

  const onHandleKeyDown = useCallback((event: React.KeyboardEvent<HTMLSpanElement>) => {
    if (!controls) return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home') return;
    event.preventDefault();
    if (event.key === 'Home') {
      controls.resetWidth(column.key);
      return;
    }
    const th = event.currentTarget.closest('th');
    const current = Math.round(th?.getBoundingClientRect().width ?? (typeof width === 'number' ? width : 160));
    const { tableWidth, maxWidth } = measureDragBounds(th, current);
    const next = Math.round(Math.max(MIN_COLUMN_WIDTH, Math.min(maxWidth, current + (event.key === 'ArrowLeft' ? -16 : 16))));
    const percent = tableWidth > 0 ? Math.round((next / tableWidth) * 10000) / 100 : 0;
    controls.setWidth(column.key, percent > 0 ? `${percent}%` : next);
  }, [column.key, controls, measureDragBounds, width]);

  const widthLabel = typeof width === 'number' ? `${Math.round(width)}px` : typeof width === 'string' ? width : '自动';

  return (
    <th
      scope="col"
      className={[className, styles.head, sticky ? styles.sticky : '', active ? styles.headActive : '', guideLeft !== null ? styles.headDragging : ''].filter(Boolean).join(' ')}
      style={controls && width ? { width } : undefined}
      aria-sort={sortable && active ? (active === 'asc' ? 'ascending' : 'descending') : undefined}
      data-sort-key={column.key}
      data-resize-key={column.key}
      data-sort-dir={sortable ? active ?? undefined : undefined}
    >
      <div className={styles.headInner}>
        {sortable ? (
          <button
            type="button"
            className={styles.sortButton}
            onClick={() => (onSort ? onSort(column.key) : controls?.toggleSort(column.key))}
            data-testid={`sort-${column.key}`}
            aria-label={`${column.label}${active === 'asc' ? '，已升序，点击降序' : active === 'desc' ? '，已降序，点击取消排序' : '，点击升序'}`}
          >
            <span className={styles.sortLabel}>{children ?? column.label}</span>
            {active === 'asc' ? (
              <ArrowUp className={styles.sortIcon} size={13} strokeWidth={2.2} aria-hidden />
            ) : active === 'desc' ? (
              <ArrowDown className={styles.sortIcon} size={13} strokeWidth={2.2} aria-hidden />
            ) : (
              <ChevronsUpDown className={styles.sortIconIdle} size={13} strokeWidth={1.8} aria-hidden />
            )}
          </button>
        ) : (
          <span className={styles.sortLabel}>{children ?? column.label}</span>
        )}
        {resizable ? (
          <span
            className={styles.resizeHandle}
            role="separator"
            aria-orientation="vertical"
            aria-label={`调整「${column.label}」列宽，当前 ${widthLabel}`}
            aria-valuemin={MIN_COLUMN_WIDTH}
            aria-valuemax={MAX_COLUMN_WIDTH}
            aria-valuenow={typeof width === 'number' ? Math.round(width) : undefined}
            tabIndex={0}
            title="左右拖动调整列宽，双击恢复默认"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={finishDrag}
            onPointerCancel={finishDrag}
            onLostPointerCapture={() => { dragRef.current = null; cancelFrame(); setGuideLeft(null); restoreBody(); }}
            onKeyDown={onHandleKeyDown}
            onDoubleClick={() => controls?.resetWidth(column.key)}
            data-testid={`resize-${column.key}`}
          >
            <ChevronsLeftRight className={styles.resizeIcon} size={12} strokeWidth={2.2} aria-hidden />
          </span>
        ) : null}
      </div>
      {guideLeft !== null ? <span className={styles.resizeGuide} style={{ left: guideLeft }} aria-hidden /> : null}
    </th>
  );
}

/** 工具栏「显示列」：勾选即生效，可一键恢复默认布局。 */
export function ColumnsMenu({
  columns,
  controls,
  testId = 'columns-menu',
}: {
  columns: TableColumn[];
  controls: TableControls;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const toggleable = columns.filter((column) => column.hideable !== false);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <span className={styles.menuWrap} ref={rootRef}>
      <button
        type="button"
        className={styles.menuButton}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label="显示列"
        data-testid={testId}
        onClick={() => setOpen((current) => !current)}
      >
        <SlidersHorizontal size={15} strokeWidth={1.9} aria-hidden />
        显示列
        {controls.hiddenCount > 0 ? <span className={styles.menuBadge}>{controls.hiddenCount}</span> : null}
      </button>
      {open ? (
        <div className={styles.menuPanel} role="group" aria-label="显示列" data-testid={`${testId}-panel`}>
          {toggleable.map((column) => (
            <div key={column.key} className={styles.menuRow}>
              <Checkbox
                checked={controls.isVisible(column.key)}
                onChange={() => controls.toggleVisible(column.key)}
                label={column.label}
                testId={`${testId}-${column.key}`}
              />
            </div>
          ))}
          <div className={styles.menuFoot}>
            <button type="button" className={styles.menuReset} onClick={controls.resetLayout} data-testid={`${testId}-reset`}>
              恢复默认
            </button>
          </div>
        </div>
      ) : null}
    </span>
  );
}

/** 按当前排序状态排序（稳定排序；空值排在最后）。 */
export function sortRows<T>(
  rows: T[],
  sort: SortState,
  accessors: Record<string, (row: T) => string | number | null | undefined>,
): T[] {
  if (!sort) return rows;
  const accessor = accessors[sort.key];
  if (!accessor) return rows;
  const factor = sort.dir === 'asc' ? 1 : -1;
  return rows
    .map((row) => ({ row, key: accessor(row) }))
    .sort((left, right) => {
      const a = left.key;
      const b = right.key;
      const aEmpty = a === null || a === undefined || a === '';
      const bEmpty = b === null || b === undefined || b === '';
      if (aEmpty && bEmpty) return 0;
      if (aEmpty) return 1;
      if (bEmpty) return -1;
      if (typeof a === 'number' && typeof b === 'number') return (a - b) * factor;
      return String(a).localeCompare(String(b), 'zh-Hans-CN') * factor;
    })
    .map((entry) => entry.row);
}
