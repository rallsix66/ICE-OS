import Link from 'next/link';
import { formatHomeQuantity } from '../model';
import type { HomePageData } from '../server/reads';
import styles from './business-overview.module.css';

/**
 * 「估值口径与未计入说明」正文（原经营总览首页折叠块）。
 *
 * 已从首页移出，只在 /dashboard/valuation 渲染：内容与首页原来的折叠块一致
 * （金额口径、缺价商品、合计待核对、未对应来源行、数量未知/市场待确认、在途未计入与货值补充说明），
 * 不重新计算、不补 0；服务端数据仍来自 getBusinessOverviewData() 的同一份 aggregate。
 */
export function ValuationFacts({ data }: { data: HomePageData }) {
  const { aggregate } = data;
  // 金额权限与「进货价读取失败」分开：成本失败不是权限不足，也不是缺价 0。
  const costFailed = data.costReadFailed;
  const showAmounts = data.amountsVisible && !costFailed;
  const amountNote = data.amountsVisible
    ? costFailed
      ? '进货价读取失败，本次不计算金额、也不判断缺价；数量仍按来源显示，不生成补价待办。'
      : '估算货值 = 实物数量 × 商品库当前采用进货价（人民币、单品、不含运费）。'
    : '当前账号无金额权限，只显示数量，不显示估算货值。';

  return (
    <div className={styles.valuation}>
      <p className={styles.valuationNote}>{amountNote}</p>
      <ul className={styles.valuationFacts}>
        {costFailed ? (
          <li data-testid="home-valuation-cost-failed">
            进货价读取失败：本次不计算金额、不判断缺价，也不生成补价待办；数量与未计入情况仍按来源显示。
          </li>
        ) : (
          <li>缺进货价：<strong>{aggregate.valuation.missingCostProducts.length} 款</strong> / {formatHomeQuantity(aggregate.valuation.missingCostQuantity)} 件已知数量（库存+在途）未计入金额</li>
        )}
        <li>
          海外合计待核对：<strong>{aggregate.valuation.pendingTotalProducts} 款</strong>
          {aggregate.valuation.pendingTotalItems.length > 0
            ? `（已知小计 ${formatHomeQuantity(aggregate.valuation.pendingTotalItems.reduce((sum, item) => sum + item.quantity, 0))} 件；数量为已知小计，不等于完整合计）`
            : ''}
        </li>
        <li>
          未对应来源行：<strong>{formatHomeQuantity(aggregate.valuation.unmappedSourceRows)} 条</strong>（数量保留、不计入合计
          {data.excludedWarehouseUnmappedRows > 0 ? `；另有 ${data.excludedWarehouseUnmappedRows} 条属已排除仓，不在本页处理` : ''}）
        </li>
        <li>数量未知/多单位商品：<strong>{aggregate.valuation.unknownQuantityProducts} 款</strong>（海外）</li>
        <li>市场待确认商品：<strong>{aggregate.valuation.unknownMarketProducts} 款</strong></li>
        {data.transitAvailable ? (
          <li>
            在途未计入：未关联 {aggregate.valuation.transitExclusions.unbound} · 数量待核 {aggregate.valuation.transitExclusions.quantityPending} ·
            缺单价 {aggregate.valuation.transitExclusions.priceMissing} · 待复核 {aggregate.valuation.transitExclusions.reviewPending}
          </li>
        ) : null}
      </ul>
      {showAmounts && aggregate.valuation.missingCostProducts.length > 0 ? (
        <div className={styles.gapList}>
          <h3>缺价商品（按已知数量）</h3>
          <ul>
            {aggregate.valuation.missingCostProducts.slice(0, 8).map((item) => (
              <li key={item.itemId}>
                <Link href={`/dashboard/inventory?view=product&item=${item.itemId}`}>
                  {item.iceCode ?? '缺货号'} · {item.nameCn ?? '未命名'}
                </Link>
                <span>{formatHomeQuantity(item.quantity)} 件</span>
              </li>
            ))}
          </ul>
          {aggregate.valuation.missingCostProducts.length > 8 ? (
            <p>另有 {aggregate.valuation.missingCostProducts.length - 8} 款未列出，可在商品库按货号查看。</p>
          ) : null}
          <Link className={styles.gapMore} href="/dashboard/catalog">到商品库补充采用进货价</Link>
        </div>
      ) : null}
      {aggregate.valuation.pendingTotalItems.length > 0 ? (
        <div className={styles.gapList} data-testid="home-valuation-pending-total">
          <h3>合计待核对商品（已知小计）</h3>
          <ul>
            {aggregate.valuation.pendingTotalItems.slice(0, 8).map((item) => (
              <li key={item.itemId}>
                <Link href={`/dashboard/inventory?view=product&item=${item.itemId}`}>
                  {item.iceCode ?? '缺货号'} · {item.nameCn ?? '未命名'}
                </Link>
                <span>已知小计 {formatHomeQuantity(item.quantity)} 件</span>
              </li>
            ))}
          </ul>
          <Link className={styles.gapMore} href="/dashboard/inventory?view=product&source=overseas">
            到商品库存查看市场格与待核原因
          </Link>
        </div>
      ) : null}
      <p className={styles.valuationFoot}>
        可售数量属仓库口径，在各仓明细中查看；首页不把「整仓可用」改称跨仓可售。来源失败时保留最近成功数据与时间。
      </p>
    </div>
  );
}
