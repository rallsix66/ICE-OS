import type { Metadata } from 'next';
import { LegacyInventoryGuidance } from '@/features/inventory/components/display';

export const metadata: Metadata = { title: '国内库存 · 未接入' };

/** 旧国内库存地址的安全引导：不恢复旧写入链，也不把“未接入”写成 0。 */
export default function DomesticInventoryGuidancePage() {
  return (
    <LegacyInventoryGuidance
      title="国内库存（聚水潭）本包未接入"
      lede="旧国内库存界面已从现役路由树退出。本包只接入 BigSeller 海外仓库存；国内库存（聚水潭）显示“未接入”，不补 0，也不并入海外仓合计。"
      points={[
        '国内库存本包未接入：不显示 0，也不当作没有库存；不会用海外仓数量代替国内数量。',
        '海外仓数量、来源时间与批次历史，请到「商品库存」按商品身份查看。',
        '旧的手工改库存与旧写入口不恢复；本包不部署、不写回来源系统。',
      ]}
    />
  );
}
