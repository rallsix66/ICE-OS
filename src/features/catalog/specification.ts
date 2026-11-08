/**
 * 商品规格解析（第四轮新增，商品库与在途共用）。
 *
 * 口径（用户 2026-11-02 确认）：
 * - 优先使用商品库表中已有的「规格」字段原文；已有有效规格原样保留，不改写、不换算；
 * - 规格字段缺失（未读取 / 明确空串 / 明确空值 / 无可读文本）时，从该商品的标准名称提取净含量；
 * - 净含量只认 g / 克 / ml / 毫升 / mg / kg / l，以及用 + / * / × 连接的组合
 *   （如 1.1g+0.25g、2.5g+2.5g、7.5g*10个/盒、23ml*5片）；
 * - 色号（P06、M04、#03、01）、ICE 货号、百分比（7%）不是规格；
 * - 本函数只负责「显示用规格文本」，不改商品资料、不改库存计数单位、不改单价计价单位；
 *   计数单位（支/瓶/盒…）仍以商品库「单位」字段为准，二者分开展示。
 */

import type { FieldObservation } from './types';

export type SpecificationSource = 'field' | 'name' | 'none';

export interface ResolvedSpecification {
  /** 可直接展示的规格文本；没有可用规格时为 ''（调用方决定显示「规格待补」）。 */
  text: string;
  /** field = 商品库规格列；name = 标准名称提取；none = 两者都没有。 */
  source: SpecificationSource;
  /** 名称提取命中的原文片段；field 来源时为 null。 */
  matched: string | null;
}

/** 净含量单位（不区分大小写；l 与 ml 同时出现时优先长单位，靠正则分支顺序保证）。 */
const NET_CONTENT_UNIT = 'ml|毫升|mg|kg|克|g|l';
/** 组合规格里允许出现的计数单位（只作为整体规格的一部分，不单独当规格）。 */
const COUNT_UNIT = '个|片|瓶|支|袋|只|包|对|盒|条|罐|套|双';

const FIRST_TOKEN = `\\d+(?:\\.\\d+)?\\s*(?:${NET_CONTENT_UNIT})`;
const EXTRA_TOKEN = `\\s*(?:\\+|＋|\\*|×|x|X)\\s*\\d+(?:\\.\\d+)?\\s*(?:${NET_CONTENT_UNIT}|${COUNT_UNIT})`;
const NET_CONTENT_PATTERN = new RegExp(`${FIRST_TOKEN}(?:${EXTRA_TOKEN})*`, 'i');

function fieldSpecText(field: FieldObservation | null | undefined): string | null {
  if (!field || field.state !== 'observed') return null;
  if (field.meaning !== 'value') return null;
  const text = field.raw.trim();
  return text || null;
}

/** 从标准名称里提取第一个净含量片段（含组合）。没有则返回 null。 */
export function extractSpecificationFromName(nameCn: string | null | undefined): string | null {
  const name = (nameCn ?? '').trim();
  if (!name) return null;
  const match = name.match(NET_CONTENT_PATTERN);
  if (!match) return null;
  return match[0].replace(/\s+/g, ' ').trim() || null;
}

/**
 * 解析展示规格：商品库规格字段优先，缺失时从标准名称提取。
 * 不修改任何原始字段；调用方不能用它回写商品资料。
 *
 * 两个入口同义：`specification` 是商品库字段观测（列表/详情），
 * `specificationText` 是搜索等只带独立规格原文的读取链；两者都先于名称提取。
 */
export function resolveSpecification(input: {
  specification?: FieldObservation | null;
  specificationText?: string | null;
  nameCn?: string | null;
}): ResolvedSpecification {
  const fieldText = fieldSpecText(input.specification)
    ?? (input.specificationText?.trim() || null);
  if (fieldText) return { text: fieldText, source: 'field', matched: null };
  const matched = extractSpecificationFromName(input.nameCn);
  if (matched) return { text: matched, source: 'name', matched };
  return { text: '', source: 'none', matched: null };
}
