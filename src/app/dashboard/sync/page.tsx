import type { Metadata } from 'next';
import { SealedLegacyRoute } from '@/ui/ice-v4/sealed-route';

export const metadata: Metadata = { title: '库存同步 · 已封存' };

export default function SyncSealedPage() {
  return (
    <SealedLegacyRoute title="库存同步已封存">
      <p>旧来源读取、发布与同步运行记录界面已封存，Server Actions 与写入口不再对 Dashboard 开放。</p>
    </SealedLegacyRoute>
  );
}
