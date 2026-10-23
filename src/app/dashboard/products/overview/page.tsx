import type { Metadata } from 'next';
import { SealedLegacyRoute } from '@/ui/ice-v4/sealed-route';

export const metadata: Metadata = { title: '全球库存作战室 · 已封存' };

export default function ProductOverviewSealedPage() {
  return (
    <SealedLegacyRoute title="全球库存作战室已封存">
      <p>旧 public 库存 RPC 作战室与决策队列已封存，不在现役导航中开放。</p>
    </SealedLegacyRoute>
  );
}
