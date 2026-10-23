import type { Metadata } from 'next';
import { SealedLegacyRoute } from '@/ui/ice-v4/sealed-route';

export const metadata: Metadata = { title: '国内库存 · 已封存' };

export default function DomesticInventorySealedPage() {
  return (
    <SealedLegacyRoute title="国内库存（聚水潭）已封存">
      <p>旧国内库存经营界面已从现役路由树退出，尚未按 architecture-v3 与 product-plan-v4 接通真实聚水潭投影。</p>
      <p>样表库存与货值请使用 ICE 商品库；勿通过旧入口加载封存业务。</p>
    </SealedLegacyRoute>
  );
}
