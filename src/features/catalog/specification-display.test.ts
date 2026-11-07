import { describe, expect, it } from 'vitest';

import { catalogSpecFact } from './components/catalog-detail';
import { specText } from './local-display/service';
import type { CatalogItemDto, FieldObservation } from './types';

/**
 * 列表 / 详情规格显示一致性（第四轮，task-7）。
 *
 * 两个入口必须共用同一口径：商品库「规格」列优先，缺失时从标准名称提取净含量；
 * 规格字段 parse_failed 是真实错误，不得被名称提取掩盖。
 * 样例名称与规格取自真实商品库快照（WM0048 / WM0043 / WM0098 / LS101274 等）。
 */

const observed = (raw: string): FieldObservation => ({ state: 'observed', raw, meaning: 'value', evidenceRef: 'test' });
const empty = (): FieldObservation => ({ state: 'observed', raw: '', meaning: 'explicit_empty', evidenceRef: 'test' });
const nullValue = (): FieldObservation => ({ state: 'observed', raw: null, meaning: 'explicit_null', evidenceRef: 'test' });
const notRead = (): FieldObservation => ({ state: 'not_read', raw: null, reason: '未读取', evidenceRef: 'test' });
const noText = (): FieldObservation => ({ state: 'no_text', raw: null, evidenceRef: 'test' });
const parseFailed = (): FieldObservation => ({ state: 'parse_failed', raw: null, reason: '解析失败', evidenceRef: 'test' });

/** 最小可用商品 DTO：真实基线商品的 unit 字段是 not_read（来源无「单位」列）。 */
function makeItem(params: {
  nameCn: string;
  specification: FieldObservation;
  unit?: FieldObservation;
}): CatalogItemDto {
  const fields: Record<string, FieldObservation> = { specification: params.specification };
  if (params.unit) fields.unit = params.unit;
  return {
    itemId: '00000000-0000-0000-0000-000000000000',
    revision: 1,
    iceCode: null,
    codeState: 'awaiting_code',
    newProductConfirmed: false,
    nameCn: params.nameCn,
    specification: params.specification,
    barcodeRefs: [],
    fields,
    humanChoices: { bigseller: 0, jushuitan: 0 },
    sourceRecordId: null,
    sourceIdentityVerified: false,
    relationshipUsable: false,
    provenanceRefs: [],
  };
}

/** 详情当前把「有效单位」拼在规格后面；无有效单位时详情值就是规格文本。 */
function detailSpecText(item: CatalogItemDto): string {
  return catalogSpecFact(item).value;
}

describe('列表与详情规格显示一致（真实样例）', () => {
  it('WM0048：规格列为空，两个入口都从名称提取 1.8g，并标明名称提取', () => {
    const item = makeItem({ nameCn: 'CHIC PEAK 唇泥 P06- 1.8g', specification: empty() });
    expect(specText(item)).toBe('1.8g');
    const fact = catalogSpecFact(item);
    expect(fact.value).toBe('1.8g');
    expect(fact.hint).toContain('名称提取');
    expect(fact.warn).toBeFalsy();
    expect(detailSpecText(item)).toBe(specText(item));
  });

  it('WM0043：同系列 P01- 1.8g 也一致提取', () => {
    const item = makeItem({ nameCn: 'CHIC PEAK 唇泥 P01- 1.8g', specification: empty() });
    expect(specText(item)).toBe('1.8g');
    expect(detailSpecText(item)).toBe('1.8g');
  });

  it('WM0098：表列 120g/瓶 优先，两个入口都显示 120g/瓶', () => {
    const item = makeItem({ nameCn: 'ICE LERSKIN 三酸净化喷雾', specification: observed('120g/瓶') });
    expect(specText(item)).toBe('120g/瓶');
    expect(detailSpecText(item)).toBe('120g/瓶');
    expect(catalogSpecFact(item).hint).not.toContain('名称提取');
  });

  it('LS101274：表列 200ml/瓶 优先，7% 不被当成规格', () => {
    const item = makeItem({ nameCn: 'ICE LERSKIN 7% 乙醇酸爽肤水', specification: observed('200ml/瓶') });
    expect(specText(item)).toBe('200ml/瓶');
    expect(detailSpecText(item)).toBe('200ml/瓶');
  });

  it('名称提取保留组合规格（双头唇膏 1.1g+0.25g）', () => {
    const item = makeItem({ nameCn: 'CHIC.PEAK双头唇膏+唇线笔1.1g+0.25g 205', specification: empty() });
    expect(specText(item)).toBe('1.1g+0.25g');
    expect(detailSpecText(item)).toBe('1.1g+0.25g');
  });

  it('真实名称里的净含量都能对齐（WM0057 4.8g、WM0099 30ml、新品 150ml）', () => {
    const samples: Array<[string, string]> = [
      ['CHIC PEAK 腮红4.8g-M01', '4.8g'],
      ['ICE LERSKIN VC-阿魏酸抗氧化精华液 30ml', '30ml'],
      ['ICE LERSKIN 烟酰胺提亮精华水150ml', '150ml'],
    ];
    for (const [nameCn, expected] of samples) {
      const item = makeItem({ nameCn, specification: empty() });
      expect(specText(item)).toBe(expected);
      expect(detailSpecText(item)).toBe(expected);
    }
  });

  it('只有色号/货号时两边都不编造规格：列表留空（组件兜底“规格待补”），详情明确待补', () => {
    const item = makeItem({ nameCn: 'CHICPEAK 按压唇冻 #03', specification: empty() });
    expect(specText(item)).toBe('');
    const fact = catalogSpecFact(item);
    expect(fact.value).toBe('规格缺失（待补）');
    expect(fact.warn).toBe(true);
  });
});

describe('规格字段解析失败不得被名称提取掩盖', () => {
  it('parse_failed + 名称含 1.8g：两个入口都显示解析失败，不显示 1.8g', () => {
    const item = makeItem({ nameCn: 'CHIC PEAK 唇泥 P06- 1.8g', specification: parseFailed() });
    expect(specText(item)).toBe('规格解析失败');
    const fact = catalogSpecFact(item);
    expect(fact.value).toBe('规格解析失败');
    expect(fact.warn).toBe(true);
    expect(specText(item)).not.toContain('1.8g');
  });

  it('not_read / 明确空值 / 无可读文本 仍可按名称兜底，且两边一致', () => {
    for (const specification of [notRead(), nullValue(), noText()]) {
      const item = makeItem({ nameCn: 'ICELERSKIN乙醇酸爽水200ml', specification });
      expect(specText(item)).toBe('200ml');
      expect(detailSpecText(item)).toBe('200ml');
    }
  });
});

describe('单位与规格分开展示，不互相替代', () => {
  it('有效单位仍按现状拼接在详情规格后（列表单位另有「单位」格）', () => {
    const item = makeItem({
      nameCn: 'ICE LERSKIN 三酸净化喷雾',
      specification: observed('120g/瓶'),
      unit: observed('瓶'),
    });
    expect(specText(item)).toBe('120g/瓶');
    const fact = catalogSpecFact(item);
    expect(fact.value).toBe('120g/瓶 / 瓶');
    expect(fact.hint).toBeNull();
  });

  it('名称提取命中且单位缺失时，hint 同时说明名称提取与单位待补', () => {
    const item = makeItem({ nameCn: 'CHIC PEAK 唇泥 P06- 1.8g', specification: empty() });
    expect(catalogSpecFact(item).hint).toBe('名称提取 · 单位待补');
  });
});
