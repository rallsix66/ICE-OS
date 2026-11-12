'use client';

import { ShipmentGroupingReviewEntry } from '@/features/shipment/components/shipment-grouping-review';
import surface from '@/ui/ice-v4/data-surface.module.css';
import type { ShipmentGroupingReviewsDto } from '@/features/shipment/types';

/**
 * 经营总览「需要处理」里的物流分类动作：直接打开与物流在途页相同的整页居中复核弹窗。
 *
 * 总览是服务端组件，render prop 不能跨到客户端组件，所以在这里包一层客户端入口，
 * 复核弹窗本身仍复用同一个 `ShipmentGroupingReviewEntry`（variant="custom"）。
 * 按钮沿用统一控件外观（有边框的小按钮），文案明确写「复核货票」。
 */
export function HomePendingReview({
  reviews,
  error,
  label = '复核货票',
}: {
  reviews: ShipmentGroupingReviewsDto | null;
  error: string | null;
  label?: string;
}) {
  return (
    <ShipmentGroupingReviewEntry
      reviews={reviews}
      error={error}
      variant="custom"
      trigger={(openModal) => (
        <button
          type="button"
          className={`${surface.button} ${surface.buttonSmall}`}
          onClick={openModal}
          data-testid="home-pending-review-open"
        >
          {label}
        </button>
      )}
    />
  );
}
