import type { Metadata } from 'next';
import { LegacyInventoryGuidance } from '@/features/inventory/components/display';

export const metadata: Metadata = { title: '海外库存 · 已并入商品库存' };

/** 旧海外库存地址的安全引导：范围已由新的「商品库存」统一承载，不恢复旧写入链。 */
export default function OverseasInventoryGuidancePage() {
  return (
    <LegacyInventoryGuidance
      title="海外库存已统一到「商品库存」"
      lede="旧海外库存页不再单独展示。BigSeller 各仓数量、来源时间与批次历史，统一在「商品库存」按商品身份查看；旧写入链不恢复。"
      points={[
        '列表与同页详情使用同一批当前库存读取函数，不会一个读新批次、一个读冻结样表。',
        '缺仓、未对应或单位不一致时只显示已知小计与缺口，不装成完整总量。',
        '每个仓的成功时间与当前范围“最后全部成功时间”在「数据同步」页单独展示。',
      ]}
    />
  );
}
