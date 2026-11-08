import { describe, expect, it } from 'vitest';

import type { CatalogItemDto, FieldObservation, PreparedFinancial } from '@/features/catalog/types';
import { buildShipmentProductCard } from './product-card';

/**
 * 在途明细商品卡片单测（第四轮）。
 *
 * 覆盖：规格字段优先、名称兜底、金融缺失、商品主档缺失降级、单位为空；
 * 断言重点是「与商品库列表同文本」「缺价不写 0」「缺价与未绑定可区分」。
 */

function observedValue(raw: string): FieldObservation {
  return { state: 'observed', raw, meaning: 'value', evidenceRef: 'test#/规格' };
}

function observedEmpty(): FieldObservation {
  return { state: 'observed', raw: '', meaning: 'explicit_empty', evidenceRef: 'test#/规格' };
}

function notRead(): FieldObservation {
  return { state: 'not_read', raw: null, reason: '测试未读取', evidenceRef: 'test#/规格' };
}

function makeItem(overrides: Partial<CatalogItemDto> = {}): CatalogItemDto {
  return {
    itemId: 'item-1',
    revision: 1,
    iceCode: 'WM0098',
    codeState: 'coded',
    newProductConfirmed: false,
    nameCn: 'ICE LERSKIN 三酸净化喷雾',
    specification: observedValue('120g/瓶'),
    barcodeRefs: [],
    fields: {},
    humanChoices: { bigseller: 0, jushuitan: 0 },
    sourceRecordId: null,
    sourceIdentityVerified: false,
    relationshipUsable: false,
    provenanceRefs: [],
    ...overrides,
  };
}

function makeFinancial(cost: FieldObservation, sourceRow: number | null = 6): PreparedFinancial {
  return {
    cost,
    operatingPrice: notRead(),
    sourceRow,
    versions: [],
    currency: 'unknown',
    unit: 'unknown',
    tax: 'unknown',
    freight: 'unknown',
    valuationAuthorized: false,
    rawRef: 'test#/金融',
  };
}

const fallback = { itemId: 'item-1', iceCode: null, nameCn: null };

describe('buildShipmentProductCard', () => {
  it('priced：商品库规格字段优先，单位成本与商品库列表同文本', () => {
    const card = buildShipmentProductCard(
      makeItem({ fields: { unit: observedValue('瓶') } }),
      makeFinancial(observedValue('2.11')),
      fallback,
    );
    expect(card.specificationText).toBe('120g/瓶');
    expect(card.specificationSource).toBe('field');
    expect(card.unitText).toBe('瓶');
    expect(card.unitCost).toEqual({ state: 'priced', amountCny: '2.11', label: '¥2.11', reason: null });
    expect(card.iceCode).toBe('WM0098');
    expect(card.nameCn).toBe('ICE LERSKIN 三酸净化喷雾');
  });

  it('priced：整数成本按商品库原文本保留小数位（2 → ¥2，不补 .00）', () => {
    const card = buildShipmentProductCard(
      makeItem({ itemId: 'item-wm0098', iceCode: 'WM0098' }),
      makeFinancial(observedValue('2'), 92),
      fallback,
    );
    expect(card.unitCost).toEqual({ state: 'priced', amountCny: '2', label: '¥2', reason: null });
  });

  it('name 兜底：规格字段为空时从标准名称提取（CHIC PEAK 唇泥 P06- 1.8g → 1.8g）', () => {
    const card = buildShipmentProductCard(
      makeItem({
        iceCode: 'WM0048',
        nameCn: 'CHIC PEAK 唇泥 P06- 1.8g',
        specification: observedEmpty(),
        fields: { unit: observedValue('支') },
      }),
      makeFinancial(observedValue('3.5')),
      fallback,
    );
    expect(card.specificationText).toBe('1.8g');
    expect(card.specificationSource).toBe('name');
    expect(card.unitText).toBe('支');
  });

  it('name 兜底：组合规格与真实 WM0075 名称（1.1g+0.25g）', () => {
    const card = buildShipmentProductCard(
      makeItem({
        iceCode: 'WM0075',
        nameCn: 'CHIC.PEAK双头唇膏+唇线笔1.1g+0.25g- 201',
        specification: observedEmpty(),
      }),
      makeFinancial(observedValue('2.82')),
      fallback,
    );
    expect(card.specificationText).toBe('1.1g+0.25g');
    expect(card.specificationSource).toBe('name');
    expect(card.unitCost.label).toBe('¥2.82');
  });

  it('规格字段与名称都没有时：空规格 + none，不编造（WM0103 名称可提取 23ml 的对照）', () => {
    const none = buildShipmentProductCard(
      makeItem({ nameCn: 'ICE LERSKIN 三酸净化喷雾', specification: observedEmpty() }),
      makeFinancial(observedValue('2')),
      fallback,
    );
    expect(none.specificationText).toBe('');
    expect(none.specificationSource).toBe('none');

    const fromName = buildShipmentProductCard(
      makeItem({ iceCode: 'WM0103', nameCn: 'ICE LERSKIN 焕亮磨砂手套（单片装）23ml', specification: observedEmpty() }),
      makeFinancial(observedValue('0.48'), 101),
      fallback,
    );
    expect(fromName.specificationText).toBe('23ml');
    expect(fromName.specificationSource).toBe('name');
    expect(fromName.unitCost.label).toBe('¥0.48');
  });

  it('financial 缺失：规格/单位照常，成本待补充并带缺价原因（不写 0）', () => {
    const card = buildShipmentProductCard(
      makeItem({ fields: { unit: observedValue('瓶') } }),
      null,
      fallback,
    );
    expect(card.specificationText).toBe('120g/瓶');
    expect(card.unitText).toBe('瓶');
    expect(card.unitCost).toEqual({
      state: 'missing',
      amountCny: null,
      label: '成本待补充',
      reason: '无已承接的采用价格版本',
    });
  });

  it('financial 存在但成本为空：缺价原因取商品库同口径文案', () => {
    const card = buildShipmentProductCard(makeItem(), makeFinancial(observedEmpty(), 39), fallback);
    expect(card.unitCost.state).toBe('missing');
    expect(card.unitCost.label).toBe('成本待补充');
    expect(card.unitCost.amountCny).toBeNull();
    expect(card.unitCost.reason).toBe('当前资料无可用数值进货价');
  });

  it('item 缺失（商品资料读取失败）：fallback 身份 + 空规格 + 读取失败原因，只降级该商品', () => {
    const card = buildShipmentProductCard(null, null, {
      itemId: 'item-x',
      iceCode: 'WM0103',
      nameCn: 'ICE LERSKIN 焕亮磨砂手套（单片装）23ml',
    });
    expect(card).toEqual({
      itemId: 'item-x',
      iceCode: 'WM0103',
      nameCn: 'ICE LERSKIN 焕亮磨砂手套（单片装）23ml',
      specificationText: '',
      specificationSource: 'none',
      unitText: null,
      cartonQuantity: null,
      unitCost: { state: 'missing', amountCny: null, label: '成本待补充', reason: '商品资料读取失败' },
    });
  });

  it('装箱数量：只取商品库 cartonQuantity 的 observed 正整数字段（不从规格/名称推算）', () => {
    const priced = makeFinancial(observedValue('2.11'));
    const eighty = buildShipmentProductCard(makeItem({ fields: { cartonQuantity: observedValue('80') } }), priced, fallback);
    expect(eighty.cartonQuantity).toBe(80);

    const missing = buildShipmentProductCard(makeItem({ fields: {} }), priced, fallback);
    expect(missing.cartonQuantity).toBeNull();

    const notReadField = buildShipmentProductCard(
      makeItem({ fields: { cartonQuantity: notRead() } }), priced, fallback);
    expect(notReadField.cartonQuantity).toBeNull();

    const emptyField = buildShipmentProductCard(
      makeItem({ fields: { cartonQuantity: observedEmpty() } }), priced, fallback);
    expect(emptyField.cartonQuantity).toBeNull();

    for (const raw of ['0', '-8', '80.5', '80箱', '  ']) {
      const card = buildShipmentProductCard(
        makeItem({ fields: { cartonQuantity: observedValue(raw) } }), priced, fallback);
      expect(card.cartonQuantity, `cartonQuantity=${JSON.stringify(raw)}`).toBeNull();
    }

    // 规格里的 120g/瓶、名称里的 200ml 都不作为装箱数。
    const fromNameOnly = buildShipmentProductCard(
      makeItem({ nameCn: 'ICELERSKIN乙醇酸爽肤水200ml', fields: {} }), priced, fallback);
    expect(fromNameOnly.cartonQuantity).toBeNull();
  });

  it('unit 为空：未读取 / 明确空串 / 无文本都返回 null（显示单位待确认，不当作有单位）', () => {
    for (const unit of [undefined, notRead(), observedEmpty(), observedValue('   ')]) {
      const card = buildShipmentProductCard(
        makeItem({ fields: unit ? { unit } : {} }),
        makeFinancial(observedValue('2')),
        fallback,
      );
      expect(card.unitText).toBeNull();
    }
    const spaced = buildShipmentProductCard(
      makeItem({ fields: { unit: observedValue('   ') } }),
      makeFinancial(observedValue('2')),
      fallback,
    );
    expect(spaced.unitCost.state).toBe('priced');
  });
});
