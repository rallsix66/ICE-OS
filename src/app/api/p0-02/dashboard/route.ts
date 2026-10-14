import { inventoryRepository } from '@/features/inventory/repository';
import { preferencesRepository } from '@/features/preferences/repository';
import { shipmentRepository } from '@/features/shipments/repository';
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
    const [health, inTransit, lowStock, followed] = await Promise.all([
      inventoryRepository.getWarehouseHealthOverview(user.id),
      shipmentRepository.getInTransitDetail(user.id),
      inventoryRepository.getLowStock({ userId: user.id }),
      preferencesRepository.getFollowedVariantsBasic(user.id),
    ]);

    return Response.json(
      {
        health: { summary: health.summary },
        inTransitCount: inTransit.length,
        lowStockCount: lowStock.length,
        followedCount: followed.length,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return new Response(JSON.stringify({ error: 'Dashboard 数据加载失败', detail }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }
}
