import type { Metadata } from 'next';
import Link from 'next/link';
import { ReadFailurePanel } from '@/features/inventory/components/display';
import { classifyReadFailure } from '@/features/inventory/model';
import { PageHeading } from '@/ui/ice-v4/data-surface';
import surface from '@/ui/ice-v4/data-surface.module.css';
import { ValuationFacts } from '@/features/overview/components/valuation-facts';
import { getBusinessOverviewData } from '@/features/overview/server/reads';
import styles from '@/features/overview/components/business-overview.module.css';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const metadata: Metadata = { title: '估值口径与未计入说明' };

/**
 * /dashboard/valuation：把原先经营总览首页折叠的「估值口径与未计入说明」整块放到独立页面。
 *
 * - 服务端复用 `getBusinessOverviewData()` 与同一份 aggregate，口径与首页完全一致，不重新计算；
 * - 登录/读取失败照常给失败面板，不显示 0 或假总额；
 * - 只提供「返回经营总览」入口，不新增操作。
 */
export default async function ValuationPage() {
  let data;
  try {
    data = await getBusinessOverviewData();
  } catch (error) {
    return (
      <ReadFailurePanel
        kind={classifyReadFailure(error)}
        backHref="/dashboard"
        backLabel="返回经营总览"
        extra={(
          <p style={{ margin: '10px 0 0', color: '#8d98a8', fontSize: '12px' }}>
            估值口径依赖商品库存汇总；没有读到时不显示任何缺价或未计入数量，可刷新重试。
          </p>
        )}
      />
    );
  }

  return (
    <div className={styles.page} data-testid="valuation-page">
      <PageHeading
        title="估值口径与未计入说明"
        meta="金额只统计已计价数量；缺价、数量未知与未对应行不算 0。"
        actions={(
          <Link className={`${surface.button} ${surface.buttonSmall}`} href="/dashboard">
            返回经营总览
          </Link>
        )}
      />
      <section className={styles.panel} aria-label="估值口径与未计入说明">
        <ValuationFacts data={data} />
      </section>
    </div>
  );
}
