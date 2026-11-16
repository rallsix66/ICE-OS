import 'server-only';

import type { DbIdentity } from '@/lib/database/app-db';
import {
  buildPendingBindingRows,
  type PendingBindingCountResult,
  type PendingBindingsReadResult,
} from '../pending-bindings';
import type { InventoryMappingQueueItemDto } from '../types';
import { getInventoryMappingQueue } from './reads';

/**
 * 商品库存页「待处理」清单的服务端读取。
 *
 * - 复用已有映射队列 RPC `catalog.read_inventory_mapping_queue`（它已排除 confirmed 绑定）；
 * - 队列要按参与仓（overview.scope.warehouseIds）过滤后才等于库存页的可处理数量，
 *   所以分页拉全（limit 100 / 最多 5 页）再交给纯函数过滤，不能在单页上算数；
 * - 读取失败返回 state='read_failed'（数量为 null），不抛崩整页、也不补 0；
 * - 首屏只流式读取「数量」，完整清单在打开弹窗时再懒加载（同一队列、同一过滤口径）。
 */

const QUEUE_PAGE_SIZE = 100;
const QUEUE_MAX_PAGES = 5;

type QueueRead =
  | { ok: true; items: InventoryMappingQueueItemDto[]; queueTotal: number }
  | { ok: false; error: string };

/** 分页拉全队列；超过分页上限时宁可不显示数字，也不显示被截断的错误数量。 */
async function readMappingQueue(identity: DbIdentity): Promise<QueueRead> {
  try {
    const items: InventoryMappingQueueItemDto[] = [];
    let queueTotal = 0;
    let offset = 0;
    for (let page = 0; page < QUEUE_MAX_PAGES; page += 1) {
      const queue = await getInventoryMappingQueue(identity, { search: '', offset, limit: QUEUE_PAGE_SIZE });
      if (page === 0) queueTotal = queue.total;
      if (queue.items.length === 0) break;
      items.push(...queue.items);
      offset += queue.items.length;
      if (items.length >= queueTotal) break;
    }
    if (queueTotal > items.length) {
      return { ok: false, error: '待绑定记录过多，未能一次读取全部；请稍后刷新重试。' };
    }
    return { ok: true, items, queueTotal };
  } catch {
    return { ok: false, error: '待绑定清单读取失败；请稍后刷新重试。' };
  }
}

export async function getInventoryPendingBindings(
  identity: DbIdentity,
  scopeWarehouseIds: readonly string[],
): Promise<PendingBindingsReadResult> {
  const read = await readMappingQueue(identity);
  if (!read.ok) return { state: 'read_failed', rows: [], total: null, error: read.error };
  const built = buildPendingBindingRows(read.items, scopeWarehouseIds);
  return { state: 'ok', rows: built.rows, total: built.total };
}

/**
 * 首屏流式计数：只返回与完整清单同一口径的数量（不把 141 行下发到首屏）。
 * 读取失败返回 count=null（入口显示「读取失败」，不补 0）。
 */
export async function getInventoryPendingBindingCount(
  identity: DbIdentity,
  scopeWarehouseIds: readonly string[],
): Promise<PendingBindingCountResult> {
  const read = await readMappingQueue(identity);
  if (!read.ok) return { state: 'read_failed', count: null, error: read.error };
  const built = buildPendingBindingRows(read.items, scopeWarehouseIds);
  return { state: 'ok', count: built.total };
}
