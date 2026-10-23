import type { Metadata } from 'next';
import { SealedLegacyRoute } from '@/ui/ice-v4/sealed-route';

export const metadata: Metadata = { title: '在途管理 · 已封存' };

export default function ShipmentsSealedPage() {
  return (
    <SealedLegacyRoute title="在途 / 货票管理已封存">
      <p>旧货票列表、编辑、Golucky 导入与批次入仓流程已封存。</p>
    </SealedLegacyRoute>
  );
}
