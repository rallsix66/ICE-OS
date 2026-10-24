import type { FieldObservation } from '../types';

/**
 * 字段标签与源列语义对齐（U4）。
 *
 * 冻结基线 `sources/baseline-adapter.ts` 的真实列是：length / width / height（单产品 cm）、
 * unitWeight（单个产品 kg）、cartonQuantity（装箱数量）、cartonLength / cartonWidth / cartonHeight（外箱 cm）、
 * cartonWeight（单箱重量）、cartonVolume / unitVolume、liquid / shelfLifeDays / factoryLeadDays / shippingDays。
 * 因此 width / height 是**单产品**宽高，不是“包装宽高”；这里只改展示标签，不迁移、不重算、不改历史值。
 *
 * `packaging` 在本批冻结主资料中没有来源列；标签保留为“包装（原字段，含义未定义）”，
 * 只在历史/附加信息中如实展示已有值，不再作为默认可填字段。
 */
export const CATALOG_FIELD_LABELS: Record<string, string> = {
  nameCn: '中文产品名称',
  englishName: '英文名称',
  specification: '规格',
  unit: '单位',
  category: '商品分类',
  factory: '生产工厂',
  packaging: '包装（原字段，含义未定义）',
  cartonQuantity: '装箱数量',
  barcode: '69编码（字符串）',
  imageRef: '图片引用',
  vendorRecordId: '供应商记录编号',
  length: '单产品长（cm）',
  width: '单产品宽（cm）',
  height: '单产品高（cm）',
  unitWeight: '单产品重量（kg）',
  cartonLength: '外箱长（cm）',
  cartonWidth: '外箱宽（cm）',
  cartonHeight: '外箱高（cm）',
  cartonWeight: '外箱重量（kg）',
  cartonVolume: '单箱体积',
  unitVolume: '单瓶体积',
  liquid: '是否液体',
  shelfLifeDays: '有效期（天）',
  factoryLeadDays: '工厂生产货期（天）',
  shippingDays: '运输时间（海运预估）',
  /** 旧字段名：本批冻结输入没有这些列。保留独立标签，不与 length / unitWeight 混用。 */
  depth: '深度（旧字段，未映射）',
  weight: '重量（旧字段，未映射）',
};

export function fieldBusinessValue(field: FieldObservation | undefined): string {
  if (!field || field.state === 'not_read') return '待补';
  if (field.state === 'no_text') return '未知';
  if (field.state === 'parse_failed') return '解析失败';
  if (field.state === 'observed') {
    if (field.meaning === 'explicit_empty') return '待补';
    if (field.meaning === 'explicit_null') return '未知';
    const trimmed = field.raw.trim();
    return trimmed || '待补';
  }
  return '待补';
}

export function fieldAuditValue(field: FieldObservation | undefined): string {
  if (!field || field.state !== 'observed') {
    return ({ no_text: '未读到文本', not_read: '未读取', parse_failed: '解析失败' })[field?.state ?? 'not_read'] ?? '未读取';
  }
  if (field.meaning === 'explicit_empty') return '明确空串';
  if (field.meaning === 'explicit_null') return '明确空值';
  return field.raw;
}

/**
 * 可选资料行：未提供（无记录 / 明确空串 / 未读取）时不占位，避免整屏“待补”；
 * 但真实错误（解析失败、无可读文本、明确空值）必须显示，不能被“隐藏可选字段”掩盖。
 */
export function optionalFieldRow(field: FieldObservation | undefined): { show: boolean; value: string } {
  const value = fieldBusinessValue(field);
  if (!field) return { show: false, value };
  if (field.state === 'not_read') return { show: false, value };
  if (field.state === 'observed' && field.meaning === 'explicit_empty') return { show: false, value };
  return { show: true, value };
}
