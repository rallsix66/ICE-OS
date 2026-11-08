/**
 * 在途明细的商品卡片组装（第四轮，纯函数、无 server-only，供 reads.ts 与单测共用）。
 *
 * 口径（用户 2026-11-02 批准）：
 * - 只按绑定的商品 ID 复用商品库现有读取结果（主档 + 采用进货价），**不新建价格通道**；
 * - 规格：商品库「规格」字段优先，字段缺失时才从标准名称提取（catalog/specification.ts）；
 * - 单位：只认商品库「单位」字段的有效值；没有就保持 null，页面显示「单位 待确认」；
 * - 单位成本：与商品库列表同一函数、同一文本（formatAdoptedUnitCostCell），缺价显示
 *   「成本待补充」并带短因，**不写 0、不冒充已确认货值**；
 * - 商品主档读取失败（item 为 null）时只降级该商品卡片：保留来源侧身份 fallback，
 *   规格留空、成本标「商品资料读取失败」，不让详情整页失败。
 */

import { adoptedUnitCostFromFinancial } from '@/features/catalog/local-display/adopted-price';
import { formatAdoptedUnitCostCell } from '@/features/catalog/local-display/list-row-display';
import { resolveSpecification } from '@/features/catalog/specification';
import type { CatalogItemDto, FieldObservation, PreparedFinancial } from '@/features/catalog/types';
import type { ShipmentLinkedProductDto } from '../types';

/** 商品主档读取失败时，用来源侧已有的身份兜底（不编造货号/名称）。 */
export interface ShipmentProductCardFallback {
  itemId: string;
  iceCode: string | null;
  nameCn: string | null;
}

/** 商品库「单位」字段的有效值；未读/空值/无文本一律 null（页面显示待确认，不当作有单位）。 */
function observedUnitText(field: FieldObservation | undefined): string | null {
  if (!field || field.state !== 'observed' || field.meaning !== 'value') return null;
  const text = field.raw.trim();
  return text === '' ? null : text;
}

/**
 * 商品库「装箱数量」的有效值：只认 observed/value 且原文是正整数的字段。
 * **不从规格/名称/体积推算**；缺字段或值不是正整数时返回 null（页面按箱填写不可用）。
 */
function observedPositiveInteger(field: FieldObservation | undefined): number | null {
  if (!field || field.state !== 'observed' || field.meaning !== 'value') return null;
  const raw = field.raw.trim();
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function missingUnitCost(reason: string): ShipmentLinkedProductDto['unitCost'] {
  return { state: 'missing', amountCny: null, label: '成本待补充', reason };
}

/**
 * 组装明细商品卡片：
 * - item 为 null：商品主档读取失败 → fallback 身份 + 空规格 + 缺价（原因「商品资料读取失败」）；
 * - financial 为 null：主档正常但无采用价格版本 → 规格/单位照常，成本走缺失文案。
 */
export function buildShipmentProductCard(
  item: CatalogItemDto | null,
  financial: PreparedFinancial | null,
  fallback: ShipmentProductCardFallback,
): ShipmentLinkedProductDto {
  if (!item) {
    return {
      itemId: fallback.itemId,
      iceCode: fallback.iceCode,
      nameCn: fallback.nameCn,
      specificationText: '',
      specificationSource: 'none',
      unitText: null,
      cartonQuantity: null,
      unitCost: missingUnitCost('商品资料读取失败'),
    };
  }

  const specification = resolveSpecification({ specification: item.specification, nameCn: item.nameCn });
  const adopted = adoptedUnitCostFromFinancial(financial);
  return {
    itemId: item.itemId,
    iceCode: item.iceCode,
    nameCn: item.nameCn,
    specificationText: specification.text,
    specificationSource: specification.source,
    unitText: observedUnitText(item.fields.unit),
    cartonQuantity: observedPositiveInteger(item.fields.cartonQuantity),
    unitCost: adopted.state === 'priced'
      ? {
        state: 'priced',
        amountCny: adopted.amountCny,
        label: formatAdoptedUnitCostCell(adopted),
        reason: null,
      }
      : missingUnitCost(adopted.reason),
  };
}
