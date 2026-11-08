import { describe, expect, it } from 'vitest';

import type { FieldObservation } from './types';
import { extractSpecificationFromName, resolveSpecification } from './specification';

const observed = (raw: string): FieldObservation => ({
  state: 'observed',
  raw,
  meaning: 'value',
  evidenceRef: 'test',
});
const empty = (): FieldObservation => ({ state: 'observed', raw: '', meaning: 'explicit_empty', evidenceRef: 'test' });
const nullValue = (): FieldObservation => ({ state: 'observed', raw: null, meaning: 'explicit_null', evidenceRef: 'test' });
const notRead = (): FieldObservation => ({ state: 'not_read', raw: null, reason: '未读取', evidenceRef: 'test' });

describe('extractSpecificationFromName（净含量，不认色号/货号/百分比）', () => {
  it('用户给出的三个例子', () => {
    expect(extractSpecificationFromName('CHIC PEAK 唇泥 P06- 1.8g')).toBe('1.8g');
    expect(extractSpecificationFromName('ICELERSKIN乙醇酸爽肤水200ml')).toBe('200ml');
    expect(extractSpecificationFromName('CHIC.PEAK双头唇膏+唇线笔1.1g+0.25g 205')).toBe('1.1g+0.25g');
  });

  it('常见商品库名称', () => {
    expect(extractSpecificationFromName('CHICPEAK 双头唇釉 C01 2.5g+2.5g')).toBe('2.5g+2.5g');
    expect(extractSpecificationFromName('CHIC PEAK 唇泥 P01- 1.8g')).toBe('1.8g');
    expect(extractSpecificationFromName('CHIC PEAK 腮红4.8g-M01')).toBe('4.8g');
    expect(extractSpecificationFromName('CHIC.PEAK 多功能彩妆盘（玫瑰粉色）9.5g')).toBe('9.5g');
    expect(extractSpecificationFromName('ICE LERSKIN 防晒水喷雾90ml')).toBe('90ml');
    expect(extractSpecificationFromName('GreTeam身体油\n333克')).toBe('333克');
    expect(extractSpecificationFromName('CHIC.PEAK防晒气垫 01#象牙白 12g替換裝'.replace('替換裝', '替换装'))).toBe('12g');
    expect(extractSpecificationFromName('ICE LERSKIN 日夜爆痘急救笔 5ml+5ml')).toBe('5ml+5ml');
  });

  it('组合包装：保留完整组合片段，不把数量单独当规格', () => {
    expect(extractSpecificationFromName('ICE LERSKIN 毛孔清洁布丁泥膜 7.5g*10个/盒')).toBe('7.5g*10个');
    expect(extractSpecificationFromName('ICE LERSKIN 焕亮磨砂手套（盒装5片）23ml*5片')).toBe('23ml*5片');
    expect(extractSpecificationFromName('CHICPEAK 双头眉笔与染眉膏 B01（深棕）--2g+0.23g')).toBe('2g+0.23g');
  });

  it('色号、货号、百分比、日期不是规格', () => {
    expect(extractSpecificationFromName('ICE LERSKIN 7% 乙醇酸爽肤水')).toBeNull();
    expect(extractSpecificationFromName('CHIC PEAK 唇泥 P06-')).toBeNull();
    expect(extractSpecificationFromName('WM0057 CHIC PEAK 腮红-M04')).toBeNull();
    expect(extractSpecificationFromName('CHICPEAK 按压唇冻 #03')).toBeNull();
    expect(extractSpecificationFromName('POKNZX022306')).toBeNull();
    expect(extractSpecificationFromName('')).toBeNull();
    expect(extractSpecificationFromName(null)).toBeNull();
  });
});

describe('resolveSpecification（表列优先，名称兜底）', () => {
  it('已有有效规格原样保留，忽略名称里的其它数字', () => {
    expect(resolveSpecification({
      specification: observed('200ml/瓶'),
      nameCn: 'ICE LERSKIN 7% 乙醇酸爽肤水',
    })).toEqual({ text: '200ml/瓶', source: 'field', matched: null });
  });

  it('规格为空/未读取/明确空值时从名称提取', () => {
    expect(resolveSpecification({ specification: empty(), nameCn: 'CHIC PEAK 唇泥 P06- 1.8g' }))
      .toEqual({ text: '1.8g', source: 'name', matched: '1.8g' });
    expect(resolveSpecification({ specification: notRead(), nameCn: 'ICELERSKIN乙醇酸爽肤水200ml' }))
      .toEqual({ text: '200ml', source: 'name', matched: '200ml' });
    expect(resolveSpecification({ specification: nullValue(), nameCn: 'CHICPEAK 双头唇釉 C01 2.5g+2.5g' }))
      .toEqual({ text: '2.5g+2.5g', source: 'name', matched: '2.5g+2.5g' });
  });

  it('两者都没有时返回空，不编造规格', () => {
    expect(resolveSpecification({ specification: empty(), nameCn: 'CHIC PEAK 唇泥 P06-' }))
      .toEqual({ text: '', source: 'none', matched: null });
    expect(resolveSpecification({ specification: undefined, nameCn: '售后卡' }))
      .toEqual({ text: '', source: 'none', matched: null });
  });

  it('只带独立规格原文的读取链（关联搜索）：独立规格优先，名称补充', () => {
    expect(resolveSpecification({ specificationText: '120g/瓶', nameCn: 'ICE LERSKIN 三酸净化喷雾' }))
      .toEqual({ text: '120g/瓶', source: 'field', matched: null });
    expect(resolveSpecification({ specificationText: null, nameCn: 'CHIC PEAK 唇泥 P06- 1.8g' }))
      .toEqual({ text: '1.8g', source: 'name', matched: '1.8g' });
    expect(resolveSpecification({ specificationText: '  ', nameCn: 'ICE LERSKIN 三酸净化喷雾' }))
      .toEqual({ text: '', source: 'none', matched: null });
    // 独立规格与名称不一致时以独立规格为准，不覆盖原文。
    expect(resolveSpecification({ specificationText: '200ml/瓶', nameCn: '示例名称100ml' }))
      .toEqual({ text: '200ml/瓶', source: 'field', matched: null });
  });
});
