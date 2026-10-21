import 'server-only';

import { requireActiveAdmin } from '@/lib/auth';
import { isIndependentPlatformRuntime } from '@/lib/database/runtime';
import type { DbIdentity } from '@/lib/database/app-db';

export type CatalogAction = 'catalog:read' | 'catalog:write' | 'history:read' | 'amount:read' | 'evidence:read';

/** No client permission flags are consumed: the server policy is active-admin only. */
export async function requireCatalogAdmin(action: CatalogAction = 'catalog:read'): Promise<DbIdentity> {
  if (!isIndependentPlatformRuntime()) throw new Error('CATALOG_UNAVAILABLE');
  const actor = await requireActiveAdmin();
  // This explicit allowlist also makes new action additions fail closed.
  if (!['catalog:read', 'catalog:write', 'history:read', 'amount:read', 'evidence:read'].includes(action)) {
    throw new Error('CATALOG_FORBIDDEN');
  }
  return { profileUserId: actor.id };
}
