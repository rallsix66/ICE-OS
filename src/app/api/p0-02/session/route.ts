import { getP002AuthSessionUser } from '@/lib/independent-platform/p0-02-session';
import { loadP002Config } from '@/lib/independent-platform/p0-02-config';

export async function GET() {
  if (!loadP002Config()) {
    return new Response(null, { status: 404 });
  }
  const user = await getP002AuthSessionUser();
  if (!user) {
    return new Response(null, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
}
