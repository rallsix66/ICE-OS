import 'server-only';

import { requireActiveAuth } from '@/lib/auth';
import { adoptedUnitCostFromFinancial } from '@/features/catalog/local-display/adopted-price';
import {
  getInventoryProductSummary,
  getInventoryWarehouseRows,
  getMemberItemAmounts,
} from '@/features/inventory/server/reads';
import { getMemberShipmentMarketSource } from '@/features/shipment/server/reads';
import { summarizeMemberInventory, summarizeMemberShipment } from '../aggregate';
import type { MyInventoryAccessDto } from '@/features/access/types';
import type { InventoryProductSummaryDto } from '@/features/inventory/types';
import type { MemberInventorySummaryDto, MemberShipmentSummaryDto } from '../types';

/**
 * 成员经营总览服务端读取。
 *
 * - 只走现有成员读取入口：库存 read_inventory_warehouse_rows（043 按授权仓收窄）、
 *   商品汇总 read_inventory_product_summary（同仓多来源 SKU / 单位冲突 / 已知小计判定）、
 *   物流 read_shipment_market_summary（047 按授权市场收窄）；
 * - 商品汇总按授权仓逐个读取：这样「同款商品在其他仓可明确计入」不会被别的仓的待核拖累；
 * - 金额只在 canViewAmount 时读取成员授权仓成本，沿用商品库存页的采用进货价与缺价口径；
 * - 两个板块各自读取、各自失败，一块失败不清空另一块，也不把失败写成 0。
 */

export interface MemberOverviewSection<T> {
  data: T | null;
  error: string | null;
}

export interface MemberOverviewSections {
  inventory: MemberOverviewSection<MemberInventorySummaryDto>;
  shipment: MemberOverviewSection<MemberShipmentSummaryDto>;
}

/** 单仓商品汇总：商品数超过 RPC 200 上限时按 total 继续翻页，避免只取第一页。 */
async function loadWarehouseProductSummary(
  identity: { profileUserId: string },
  warehouseId: string,
): Promise<InventoryProductSummaryDto> {
  let first: InventoryProductSummaryDto | null = null;
  const rows: InventoryProductSummaryDto['rows'] = [];
  for (let page = 0; page < 25; page += 1) {
    const dto = await getInventoryProductSummary(identity, {
      q: '',
      warehouse: warehouseId,
      market: 'all',
      limit: 200,
      offset: page * 200,
    });
    first ??= dto;
    rows.push(...dto.rows);
    if (rows.length >= dto.total || dto.rows.length === 0) break;
  }
  if (!first) throw new Error('MEMBER_OVERVIEW_PRODUCT_SUMMARY_EMPTY');
  return { ...first, rows, total: first.total };
}

async function loadInventory(
  identity: { profileUserId: string },
  access: MyInventoryAccessDto,
): Promise<MemberInventorySummaryDto> {
  const [rows, productSummaries] = await Promise.all([
    getInventoryWarehouseRows(identity, {
      q: '',
      warehouse: 'all',
      market: 'all',
    }),
    Promise.all(access.warehouses.map(async (warehouse) => ({
      warehouseId: warehouse.id,
      summary: await loadWarehouseProductSummary(identity, warehouse.id),
    }))),
  ]);
  let costMap: Record<string, string> | null = null;
  let amountError: string | null = null;
  if (access.canViewAmount) {
    try {
      const financial = await getMemberItemAmounts(identity);
      costMap = {};
      for (const [itemId, value] of financial) {
        const cost = adoptedUnitCostFromFinancial(value);
        if (cost.state === 'priced') costMap[itemId] = cost.amountCny;
      }
    } catch {
      amountError = '货值读取失败，本次未显示金额';
    }
  }
  return summarizeMemberInventory({
    rows,
    warehouses: access.warehouses,
    productSummaries,
    costMap,
    canViewAmount: access.canViewAmount,
    amountError,
  });
}

export async function getMemberOverviewSections(access: MyInventoryAccessDto): Promise<MemberOverviewSections> {
  const actor = await requireActiveAuth();
  const identity = { profileUserId: actor.id };
  const [inventory, shipment] = await Promise.allSettled([
    access.canViewInventory ? loadInventory(identity, access) : Promise.resolve(null),
    access.canViewShipment ? getMemberShipmentMarketSource().then((source) => (
      summarizeMemberShipment(source, access.shipmentMarkets)
    )) : Promise.resolve(null),
  ]);

  return {
    inventory: inventory.status === 'fulfilled'
      ? { data: inventory.value, error: null }
      : { data: null, error: '库存读取失败，请刷新重试' },
    shipment: shipment.status === 'fulfilled'
      ? { data: shipment.value, error: null }
      : { data: null, error: '物流读取失败，请刷新重试' },
  };
}
