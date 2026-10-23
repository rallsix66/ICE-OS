import type { Metadata } from 'next';
import { SealedLegacyRoute } from '@/ui/ice-v4/sealed-route';

export const metadata: Metadata = { title: '海外库存 · 已封存' };

export default function OverseasInventorySealedPage() {
  return (
    <SealedLegacyRoute title="海外库存已封存">
      <p>旧 BigSeller 海外库存页、导出与绑定流程已封存，不在本包重新开放。</p>
      <p>六仓样表投影与 BS 430/100 展示仍在 ICE 商品库列表与详情中按已验收口径提供。</p>
    </SealedLegacyRoute>
  );
}
