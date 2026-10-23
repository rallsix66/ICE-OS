import type { Metadata } from 'next';
import Link from 'next/link';
import { SealedLegacyRoute } from '@/ui/ice-v4/sealed-route';

export const metadata: Metadata = { title: '产品详情 · 已封存' };

/** 旧 public.product UUID 详情 — 不按 UUID 形态猜测商品库映射。 */
export default async function LegacyProductDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <SealedLegacyRoute title="旧产品详情地址已封存">
      <p>
        本地 ICE 主资料在
        {' '}
        <Link className="underline" href="/dashboard/catalog">ICE 商品库</Link>
        。旧路径
        {' '}
        <code>/dashboard/products/{id}</code>
        {' '}
        使用 legacy public.product 变体身份，系统不会自动映射为商品库条目 UUID。
      </p>
      <p>请从商品库列表按 ICE 货号或已知的商品库条目 UUID 打开详情。</p>
    </SealedLegacyRoute>
  );
}
