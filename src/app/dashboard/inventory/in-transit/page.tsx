import type { Metadata } from 'next';
import { SealedLegacyRoute } from '@/ui/ice-v4/sealed-route';

export const metadata: Metadata = { title: '在途库存 · 已封存' };

export default function InTransitInventorySealedPage() {
  return (
    <SealedLegacyRoute title="在途库存视图已封存">
      <p>旧在途库存汇总与货票关联界面已退出现役构建。</p>
      <p>后续物流/在途能力将按新方案分包验收后再开放。</p>
    </SealedLegacyRoute>
  );
}
