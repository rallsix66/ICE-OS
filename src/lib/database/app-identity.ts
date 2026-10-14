import 'server-only';

import { requireActiveAuth } from '@/lib/auth';
import type { DbIdentity } from '@/lib/database/app-db';

/** 当前会话对应的 app DB 身份（profiles.id + RLS GUC）。 */
export async function requireAppDbIdentity(): Promise<DbIdentity> {
  const user = await requireActiveAuth();
  return { profileUserId: user.id };
}
