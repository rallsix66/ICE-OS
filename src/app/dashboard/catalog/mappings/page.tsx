import { redirect } from 'next/navigation';
import { isUuid } from '@/features/inventory/model';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const MAX_TEXT_LENGTH = 120;

function first(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' ? raw : '';
}

function cleanText(raw: string, maxLength: number): string {
  return raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLength);
}

/**
 * 旧「来源 SKU 对应」页已退役：不再保留第二套编辑页。
 * 旧地址只按已有上下文跳到库存页的对应详情/筛选，不解析 from/back 等旧维护页参数：
 * - 有商品 item：打开该商品库存详情（/dashboard/inventory?item=<uuid>）；
 * - 有仓库 + 来源 SKU：打开仓库明细并按该仓该 SKU 定位；
 * - 只有来源 SKU/检索词：打开仓库明细并带入搜索；
 * - 无上下文：回仓库明细默认页。
 */
export default async function CatalogMappingsRedirectPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const item = cleanText(first(sp.item), 64);
  const warehouse = cleanText(first(sp.warehouse), 64);
  const sku = cleanText(first(sp.sku), MAX_TEXT_LENGTH);
  const q = cleanText(first(sp.q), MAX_TEXT_LENGTH);

  if (isUuid(item)) {
    redirect(`/dashboard/inventory?item=${encodeURIComponent(item)}`);
  }

  const params = new URLSearchParams();
  params.set('view', 'warehouse');
  if (isUuid(warehouse)) {
    params.set('warehouse', warehouse);
    params.set('source', 'overseas');
  }
  const search = sku || q;
  if (search) params.set('q', search);
  redirect(`/dashboard/inventory?${params.toString()}`);
}
