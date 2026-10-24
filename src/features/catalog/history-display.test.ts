import { describe, expect, it } from 'vitest';
import {
  BASELINE_INITIAL_REASON,
  BASELINE_INITIAL_REASON_LABEL,
  GENERIC_REVISION_REASON_LABEL,
  buildChangedFields,
  buildRevisionHistoryDisplay,
  formatRecordedAtDisplay,
  revisionReasonLabel,
} from './history-display';
import type { CatalogItemRevisionDto, FieldObservation } from './types';

const ITEM_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACTOR_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const OTHER_ACTOR_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const observed = (raw: string): FieldObservation => ({ state: 'observed', raw, meaning: 'value', evidenceRef: 'evidence-ref' });

function revisionRow(overrides: Partial<CatalogItemRevisionDto> & { revision: number }): CatalogItemRevisionDto {
  const fields = overrides.fields ?? { specification: observed('100ml') };
  return {
    itemId: ITEM_ID,
    revision: overrides.revision,
    iceCode: 'iceCode' in overrides ? overrides.iceCode ?? null : 'WM0043',
    codeState: overrides.iceCode === null ? 'awaiting_code' : 'coded',
    newProductConfirmed: overrides.newProductConfirmed ?? false,
    nameCn: overrides.nameCn ?? '滋越润肤乳',
    specification: fields.specification ?? { state: 'not_read', raw: null, reason: 'x', evidenceRef: 'e' },
    barcodeRefs: [],
    fields,
    humanChoices: { bigseller: 1, jushuitan: 0 },
    sourceRecordId: null,
    sourceIdentityVerified: false,
    relationshipUsable: false,
    provenanceRefs: [],
    revisionAudit: overrides.revisionAudit ?? {
      reason: 'accepted frozen baseline',
      actorId: ACTOR_ID,
      recordedAt: '2026-10-23T02:05:00.000Z',
      evidenceRef: 'match-bundle.json#items/0',
    },
  };
}

describe('formatRecordedAtDisplay（Asia/Shanghai，确定性）', () => {
  it('按东八区换算到分钟，跨日期也正确', () => {
    expect(formatRecordedAtDisplay('2026-10-23T02:05:00.000Z')).toBe('2026-10-23 10:05');
    expect(formatRecordedAtDisplay('2026-10-23T16:05:59.999Z')).toBe('2026-10-24 00:05');
    expect(formatRecordedAtDisplay('2026-01-01T00:00:00.000Z')).toBe('2026-01-01 08:00');
  });

  it('同一时刻重复格式化结果稳定（不随本机 locale 漂移）', () => {
    const iso = '2026-03-08T09:07:00.000Z';
    const first = formatRecordedAtDisplay(iso);
    expect(formatRecordedAtDisplay(iso)).toBe(first);
    expect(first).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('无效时间不编造，返回空串', () => {
    expect(formatRecordedAtDisplay('not-a-time')).toBe('');
  });
});

describe('revisionReasonLabel', () => {
  it('基线首版理由只在证据支持时映射为“初始资料承接（系统批量）”', () => {
    expect(revisionReasonLabel({ reason: BASELINE_INITIAL_REASON, revision: 1, baselineOrigin: true, hasEvidence: true }))
      .toBe(BASELINE_INITIAL_REASON_LABEL);
    // 证据缺失 / 来源不是基线 / 不是首版：都退回中性中文，不冒充系统批量承接
    expect(revisionReasonLabel({ reason: BASELINE_INITIAL_REASON, revision: 1, baselineOrigin: true, hasEvidence: false }))
      .toBe(GENERIC_REVISION_REASON_LABEL);
    expect(revisionReasonLabel({ reason: BASELINE_INITIAL_REASON, revision: 1, baselineOrigin: false, hasEvidence: true }))
      .toBe(GENERIC_REVISION_REASON_LABEL);
    expect(revisionReasonLabel({ reason: BASELINE_INITIAL_REASON, revision: 3, baselineOrigin: true, hasEvidence: true }))
      .toBe(GENERIC_REVISION_REASON_LABEL);
  });

  it('人为填写的中文理由原样透传', () => {
    expect(revisionReasonLabel({ reason: '人工核对规格后修订', revision: 2, baselineOrigin: true, hasEvidence: true }))
      .toBe('人工核对规格后修订');
  });

  it('内部英文 reason 一律不进入日常投影', () => {
    for (const reason of ['INITIAL_CODE_ASSIGNED', 'NONPRICE_REVISED', 'NEW_ITEM_CONFIRMED', '', '   ']) {
      expect(revisionReasonLabel({ reason, revision: 2, baselineOrigin: false, hasEvidence: true }))
        .toBe(GENERIC_REVISION_REASON_LABEL);
    }
  });
});

describe('buildChangedFields', () => {
  it('首版没有上一版本 → 无差异条目', () => {
    expect(buildChangedFields(null, revisionRow({ revision: 1 }))).toEqual([]);
  });

  it('按字段标签给出字段级差异，并包含货号变化', () => {
    const previous = revisionRow({ revision: 1, iceCode: null, fields: { specification: observed('100ml') } });
    const current = revisionRow({ revision: 2, iceCode: 'WM0043', fields: { specification: observed('120ml') } });
    expect(buildChangedFields(previous, current)).toEqual([
      { key: 'specification', label: '规格', before: '100ml', after: '120ml' },
      { key: 'iceCode', label: 'ICE 货号', before: '未分配', after: 'WM0043' },
    ]);
  });

  it('没有真实业务差异时不产出条目（只有证据引用变化不算资料修订）', () => {
    const previous = revisionRow({ revision: 1, fields: { specification: observed('100ml') } });
    const current = revisionRow({ revision: 2, fields: { specification: { ...observed('100ml'), evidenceRef: 'other-ref' } } });
    expect(buildChangedFields(previous, current)).toEqual([]);
  });

  it('未知字段键用中性中文标签，不透出内部字段名', () => {
    const previous = revisionRow({ revision: 1, fields: { internalKey: observed('a') } });
    const current = revisionRow({ revision: 2, fields: { internalKey: observed('b') } });
    const changes = buildChangedFields(previous, current);
    expect(changes).toEqual([{ key: 'internalKey', label: '其他资料字段', before: 'a', after: 'b' }]);
  });
});

describe('buildRevisionHistoryDisplay（日常投影）', () => {
  const rows = [
    revisionRow({
      revision: 2,
      iceCode: 'WM0043',
      fields: { specification: observed('120ml'), nameCn: observed('滋越润肤乳') },
      revisionAudit: { reason: '规格按来源修正', actorId: ACTOR_ID, recordedAt: '2026-10-23T16:05:00.000Z', evidenceRef: 'manual-request:xxxx' },
    }),
    revisionRow({
      revision: 1,
      iceCode: 'WM0043',
      fields: { specification: observed('100ml'), nameCn: observed('滋越润肤乳') },
    }),
  ];

  it('当前/历史、首版/修订、中文理由、可核实显示名与字段差异一次给全', () => {
    const [current, initial] = buildRevisionHistoryDisplay({
      rows,
      currentRevision: 2,
      originKind: 'baseline',
      actorLabels: new Map([[ACTOR_ID, '张管理']]),
    });
    expect(current).toMatchObject({
      revision: 2,
      iceCode: 'WM0043',
      nameCn: '滋越润肤乳',
      newProductConfirmed: false,
      display: {
        isCurrent: true,
        kind: 'revision',
        reasonLabel: '规格按来源修正',
        actorLabel: '张管理',
        recordedAtDisplay: '2026-10-24 00:05',
        hasEvidence: true,
      },
    });
    expect(current.display.changedFields).toEqual([{ key: 'specification', label: '规格', before: '100ml', after: '120ml' }]);
    expect(initial).toMatchObject({
      revision: 1,
      display: {
        isCurrent: false,
        kind: 'initial',
        reasonLabel: BASELINE_INITIAL_REASON_LABEL,
        actorLabel: '张管理',
        recordedAtDisplay: '2026-10-23 10:05',
        hasEvidence: true,
        changedFields: [],
      },
    });
  });

  it('显示名不可核实时为 null，绝不回传操作者 UUID', () => {
    const [current] = buildRevisionHistoryDisplay({ rows, currentRevision: 2, originKind: 'baseline', actorLabels: new Map() });
    expect(current.display.actorLabel).toBeNull();
    expect(JSON.stringify(current)).not.toContain(ACTOR_ID);
    expect(JSON.stringify(current)).not.toContain(OTHER_ACTOR_ID);
  });

  it('日常投影不含 UUID、证据路径、内部英文 reason、原始 ISO 时间', () => {
    const display = buildRevisionHistoryDisplay({ rows, currentRevision: 2, originKind: 'baseline', actorLabels: new Map([[ACTOR_ID, '张管理']]) });
    const serialized = JSON.stringify(display);
    expect(serialized).not.toMatch(/[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}/i);
    expect(serialized).not.toContain('.json');
    expect(serialized).not.toContain('manual-request');
    expect(serialized).not.toContain(BASELINE_INITIAL_REASON);
    expect(serialized).not.toContain('INITIAL_CODE_ASSIGNED');
    expect(serialized).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });

  it('没有证据时不宣称有证据，也不把空理由写成英文 key', () => {
    const noEvidence = revisionRow({
      revision: 1,
      revisionAudit: { reason: 'INITIAL_CODE_ASSIGNED', actorId: ACTOR_ID, recordedAt: '2026-10-23T02:05:00.000Z', evidenceRef: '' },
    });
    const [only] = buildRevisionHistoryDisplay({ rows: [noEvidence], currentRevision: 1, originKind: 'new_item', actorLabels: new Map() });
    expect(only.display.hasEvidence).toBe(false);
    expect(only.display.reasonLabel).toBe(GENERIC_REVISION_REASON_LABEL);
    expect(only.display.kind).toBe('initial');
    expect(only.display.isCurrent).toBe(true);
  });

  it('空历史返回空数组（无记录不等于有草稿历史）', () => {
    expect(buildRevisionHistoryDisplay({ rows: [], currentRevision: 1, originKind: null, actorLabels: new Map() })).toEqual([]);
  });
});
