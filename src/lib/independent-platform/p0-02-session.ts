import 'server-only';

import { headers } from 'next/headers';

import { getP002BetterAuth } from './p0-02-auth';
import { loadP002Config } from './p0-02-config';
import { resolveProfileUserId } from './p0-02-tx-context';

export async function getP002AuthSessionUser(): Promise<{ id: string; email?: string } | null> {
  const config = loadP002Config();
  if (!config) {
    return null;
  }
  const auth = getP002BetterAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user?.id) {
    return null;
  }
  return { id: session.user.id, email: session.user.email ?? undefined };
}

export async function getP002ProfileUserId(): Promise<string | null> {
  const authUser = await getP002AuthSessionUser();
  if (!authUser) {
    return null;
  }
  try {
    return await resolveProfileUserId(authUser.id);
  } catch {
    return null;
  }
}
