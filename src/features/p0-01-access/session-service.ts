import { getP001AppPool } from '@/lib/independent-platform/p0-01-app-pool';
import { withIceTransaction } from '@/lib/independent-platform/p0-01-tx-context';

import {
  AuthenticationError,
  AuthorizationError,
  InactiveUserError,
  isKnownRole,
} from './authorization';
import { loadActiveUserByIceId, loadIceUserIdByAuthUserId } from './repository';
import type { IceActiveUserDto } from './types';

export async function resolveIceUserFromAuthUserId(authUserId: string): Promise<IceActiveUserDto> {
  const pool = getP001AppPool();
  const lookupClient = await pool.connect();
  let iceUserId: string;
  try {
    const mapped = await loadIceUserIdByAuthUserId(lookupClient, authUserId);
    if (!mapped) {
      throw new AuthenticationError('未绑定业务用户');
    }
    iceUserId = mapped;
  } finally {
    lookupClient.release();
  }

  return withIceTransaction({ iceUserId }, async (client) => {
    const row = await loadActiveUserByIceId(client, iceUserId);
    if (!row) {
      throw new AuthenticationError('业务用户不存在');
    }
    if (!row.is_enabled) {
      throw new InactiveUserError('账号已停用');
    }
    if (!isKnownRole(row.role)) {
      throw new AuthorizationError('未知角色');
    }
    return {
      iceUserId: row.id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
      isEnabled: row.is_enabled,
    };
  });
}
