import { describe, expect, it } from 'vitest';
import { formatCnyPrice, formatCnyValue } from './money-display';

describe('formatCnyValue（估算货值：千分位 + 2 位小数）', () => {
  it('补齐到两位小数并加千分位', () => {
    expect(formatCnyValue('21623.7')).toBe('¥21,623.70');
    expect(formatCnyValue('7082.46')).toBe('¥7,082.46');
    expect(formatCnyValue('14541.24')).toBe('¥14,541.24');
    expect(formatCnyValue('4.4')).toBe('¥4.40');
  });

  it('真零与小数取整（half-up，不经浮点）', () => {
    expect(formatCnyValue('0')).toBe('¥0.00');
    expect(formatCnyValue('0.00')).toBe('¥0.00');
    expect(formatCnyValue('1.005')).toBe('¥1.01');
    expect(formatCnyValue('1.004')).toBe('¥1.00');
    expect(formatCnyValue('0.0001')).toBe('¥0.00');
    expect(formatCnyValue('1234.5678')).toBe('¥1,234.57');
  });

  it('整数原值不得被放大（无小数位时不能多拼 0）', () => {
    expect(formatCnyValue('102190')).toBe('¥102,190.00');
    expect(formatCnyValue('128')).toBe('¥128.00');
    expect(formatCnyValue('1000')).toBe('¥1,000.00');
    expect(formatCnyValue('21623')).toBe('¥21,623.00');
  });

  it('非法/缺失输入返回 null，不转零', () => {
    expect(formatCnyValue(null)).toBeNull();
    expect(formatCnyValue(undefined)).toBeNull();
    expect(formatCnyValue('')).toBeNull();
    expect(formatCnyValue('--')).toBeNull();
    expect(formatCnyValue('abc')).toBeNull();
  });
});

describe('formatCnyPrice（采用进货价：千分位 + 保留原精度）', () => {
  it('保留原有小数位，不补零不丢精度', () => {
    expect(formatCnyPrice('5.18')).toBe('¥5.18');
    expect(formatCnyPrice('4.4')).toBe('¥4.4');
    expect(formatCnyPrice('5.1837')).toBe('¥5.1837');
    expect(formatCnyPrice('12345.6')).toBe('¥12,345.6');
  });

  it('整数与真零', () => {
    expect(formatCnyPrice('12')).toBe('¥12');
    expect(formatCnyPrice('0')).toBe('¥0');
  });

  it('非法/缺失输入返回 null，不转零', () => {
    expect(formatCnyPrice(null)).toBeNull();
    expect(formatCnyPrice('--')).toBeNull();
  });
});
