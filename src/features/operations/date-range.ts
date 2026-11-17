/**
 * 操作记录日期范围：纯日期计算（按北京时间自然日，不依赖浏览器时区）。
 * 日历用本地 Date 表示“某一天”，只比较年月日，不比较时刻。
 */
import { format, isValid, parse } from 'date-fns';

const BEIJING_TODAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** 北京时间的今天，YYYY-MM-DD。 */
export function beijingTodayIso(now: Date = new Date()): string {
  return BEIJING_TODAY.format(now);
}

/** YYYY-MM-DD → 本地中午的 Date（避免时区/夏令时把日期挪一天）。 */
export function isoToDate(iso: string): Date {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(year, month - 1, day, 12);
}

export function dateToIso(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** 按自然日加减，跨月/跨年不变。 */
export function shiftIso(iso: string, days: number): string {
  const [year, month, day] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** 文本输入校验：只接受严格 YYYY-MM-DD，且必须是真实日期。 */
export function parseDateInput(value: string): { iso: string; valid: boolean } {
  const text = value.trim();
  if (!text) return { iso: '', valid: true };
  const parsed = parse(text, 'yyyy-MM-dd', new Date());
  if (!isValid(parsed) || format(parsed, 'yyyy-MM-dd') !== text) return { iso: '', valid: false };
  return { iso: text, valid: true };
}

/** 触发器文案：完整起止日期；单侧范围明确写“自/截至”。 */
export function dateRangeLabel(from: string, to: string): string {
  if (from && to) return from === to ? `${from}（单日）` : `${from} 至 ${to}`;
  if (from) return `自 ${from} 起`;
  if (to) return `截至 ${to}`;
  return '日期不限';
}

/** 近 N 天（含今天），返回起点/终点；N<=0 视为不限。 */
export function quickDateRange(days: number, todayIso: string): { from: string; to: string } {
  if (!Number.isFinite(days) || days <= 0) return { from: '', to: '' };
  return { from: shiftIso(todayIso, -(Math.trunc(days) - 1)), to: todayIso };
}
