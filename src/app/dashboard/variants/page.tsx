import type { Metadata } from 'next';
import { SealedLegacyRoute } from '@/ui/ice-v4/sealed-route';

export const metadata: Metadata = { title: 'SKU 管理 · 已封存' };

export default function VariantsSealedPage() {
  return (
    <SealedLegacyRoute title="SKU 与外部映射管理已封存">
      <p>旧 public.product / variant 维护界面已封存。商品身份与来源核实请使用 ICE 商品库与来源核实工作区。</p>
    </SealedLegacyRoute>
  );
}
