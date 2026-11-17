import { describe, expect, it } from 'vitest';
import {
  beijingTodayIso,
  dateRangeLabel,
  dateToIso,
  isoToDate,
  parseDateInput,
  quickDateRange,
  shiftIso,
} from './date-range';

describe('操作记录日期范围：纯日期计算', () => {
  it('触发器文案：不限 / 单侧 / 完整范围 / 单日', () => {
    expect(dateRangeLabel('', '')).toBe('日期不限');
    expect(dateRangeLabel('2026-11-01', '')).toBe('自 2026-11-01 起');
    expect(dateRangeLabel('', '2026-11-17')).toBe('截至 2026-11-17');
    expect(dateRangeLabel('2026-11-01', '2026-11-17')).toBe('2026-11-01 至 2026-11-17');
    expect(dateRangeLabel('2026-11-17', '2026-11-17')).toBe('2026-11-17（单日）');
  });

  it('文本输入只接受严格 YYYY-MM-DD 真实日期', () => {
    expect(parseDateInput('')).toEqual({ iso: '', valid: true });
    expect(parseDateInput(' 2026-11-17 ')).toEqual({ iso: '2026-11-17', valid: true });
    expect(parseDateInput('2026-02-29').valid).toBe(false);
    expect(parseDateInput('2024-02-29')).toEqual({ iso: '2024-02-29', valid: true });
    expect(parseDateInput('2026-2-1').valid).toBe(false);
    expect(parseDateInput('2026-13-01').valid).toBe(false);
    expect(parseDateInput('2026/11/17').valid).toBe(false);
  });

  it('自然日加减跨月、跨年', () => {
    expect(shiftIso('2026-11-17', -6)).toBe('2026-11-11');
    expect(shiftIso('2026-11-01', -1)).toBe('2026-10-31');
    expect(shiftIso('2026-01-01', -1)).toBe('2025-12-31');
    expect(shiftIso('2024-02-28', 1)).toBe('2024-02-29');
    expect(shiftIso('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('本地 Date 与 YYYY-MM-DD 往返不发生时区偏移', () => {
    expect(dateToIso(isoToDate('2026-11-17'))).toBe('2026-11-17');
    expect(dateToIso(isoToDate('2024-02-29'))).toBe('2024-02-29');
  });

  it('北京时间今天按 Asia/Shanghai 取自然日，不跟浏览器时区走', () => {
    expect(beijingTodayIso(new Date('2026-11-16T15:59:00Z'))).toBe('2026-11-16');
    expect(beijingTodayIso(new Date('2026-11-16T16:00:00Z'))).toBe('2026-11-17');
    expect(beijingTodayIso(new Date('2026-11-17T03:30:00Z'))).toBe('2026-11-17');
  });

  it('近 N 天包含今天；N<=0 视为不限', () => {
    expect(quickDateRange(7, '2026-11-17')).toEqual({ from: '2026-11-11', to: '2026-11-17' });
    expect(quickDateRange(30, '2026-11-17')).toEqual({ from: '2026-10-19', to: '2026-11-17' });
    expect(quickDateRange(0, '2026-11-17')).toEqual({ from: '', to: '' });
  });
});
