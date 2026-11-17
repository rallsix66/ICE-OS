/**
 * 操作记录单日日历的日期换算。
 *
 * 日历里的 Date 只表示“某一天”，统一放在本地中午，避免时区/夏令时把日期挪一天；
 * 真正用于筛选的 YYYY-MM-DD 仍按北京时间自然日解释（由 model.ts 的 +08 边界完成）。
 */
import { format } from 'date-fns';

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

/** YYYY-MM-DD → 本地中午的 Date（只比较年月日，不比较时刻）。 */
export function isoToDate(iso: string): Date {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(year, month - 1, day, 12);
}

/** Date → YYYY-MM-DD（按本地年月日，不受 UTC 偏移影响）。 */
export function dateToIso(date: Date): string {
  return format(date, 'yyyy-MM-dd');
}
