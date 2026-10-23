import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

export const metadata: Metadata = { title: '产品列表' };

/** Legacy public.product 列表 — 重定向至商品库（search → q）。 */
export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: string; page?: string }>;
}) {
  const sp = await searchParams;
  const params = new URLSearchParams();
  if (sp.search?.trim()) params.set('q', sp.search.trim());
  const suffix = params.toString() ? `?${params.toString()}` : '';
  redirect(`/dashboard/catalog${suffix}`);
}
