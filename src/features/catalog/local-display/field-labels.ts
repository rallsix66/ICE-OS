import type { FieldObservation } from '../types';

export const CATALOG_FIELD_LABELS: Record<string, string> = {
  nameCn: '中文产品名称',
  englishName: '英文名称',
  specification: '规格',
  unit: '单位',
  category: '商品分类',
  factory: '生产工厂',
  packaging: '包装',
  cartonQuantity: '装箱数量',
  barcode: '69编码（字符串）',
  imageRef: '图片引用',
  vendorRecordId: '供应商记录编号',
  width: '包装宽度',
  height: '包装高度',
  depth: '包装深度',
  weight: '包装重量',
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
