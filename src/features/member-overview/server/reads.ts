import 'server-only';

import { requireActiveAuth } from '@/lib/auth';
import { adoptedUnitCostFromFinancial } from '@/features/catalog/local-display/adopted-price';
import { getInventoryWarehouseRows, getMemberItemAmounts } from '@/features/inventory/server/reads';
import { getMemberShipmentMarketSource } from '@/features/shipment/server/reads';
import { summarizeMemberInventory, summarizeMemberShipment } from '../aggregate';
import type { MyInventoryAccessDto } from '@/features/access/types';
import type { MemberInventorySummaryDto, MemberShipmentSummaryDto } from '../types';

/**
 * 成员经营总览服务端读取。
 *
 * - 只走现有成员读取入口：库存 read_inventory_warehouse_rows（043 按授权仓收窄）、
 *   物流 read_shipment_market_summary（047 按授权市场收窄）；
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

async function loadInventory(
  identity: { profileUserId: string },
  access: MyInventoryAccessDto,
): Promise<MemberInventorySummaryDto> {
  const rows = await getInventoryWarehouseRows(identity, {
    q: '',
    warehouse: 'all',
    market: 'all',
  });
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
