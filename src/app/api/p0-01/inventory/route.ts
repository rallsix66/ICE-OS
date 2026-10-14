import { NextResponse } from 'next/server';

import { getP001BetterAuth } from '@/lib/independent-platform/p0-01-auth';
import { loadP001Config } from '@/lib/independent-platform/p0-01-config';
import { getInventoryForUser } from '@/features/p0-01-access/inventory-service';
import { resolveIceUserFromAuthUserId } from '@/features/p0-01-access/session-service';
import { noStoreHeaders, toP001ErrorResponse } from '@/features/p0-01-access/http-errors';
import { AuthenticationError } from '@/features/p0-01-access/authorization';

export async function GET(request: Request) {
  try {
    const config = loadP001Config();
    if (!config) {
      return NextResponse.json({ error: 'P0-01 未启用' }, { status: 404, headers: noStoreHeaders() });
    }

    const auth = getP001BetterAuth();
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user?.id) {
      throw new AuthenticationError('未登录或会话无效');
    }

    const user = await resolveIceUserFromAuthUserId(session.user.id);
    const url = new URL(request.url);
    const includeAmount = url.searchParams.get('includeAmount') === 'true';
    const marketCode = url.searchParams.get('marketCode') ?? undefined;
    const warehouseCode = url.searchParams.get('warehouseCode') ?? undefined;

    const data = await getInventoryForUser(user, {
      includeAmount,
      marketCode,
      warehouseCode,
    });

    return NextResponse.json(data, { headers: noStoreHeaders() });
  } catch (error) {
    return toP001ErrorResponse(error);
  }
}
