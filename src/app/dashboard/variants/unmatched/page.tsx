import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

export const metadata: Metadata = { title: '未匹配 SKU · 已封存' };

export default function VariantsUnmatchedSealedPage() {
  redirect('/dashboard/variants');
}
