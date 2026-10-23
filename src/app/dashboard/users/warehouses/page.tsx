import type { Metadata } from 'next';
import { SealedLegacyRoute } from '@/ui/ice-v4/sealed-route';

export const metadata: Metadata = { title: '仓库分配 · 已封存' };

export default function WarehouseAssignmentSealedPage() {
  return (
    <SealedLegacyRoute title="仓库分配界面已封存">
      <p>旧成员-仓库范围配置页已封存；底层 RLS 与运行身份约束保持不变。</p>
    </SealedLegacyRoute>
  );
}
