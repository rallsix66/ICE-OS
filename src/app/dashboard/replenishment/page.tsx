import type { Metadata } from 'next';
import { SealedLegacyRoute } from '@/ui/ice-v4/sealed-route';

export const metadata: Metadata = { title: '补货预测 · 已封存' };

export default function ReplenishmentSealedPage() {
  return (
    <SealedLegacyRoute title="预测式补货已封存">
      <p>旧补货建议、参数与计划货票入口已退出；不在本包以 Demo 或旧 RPC 替代。</p>
    </SealedLegacyRoute>
  );
}
