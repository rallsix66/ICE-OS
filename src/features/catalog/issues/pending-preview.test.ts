import { describe, expect, it } from 'vitest';
import { buildCatalogIssueIndex, buildCatalogIssueToolbarModel, buildCatalogIssues, buildCatalogPendingItems, type CatalogIssueFacts } from './issue-index';
import type { CatalogIssueCoverage } from './types';

/**
 * 「待处理」弹窗投影：只读事实 → 可操作项。
 * - 同号多行：两个真实候选行（行号 + 每字段真实值）与 issueId/itemRevision；
 * - 缺货号：飞书补充的候选货号；
 * - 刷子历史（仅查看）不进入弹窗与徽标，但仍保留在待处理索引。
 */

const COVERAGE: CatalogIssueCoverage = {
  modules: [],
  note: '测试覆盖边界。',
};

const ITEM_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ITEM_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DUPLICATE_ISSUE = '99999999-1111-4999-8999-999999999991';
const MISSING_ISSUE = '99999999-2222-4999-8999-999999999992';
const BRUSH_DECISION = '11111111-1111-4111-8111-111111111111';

function facts(): CatalogIssueFacts {
  return {
    uncodedNewItems: [],
    brushPending: [{
      decisionId: BRUSH_DECISION,
      entryKey: '/batch_brush_preservation/0',
      rawRef: 'match-bundle.json#/batch_brush_preservation/0',
      itemId: ITEM_A,
      iceCode: 'WM0069',
      nameCn: '测试护发精油',
      sourceSystem: 'bigseller',
      reason: null,
      doNotMerge: true,
    }],
    moduleFacts: {
      productSource: {
        sourceLabel: 'ICE产品库 · Sheet1',
        sourceHref: null,
        issues: [
          {
            issueId: DUPLICATE_ISSUE,
            iceCode: 'WM0069',
            nameCn: '测试护发精油',
            kind: 'duplicate_code_inconsistent',
            kindLabel: '同号多行不一致',
            itemId: ITEM_A,
            itemRevision: 7,
            specificationText: '20ml*4瓶-泰国特供版',
            rows: [63, 128],
            fieldLabels: ['商品条码'],
            duplicate: {
              fields: [{
                fieldLabel: '商品条码',
                values: [
                  { rowNumber: 63, value: '', empty: true },
                  { rowNumber: 128, value: '757577407380', empty: false },
                ],
              }],
            },
            pendingCode: false,
          },
          {
            issueId: MISSING_ISSUE,
            iceCode: null,
            nameCn: 'ICE LERSKIN 烟酰胺提亮精华水150ml',
            kind: 'missing_code',
            kindLabel: '来源缺码',
            itemId: ITEM_B,
            itemRevision: 3,
            specificationText: '150ml',
            rows: [122],
            fieldLabels: ['正式货号'],
            duplicate: null,
            pendingCode: true,
            sourceCodeCandidate: {
              sourceCode: 'WM0131',
              rowNumbers: [122],
              capturedAtDisplay: '2026-11-11 10:00',
            },
          },
        ],
      },
    },
  };
}

describe('待处理弹窗投影', () => {
  it('刷子历史不进入弹窗/徽标，但待处理索引仍保留全部事项', () => {
    const index = buildCatalogIssueIndex(facts(), COVERAGE, '2026-11-11T02:00:00.000Z');
    if (index.state !== 'ok') throw new Error('unreachable');
    expect(index.issueCount).toBe(3); // 2 来源 + 1 刷子：索引原始事项保持完整

    const items = buildCatalogPendingItems(index.items);
    expect(items).toHaveLength(2);
    expect(items.some((item) => item.kind === 'brush_pending')).toBe(false);
    expect(items.map((item) => item.issueId)).toEqual([DUPLICATE_ISSUE, MISSING_ISSUE]);
    // 总览/徽标/工具栏与弹窗同一份数据：都是 2 项（不再出现总览 3、点进去 2 的不一致）。
    expect(buildCatalogIssueToolbarModel(index)).toEqual({ state: 'ok', issueCount: 2, itemCount: 2 });
  });

  it('同号多行：两个候选行都带行号与每个字段的真实值（空值写「未填写」）', () => {
    const items = buildCatalogPendingItems(buildCatalogIssues(facts()));
    const duplicate = items.find((item) => item.issueId === DUPLICATE_ISSUE)!;
    expect(duplicate.sourceKind).toBe('duplicate_code_inconsistent');
    expect(duplicate.itemId).toBe(ITEM_A);
    expect(duplicate.itemRevision).toBe(7);
    expect(duplicate.iceCode).toBe('WM0069');
    expect(duplicate.specificationText).toBe('20ml*4瓶-泰国特供版');
    expect(duplicate.candidateRows).toEqual([
      { rowNumber: 63, fieldLines: ['商品条码未填写'] },
      { rowNumber: 128, fieldLines: ['商品条码 757577407380'] },
    ]);
    expect(duplicate.candidateCode).toBeNull();
    // 弹窗投影不再携带跳旧来源面板/来源页的 actionHref。
    expect('actionHref' in duplicate).toBe(false);
    expect(duplicate.referenceHref).toContain(`/dashboard/catalog?detail=${ITEM_A}`);
  });

  it('缺货号：飞书补充的候选货号进入投影，供「确认采用此货号」使用', () => {
    const items = buildCatalogPendingItems(buildCatalogIssues(facts()));
    const missing = items.find((item) => item.issueId === MISSING_ISSUE)!;
    expect(missing.sourceKind).toBe('missing_code');
    expect(missing.candidateCode).toBe('WM0131');
    expect(missing.itemId).toBe(ITEM_B);
    expect(missing.itemRevision).toBe(3);
    expect(missing.candidateRows).toEqual([]);
  });

  it('规格取不到时显示「规格未填写」；非来源事项 sourceKind 为 null', () => {
    const index = buildCatalogIssueIndex({
      uncodedNewItems: [{ itemId: ITEM_A, nameCn: '无规格新品', revision: 1, evidenceRef: null }],
      brushPending: [],
    }, COVERAGE, '2026-11-11T02:00:00.000Z');
    if (index.state !== 'ok') throw new Error('unreachable');
    const items = buildCatalogPendingItems(index.items);
    expect(items).toHaveLength(1);
    expect(items[0]!.specificationText).toBe('规格未填写');
    expect(items[0]!.sourceKind).toBeNull();
    expect(items[0]!.issueId).toBeNull();
    expect(items[0]!.itemRevision).toBeNull();
  });
});
