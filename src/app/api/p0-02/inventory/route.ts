import { inventoryRepository } from '@/features/inventory/repository';
import { requireActiveAuth } from '@/lib/auth';
import { loadP002Config } from '@/lib/independent-platform/p0-02-config';

export async function GET() {
  if (!loadP002Config()) {
    return new Response(JSON.stringify({ error: '未启用' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  let user;
  try {
    user = await requireActiveAuth();
  } catch {
    return new Response(JSON.stringify({ error: '未登录或账户已停用' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  try {
    const page = await inventoryRepository.getOverseasList({ userId: user.id, page: 1, pageSize: 50 });
    return Response.json(
      { items: page.data, total: page.total },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch {
    return new Response(JSON.stringify({ error: '库存查询失败' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }
}
