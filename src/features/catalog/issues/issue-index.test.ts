import { describe, expect, it } from 'vitest';
import {
  buildCatalogIssueIndex,
  buildCatalogIssueToolbarModel,
  buildCatalogIssues,
  buildCatalogPendingItems,
  catalogDetailHref,
  countIssuesByKind,
  countIssuesForItem,
  dedupeItemCount,
  intakeObservationHref,
  intakeScopeHref,
  isEmptyIssueIndex,
  issueKindLabel,
  legacySourceHref,
  sourceRecordHref,
  sourceScopeHref,
  unlinkedIssueCount,
  type CatalogIssueFacts,
} from './issue-index';
import { ISSUES_RETURN_HREF } from './context';
import { classifyCatalogReadFailure } from './entry-state';
import type { CatalogIssue, CatalogIssueCoverage } from './types';

const COVERAGE: CatalogIssueCoverage = {
  modules: [
    {
      key: 'new_item', enabled: false, status: 'disabled', label: '持续新品资料当前未启用',
      covered: [], uncovered: ['尚未分类的来源观测暂不纳入（待业务确认）'],
    },
    {
      key: 'source_identity', enabled: false, status: 'disabled', label: '来源身份核实当前未启用',
      covered: [], uncovered: ['已撤销的来源记录视为已结束'],
    },
  ],
  note: '覆盖边界测试文本：未启用不代表 0 项，也不代表已完整检查。',
};

const ITEM_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ITEM_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DECISION_1 = '11111111-1111-4111-8111-111111111111';
const DECISION_2 = '22222222-2222-4222-8222-222222222222';
const SCOPE_A = 'cccccccc-aaaa-4ccc-8aaa-cccccccccca1';
const SCOPE_B = 'cccccccc-bbbb-4ccc-8bbb-ccccccccccb2';
const SCOPE_UNRESOLVED = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3';
const RECORD_1 = 'dddddddd-aaaa-4ddd-8aaa-ddddddddddd1';
const RECORD_2 = 'dddddddd-bbbb-4ddd-8bbb-ddddddddddd2';
const OBS_1 = 'eeeeeeee-aaaa-4eee-8aaa-eeeeeeeeeea1';
const OBS_2 = 'eeeeeeee-bbbb-4eee-8bbb-eeeeeeeeeea2';
const OBS_3 = 'eeeeeeee-cccc-4eee-8ccc-eeeeeeeeeea3';

const CORE_FACTS: CatalogIssueFacts = {
  uncodedNewItems: [
    { itemId: ITEM_A, nameCn: '测试新品甲', revision: 1, evidenceRef: 'match-bundle.json#/items/117' },
  ],
  brushPending: [
    {
      decisionId: DECISION_1,
      entryKey: '/batch_brush_preservation/0',
      rawRef: 'match-bundle.json#/batch_brush_preservation/0',
      itemId: ITEM_A,
      iceCode: null,
      nameCn: '测试新品甲',
      sourceSystem: 'bigseller',
      reason: 'two brushes kept separate',
      doNotMerge: true,
    },
    {
      decisionId: DECISION_2,
      entryKey: '/batch_brush_preservation/1',
      rawRef: 'match-bundle.json#/batch_brush_preservation/1',
      itemId: ITEM_B,
      iceCode: 'WM0002',
      nameCn: '测试基线乙',
      sourceSystem: 'jushuitan',
      reason: null,
      doNotMerge: false,
    },
  ],
};

const MODULE_FACTS: CatalogIssueFacts = {
  ...CORE_FACTS,
  moduleFacts: {
    sourceIdentity: {
      scopes: [
        { scopeId: SCOPE_A, displayName: '来源范围甲', system: 'bigseller', scopeState: 'identity_ready' },
        { scopeId: SCOPE_UNRESOLVED, displayName: '未解析范围丙', system: 'feishu', scopeState: 'unresolved' },
      ],
      records: [
        { recordId: RECORD_1, scopeId: SCOPE_A, scopeDisplayName: '来源范围甲', state: 'review_required', revision: 2, entityKind: 'product_record' },
        { recordId: RECORD_2, scopeId: SCOPE_A, scopeDisplayName: '来源范围甲', state: 'suspended', revision: 3, entityKind: 'sku_record' },
      ],
    },
    newItem: {
      // 与来源核实共用同一份范围列表：同一未解析范围必须只出现一次。
      scopes: [
        { scopeId: SCOPE_A, displayName: '来源范围甲', system: 'bigseller', scopeState: 'identity_ready' },
        { scopeId: SCOPE_UNRESOLVED, displayName: '未解析范围丙', system: 'feishu', scopeState: 'unresolved' },
        { scopeId: SCOPE_B, displayName: '来源范围乙', system: 'jushuitan', scopeState: 'identity_ready' },
      ],
      observations: [
        // 分类待复核（即使已关联商品也仍是待办）
        { observationId: OBS_1, scopeId: SCOPE_A, scopeDisplayName: '来源范围甲', recordPointer: '/rows/1', nameHint: '观测一看', reviewState: 'needs_review', classification: 'new_item', originItemId: ITEM_A },
        // 已分类但未建档/关联商品
        { observationId: OBS_2, scopeId: SCOPE_A, scopeDisplayName: '来源范围甲', recordPointer: '/rows/2', nameHint: '观测二看', reviewState: 'proposed', classification: 'item_update', originItemId: null },
        // 已确认关联：不是待办
        { observationId: OBS_3, scopeId: SCOPE_A, scopeDisplayName: '来源范围甲', recordPointer: '/rows/3', nameHint: '观测三看', reviewState: 'proposed', classification: 'new_item', originItemId: ITEM_B },
        // 未分类：没有既有规则依据，明确不纳入（coverage.uncovered 说明）
        { observationId: 'eeeeeeee-dddd-4eee-8ddd-eeeeeeeeeea4', scopeId: SCOPE_A, scopeDisplayName: '来源范围甲', recordPointer: '/rows/4', nameHint: null, reviewState: null, classification: null, originItemId: null },
      ],
    },
  },
};

const FROM_QUERY = `from=${encodeURIComponent(ISSUES_RETURN_HREF)}`;

/** 业务文案不得出现的内部标记（表名/状态码/模块编号/工程说明）。 */
const TECHNICAL_TOKEN = /catalog_|decision_evidence|source_scope|source_record|product_observation|pending_confirmation|review_required|needs_review|unresolved|N1A|N1C|fixture|schema|migration|ice_code|item_revision/i;

function businessText(issue: CatalogIssue): string {
  return [issue.summary, issue.reason, ...issue.differences, issue.stateLabel, issue.actionNote, issue.closureNote, issue.permissionLabel].join(' ');
}

describe('待处理问题索引 — 现役商品库事实与能力真值', () => {
  const issues = buildCatalogIssues(CORE_FACTS);

  it('只从两类既有事实派生，事项数与去重商品数口径分开', () => {
    expect(issues).toHaveLength(3);
    expect(issues.map((issue) => issue.kind).sort()).toEqual([
      'brush_pending',
      'brush_pending',
      'new_item_missing_code',
    ]);
    expect(dedupeItemCount(issues)).toBe(2);
    expect(unlinkedIssueCount(issues)).toBe(0);
  });

  it('去重键来自既有记录身份', () => {
    const keys = issues.map((issue) => issue.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain(`new_item_missing_code:${ITEM_A}`);
    expect(keys).toContain(`brush_pending:${DECISION_1}`);
    expect(keys).toContain(`brush_pending:${DECISION_2}`);
  });

  it('有现役动作的类别：给出处理入口与已定义关闭依据', () => {
    const missingCode = issues.find((issue) => issue.kind === 'new_item_missing_code')!;
    expect(missingCode.action).toBe('available');
    expect(missingCode.actionHref).toBe(`/dashboard/catalog?detail=${ITEM_A}&${FROM_QUERY}`);
    expect(missingCode.closure).toBe('defined');
    expect(missingCode.closureNote).toContain('自动消失');
    expect(missingCode.permissionLabel).toContain('商品资料写入');
    expect(missingCode.targetHref).toBe(missingCode.actionHref);
  });

  it('没有现役处理能力的类别：保留事项并如实说明“当前无处理入口 / 关闭依据待业务定义”', () => {
    const brush = issues.find((issue) => issue.kind === 'brush_pending' && issue.itemId === ITEM_A)!;
    expect(brush.action).toBe('none');
    expect(brush.actionHref).toBeNull();
    expect(brush.actionNote).not.toContain('当前没有处理入口');
    expect(brush.actionNote).toContain('待业务定义');
    expect(brush.closure).toBe('pending_definition');
    expect(brush.closureNote).toContain('待业务定义');
    expect(brush.closureNote).not.toContain('数据库');
    // 仍给只读参考入口（相关商品），不是“处理”按钮
    expect(brush.referenceHref).toBe(`/dashboard/catalog?detail=${ITEM_A}&${FROM_QUERY}`);
    expect(brush.targetHref).toBe(brush.referenceHref);
  });

  it('业务文案不含表名/状态码/模块编号/工程说明', () => {
    for (const issue of issues) {
      expect(businessText(issue)).not.toMatch(TECHNICAL_TOKEN);
    }
    const brush = issues.find((issue) => issue.kind === 'brush_pending' && issue.itemId === ITEM_A)!;
    expect(brush.summary).toContain('两刷子');
    expect(brush.summary).toContain('BigSeller');
    expect(brush.summary).not.toContain('bigseller');
    // 内部谓词仍保留在技术字段，供复核与测试使用（不渲染）
    expect(brush.predicate.length).toBeGreaterThan(0);
  });

  it('不把通用来源提示或候选冲突汇总为待办', () => {
    const serialized = JSON.stringify(issues);
    expect(serialized).not.toContain('SOURCE_IDENTITY_UNVERIFIED');
    expect(serialized).not.toContain('exact_code_hint');
    expect(serialized).not.toContain('conflicts');
    expect(serialized).not.toContain('outside_rules');
  });

  it('排序稳定：先新品缺码，再按名称与去重键', () => {
    const again = buildCatalogIssues(CORE_FACTS);
    expect(again.map((issue) => issue.key)).toEqual(issues.map((issue) => issue.key));
    expect(issues[0]!.kind).toBe('new_item_missing_code');
  });

  it('按种类计数（所有种类都有明确 0）与按商品计数可复核', () => {
    expect(countIssuesByKind(issues)).toEqual({
      new_item_missing_code: 1,
      brush_pending: 2,
      source_scope_unresolved: 0,
      source_identity_review: 0,
      source_identity_suspended: 0,
      new_item_review: 0,
      new_item_pending_association: 0,
      product_source_review: 0,
      source_formula_errors: 0,
      source_formula_fixed: 0,
      source_formula_unreadable: 0,
    });
    expect(countIssuesForItem(issues, ITEM_A)).toBe(2);
    expect(countIssuesForItem(issues, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc')).toBe(0);
  });
});

describe('待处理问题索引 — 既有模块状态（能力真值）', () => {
  const issues = buildCatalogIssues(MODULE_FACTS);

  it('来源记录：有现役复核/恢复动作，关闭依据已定义', () => {
    const review = issues.find((issue) => issue.key === `source_identity_record:${RECORD_1}`)!;
    expect(review.kind).toBe('source_identity_review');
    expect(review.itemId).toBeNull();
    expect(review.action).toBe('available');
    expect(review.actionHref).toBe(`/dashboard/catalog/sources?scope=${SCOPE_A}&record=${RECORD_1}&${FROM_QUERY}`);
    expect(review.closure).toBe('defined');
    expect(review.closureNote).toContain('自动消失');
    expect(review.stateLabel).toBe('待复核');

    const suspended = issues.find((issue) => issue.key === `source_identity_record:${RECORD_2}`)!;
    expect(suspended.kind).toBe('source_identity_suspended');
    expect(suspended.action).toBe('available');
    expect(suspended.stateLabel).toBe('已暂停');
  });

  it('未解析范围：保留事项并如实说明无处理入口（范围记录不可修改）', () => {
    const scopeIssues = issues.filter((issue) => issue.kind === 'source_scope_unresolved');
    expect(scopeIssues).toHaveLength(1);
    const scope = scopeIssues[0]!;
    expect(scope.key).toBe(`source_scope_unresolved:${SCOPE_UNRESOLVED}`);
    expect(scope.module).toBe('source_identity');
    expect(scope.itemId).toBeNull();
    expect(scope.action).toBe('none');
    expect(scope.actionHref).toBeNull();
    expect(scope.actionNote).not.toContain('当前没有处理入口');
    expect(scope.actionNote).toContain('待业务定义');
    expect(scope.closure).toBe('pending_definition');
    expect(scope.referenceHref).toContain(`scope=${SCOPE_UNRESOLVED}`);
  });

  it('持续新品观测：待复核与未关联商品都有现役动作；已关联/未分类不进入待办', () => {
    const review = issues.find((issue) => issue.key === `new_item_observation:${OBS_1}`)!;
    expect(review.kind).toBe('new_item_review');
    expect(review.action).toBe('available');
    expect(review.actionHref).toBe(`/dashboard/catalog/intake?scope=${SCOPE_A}&observation=${OBS_1}&${FROM_QUERY}`);
    expect(review.closure).toBe('defined');

    const association = issues.find((issue) => issue.key === `new_item_observation:${OBS_2}`)!;
    expect(association.kind).toBe('new_item_pending_association');
    expect(association.itemId).toBeNull();
    expect(association.action).toBe('available');
    expect(association.summary).toContain('尚未建档或关联');

    expect(issues.some((issue) => issue.key === `new_item_observation:${OBS_3}`)).toBe(false);
  });

  it('每条事项的能力字段自洽：有动作必有入口，无动作必有真实说明', () => {
    for (const issue of issues) {
      if (issue.action === 'available') {
        expect(issue.actionHref).not.toBeNull();
        expect(issue.actionNote.length).toBeGreaterThan(0);
      } else {
        expect(issue.actionHref).toBeNull();
        expect(issue.actionNote.length).toBeGreaterThan(0);
        expect(issue.actionNote).not.toContain('当前没有处理入口');
      }
      if (issue.closure === 'pending_definition') expect(issue.closureNote).toContain('待业务定义');
      else expect(issue.closureNote.length).toBeGreaterThan(0);
      expect(issue.targetHref).toBe(issue.actionHref ?? issue.referenceHref);
      expect(issue.permissionLabel.length).toBeGreaterThan(0);
    }
  });

  it('模块事项的业务文案同样不含内部标记', () => {
    for (const issue of issues) {
      expect(businessText(issue)).not.toMatch(TECHNICAL_TOKEN);
    }
  });
});

const PS_ISSUE_DUPLICATE = '99999999-1111-4999-8999-999999999991';
const PS_ISSUE_MISSING = '99999999-2222-4999-8999-999999999992';

const PRODUCT_SOURCE_FACTS: CatalogIssueFacts = {
  uncodedNewItems: [],
  brushPending: [],
  moduleFacts: {
    productSource: {
      sourceLabel: 'ICE产品库 · Sheet1',
      sourceHref: 'https://example.feishu.cn/wiki/demo',
      issues: [
        {
          issueId: PS_ISSUE_DUPLICATE,
          iceCode: 'WM0069',
          nameCn: '测试护发精油',
          kind: 'duplicate_code_inconsistent',
          kindLabel: '同号多行不一致',
          itemId: ITEM_A,
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
        },
        {
          issueId: PS_ISSUE_MISSING,
          iceCode: null,
          nameCn: null,
          kind: 'missing_code',
          kindLabel: '来源缺码',
          itemId: null,
          rows: [122],
          fieldLabels: [],
        },
      ],
    },
  },
};

describe('待处理问题索引 — 飞书商品资料来源待核对', () => {
  const issues = buildCatalogIssues(PRODUCT_SOURCE_FACTS);

  it('一条 open 来源事项一条待办，可定位货号、问题字段与来源行', () => {
    expect(issues).toHaveLength(2);
    expect(issues.every((issue) => issue.kind === 'product_source_review')).toBe(true);
    expect(issues.every((issue) => issue.module === 'product_source')).toBe(true);
    const duplicate = issues.find((issue) => issue.key === `product_source_review:${PS_ISSUE_DUPLICATE}`)!;
    expect(duplicate.itemId).toBe(ITEM_A);
    expect(duplicate.iceCode).toBe('WM0069');
    expect(duplicate.detail?.rows).toEqual([63, 128]);
    expect(duplicate.detail?.fieldLabels).toEqual(['商品条码']);
    expect(duplicate.detail?.productHref).toBe(`/dashboard/catalog?detail=${ITEM_A}&${FROM_QUERY}`);
    expect(duplicate.detail?.sourceHref).toBe('https://example.feishu.cn/wiki/demo');
    expect(duplicate.detail?.fixGuidance).toContain('重新读取');
    expect(duplicate.detail?.fixGuidance).toContain('应用本批');
    expect(duplicate.action).toBe('available');
    expect(duplicate.actionHref).toContain('/dashboard/catalog/sources');
    expect(duplicate.actionHref).toContain('#product-source');
    expect(duplicate.actionHref).toContain(FROM_QUERY);
  });

  it('「标记已处理」只关闭事项；不把事项写成已修改商品', () => {
    for (const issue of issues) {
      expect(issue.stateLabel).toBe('待核对');
      expect(issue.detail?.resolveNote).toContain('不改写商品资料');
      expect(issue.actionNote).toContain('标记已处理');
      expect(issue.actionNote).toContain('不改写商品资料');
      expect(issue.closureNote).toContain('标记已处理');
      expect(issue.closureNote).not.toContain('已修改商品');
    }
  });

  it('来源缺码项没有商品入口，仍给飞书原表与重新读取步骤', () => {
    const missing = issues.find((issue) => issue.key === `product_source_review:${PS_ISSUE_MISSING}`)!;
    expect(missing.itemId).toBeNull();
    expect(missing.detail?.rows).toEqual([122]);
    expect(missing.detail?.fieldLabels).toEqual([]);
    expect(missing.detail?.productHref).toBeNull();
    expect(missing.summary).toContain('来源缺码');
    expect(missing.detail?.fixGuidance).toContain('飞书原表');
    expect(missing.detail?.fixGuidance).toContain('重新读取');
  });

  it('来源事项的业务文案同样不含内部标记', () => {
    for (const issue of issues) {
      expect(businessText(issue)).not.toMatch(TECHNICAL_TOKEN);
      expect(issue.detail?.fixGuidance ?? '').not.toMatch(TECHNICAL_TOKEN);
      expect(issue.detail?.resolveNote ?? '').not.toMatch(TECHNICAL_TOKEN);
    }
  });

  it('计数：事项数 2、去重商品 1、未关联事项 1', () => {
    const index = buildCatalogIssueIndex(PRODUCT_SOURCE_FACTS, COVERAGE, '2026-11-10T02:00:00.000Z');
    if (index.state !== 'ok') throw new Error('unreachable');
    expect(index.issueCount).toBe(2);
    expect(index.itemCount).toBe(1);
    expect(index.unlinkedCount).toBe(1);
  });
});

describe('待处理问题索引 — 直接原因、差异与具体动作', () => {
  const issues = buildCatalogIssues(PRODUCT_SOURCE_FACTS);
  const duplicate = issues.find((issue) => issue.key === `product_source_review:${PS_ISSUE_DUPLICATE}`)!;

  it('同号多行：原因讲清“同号两行、条码不一致、选择采用行”，差异逐行默认可见', () => {
    expect(duplicate.reason).toBe('同一货号有两行，商品条码不一致，请选择以后采用哪行资料。');
    expect(duplicate.differences).toEqual(['第63行：未填写；第128行：757577407380。']);
    expect(duplicate.actionLabel).toBe('选择采用行');
    expect(duplicate.actionHref).toContain(`issue=${PS_ISSUE_DUPLICATE}`);
    expect(duplicate.actionHref).toContain(`#product-source-issue-${PS_ISSUE_DUPLICATE}`);
    expect(duplicate.referenceLabel).toBeNull();
  });

  it('同号多行：行号与差异值来自事项数据，不写死示例', () => {
    const changed = buildCatalogIssues({
      uncodedNewItems: [],
      brushPending: [],
      moduleFacts: {
        productSource: {
          sourceLabel: 'ICE产品库 · Sheet1',
          sourceHref: null,
          issues: [{
            ...PRODUCT_SOURCE_FACTS.moduleFacts!.productSource!.issues[0]!,
            rows: [166, 208],
            duplicate: {
              fields: [{
                fieldLabel: '商品条码',
                values: [
                  { rowNumber: 166, value: '', empty: true },
                  { rowNumber: 208, value: '6900000000012', empty: false },
                ],
              }],
            },
          }],
        },
      },
    });
    expect(changed[0]!.reason).toContain('同一货号有两行');
    expect(changed[0]!.differences).toEqual(['第166行：未填写；第208行：6900000000012。']);
  });

  it('商品级缺货号：原因说明尚无正式货号，按钮为“确认并补货号”并定位本事项', () => {
    const missingItem = buildCatalogIssues({
      uncodedNewItems: [],
      brushPending: [],
      moduleFacts: {
        productSource: {
          sourceLabel: 'ICE产品库 · Sheet1',
          sourceHref: 'https://example.feishu.cn/wiki/demo',
          issues: [{
            issueId: PS_ISSUE_MISSING,
            iceCode: null,
            nameCn: 'ICE LERSKIN 烟酰胺提亮精华水150ml',
            kind: 'missing_code',
            kindLabel: '来源缺码',
            itemId: ITEM_B,
            rows: [],
            fieldLabels: ['正式货号'],
            duplicate: null,
            pendingCode: true,
          }],
        },
      },
    });
    expect(missingItem[0]!.reason).toBe('该商品尚无正式货号，需要人工确认后补录。');
    expect(missingItem[0]!.differences).toEqual([]);
    expect(missingItem[0]!.actionLabel).toBe('确认并补货号');
    expect(missingItem[0]!.actionHref).toContain(`issue=${PS_ISSUE_MISSING}`);
    expect(missingItem[0]!.actionHref).toContain(`#product-source-issue-${PS_ISSUE_MISSING}`);
  });

  it('商品级缺货号：最新来源已读到候选货号时直接显示未填写→来源货号，按钮为“确认采用此货号”', () => {
    const missingItem = buildCatalogIssues({
      uncodedNewItems: [],
      brushPending: [],
      moduleFacts: {
        productSource: {
          sourceLabel: 'ICE产品库 · Sheet1',
          sourceHref: 'https://example.feishu.cn/wiki/demo',
          issues: [{
            issueId: PS_ISSUE_MISSING,
            iceCode: null,
            nameCn: 'ICE LERSKIN 烟酰胺提亮精华水150ml',
            kind: 'missing_code',
            kindLabel: '来源缺码',
            itemId: ITEM_B,
            rows: [],
            fieldLabels: ['正式货号'],
            duplicate: null,
            pendingCode: true,
            sourceCodeCandidate: {
              sourceCode: 'WM0131',
              rowNumbers: [134],
              capturedAtDisplay: '今天 12:10',
            },
          }],
        },
      },
    });
    expect(missingItem[0]!.reason).toBe('飞书已补充货号 WM0131，请确认用于这款商品。');
    expect(missingItem[0]!.differences).toEqual(['正式货号：未填写 → WM0131']);
    expect(missingItem[0]!.actionLabel).toBe('确认采用此货号');
  });

  it('刷子历史事项：一句话讲清两款分别保留、是否同款未确认，入口为“查看资料”', () => {
    const brush = buildCatalogIssues(MODULE_FACTS).filter((issue) => issue.kind === 'brush_pending');
    expect(brush).toHaveLength(2);
    for (const issue of brush) {
      expect(issue.reason).toBe('测试新品甲 与 WM0002 暂按两款分别保留，是否同款尚未确认。');
      expect(issue.actionLabel).toBe('查看资料');
      expect(issue.referenceLabel).toBe('查看资料');
      expect(issue.referenceHref).toContain('/dashboard/catalog?detail=');
    }
  });

  it('所有事项都有可直接展示的原因和动作文案，不再使用统一的“去处理”', () => {
    for (const issue of buildCatalogIssues(MODULE_FACTS)) {
      expect(issue.reason.trim().length).toBeGreaterThan(0);
      expect(issue.actionLabel.trim().length).toBeGreaterThan(0);
      expect(issue.actionLabel).not.toBe('去处理');
    }
  });
});

describe('处理后的索引变化（派生只依赖当前事实）', () => {
  it('补录货号/恢复记录/完成分类/完成关联后，对应事项从索引消失', () => {
    const before = buildCatalogIssues(MODULE_FACTS);
    expect(before.length).toBe(8);

    const afterHandled = buildCatalogIssues({
      uncodedNewItems: [], // 已补录货号
      brushPending: [], // 历史保留事实不在本测试输入内
      moduleFacts: {
        sourceIdentity: {
          scopes: [],
          records: [], // 记录已恢复有效/已撤销 → 不再进入事实
        },
        newItem: {
          scopes: [],
          observations: [
            // 分类已处理（离开待复核）
            { observationId: OBS_1, scopeId: SCOPE_A, scopeDisplayName: '来源范围甲', recordPointer: '/rows/1', nameHint: '观测一看', reviewState: 'proposed', classification: 'new_item', originItemId: ITEM_A },
            // 已完成关联
            { observationId: OBS_2, scopeId: SCOPE_A, scopeDisplayName: '来源范围甲', recordPointer: '/rows/2', nameHint: '观测二看', reviewState: 'proposed', classification: 'item_update', originItemId: ITEM_A },
          ],
        },
      },
    });
    expect(afterHandled).toHaveLength(0);
  });
});

describe('待处理问题索引 — 计数口径与空态', () => {
  it('事项数 / 去重商品数 / 未关联事项数分别计算', () => {
    const index = buildCatalogIssueIndex(MODULE_FACTS, COVERAGE, '2026-10-23T07:31:00.000Z');
    if (index.state !== 'ok') throw new Error('unreachable');
    // 3 条商品库事实 + 2 条记录 + 1 条范围 + 2 条观测 = 8 条事项
    expect(index.issueCount).toBe(8);
    // 去重商品：ITEM_A、ITEM_B
    expect(index.itemCount).toBe(2);
    // 未关联商品：两条记录 + 一条范围 + 一条未关联观测
    expect(index.unlinkedCount).toBe(4);
    expect(index.coverage).toEqual(COVERAGE);
    expect(index.generatedAt).toBe('2026-10-23T07:31:00.000Z');
  });

  it('真正的空态是三计数都为 0；1 条未关联事项不是空态', () => {
    const emptyIndex = buildCatalogIssueIndex({ uncodedNewItems: [], brushPending: [] }, COVERAGE, '2026-10-23T07:31:00.000Z');
    expect(isEmptyIssueIndex(emptyIndex)).toBe(true);
    expect(emptyIndex.issueCount).toBe(0);
    expect(emptyIndex.itemCount).toBe(0);
    expect(emptyIndex.unlinkedCount).toBe(0);

    const oneUnlinked = buildCatalogIssueIndex({
      uncodedNewItems: [],
      brushPending: [],
      moduleFacts: {
        sourceIdentity: {
          scopes: [{ scopeId: SCOPE_UNRESOLVED, displayName: '未解析范围丙', system: 'feishu', scopeState: 'unresolved' }],
          records: [],
        },
      },
    }, COVERAGE, '2026-10-23T07:31:00.000Z');
    expect(oneUnlinked.issueCount).toBe(1);
    expect(oneUnlinked.itemCount).toBe(0);
    expect(oneUnlinked.unlinkedCount).toBe(1);
    expect(isEmptyIssueIndex(oneUnlinked)).toBe(false);
  });

  it('工具栏投影：与可处理清单同一口径（不含刷子历史），失败给重试提示，无权限不给计数', () => {
    const okIndex = buildCatalogIssueIndex(CORE_FACTS, COVERAGE, '2026-10-23T07:31:00.000Z');
    if (okIndex.state !== 'ok') throw new Error('unreachable');
    // CORE_FACTS = 1 条新品缺货号 + 2 条刷子历史；刷子历史只在商品详情查看，不计入总览/徽标。
    expect(buildCatalogIssueToolbarModel(okIndex)).toEqual({
      state: 'ok',
      issueCount: buildCatalogPendingItems(okIndex.items).length,
      itemCount: 1,
    });
    expect(buildCatalogIssueToolbarModel(okIndex)).toEqual({ state: 'ok', issueCount: 1, itemCount: 1 });
    // 快照派生的合并事项（飞书原表生产工厂公式错误）通过 extraItemCount 追加，与大徽标/弹窗行数一致。
    expect(buildCatalogIssueToolbarModel(okIndex, 1)).toEqual({ state: 'ok', issueCount: 2, itemCount: 1 });
    expect(buildCatalogIssueToolbarModel(okIndex, 0)).toEqual({ state: 'ok', issueCount: 1, itemCount: 1 });
    expect(buildCatalogIssueToolbarModel(okIndex, -5)).toEqual({ state: 'ok', issueCount: 1, itemCount: 1 });
    expect(buildCatalogIssueToolbarModel({
      state: 'read_failed',
      error: '读取失败（网络、传输或环境异常），可重试。',
      coverage: COVERAGE,
    })).toEqual({ state: 'read_failed', message: '读取失败（网络、传输或环境异常），可重试。' });
    expect(buildCatalogIssueToolbarModel({ state: 'forbidden', error: '账号没有访问权限，或所请求的待处理索引不存在。' }))
      .toEqual({ state: 'forbidden' });
  });

  it('合并事项「飞书原表生产工厂公式错误」有中文标签（不写技术键名）', () => {
    expect(issueKindLabel('source_formula_errors')).toBe('飞书原表生产工厂公式错误');
  });
});

describe('入口 URL — 保留原处理上下文与安全返回点', () => {
  it('全部入口都带完整 from（待处理索引路径）', () => {
    expect(catalogDetailHref(ITEM_A)).toBe(`/dashboard/catalog?detail=${ITEM_A}&${FROM_QUERY}`);
    expect(legacySourceHref(ITEM_A)).toBe(`/dashboard/catalog/sources?item=${ITEM_A}&${FROM_QUERY}`);
    expect(sourceScopeHref(SCOPE_A)).toBe(`/dashboard/catalog/sources?scope=${SCOPE_A}&${FROM_QUERY}`);
    expect(sourceRecordHref(SCOPE_A, RECORD_1))
      .toBe(`/dashboard/catalog/sources?scope=${SCOPE_A}&record=${RECORD_1}&${FROM_QUERY}`);
    expect(intakeScopeHref(SCOPE_A)).toBe(`/dashboard/catalog/intake?scope=${SCOPE_A}&${FROM_QUERY}`);
    expect(intakeObservationHref(SCOPE_A, OBS_1))
      .toBe(`/dashboard/catalog/intake?scope=${SCOPE_A}&observation=${OBS_1}&${FROM_QUERY}`);
  });

  it('不把商品事项丢到通用来源首页', () => {
    expect(legacySourceHref(ITEM_A)).not.toBe('/dashboard/catalog/sources');
    expect(catalogDetailHref(ITEM_A)).not.toBe('/dashboard/catalog');
  });
});

describe('读取失败分类 — 未启用 / 无权限 / 网络失败不混用', () => {
  it('权限错误（SQLSTATE 42501、模块拒绝与中文提示）→ forbidden', () => {
    expect(classifyCatalogReadFailure(Object.assign(new Error('permission denied'), { code: '42501' }))).toBe('forbidden');
    expect(classifyCatalogReadFailure(new Error('无权限：需要管理员角色'))).toBe('forbidden');
    expect(classifyCatalogReadFailure(new Error('CATALOG_FORBIDDEN'))).toBe('forbidden');
    expect(classifyCatalogReadFailure(new Error('IDENTITY_DENIED'))).toBe('forbidden');
    expect(classifyCatalogReadFailure(new Error('NEW_ITEM_DENIED'))).toBe('forbidden');
    expect(classifyCatalogReadFailure(new Error('未登录或账户已停用'))).toBe('forbidden');
  });

  it('模块/环境未启用 → unavailable（不得写成 0 项）', () => {
    expect(classifyCatalogReadFailure(new Error('CATALOG_UNAVAILABLE'))).toBe('unavailable');
    expect(classifyCatalogReadFailure(new Error('NEW_ITEM_MODULE_DISABLED'))).toBe('unavailable');
    expect(classifyCatalogReadFailure(new Error('IDENTITY_FIXTURE_RUNTIME_DENIED'))).toBe('unavailable');
  });

  it('网络 / 传输 / SQL 故障 → read_failed（可重试，不并入无权限）', () => {
    expect(classifyCatalogReadFailure(new Error('ECONNRESET'))).toBe('read_failed');
    expect(classifyCatalogReadFailure(Object.assign(new Error('connect ETIMEDOUT'), { code: '08' }))).toBe('read_failed');
    expect(classifyCatalogReadFailure(new Error('boom'))).toBe('read_failed');
    expect(classifyCatalogReadFailure(null)).toBe('read_failed');
  });
});
