import Link from 'next/link';
import {
  ArrowRight,
  Boxes,
  Clock3,
  Package,
  Search,
  Ship,
  Warehouse,
} from 'lucide-react';
import { EmptyState, PageHeading, StatusDot } from '@/ui/ice-v4/data-surface';
import surface from '@/ui/ice-v4/data-surface.module.css';
import { HomeMissingCost } from './home-missing-cost';
import { HomePendingReview } from './home-pending-review';
import { formatTimestamp } from '@/features/inventory/model';
import { paginateHomeProducts, searchHomeProducts } from '../aggregate';
import {
  buildHomeHref,
  formatCnyAmount,
  formatHomeQuantity,
  HOME_PAGE_SIZE,
  type HomeQueryState,
} from '../model';
import type { HomePageData } from '../server/reads';
import styles from './business-overview.module.css';

function timeText(iso: string | null | undefined, fallback: string): string {
  const text = formatTimestamp(iso);
  return text || fallback;
}

function quantityText(value: number | null, fallback: string): string {
  return value === null ? fallback : formatHomeQuantity(value);
}

/**
 * /dashboard 经营总览：三阶段货物与已知估算货值、海外市场分布、真实待处理事项、商品库存概览。
 *
 * 服务端组件：数据由 `getBusinessOverviewData()` 在完整范围内先汇总再切分页；
 * 页面不重新累加来源行，不把未知写成 0，不提供跨阶段总资产。
 *
 * 本轮（ux-round-20261112）：
 * - 去掉页头「待处理」入口，只保留「查看商品库存」；
 * - 删除「待处理 N 类」统计卡与各卡片重复小字，保留三阶段时间条、失败/未读取原因、
 *   海外已知小计标记与成本读取失败状态；
 * - 「估值口径与未计入说明」移到 /dashboard/valuation，首页底部只留文字链接；
 * - 「需要处理」每类事项给出明确动作按钮，物流当场复核、缺价商品就地展开清单。
 */
export function BusinessOverviewPage({
  data,
  query,
}: {
  data: HomePageData;
  query: HomeQueryState;
}) {
  const { aggregate } = data;
  // 金额权限与「进货价读取失败」分开：成本失败不是权限不足，也不是缺价 0。
  const costFailed = data.costReadFailed;
  const showAmounts = data.amountsVisible && !costFailed;
  const amountStateText = costFailed ? '进货价读取失败' : '无金额权限';
  const filtered = searchHomeProducts(aggregate.products, query.q);
  const page = paginateHomeProducts(filtered, query.page, HOME_PAGE_SIZE);
  const domestic = aggregate.stages.domestic;
  const transit = aggregate.stages.transit;
  const overseas = aggregate.stages.overseas;
  const marketsWithStock = aggregate.markets.filter((row) => (row.onHand ?? 0) > 0 || row.transitTickets > 0);
  const domesticTime = data.domesticFileDate
    ? `冻结文件日期 ${data.domesticFileDate}`
    : '国内冻结快照未读取';
  const overseasTime = `最近成功 ${timeText(aggregate.times.overseas, '尚无记录')}`;
  const transitTime = `最近成功 ${timeText(aggregate.times.transit, '尚无记录')}`;

  return (
    <div className={styles.page} data-testid="business-overview-page">
      <PageHeading
        title="经营总览"
        meta="三阶段来源时点不同，不合并为总资产。"
        actions={(
          <Link className={`${styles.headAction} ${styles.headActionTall}`} href="/dashboard/inventory">
            查看商品库存 <ArrowRight size={15} aria-hidden />
          </Link>
        )}
      />

      <div className={styles.timeBar} data-testid="home-data-times">
        <span><Clock3 size={14} aria-hidden /> 国内：{domesticTime}</span>
        <span>海外：{overseasTime}</span>
        <span>在途：{transitTime}</span>
        <span className={styles.timeBarNote}>三阶段不直接相加</span>
      </div>

      <section className={styles.statStrip} aria-label="经营概况指标">
        <div className={styles.stat}>
          <span className={styles.statLabel}><Boxes size={15} aria-hidden /> 商品覆盖</span>
          <strong>{formatHomeQuantity(aggregate.productCount)}<small>款</small></strong>
        </div>
        <div className={styles.stat}>
          <span className={styles.statLabel}><Warehouse size={15} aria-hidden /> 海外市场</span>
          <strong>{formatHomeQuantity(marketsWithStock.length)}<small>个</small></strong>
        </div>
        <div className={styles.stat}>
          <span className={styles.statLabel}><Ship size={15} aria-hidden /> 运输在途</span>
          <strong>
            {data.transitAvailable ? formatHomeQuantity(data.transitTicketCount) : '未读取'}
            {data.transitAvailable ? <small>票</small> : null}
          </strong>
        </div>
      </section>

      <section className={styles.stages} aria-label="国内、在途与海外库存">
        <article className={styles.stage} data-testid="home-stage-domestic">
          <header className={styles.stageHead}>
            <span className={styles.stageIcon}><Warehouse size={16} aria-hidden /></span>
            <div><h2>国内库存</h2><p>聚水潭冻结表格快照</p></div>
          </header>
          <div className={styles.stageValue}>
            <strong data-testid="home-stage-domestic-quantity">{data.domesticAvailable ? quantityText(domestic.quantity, '未读取') : '未读取'}</strong>
            <span>{data.domesticAvailable && domestic.quantity !== null ? '实物（各商品单位分别合计）' : ''}</span>
          </div>
          <dl className={styles.stageFacts}>
            <div><dt>已知估算货值</dt><dd data-testid="home-stage-domestic-value">{!data.domesticAvailable ? '未读取' : showAmounts ? formatCnyAmount(domestic.valueCny) : amountStateText}</dd></div>
            <div><dt>已计价 / 缺价</dt><dd>{data.domesticAvailable && !costFailed ? `${formatHomeQuantity(domestic.pricedQuantity)} / ${formatHomeQuantity(domestic.unpricedQuantity)}` : '—'}</dd></div>
            <div><dt>未计入</dt><dd>{data.domesticAvailable ? `${domestic.excludedItems} 条（数量缺失/未关联）` : '—'}</dd></div>
          </dl>
          <div className={styles.stageFoot}>
            <span><Clock3 size={13} aria-hidden /> {domesticTime}</span>
            <Link href="/dashboard/inventory?source=domestic">查看国内明细 <ArrowRight size={14} aria-hidden /></Link>
          </div>
          {!data.domesticAvailable ? (
            <p className={styles.stageWarn} role="status">{data.domesticReason}</p>
          ) : null}
        </article>

        <article className={styles.stage} data-testid="home-stage-transit">
          <header className={styles.stageHead}>
            <span className={styles.stageIcon}><Ship size={16} aria-hidden /></span>
            <div><h2>物流在途</h2><p>飞书物流情况表 · 剩余在途</p></div>
          </header>
          <div className={styles.stageValue}>
            <strong data-testid="home-stage-transit-quantity">{data.transitAvailable ? quantityText(transit.quantity, '无已知剩余') : '未读取'}</strong>
            <span>{data.transitAvailable ? '剩余（数量待核不计）' : ''}</span>
          </div>
          <dl className={styles.stageFacts}>
            <div><dt>已知估算货值</dt><dd data-testid="home-stage-transit-value">{!data.transitAvailable ? '未读取' : showAmounts ? formatCnyAmount(transit.valueCny) : amountStateText}</dd></div>
            <div><dt>已计价 / 缺价</dt><dd>{data.transitAvailable && !costFailed ? `${formatHomeQuantity(transit.pricedQuantity)} / ${formatHomeQuantity(transit.unpricedQuantity)}` : '—'}</dd></div>
            <div><dt>未计入</dt><dd>{data.transitAvailable ? `${transit.excludedItems} 条（未关联/待核/缺单价/待复核）` : '—'}</dd></div>
          </dl>
          <div className={styles.stageFoot}>
            <span><Clock3 size={13} aria-hidden /> {transitTime}</span>
            <Link href="/dashboard/in-transit?view=value">查看在途汇总 <ArrowRight size={14} aria-hidden /></Link>
          </div>
          {data.transitError ? <p className={styles.stageWarn} role="status">{data.transitError}</p> : null}
        </article>

        <article className={styles.stage} data-testid="home-stage-overseas">
          <header className={styles.stageHead}>
            <span className={styles.stageIcon}><Boxes size={16} aria-hidden /></span>
            <div><h2>海外库存</h2><p>BigSeller 各仓最新有效批次</p></div>
          </header>
          <div className={styles.stageValue}>
            <strong data-testid="home-stage-overseas-quantity">{quantityText(overseas.quantity, '未计入')}</strong>
            <span>实物（各仓合计，不含可售）</span>
          </div>
          <dl className={styles.stageFacts}>
            <div>
              <dt>已知估算货值</dt>
              <dd data-testid="home-stage-overseas-value">
                {showAmounts ? formatCnyAmount(overseas.valueCny) : amountStateText}
                {showAmounts && overseas.pendingTotalProducts > 0 ? (
                  <small className={styles.cellSub} data-testid="home-stage-overseas-value-note">
                    含 {overseas.pendingTotalProducts} 款已知小计、合计待核对
                  </small>
                ) : null}
              </dd>
            </div>
            <div><dt>已计价 / 缺价</dt><dd>{!costFailed ? `${formatHomeQuantity(overseas.pricedQuantity)} / ${formatHomeQuantity(overseas.unpricedQuantity)}` : '—'}</dd></div>
            <div>
              <dt>数量待核</dt>
              <dd data-testid="home-stage-overseas-pending">
                {overseas.unknownItems} 款数量未知
                {overseas.pendingTotalProducts > 0 ? ` · ${overseas.pendingTotalProducts} 款合计待核对` : ''}
              </dd>
            </div>
          </dl>
          <div className={styles.stageFoot}>
            <span><Clock3 size={13} aria-hidden /> {overseasTime}</span>
            <Link href="/dashboard/inventory?view=product&source=overseas">查看商品汇总 <ArrowRight size={14} aria-hidden /></Link>
          </div>
        </article>
      </section>

      <div className={styles.twoColumns}>
        <section className={styles.panel} aria-label="海外市场分布">
          <header className={styles.panelHead}>
            <h2>海外各市场分布</h2>
          </header>
          {aggregate.markets.length === 0 ? (
            <EmptyState title="暂无海外市场数据" hint="海外库存或在途读取后才显示市场分布。" />
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table} data-testid="home-market-rows">
                <thead>
                  <tr>
                    <th scope="col">市场</th>
                    <th scope="col" className={styles.num}>海外实物</th>
                    <th scope="col" className={styles.num}>库存估算货值</th>
                    <th scope="col" className={styles.num}>在途剩余</th>
                    <th scope="col" className={styles.num}>在途估算货值</th>
                    <th scope="col">明细</th>
                  </tr>
                </thead>
                <tbody>
                  {aggregate.markets.map((row) => {
                    const code = row.market ?? '__unknown__';
                    const inventoryHref = row.market
                      ? `/dashboard/inventory?view=product&market=${encodeURIComponent(row.market)}`
                      : '/dashboard/inventory?view=product&market=__unknown__';
                    const transitHref = row.label && row.label !== '市场待确认'
                      ? `/dashboard/in-transit?market=${encodeURIComponent(row.label)}`
                      : '/dashboard/in-transit?market=__unknown__';
                    return (
                      <tr key={code} data-testid="home-market-row" data-market={row.market ?? ''}>
                        <td>
                          <span className={styles.marketName}>{row.label}</span>
                          {row.market ? <small className={styles.marketCode}>{row.market}</small> : null}
                        </td>
                        <td className={styles.num}>{quantityText(row.onHand, '—')}{row.unknownProducts > 0 ? <small className={styles.cellSub}>{row.unknownProducts} 款待核</small> : null}</td>
                        <td className={styles.num}>{showAmounts ? formatCnyAmount(row.onHandValueCny) : '—'}</td>
                        <td className={styles.num}>{quantityText(row.transitRemaining, '—')}</td>
                        <td className={styles.num}>{showAmounts ? formatCnyAmount(row.transitValueCny) : '—'}</td>
                        <td>
                          <span className={styles.rowLinks}>
                            <Link href={inventoryHref}>库存</Link>
                            <Link href={transitHref}>在途</Link>
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className={styles.tableFoot}>市场待确认行来自没有市场证据的仓库或来源国家为空，不按名称猜测归属。</p>
        </section>

        <section className={styles.panel} aria-label="需要处理" id="home-pending" data-testid="home-pending-section">
          <header className={styles.panelHead}>
            <h2>需要处理</h2>
          </header>
          {data.pending.length === 0 ? (
            <EmptyState title="暂无待处理事项" hint="来源正常、没有待对应或待复核。" />
          ) : (
            <ul className={styles.pendingList} data-testid="home-pending-list">
              {data.pending.map((item) => (
                <li
                  className={styles.pendingItem}
                  key={item.key}
                  data-testid="home-pending-item"
                  data-key={item.key}
                  data-category={item.category}
                  data-action={item.action}
                >
                  <span className={styles.pendingDot} aria-hidden />
                  <div className={styles.pendingInfo}>
                    <span className={styles.pendingTags}>
                      <span className={styles.pendingCategory}>{item.category}</span>
                      {item.countLabel ? <span className={styles.pendingCount}>{item.countLabel}</span> : null}
                    </span>
                    <h3>{item.title}</h3>
                    <p>{item.detail}</p>
                  </div>
                  {item.action === 'review' ? (
                    <HomePendingReview
                      reviews={data.groupingReviews}
                      error={data.groupingReviewsError}
                      label={item.actionLabel}
                    />
                  ) : item.action === 'missing-cost' ? (
                    <HomeMissingCost
                      label={item.actionLabel}
                      items={aggregate.valuation.missingCostProducts}
                    />
                  ) : (
                    <Link
                      className={`${surface.button} ${surface.buttonSmall}`}
                      href={item.href}
                      data-testid={`home-pending-action-${item.key}`}
                    >
                      {item.actionLabel}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className={styles.panelFoot}>
            <StatusDot tone={data.inventoryStateLabel === '自动同步运行中' ? 'green' : 'amber'}>
              {data.inventoryStateLabel}
            </StatusDot>
            <span>{data.inventoryStateDetail}</span>
          </p>
        </section>
      </div>

      <section className={styles.panel} aria-label="商品库存概览">
        <header className={styles.panelHead}>
          <h2>商品库存概览</h2>
          <Link className={styles.panelLink} href="/dashboard/inventory?view=product">查看全部 <ArrowRight size={14} aria-hidden /></Link>
        </header>
        <form className={styles.searchRow} action="/dashboard" method="get" role="search">
          <label className={styles.search}>
            <Search size={15} aria-hidden />
            <input
              name="q"
              type="search"
              defaultValue={query.q}
              placeholder="搜索货号 / 商品名称 / 69 编码"
              aria-label="搜索商品库存"
              data-testid="home-product-search"
              maxLength={120}
              autoComplete="off"
            />
          </label>
          <button className={styles.searchButton} type="submit">搜索</button>
          {query.q ? <Link className={styles.clearLink} href="/dashboard">清空</Link> : null}
          <span className={styles.searchCount}>
            {query.q ? `匹配 ${filtered.length} 款` : `共 ${aggregate.productCount} 款`}
          </span>
        </form>
        {page.rows.length === 0 ? (
          <EmptyState
            title={query.q ? '没有匹配的商品' : '当前没有商品库存记录'}
            hint={query.q ? '换货号、名称或 69 编码再试。' : '商品汇总读取为空；先确认库存来源已成功发布。'}
            action={query.q ? <Link className={styles.gapMore} href="/dashboard">清空搜索</Link> : undefined}
          />
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table} data-testid="home-product-table">
              <thead>
                <tr>
                  <th scope="col">商品 / 货号</th>
                  <th scope="col" className={styles.num}>国内实物</th>
                  <th scope="col" className={styles.num}>海外实物</th>
                  <th scope="col" className={styles.num}>已知剩余在途</th>
                  {showAmounts ? <th scope="col" className={styles.num}>库存估算货值</th> : null}
                  <th scope="col"><span className={styles.srOnly}>详情</span></th>
                </tr>
              </thead>
              <tbody>
                {page.rows.map((row) => (
                  <tr key={row.itemId} data-testid="home-product-row" data-item-id={row.itemId}>
                    <td>
                      <Link className={styles.productLink} href={`/dashboard/inventory?view=product&item=${row.itemId}`}>
                        <span className={styles.productIcon}><Package size={16} aria-hidden /></span>
                        <span>
                          <strong>{row.nameCn ?? '未命名商品'}</strong>
                          <small>{row.iceCode ?? '缺货号'}{row.gtin ? ` · 69 ${row.gtin}` : ''}{row.unit ? ` · ${row.unit}` : ''}</small>
                        </span>
                      </Link>
                    </td>
                    <td className={styles.num}>{quantityText(row.domesticOnHand, '—')}</td>
                    <td className={styles.num}>
                      {quantityText(row.overseasOnHand, '—')}
                      {row.pendingTotal ? <small className={styles.cellSub} data-testid="home-product-pending">合计待核对</small> : null}
                    </td>
                    <td className={styles.num}>
                      {quantityText(row.transitRemaining, '—')}
                      {row.transitPending ? <small className={styles.cellSub}>含数量待核</small> : null}
                    </td>
                    {showAmounts ? (
                      <td className={styles.num}>
                        {formatCnyAmount(row.inventoryValueCny)}
                        {row.pendingTotal ? <small className={styles.cellSub}>已知小计</small> : null}
                        {!row.pendingTotal && row.valueIncomplete ? <small className={styles.cellSub}>部分数量未计入</small> : null}
                      </td>
                    ) : null}
                    <td>
                      <span className={styles.rowActions}>
                        <Link className={styles.rowAction} href={`/dashboard/inventory?view=product&item=${row.itemId}`}>详情 <ArrowRight size={13} aria-hidden /></Link>
                        {row.transitRemaining !== null ? (
                          <Link className={styles.rowAction} href={`/dashboard/in-transit?product=${row.itemId}`}>货票</Link>
                        ) : null}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {page.pageCount > 1 ? (
          <nav className={styles.pagination} aria-label="商品库存分页" data-testid="home-product-pagination">
            {page.page > 1
              ? <a data-testid="home-page-prev" href={buildHomeHref({ q: query.q, page: page.page - 1 })}>上一页</a>
              : <span className={styles.pageDisabled}>上一页</span>}
            <span>第 {page.page} / {page.pageCount} 页 · 共 {page.total} 款</span>
            {page.page < page.pageCount
              ? <a data-testid="home-page-next" href={buildHomeHref({ q: query.q, page: page.page + 1 })}>下一页</a>
              : <span className={styles.pageDisabled}>下一页</span>}
          </nav>
        ) : null}
        <p className={styles.tableFoot}>
          海外为各仓实物合计，不含跨仓可售；「—」表示没有有效记录或未计入，不是 0。
          {costFailed ? ' 进货价读取失败，本次不显示金额列。' : ''}
        </p>
      </section>

      <Link className={styles.valuationLink} href="/dashboard/valuation">
        估值口径与未计入说明
      </Link>
    </div>
  );
}
