'use client';

import { createContext, useContext } from 'react';
import type { InventoryWarehouseRowDto } from '../types';

/**
 * 库存详情弹层的目标：
 * - row：仓库明细的一行（来源账号 × 仓库 × 来源 SKU），直接用行内事实渲染，不再多读一次；
 * - product：商品汇总的一行（标准商品），显示该商品在当前筛选范围的各仓库存。
 */
export type InventoryDetailTarget =
  | { kind: 'row'; row: InventoryWarehouseRowDto }
  | { kind: 'product'; itemId: string; label: string | null; sublabel: string | null };

export interface InventoryDetailApi {
  openRow(row: InventoryWarehouseRowDto): void;
  openProduct(target: { itemId: string; label: string | null; sublabel: string | null }): void;
}

export const InventoryDetailContext = createContext<InventoryDetailApi | null>(null);

export function useInventoryDetail(): InventoryDetailApi {
  const api = useContext(InventoryDetailContext);
  if (!api) throw new Error('InventoryDetailContext is missing');
  return api;
}
