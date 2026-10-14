import { z } from 'zod';

import { withIceTransaction } from '@/lib/independent-platform/p0-01-tx-context';

import {
  assertActionAllowed,
  AuthorizationError,
  InactiveUserError,
  isKnownRole,
} from './authorization';
import {
  listInventoryInTransaction,
  marketCodeExists,
  userHasAmountGrantForMarket,
  userHasEffectiveInventoryScope,
  userHasMarketGrant,
  userHasWarehouseGrant,
  warehouseCodeExists,
} from './repository';
import type { IceActiveUserDto, InventoryListDto } from './types';

const inventoryQuerySchema = z.object({
  marketCode: z.string().min(1).optional(),
  warehouseCode: z.string().min(1).optional(),
  includeAmount: z.boolean().default(false),
});

export async function getInventoryForUser(
  user: IceActiveUserDto,
  rawQuery: unknown,
): Promise<InventoryListDto> {
  if (!user.isEnabled) {
    throw new InactiveUserError('账号已停用');
  }
  if (!isKnownRole(user.role)) {
    throw new AuthorizationError('未知角色');
  }

  const query = inventoryQuerySchema.parse(rawQuery);
  assertActionAllowed(user.role, 'inventory:read');

  if (query.includeAmount) {
    assertActionAllowed(user.role, 'amount:read');
    if (query.marketCode) {
      const allowed = await withIceTransaction({ iceUserId: user.iceUserId }, async (client) =>
        userHasAmountGrantForMarket(client, user.iceUserId, query.marketCode!),
      );
      if (!allowed) {
        throw new AuthorizationError('无权查看该市场金额');
      }
    } else {
      throw new AuthorizationError('查看金额必须指定市场');
    }
  }

  return withIceTransaction({ iceUserId: user.iceUserId }, async (client) => {
    if (query.marketCode) {
      const exists = await marketCodeExists(client, query.marketCode);
      if (!exists) {
        throw new AuthorizationError('无权访问该市场');
      }
      const allowed = await userHasMarketGrant(client, user.iceUserId, query.marketCode);
      if (!allowed) {
        throw new AuthorizationError('无权访问该市场');
      }
    }

    if (query.warehouseCode) {
      const exists = await warehouseCodeExists(client, query.warehouseCode);
      if (!exists) {
        throw new AuthorizationError('无权访问该仓库');
      }
      const allowed = await userHasWarehouseGrant(client, user.iceUserId, query.warehouseCode);
      if (!allowed) {
        throw new AuthorizationError('无权访问该仓库');
      }
    }

    const hasScope = await userHasEffectiveInventoryScope(
      client,
      user.iceUserId,
      query.marketCode,
      query.warehouseCode,
    );
    if (!hasScope) {
      throw new AuthorizationError('无权访问库存范围');
    }

    return listInventoryInTransaction(client, query);
  });
}
