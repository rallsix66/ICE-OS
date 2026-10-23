import type { Metadata } from 'next';
import { SealedLegacyRoute } from '@/ui/ice-v4/sealed-route';

export const metadata: Metadata = { title: '货票详情 · 已封存' };

export default async function ShipmentDetailSealedPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <SealedLegacyRoute title="货票详情已封存">
      <p>
        路径
        {' '}
        <code>/dashboard/shipments/{id}</code>
        {' '}
        对应的旧详情页已退出，不会加载封存业务数据。
      </p>
    </SealedLegacyRoute>
  );
}
