import { describe, expect, it } from 'vitest';
import { PARTIAL_WRITTEN_NOTICE, receiptSentence } from './receipt-copy';

const counts = { unchanged: 26, needsReview: 101, failed: 0, missing: 0 };

describe('receiptSentence', () => {
  it('renders one real receipt sentence with written and writtenNeedsReview', () => {
    expect(receiptSentence({ counts, writtenItems: 7, writtenNeedsReview: 6 })).toBe(
      '已写入 7 款，其中 6 款已写入确认字段、另有字段待核对；无变化 26 款；待核对 101 款；失败 0 款。',
    );
  });

  it('omits the review clause when writtenNeedsReview is zero or missing', () => {
    const expected = '已写入 7 款；无变化 26 款；待核对 101 款；失败 0 款。';
    expect(receiptSentence({ counts, writtenItems: 7, writtenNeedsReview: 0 })).toBe(expected);
    expect(receiptSentence({ counts, writtenItems: 7, writtenNeedsReview: null })).toBe(expected);
    expect(receiptSentence({ counts, writtenItems: 7 })).toBe(expected);
  });

  it('shows an em dash when the written count is missing (never estimates it)', () => {
    expect(receiptSentence({ counts, writtenItems: null, writtenNeedsReview: 6 })).toBe(
      '已写入 — 款，其中 6 款已写入确认字段、另有字段待核对；无变化 26 款；待核对 101 款；失败 0 款。',
    );
    expect(receiptSentence({ counts, writtenItems: undefined })).toBe(
      '已写入 — 款；无变化 26 款；待核对 101 款；失败 0 款。',
    );
  });

  it('returns null when counts are missing (the page then renders no numbers)', () => {
    expect(receiptSentence({ counts: null, writtenItems: 7, writtenNeedsReview: 6 })).toBeNull();
    expect(receiptSentence({ counts: undefined, writtenItems: 7 })).toBeNull();
  });

  it('appends 本次未见 only when missing is greater than zero', () => {
    expect(receiptSentence({ counts: { ...counts, missing: 3 }, writtenItems: 7, writtenNeedsReview: 6 })).toBe(
      '已写入 7 款，其中 6 款已写入确认字段、另有字段待核对；无变化 26 款；待核对 101 款；失败 0 款；本次未见 3 款。',
    );
  });

  it('uses only the supplied numbers (no hard-coded sample values)', () => {
    expect(receiptSentence({
      counts: { unchanged: 1, needsReview: 2, failed: 3, missing: 0 },
      writtenItems: 4,
      writtenNeedsReview: 0,
    })).toBe('已写入 4 款；无变化 1 款；待核对 2 款；失败 3 款。');
  });

  it('partial 完成使用固定一句：已确认的变更已写入，待核对字段保留原值', () => {
    expect(PARTIAL_WRITTEN_NOTICE).toBe('已确认的变更已写入，待核对字段保留原值。');
    // 同一款商品可以已写入名称、另有字段待核对：它同时计入 written 与 writtenNeedsReview。
    expect(receiptSentence({ counts, writtenItems: 1, writtenNeedsReview: 1, status: 'partial' })).toBe(
      '已写入 1 款，其中 1 款已写入确认字段、另有字段待核对；无变化 26 款；待核对 101 款；失败 0 款。',
    );
  });
});
