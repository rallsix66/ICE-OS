import type { Metadata } from 'next';
import { LegacyInventoryGuidance } from '@/features/inventory/components/display';

export const metadata: Metadata = { title: '在途库存 · 未接入' };

/** 旧在途库存地址的安全引导：物流在途未接入，BigSeller 来源在途只在商品详情独立标注。 */
export default function InTransitInventoryGuidancePage() {
  return (
    <LegacyInventoryGuidance
      title="物流在途本包未接入"
      lede="飞书物流与喜运达在途本包未接入：不显示 0，也不补造在途数量。BigSeller 导出里的“来源在途”只在商品详情里独立标注。"
      points={[
        'BigSeller 来源在途 ≠ 飞书物流在途：两者不能互相替代，也不加进实物库存。',
        '到货不会自动加海外库存，发货也不会二次扣国内库存（本包不做这两类写入）。',
        '需要查看当前海外仓数量与来源时间，请到「商品库存」；自动读取状态见「数据同步」。',
      ]}
    />
  );
}
