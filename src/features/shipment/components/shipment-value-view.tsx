'use client';

import { useState } from 'react';
import Link from 'next/link';
import surface from '@/ui/ice-v4/data-surface.module.css';
import styles from './shipment.module.css';
import {
  SHIPMENT_MARKET_ALL,
  formatQuantity,
  summaryProductQuantityText,
  summaryProductValueText,
  summaryValueText,
} from '../model';
import type {
  ShipmentMarketSummaryDto,
  ShipmentSummaryExclusion,
  ShipmentSummaryItemDto,
  ShipmentSummaryProductDto,
  ShipmentValueOverviewDto,
} from '../types';

const EXCLUSION_LABEL: Record<ShipmentSummaryExclusion, string> = {
  unbound: '未关联商品',
  quantity_pending: '数量待核',
  price_missing: '缺单价',
  review_pending: '待复核',
};

const TAB_PRODUCTS = 'products';
const TAB_EXCLUDED = 'excluded';
type ValueTab = typeof TAB_PRODUCTS | typeof TAB_EXCLUDED;

function receivedText(item: ShipmentSummaryItemDto): string {
  return item.receivedQuantity === null ? '未提供' : formatQuantity(item.receivedQuantity);
}

function remainingText(item: ShipmentSummaryItemDto): string {
  return item.remainingQuantity === null ? '未提供' : formatQuantity(item.remainingQuantity);
}

function ticketText(item: ShipmentSummaryItemDto): string {
  return item.purchaseOrder ? item.purchaseOrder : item.ticketNo;
}

/**
 * 货值汇总（第十二轮）：与「货票列表」并列的主视图，共用市场筛选。
 * - 全部市场：按市场一行，显示已能算出的在途货值、未计入明细数；
 * - 具体市场：各商品的剩余在途、采用进货价、货值；点商品看组成采购单/明细并打开原票，
 *   点未计入条数看具体明细与原因；
 * - 各市场金额分别合计，不把不同商品数量混加；未知值显示待核/未计入，不写 0。
 */
export function ShipmentValueView({
  query,
  overview,
  overviewError,
  summary,
  summaryError,
  onOpenTicket,
  hrefForMarket,
}: {
  query: { market: string };
  overview: ShipmentValueOverviewDto | null;
  overviewError: string | null;
  summary: ShipmentMarketSummaryDto | null;
  summaryError: string | null;
  onOpenTicket: (shipmentId: string, itemId?: string) => void;
  hrefForMarket: (market: string) => string;
}) {
  const allMarkets = query.market === SHIPMENT_MARKET_ALL;
  return (
    <section className={styles.panel} data-testid="shipment-value-view">
      {allMarkets ? (
        <AllMarkets overview={overview} error={overviewError} hrefForMarket={hrefForMarket} />
      ) : (
        <MarketDetail summary={summary} error={summaryError} onOpenTicket={onOpenTicket} />
      )}
    </section>
  );
}

function AllMarkets({
  overview,
  error,
  hrefForMarket,
}: {
  overview: ShipmentValueOverviewDto | null;
  error: string | null;
  hrefForMarket: (market: string) => string;
}) {
  if (error) {
    return <p className={styles.inlineError} role="alert" data-testid="shipment-value-error">货值汇总读取失败：{error}</p>;
  }
  if (!overview) {
    return <p className={styles.detailEmpty} data-testid="shipment-value-loading">读取中</p>;
  }
  if (overview.markets.length === 0) {
    return <p className={styles.detailEmpty} data-testid="shipment-value-empty">暂无在途明细</p>;
  }
  return (
    <div className={styles.valueWrap}>
      <div className={styles.valueKpis} data-testid="shipment-value-kpis">
        <div className={styles.valueKpi}>
          <span>在途货值</span>
          <strong data-testid="shipment-value-total">{summaryValueText(overview.totalValueCny) ?? '暂无可计算货值'}</strong>
        </div>
        <div className={styles.valueKpi}>
          <span>未计入</span>
          <strong data-testid="shipment-value-excluded">{overview.excludedItemCount} 条</strong>
        </div>
        <div className={styles.valueKpi}>
          <span>市场</span>
          <strong>{overview.marketCount} 个</strong>
        </div>
      </div>
      <div className={styles.itemsTableWrap}>
        <table className={`${styles.itemsTable} ${styles.valueTable}`} data-testid="shipment-value-markets">
          <thead>
            <tr>
              <th scope="col">市场</th>
              <th scope="col">在途货值</th>
              <th scope="col">未计入</th>
              <th scope="col">票</th>
              <th scope="col">明细</th>
            </tr>
          </thead>
          <tbody>
            {overview.markets.map((row) => (
              <tr
                key={row.unknownMarket ? '__unknown__' : row.market ?? ''}
                data-testid="shipment-value-market-row"
                data-market={row.market ?? ''}
              >
                <td>
                  <Link
                    href={hrefForMarket(row.unknownMarket ? '__unknown__' : row.market ?? '')}
                    className={styles.itemProduct}
                    data-testid="shipment-value-market-link"
                  >
                    {row.market ?? '未提供'}
                  </Link>
                </td>
                <td className={styles.numCell} data-testid="shipment-value-market-total">
                  {summaryValueText(row.totalValueCny) ?? '未计入'}
                </td>
                <td className={styles.numCell} data-testid="shipment-value-market-excluded">{row.excludedItemCount} 条</td>
                <td className={styles.numCell}>{row.ticketCount}</td>
                <td className={styles.numCell}>{row.itemCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MarketDetail({
  summary,
  error,
  onOpenTicket,
}: {
  summary: ShipmentMarketSummaryDto | null;
  error: string | null;
  onOpenTicket: (shipmentId: string, itemId?: string) => void;
}) {
  const [expandedId, setExpandedId] = useState('');
  const [tabState, setTabState] = useState<ValueTab>(TAB_PRODUCTS);
  if (error) {
    return <p className={styles.inlineError} role="alert" data-testid="shipment-value-error">货值汇总读取失败：{error}</p>;
  }
  if (!summary) {
    return <p className={styles.detailEmpty} data-testid="shipment-value-loading">读取中</p>;
  }
  const tab: ValueTab = summary.excludedItems.length === 0 && tabState === TAB_EXCLUDED
    ? TAB_PRODUCTS
    : tabState;
  return (
    <div className={styles.valueWrap}>
      <div className={styles.valueKpis} data-testid="shipment-value-kpis">
        <div className={styles.valueKpi}>
          <span>{summary.market ?? '未提供'} · 在途货值</span>
          <strong data-testid="shipment-value-total">{summaryValueText(summary.totalValueCny) ?? '暂无可计算货值'}</strong>
        </div>
        <button
          type="button"
          className={styles.valueKpiButton}
          onClick={() => setTabState(TAB_EXCLUDED)}
          data-testid="shipment-value-excluded-button"
        >
          <span>未计入</span>
          <strong>{summary.excludedItemCount} 条</strong>
        </button>
        <div className={styles.valueKpi}>
          <span>已计入 / 明细</span>
          <strong>{summary.pricedItemCount} / {summary.itemCount} 条</strong>
        </div>
      </div>

      <div className={styles.summaryTabs} role="tablist" aria-label="货值汇总视图">
        <button
          type="button"
          role="tab"
          aria-selected={tab === TAB_PRODUCTS}
          className={tab === TAB_PRODUCTS ? styles.summaryTabActive : styles.summaryTab}
          onClick={() => setTabState(TAB_PRODUCTS)}
          data-testid="shipment-value-tab-products"
        >
          商品汇总（{summary.products.length}）
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === TAB_EXCLUDED}
          className={tab === TAB_EXCLUDED ? styles.summaryTabActive : styles.summaryTab}
          onClick={() => setTabState(TAB_EXCLUDED)}
          data-testid="shipment-value-tab-excluded"
        >
          未计入明细（{summary.excludedItems.length}）
        </button>
      </div>

      {tab === TAB_PRODUCTS ? (
        summary.products.length === 0 ? (
          <p className={styles.detailEmpty} data-testid="shipment-value-empty">暂无在途明细</p>
        ) : (
          <div className={styles.itemsTableWrap}>
            <table className={`${styles.itemsTable} ${styles.summaryTable} ${styles.summaryProductsTable}`} data-testid="shipment-value-products">
              <thead>
                <tr>
                  <th scope="col">商品</th>
                  <th scope="col">采用进货价</th>
                  <th scope="col">剩余在途</th>
                  <th scope="col">货值</th>
                  <th scope="col">明细 / 票</th>
                  <th scope="col">操作</th>
                </tr>
              </thead>
              <tbody>
                {summary.products.map((product) => (
                  <ProductRows
                    key={product.productId}
                    product={product}
                    expanded={expandedId === product.productId}
                    onToggle={() => setExpandedId((current) => (
                      current === product.productId ? '' : product.productId
                    ))}
                    onOpenTicket={onOpenTicket}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : (
        <div className={styles.itemsTableWrap}>
          <table className={`${styles.itemsTable} ${styles.summaryTable}`} data-testid="shipment-value-excluded">
            <thead>
              <tr>
                <th scope="col">原因</th>
                <th scope="col">票</th>
                <th scope="col">商品</th>
                <th scope="col">发货量</th>
                <th scope="col">累计到货</th>
                <th scope="col">剩余在途</th>
                <th scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
              {summary.excludedItems.map((item) => (
                <tr
                  key={item.itemId}
                  data-testid="shipment-value-excluded-item"
                  data-exclusion={item.exclusion ?? ''}
                  data-shipment-id={item.shipmentId}
                >
                  <td>
                    <span
                      className={item.exclusion === 'unbound' ? styles.summaryReasonError : styles.summaryReasonPending}
                      data-testid="shipment-value-excluded-reason"
                    >
                      {item.exclusion ? EXCLUSION_LABEL[item.exclusion] : '—'}
                    </span>
                  </td>
                  <td>
                    <span className={styles.itemProduct}>{ticketText(item)}</span>
                    {item.purchaseOrder ? null : <span className={styles.itemProductSub}>无采购单号</span>}
                  </td>
                  <td>
                    <span className={styles.itemName}>{item.productNameRaw}</span>
                    <span className={styles.itemProductSub}>
                      {item.product ? `${item.product.iceCode ?? '待补货号'} · ${item.product.nameCn ?? '—'}` : '未关联商品'}
                    </span>
                  </td>
                  <td className={styles.numCell}>{formatQuantity(item.shippedQuantity)}</td>
                  <td className={styles.numCell}>
                    {receivedText(item)}
                    {item.receivedQuantity === null ? <span className={styles.pendingChip}>待核</span> : null}
                  </td>
                  <td className={styles.numCell}>
                    {remainingText(item)}
                    {item.remainingQuantity === null ? <span className={styles.pendingChip}>待核</span> : null}
                  </td>
                  <td>
                    <button
                      type="button"
                      className={`${surface.button} ${surface.buttonSmall}`}
                      onClick={() => onOpenTicket(item.shipmentId, item.itemId)}
                      data-testid="shipment-value-open-ticket"
                    >
                      打开货票
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ProductRows({
  product,
  expanded,
  onToggle,
  onOpenTicket,
}: {
  product: ShipmentSummaryProductDto;
  expanded: boolean;
  onToggle: () => void;
  onOpenTicket: (shipmentId: string, itemId?: string) => void;
}) {
  return (
    <>
      <tr
        className={styles.summaryProductRow}
        data-testid="shipment-value-product"
        data-product-id={product.productId}
        data-ice-code={product.iceCode ?? ''}
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <td>
          <span className={styles.itemProduct} data-testid="shipment-value-product-code">
            {product.iceCode ?? '待补货号'}
          </span>
          <span className={styles.itemProductSub}>{product.nameCn ?? '—'}</span>
          <span className={styles.itemProductSub}>
            {product.specificationText ? `规格 ${product.specificationText}` : '规格待补'}
            {' · '}
            {product.unitText ? `单位 ${product.unitText}` : '单位 待确认'}
          </span>
        </td>
        <td data-testid="shipment-value-product-price">
          <span className={product.unitCost.state === 'priced' ? styles.unitCostPriced : styles.unitCostMissing}>
            {product.unitCost.label}
          </span>
        </td>
        <td className={styles.numCell} data-testid="shipment-value-product-quantity">
          {summaryProductQuantityText(product)}
          {product.quantityPendingCount > 0 ? (
            <span className={styles.pendingChip}>待核 {product.quantityPendingCount} 条</span>
          ) : null}
          {product.reviewPendingCount > 0 ? (
            <span className={styles.pendingChip}>待复核 {product.reviewPendingCount} 条</span>
          ) : null}
        </td>
        <td className={styles.numCell} data-testid="shipment-value-product-value">
          {summaryProductValueText(product)}
        </td>
        <td className={styles.numCell}>{product.itemCount} 条 / {product.ticketCount} 票</td>
        <td>
          <button
            type="button"
            className={`${surface.button} ${surface.buttonSmall}`}
            onClick={(event) => { event.stopPropagation(); onToggle(); }}
            aria-expanded={expanded}
            data-testid="shipment-value-product-toggle"
          >
            {expanded ? '收起' : '查看构成'}
          </button>
        </td>
      </tr>
      {expanded ? (
        <tr className={styles.summaryDetailRow}>
          <td colSpan={6}>
            <table className={styles.summaryItemsTable} data-testid="shipment-value-product-items">
              <thead>
                <tr>
                  <th scope="col">票 / 采购单</th>
                  <th scope="col">来源商品</th>
                  <th scope="col">发货量</th>
                  <th scope="col">累计到货</th>
                  <th scope="col">剩余在途</th>
                  <th scope="col">单价</th>
                  <th scope="col">货值</th>
                  <th scope="col">操作</th>
                </tr>
              </thead>
              <tbody>
                {product.items.map((item) => (
                  <tr
                    key={item.itemId}
                    data-testid="shipment-value-product-item"
                    data-remaining-state={item.remainingState}
                    data-shipment-id={item.shipmentId}
                  >
                    <td>
                      <span className={styles.itemProduct}>{ticketText(item)}</span>
                      {item.purchaseOrder ? null : <span className={styles.itemProductSub}>无采购单号</span>}
                    </td>
                    <td><span className={styles.itemName}>{item.productNameRaw}</span></td>
                    <td className={styles.numCell}>{formatQuantity(item.shippedQuantity)}</td>
                    <td className={styles.numCell}>
                      {receivedText(item)}
                      {item.receivedQuantity === null ? <span className={styles.pendingChip}>待核</span> : null}
                    </td>
                    <td className={styles.numCell}>
                      {remainingText(item)}
                      {item.remainingQuantity === null ? <span className={styles.pendingChip}>待核</span> : null}
                    </td>
                    <td className={styles.numCell}>{item.product ? item.product.unitCost.label : '—'}</td>
                    <td className={styles.numCell}>{summaryValueText(item.valueCny) ?? '未计入'}</td>
                    <td>
                      <button
                        type="button"
                        className={`${surface.button} ${surface.buttonSmall}`}
                        onClick={() => onOpenTicket(item.shipmentId, item.itemId)}
                        data-testid="shipment-value-open-ticket"
                      >
                        打开货票
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      ) : null}
    </>
  );
}
