import { describe, expect, it } from 'vitest';
import {
  GROUPING_DECISION_LABELS,
  buildLocalOverride,
  decisionSavedText,
  groupingOverrideTitle,
  groupingReviewSummary,
  mergeActiveOverrides,
} from './grouping-review-summary';
import type { ShipmentGroupingActiveOverrideDto, ShipmentGroupingReviewDto } from './types';

type ReviewTicket = ShipmentGroupingReviewDto['evidence']['current']['tickets'][number];

function ticket(overrides: Partial<ReviewTicket> = {}): ReviewTicket {
  return {
    ticketKey: 'PO:POKNZX027485',
    ticketNo: 'POKNZX027485',
    market: '越南',
    waybillsText: 'baisu1029-250box',
    purchaseOrder: 'POKNZX027485',
    sourceRowStart: 115,
    sourceRowEnd: 125,
    items: [],
    ...overrides,
  };
}

function review(
  kind: 'split' | 'merge',
  previous: ReviewTicket[],
  current: ReviewTicket[],
): Pick<ShipmentGroupingReviewDto, 'evidence'> {
  return {
    evidence: {
      kind,
      previous: { snapshotId: 'previous-snapshot', tickets: previous },
      current: { snapshotId: 'current-snapshot', tickets: current },
      affectedProducts: [],
    },
  };
}

function fullReview(
  kind: 'split' | 'merge',
  previous: ReviewTicket[],
  current: ReviewTicket[],
): Pick<ShipmentGroupingReviewDto, 'id' | 'kind' | 'status' | 'decision' | 'signature' | 'evidence'> {
  return {
    id: 'review-1',
    kind,
    status: 'pending',
    decision: null,
    signature: 'sig-review-1',
    ...review(kind, previous, current),
  };
}

const SPLIT_PREVIOUS = [ticket({ ticketKey: 'PO:POKNZX027485', ticketNo: 'POKNZX027485', purchaseOrder: 'POKNZX027485', waybillsText: 'baisu1029-250box' })];
const SPLIT_CURRENT = [
  ticket({ ticketKey: 'PO:POKNZX027485', ticketNo: 'POKNZX027485', purchaseOrder: 'POKNZX027485', waybillsText: 'baisu1029-250box' }),
  ticket({ ticketKey: 'WB:261103572394', ticketNo: '261103572394', purchaseOrder: null, waybillsText: '261103572394' }),
];
const MERGE_PREVIOUS = [
  ticket({ ticketKey: 'PO:POKNZX027485', ticketNo: 'POKNZX027485', purchaseOrder: 'POKNZX027485', waybillsText: 'baisu1029-250box' }),
  ticket({ ticketKey: 'WB:261103572394', ticketNo: '261103572394', purchaseOrder: null, waybillsText: '261103572394' }),
];
const MERGE_CURRENT = [ticket({ ticketKey: 'PO:POKNZX027485', ticketNo: 'POKNZX027485', purchaseOrder: 'POKNZX027485', waybillsText: 'baisu1029-250box' })];

describe('groupingReviewSummary', () => {
  it('合票：市场 + 采购单（运单）+ 上次/本次真实票数', () => {
    const summary = groupingReviewSummary(review('merge', MERGE_PREVIOUS, MERGE_CURRENT));
    expect(summary.previousCount).toBe(2);
    expect(summary.currentCount).toBe(1);
    expect(summary.text).toBe('越南 · 采购单 POKNZX027485（运单 baisu1029-250box、261103572394） · 上次 2 票，本次 1 票。');
  });

  it('拆票：没有采购单时用运单识别', () => {
    const summary = groupingReviewSummary(review(
      'split',
      [ticket({ purchaseOrder: null, waybillsText: '261103572394', ticketNo: '261103572394' })],
      [
        ticket({ purchaseOrder: null, waybillsText: '261103572394', ticketNo: '261103572394' }),
        ticket({ purchaseOrder: null, waybillsText: 'baisu1029-250box', ticketNo: 'baisu1029-250box' }),
      ],
    ));
    expect(summary.text).toContain('运单 261103572394、baisu1029-250box');
    expect(summary.text).toContain('上次 1 票，本次 2 票');
  });

  it('缺少市场与单号时如实写未提供，不造值', () => {
    const summary = groupingReviewSummary(review(
      'merge',
      [ticket({ market: null, purchaseOrder: null, waybillsText: null, ticketNo: '' })],
      [ticket({ market: null, purchaseOrder: null, waybillsText: null, ticketNo: '' })],
    ));
    expect(summary.text).toBe('市场未提供 · 单号未提供 · 上次 1 票，本次 1 票。');
  });
});

describe('decisionSavedText', () => {
  it('四个决定 + restored 只写实际决定，不写死票数', () => {
    expect(decisionSavedText('split_confirmed')).toBe('已保存决定：确实拆开');
    expect(decisionSavedText('keep_one')).toBe('已保存决定：仍是一票');
    expect(decisionSavedText('merge_confirmed')).toBe('已保存决定：确实合成一票');
    expect(decisionSavedText('keep_separate')).toBe('已保存决定：仍然分开');
    expect(decisionSavedText('restored')).toBe('已恢复按飞书判断');
    for (const decision of ['split_confirmed', 'keep_one', 'merge_confirmed', 'keep_separate'] as const) {
      expect(decisionSavedText(decision)).not.toContain('按两票处理');
      expect(decisionSavedText(decision)).toContain(GROUPING_DECISION_LABELS[decision]);
    }
  });

  it('没有决定时只说已保存，不猜结论', () => {
    expect(decisionSavedText(null)).toBe('决定已保存');
  });
});

describe('buildLocalOverride', () => {
  const now = '2026-11-11T02:05:00.000Z';

  it('拆票「仍是一票」：立即生成可恢复的人工决定行（市场/采购单/运单/决定/时间）', () => {
    const row = buildLocalOverride(
      fullReview('split', SPLIT_PREVIOUS, SPLIT_CURRENT),
      'keep_one',
      now,
    );
    expect(row).toMatchObject({
      id: 'local:review-1',
      reviewId: 'review-1',
      kind: 'merge',
      reviewKind: 'split',
      decision: 'keep_one',
      signature: 'sig-review-1',
      createdAt: now,
      market: '越南',
      ticketNo: 'POKNZX027485',
      waybillsText: 'baisu1029-250box',
    });
  });

  it('合票「仍然分开」：带上次票信息，覆盖类型为 split', () => {
    const row = buildLocalOverride(
      fullReview('merge', MERGE_PREVIOUS, MERGE_CURRENT),
      'keep_separate',
      new Date('2026-11-11T02:06:00.000Z'),
    );
    expect(row).toMatchObject({
      reviewId: 'review-1',
      kind: 'split',
      reviewKind: 'merge',
      decision: 'keep_separate',
      createdAt: '2026-11-11T02:06:00.000Z',
      market: '越南',
      ticketNo: 'POKNZX027485',
      waybillsText: 'baisu1029-250box',
    });
  });

  it('接受飞书原分组（确实拆开 / 确实合成一票）不新增人工决定行', () => {
    expect(buildLocalOverride(fullReview('split', SPLIT_PREVIOUS, SPLIT_CURRENT), 'split_confirmed', now)).toBeNull();
    expect(buildLocalOverride(fullReview('merge', MERGE_PREVIOUS, MERGE_CURRENT), 'merge_confirmed', now)).toBeNull();
    expect(buildLocalOverride(fullReview('split', SPLIT_PREVIOUS, SPLIT_CURRENT), 'restored', now)).toBeNull();
  });

  it('不满足覆盖条件（没有两票可比）时不生成行', () => {
    expect(buildLocalOverride(fullReview('split', SPLIT_PREVIOUS, [SPLIT_CURRENT[0]]), 'keep_one', now)).toBeNull();
    expect(buildLocalOverride(fullReview('merge', [MERGE_PREVIOUS[0]], MERGE_CURRENT), 'keep_separate', now)).toBeNull();
  });

  it('本次票信息缺失时回退上次票；单号按 采购单 → 运单 → 票键 回退，缺失保持 null', () => {
    const row = buildLocalOverride(
      fullReview('split', [
        ticket({ ticketKey: 'PO:OLD-1', ticketNo: 'OLD-1', purchaseOrder: 'OLD-1', market: '越南', waybillsText: 'OLD-WB' }),
        ticket({ ticketKey: 'PO:OLD-2', ticketNo: 'OLD-2', purchaseOrder: 'OLD-2', waybillsText: 'OLD-WB-2' }),
      ], [
        ticket({ ticketKey: 'WB:261103572394', ticketNo: '', purchaseOrder: null, market: null, waybillsText: null }),
        ticket({ ticketKey: 'PO:POKNZX027485', ticketNo: 'POKNZX027485', purchaseOrder: 'POKNZX027485' }),
      ]),
      'keep_one',
      now,
    );
    expect(row).toMatchObject({
      // 本次首票市场/运单为空 → 回退上次首票
      market: '越南',
      // 本次首票没有采购单/运单 → 用本次票键
      ticketNo: 'WB:261103572394',
      waybillsText: 'OLD-WB',
    });
  });
});

describe('groupingOverrideTitle', () => {
  it('优先用真实 decision 映射', () => {
    expect(groupingOverrideTitle({ decision: 'keep_one', reviewKind: 'split' })).toBe('仍是一票');
    expect(groupingOverrideTitle({ decision: 'keep_separate', reviewKind: 'merge' })).toBe('仍然分开');
  });

  it('历史数据没有 decision 时按复核类型回退', () => {
    expect(groupingOverrideTitle({ decision: null, reviewKind: 'split' })).toBe('按一票处理');
    expect(groupingOverrideTitle({ decision: null, reviewKind: 'merge' })).toBe('按分开处理');
  });
});

describe('mergeActiveOverrides', () => {
  const serverRow: ShipmentGroupingActiveOverrideDto = {
    id: 'server-row-1',
    reviewId: 'review-1',
    kind: 'merge',
    reviewKind: 'split',
    decision: 'keep_one',
    signature: 'sig-1',
    createdAt: '2026-11-11T02:00:00.000Z',
    market: '越南',
    ticketNo: 'POKNZX027485',
    waybillsText: 'baisu1029-250box',
  };
  const localSame: ShipmentGroupingActiveOverrideDto = {
    ...serverRow,
    id: 'local:review-1',
    createdAt: '2026-11-11T02:05:00.000Z',
  };
  const localNew: ShipmentGroupingActiveOverrideDto = {
    ...serverRow,
    id: 'local:review-2',
    reviewId: 'review-2',
    createdAt: '2026-11-11T02:06:00.000Z',
  };

  it('按 reviewId 去重（服务端行优先），本地新行参与排序', () => {
    expect(mergeActiveOverrides([serverRow], [localSame, localNew])).toEqual([localNew, serverRow]);
  });

  it('恢复过的 reviewId 立即隐藏（服务端行与本地行都不显示）', () => {
    expect(mergeActiveOverrides([serverRow], [localSame], ['review-1'])).toEqual([]);
  });

  it('没有人工决定时返回空数组', () => {
    expect(mergeActiveOverrides([], [])).toEqual([]);
  });
});
