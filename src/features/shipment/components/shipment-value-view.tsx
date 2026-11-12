'use client';

import { Fragment, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import surface from '@/ui/ice-v4/data-surface.module.css';
import styles from './shipment.module.css';
import {
  SHIPMENT_MARKET_ALL,
  associationSavedNotice,
  formatQuantity,
  marketOptionValue,
  marketText,
  summaryProductQuantityText,
  summaryProductValueText,
  summaryValueText,
} from '../model';
import type {
  ShipmentAssociationSavedPayloadDto,
  ShipmentAssociationSuggestionDto,
  ShipmentLinkedProductDto,
  ShipmentMarketSummaryDto,
  ShipmentSummaryExclusion,
  ShipmentSummaryItemDto,
  ShipmentSummaryProductDto,
  ShipmentValueMarketDetailDto,
  ShipmentValueOverviewDto,
  ShipmentValueProductRowDto,
} from '../types';
import { ShipmentAssociationEditor } from './association-editor';

const EXCLUSION_LABEL: Record<ShipmentSummaryExclusion, string> = {
  unbound: '未关联商品',
  quantity_pending: '数量待核',
  price_missing: '缺单价',
  review_pending: '待复核',
};

const TAB_PRODUCTS = 'products';
const TAB_EXCLUDED = 'excluded';
type ValueTab = typeof TAB_PRODUCTS | typeof TAB_EXCLUDED;

/** 展开状态存 sessionStorage：打开/关闭货票详情后仍在（不写 URL、不整页刷新）。 */
const EXPAND_STORAGE_KEY = 'iceos.shipment.value.expand';
const EXCLUDED_STORAGE_KEY = 'iceos.shipment.value.excluded';

function marketKeyOf(market: string | null, unknownMarket: boolean): string {
  return unknownMarket ? '__unknown__' : marketOptionValue(market);
}

function readStoredExpanded(): string[] {
  try {
    const raw = window.sessionStorage.getItem(EXPAND_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

function readStoredExcluded(): boolean {
  try {
    return window.sessionStorage.getItem(EXCLUDED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeStored(key: string, value: string): void {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    /* 会话存储不可用时只丢展开状态，不影响数据 */
  }
}

function receivedText(item: ShipmentSummaryItemDto): string {
  return item.receivedQuantity === null ? '未提供' : formatQuantity(item.receivedQuantity);
}

function remainingText(item: ShipmentSummaryItemDto): string {
  return item.remainingQuantity === null ? '未提供' : formatQuantity(item.remainingQuantity);
}

function ticketText(item: ShipmentSummaryItemDto): string {
  return item.purchaseOrder ? item.purchaseOrder : item.ticketNo;
}

function linkedProduct(item: ShipmentSummaryItemDto): ShipmentLinkedProductDto | null {
  return item.product;
}

/**
 * 货值汇总（第十七轮：按市场就地展开 + 未计入明细可点 + 未关联现场关联）。
 *
 * - 全部市场：按市场一行；点市场在当前区域展开（不跳转、不整页刷新），
 *   展开区显示该市场在途货值、票数/明细数、商品构成与未计入明细；可同时展开多个市场；
 * - 未计入 N 条：点开列出每条的具体货票、商品与原因（未关联/数量待核/缺单价/待复核），
 *   数量取当前读取数据实时值；未关联明细可当场选择商品保存（只用于本票 / 以后同市场同品名沿用）；
 * - 商品构成与明细金额口径与既有市场汇总完全一致（剩余在途 × 采用进货价，未知不写 0）；
 * - 展开状态存 sessionStorage，打开/关闭货票详情后保留；滚动位置由页面壳恢复。
 */
export function ShipmentValueView({
  query,
  overview,
  details,
  summary,
  suggestions,
  error,
  onOpenTicket,
  initialExcludedOpen = false,
}: {
  query: { market: string };
  overview: ShipmentValueOverviewDto | null;
  details: ShipmentValueMarketDetailDto[] | null;
  summary: ShipmentMarketSummaryDto | null;
  suggestions: Record<string, ShipmentAssociationSuggestionDto[]> | null;
  error: string | null;
  onOpenTicket: (shipmentId: string, itemId?: string) => void;
  /** 经营总览「查看未计入货票」直达：首次打开即展开未计入明细（URL excluded=open）。 */
  initialExcludedOpen?: boolean;
}) {
  const allMarkets = query.market === SHIPMENT_MARKET_ALL;
  return (
    <section className={styles.panel} data-testid="shipment-value-view">
      {error ? (
        <p className={styles.inlineError} role="alert" data-testid="shipment-value-error">货值汇总读取失败：{error}</p>
      ) : allMarkets ? (
        <AllMarkets
          overview={overview}
          details={details}
          suggestions={suggestions}
          onOpenTicket={onOpenTicket}
          initialExcludedOpen={initialExcludedOpen}
        />
      ) : (
        <MarketDetail summary={summary} suggestions={suggestions} onOpenTicket={onOpenTicket} />
      )}
    </section>
  );
}

function AllMarkets({
  overview,
  details,
  suggestions,
  onOpenTicket,
  initialExcludedOpen = false,
}: {
  overview: ShipmentValueOverviewDto | null;
  details: ShipmentValueMarketDetailDto[] | null;
  suggestions: Record<string, ShipmentAssociationSuggestionDto[]> | null;
  onOpenTicket: (shipmentId: string, itemId?: string) => void;
  initialExcludedOpen?: boolean;
}) {
  const router = useRouter();
  const [expanded, setExpanded] = useState<string[]>([]);
  const [excludedOpen, setExcludedOpen] = useState(initialExcludedOpen);
  const [savedNotice, setSavedNotice] = useState('');

  // 首次挂载后从 sessionStorage 恢复（避免 SSR/CSR 首帧不一致）。
  // URL 明确要求展开（经营总览直达）时以 URL 为准，并记住该状态。
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 客户端会话状态只在挂载后读取
    setExpanded(readStoredExpanded());
    if (initialExcludedOpen) {
      writeStored(EXCLUDED_STORAGE_KEY, '1');
      setExcludedOpen(true);
      return;
    }
    setExcludedOpen(readStoredExcluded());
  }, [initialExcludedOpen]);

  if (!overview) {
    return <p className={styles.detailEmpty} data-testid="shipment-value-loading">读取中</p>;
  }
  if (overview.markets.length === 0) {
    return <p className={styles.detailEmpty} data-testid="shipment-value-empty">暂无在途明细</p>;
  }

  const detailByKey = new Map((details ?? []).map((detail) => [
    marketKeyOf(detail.market, detail.unknownMarket),
    detail,
  ]));
  const allExcluded = (details ?? []).flatMap((detail) => detail.excludedItems);

  const toggleMarket = (key: string) => {
    setExpanded((current) => {
      const next = current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key];
      writeStored(EXPAND_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  };
  const toggleExcluded = () => {
    setExcludedOpen((current) => {
      const next = !current;
      writeStored(EXCLUDED_STORAGE_KEY, next ? '1' : '0');
      return next;
    });
  };
  const onSaved = (payload: ShipmentAssociationSavedPayloadDto) => {
    setSavedNotice(associationSavedNotice(payload));
    router.refresh();
  };

  return (
    <div className={styles.valueWrap}>
      <div className={styles.valueKpis} data-testid="shipment-value-kpis">
        <div className={styles.valueKpi}>
          <span>在途货值</span>
          <strong data-testid="shipment-value-total">{summaryValueText(overview.totalValueCny) ?? '暂无可计算货值'}</strong>
        </div>
        <button
          type="button"
          className={styles.valueKpiButton}
          onClick={toggleExcluded}
          aria-expanded={excludedOpen}
          data-testid="shipment-value-excluded-toggle"
        >
          <span>未计入</span>
          <strong data-testid="shipment-value-excluded">{overview.excludedItemCount} 条</strong>
          <small>{excludedOpen ? '点收起明细' : '点开看具体货票、商品与原因'}</small>
        </button>
        <div className={styles.valueKpi}>
          <span>市场</span>
          <strong>{overview.marketCount} 个</strong>
        </div>
      </div>

      {savedNotice ? (
        <p className={styles.valueSavedNotice} role="status" data-testid="shipment-value-saved-notice">{savedNotice}</p>
      ) : null}

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
            {overview.markets.map((row) => {
              const key = marketKeyOf(row.market, row.unknownMarket);
              const detail = detailByKey.get(key) ?? null;
              const isOpen = expanded.includes(key);
              return (
                <MarketGroups
                  key={key}
                  row={row}
                  marketKey={key}
                  detail={detail}
                  open={isOpen}
                  onToggle={() => toggleMarket(key)}
                  suggestions={suggestions}
                  onOpenTicket={onOpenTicket}
                  onSaved={onSaved}
                />
              );
            })}
          </tbody>
        </table>
      </div>

      {excludedOpen ? (
        <section className={styles.valueExcludedSection} data-testid="shipment-value-excluded-all">
          <header className={styles.valueSectionHead}>
            <h3>未计入货值的明细（全部市场 · {overview.excludedItemCount} 条）</h3>
            <p>原因、货票、商品与数量都来自最近一次成功读取；未关联商品的条目可当场选择商品。</p>
          </header>
          {allExcluded.length === 0 ? (
            <p className={styles.detailEmpty} data-testid="shipment-value-excluded-empty">当前没有未计入明细</p>
          ) : (
            <ExcludedTable
              items={allExcluded}
              suggestions={suggestions}
              showMarket
              onOpenTicket={onOpenTicket}
              onSaved={onSaved}
            />
          )}
        </section>
      ) : null}
    </div>
  );
}

function MarketGroups({
  row,
  marketKey,
  detail,
  open,
  onToggle,
  suggestions,
  onOpenTicket,
  onSaved,
}: {
  row: ShipmentValueOverviewDto['markets'][number];
  marketKey: string;
  detail: ShipmentValueMarketDetailDto | null;
  open: boolean;
  onToggle: () => void;
  suggestions: Record<string, ShipmentAssociationSuggestionDto[]> | null;
  onOpenTicket: (shipmentId: string, itemId?: string) => void;
  onSaved: (payload: ShipmentAssociationSavedPayloadDto) => void;
}) {
  return (
    <>
      <tr
        data-testid="shipment-value-market-row"
        data-market={row.market ?? ''}
        data-expanded={open ? 'true' : 'false'}
      >
        <td>
          <button
            type="button"
            className={styles.valueMarketToggle}
            onClick={onToggle}
            aria-expanded={open}
            aria-controls={`shipment-value-market-detail-${marketKey}`}
            data-testid="shipment-value-market-toggle"
          >
            <span className={styles.valueMarketName}>{marketText(row.market)}</span>
            <span className={styles.valueMarketHint}>{open ? '收起该市场' : '展开该市场'}</span>
          </button>
        </td>
        <td className={styles.numCell} data-testid="shipment-value-market-total">
          {summaryValueText(row.totalValueCny) ?? '未计入'}
        </td>
        <td className={styles.numCell} data-testid="shipment-value-market-excluded">{row.excludedItemCount} 条</td>
        <td className={styles.numCell}>{row.ticketCount}</td>
        <td className={styles.numCell}>{row.itemCount}</td>
      </tr>
      {open ? (
        <tr className={styles.valueExpandRow}>
          <td colSpan={5}>
            <div
              id={`shipment-value-market-detail-${marketKey}`}
              className={styles.valueExpand}
              data-testid="shipment-value-market-detail"
              data-market={row.market ?? ''}
            >
              {detail ? (
                <ExpandedMarket
                  detail={detail}
                  suggestions={suggestions}
                  onOpenTicket={onOpenTicket}
                  onSaved={onSaved}
                />
              ) : (
                <p className={styles.detailEmpty}>该市场的展开数据没有读到，请刷新重试</p>
              )}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function ExpandedMarket({
  detail,
  suggestions,
  onOpenTicket,
  onSaved,
}: {
  detail: ShipmentValueMarketDetailDto;
  suggestions: Record<string, ShipmentAssociationSuggestionDto[]> | null;
  onOpenTicket: (shipmentId: string, itemId?: string) => void;
  onSaved: (payload: ShipmentAssociationSavedPayloadDto) => void;
}) {
  return (
    <>
      <div className={styles.valueExpandKpis}>
        <span>在途货值 <strong>{summaryValueText(detail.totalValueCny) ?? '暂无可计算货值'}</strong></span>
        <span>票 <strong>{detail.ticketCount}</strong></span>
        <span>明细 <strong>{detail.itemCount}</strong></span>
        <span>未计入 <strong>{detail.excludedItemCount} 条</strong></span>
      </div>

      <section className={styles.valueExpandSection}>
        <h4>商品构成（{detail.products.length} 款）</h4>
        {detail.products.length === 0 ? (
          <p className={styles.detailEmpty}>这个市场还没有已计入货值的商品</p>
        ) : (
          <div className={styles.itemsTableWrap}>
            <table className={`${styles.itemsTable} ${styles.valueProductTable}`} data-testid="shipment-value-market-products">
              <thead>
                <tr>
                  <th scope="col">商品</th>
                  <th scope="col">采用进货价</th>
                  <th scope="col">剩余在途</th>
                  <th scope="col">货值</th>
                  <th scope="col">明细 / 票</th>
                  <th scope="col">未计入提示</th>
                </tr>
              </thead>
              <tbody>
                {detail.products.map((product) => (
                  <ProductRow key={product.productId} product={product} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className={styles.valueExpandSection}>
        <h4>未计入明细（{detail.excludedItems.length} 条）</h4>
        {detail.excludedItems.length === 0 ? (
          <p className={styles.detailEmpty}>这个市场没有未计入明细</p>
        ) : (
          <ExcludedTable
            items={detail.excludedItems}
            suggestions={suggestions}
            onOpenTicket={onOpenTicket}
            onSaved={onSaved}
          />
        )}
      </section>
    </>
  );
}

function ProductRow({ product }: { product: ShipmentValueProductRowDto }) {
  const pendingParts = [
    product.quantityPendingCount > 0 ? `数量待核 ${product.quantityPendingCount} 条` : null,
    product.reviewPendingCount > 0 ? `待复核 ${product.reviewPendingCount} 条` : null,
    product.unpricedItemCount > 0 ? `缺单价 ${product.unpricedItemCount} 条` : null,
  ].filter(Boolean);
  return (
    <tr data-testid="shipment-value-market-product" data-product-id={product.productId}>
      <td>
        <span className={styles.itemProduct}>{product.iceCode ?? '待补货号'}</span>
        <span className={styles.itemProductSub}>{product.nameCn ?? '—'}</span>
        <span className={styles.itemProductSub}>
          {product.specificationText ? `规格 ${product.specificationText}` : '规格待补'}
          {' · '}
          {product.unitText ? `单位 ${product.unitText}` : '单位 待确认'}
        </span>
      </td>
      <td>
        <span className={product.unitCost.state === 'priced' ? styles.unitCostPriced : styles.unitCostMissing}>
          {product.unitCost.label}
        </span>
      </td>
      <td className={styles.numCell} data-testid="shipment-value-market-product-quantity">
        {formatQuantity(product.remainingQuantity)}
      </td>
      <td className={styles.numCell} data-testid="shipment-value-market-product-value">
        {summaryValueText(product.valueCny) ?? '未计入'}
      </td>
      <td className={styles.numCell}>{product.itemCount} 条 / {product.ticketCount} 票</td>
      <td>
        {pendingParts.length === 0
          ? <span className={styles.valueMuted}>全部计入</span>
          : pendingParts.map((text) => <span key={text} className={styles.pendingChip}>{text}</span>)}
      </td>
    </tr>
  );
}

/**
 * 未计入明细表（全部市场 / 单市场 / 市场展开区共用）：
 * 每条写明原因、货票、商品与数量；未关联商品的条目提供「关联商品」，
 * 当场给同市场同品名建议并选择「只用于本票 / 以后沿用」，保存后刷新货值与数量。
 */
function ExcludedTable({
  items,
  suggestions,
  showMarket = false,
  onOpenTicket,
  onSaved,
}: {
  items: ShipmentSummaryItemDto[];
  suggestions: Record<string, ShipmentAssociationSuggestionDto[]> | null;
  showMarket?: boolean;
  onOpenTicket: (shipmentId: string, itemId?: string) => void;
  onSaved: (payload: ShipmentAssociationSavedPayloadDto) => void;
}) {
  const [editingItemId, setEditingItemId] = useState('');
  const columns = showMarket ? 8 : 7;
  return (
    <div className={styles.itemsTableWrap}>
      <table className={`${styles.itemsTable} ${styles.summaryTable}`} data-testid="shipment-value-excluded">
        <thead>
          <tr>
            <th scope="col">原因</th>
            {showMarket ? <th scope="col">市场</th> : null}
            <th scope="col">票</th>
            <th scope="col">商品</th>
            <th scope="col">发货量</th>
            <th scope="col">累计到货</th>
            <th scope="col">剩余在途</th>
            <th scope="col">操作</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const editing = editingItemId === item.itemId;
            return (
              <Fragment key={item.itemId}>
                <tr
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
                  {showMarket ? <td><span className={styles.itemProduct}>{marketText(item.market ?? null)}</span></td> : null}
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
                  <td className={styles.valueItemActions}>
                    <button
                      type="button"
                      className={`${surface.button} ${surface.buttonSmall}`}
                      onClick={() => onOpenTicket(item.shipmentId, item.itemId)}
                      data-testid="shipment-value-open-ticket"
                    >
                      打开货票
                    </button>
                    {item.exclusion === 'unbound' ? (
                      <button
                        type="button"
                        className={`${surface.button} ${surface.buttonSmall}`}
                        onClick={() => setEditingItemId(editing ? '' : item.itemId)}
                        aria-expanded={editing}
                        data-testid="shipment-value-associate"
                      >
                        {editing ? '收起关联' : '关联商品'}
                      </button>
                    ) : null}
                  </td>
                </tr>
                {editing ? (
                  <tr className={styles.valueEditorRow}>
                    <td colSpan={columns}>
                      <ShipmentAssociationEditor
                        item={{
                          itemId: item.itemId,
                          shipmentId: item.shipmentId,
                          productNameRaw: item.productNameRaw,
                          product: linkedProduct(item),
                          revision: null,
                        }}
                        suggestions={suggestions?.[item.itemId] ?? []}
                        onCancel={() => setEditingItemId('')}
                        onSaved={(payload) => {
                          setEditingItemId('');
                          onSaved(payload);
                        }}
                      />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function MarketDetail({
  summary,
  suggestions,
  onOpenTicket,
}: {
  summary: ShipmentMarketSummaryDto | null;
  suggestions: Record<string, ShipmentAssociationSuggestionDto[]> | null;
  onOpenTicket: (shipmentId: string, itemId?: string) => void;
}) {
  const router = useRouter();
  const [expandedId, setExpandedId] = useState('');
  const [tabState, setTabState] = useState<ValueTab>(TAB_PRODUCTS);
  const [savedNotice, setSavedNotice] = useState('');
  if (!summary) {
    return <p className={styles.detailEmpty} data-testid="shipment-value-loading">读取中</p>;
  }
  const tab: ValueTab = summary.excludedItems.length === 0 && tabState === TAB_EXCLUDED
    ? TAB_PRODUCTS
    : tabState;
  const onSaved = (payload: ShipmentAssociationSavedPayloadDto) => {
    setSavedNotice(associationSavedNotice(payload));
    router.refresh();
  };
  return (
    <div className={styles.valueWrap}>
      <div className={styles.valueKpis} data-testid="shipment-value-kpis">
        <div className={styles.valueKpi}>
          <span>{marketText(summary.market)} · 在途货值</span>
          <strong data-testid="shipment-value-total">{summaryValueText(summary.totalValueCny) ?? '暂无可计算货值'}</strong>
        </div>
        <button
          type="button"
          className={styles.valueKpiButton}
          onClick={() => setTabState(TAB_EXCLUDED)}
          aria-expanded={tab === TAB_EXCLUDED}
          data-testid="shipment-value-excluded-button"
        >
          <span>未计入</span>
          <strong>{summary.excludedItemCount} 条</strong>
          <small>点开看具体货票、商品与原因</small>
        </button>
        <div className={styles.valueKpi}>
          <span>已计入 / 明细</span>
          <strong>{summary.pricedItemCount} / {summary.itemCount} 条</strong>
        </div>
      </div>

      {savedNotice ? (
        <p className={styles.valueSavedNotice} role="status" data-testid="shipment-value-saved-notice">{savedNotice}</p>
      ) : null}

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
        <ExcludedTable
          items={summary.excludedItems}
          suggestions={suggestions}
          onOpenTicket={onOpenTicket}
          onSaved={onSaved}
        />
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
