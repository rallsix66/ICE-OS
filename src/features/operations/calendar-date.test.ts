import { describe, expect, it } from 'vitest';
import { beijingTodayIso, dateToIso, isoToDate } from './calendar-date';

describe('operations calendar-date', () => {
  it('YYYY-MM-DD 与日历 Date 互转不丢日期', () => {
    expect(dateToIso(isoToDate('2026-11-10'))).toBe('2026-11-10');
    expect(dateToIso(isoToDate('2026-01-01'))).toBe('2026-01-01');
    expect(dateToIso(isoToDate('2026-12-31'))).toBe('2026-12-31');
  });

  it('闰日按自然日保留', () => {
    expect(dateToIso(isoToDate('2028-02-29'))).toBe('2028-02-29');
  });

  it('日历 Date 固定为本地中午，跨时区不挪到前一天', () => {
    const date = isoToDate('2026-11-10');
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(10);
    expect(date.getDate()).toBe(10);
    expect(date.getHours()).toBe(12);
  });

  it('北京时间跨过 UTC 零点时，今天按 +08 计算', () => {
    expect(beijingTodayIso(new Date('2026-11-16T15:59:00Z'))).toBe('2026-11-16');
    expect(beijingTodayIso(new Date('2026-11-16T16:00:00Z'))).toBe('2026-11-17');
  });
});
