import { useState } from 'react';
import { ArrowRight, Boxes, Clock3, Info, Layers, Package, Search, Ship, Warehouse } from 'lucide-react';
import { MARKETS } from './fixtures';
import { calculateValuation, confirmedSnapshots, filterProducts, getProductMetrics, isSnapshotAttributable, latestSnapshots, remainingInTransit, shipmentValuation } from './model';
import type { DemoData, DemoFilters, DemoView, Market } from './types';
import { money, number } from './widgets';
import styles from './reference-home.module.css';

export interface ReferenceHomeProps {
  data: DemoData;
  showAmounts: boolean;
  onBrowse: (market?: Market | 'all', exception?: DemoFilters['exception']) => void;
  onNavigate: (view: DemoView) => void;
  onOpenProduct: (id: string) => void;
}

/** The reference home() DOM/class structure, with React events and existing demo DTOs. */
export function ReferenceHome({ data, showAmounts, onBrowse, onNavigate, onOpenProduct }: ReferenceHomeProps) {
  const [tab, setTab] = useState<'products' | 'flows' | 'arrivals'>('products');
  const raw = latestSnapshots(data);
  const domestic = calculateValuation(raw.filter((row) => row.market === 'CN'), data.products, data.mappings);
  const overseas = calculateValuation(raw.filter((row) => row.market !== 'CN'), data.products, data.mappings);
  const transit = shipmentValuation(data);
  const active = data.shipments.filter((row) => row.receivedQuantity < row.quantity);
  const soon = active.filter((row) => row.eta >= '2026-10-13' && row.eta <= '2026-10-19');
  const low = filterProducts(data, { query: '', market: 'all', exception: 'low' });
  const unconfirmed = raw.filter((row) => !isSnapshotAttributable(row, data.mappings));
  const stale = raw.filter((row) => row.freshness === 'stale');
  const stages = [
    { key: 'domestic', label: '国内备货', value: domestic, icon: Warehouse, source: '聚水潭最近快照 · 按来源原值', available: raw.some((row) => row.market === 'CN'), open: () => onBrowse('CN') },
    { key: 'transit', label: '运输在途', value: transit, icon: Ship, source: '飞书物流情况表 · 按剩余在途', available: data.shipments.length > 0, open: () => onNavigate('logistics') },
    { key: 'overseas', label: '海外在库', value: overseas, icon: Boxes, source: 'BigSeller最近快照 · 按来源原值', available: raw.some((row) => row.market !== 'CN'), open: () => onBrowse() },
  ];
  const markets = MARKETS.filter((market) => market.id !== 'CN' && raw.some((row) => row.market === market.id)).map((market) => ({ ...market, value: calculateValuation(raw.filter((row) => row.market === market.id), data.products, data.mappings) })).sort((a, b) => b.value.knownValue - a.value.knownValue);
  const issues = [
    ...(low.length ? [{ title: `${low.length} 款商品可售量较低`, sub: '查看原始SKU、库存与对应在途', icon: Package, open: () => onBrowse('all', 'low') }] : []),
    ...(unconfirmed.length ? [{ title: `${unconfirmed.length} 条商品对应关系待核对`, sub: '未确认原始数量保留，不自动归集', icon: Search, open: () => onNavigate('products') }] : []),
    ...(stale.length ? [{ title: `${stale.length} 条来源快照较旧`, sub: '保留最近成功数据，等待来源恢复', icon: Clock3, open: () => onNavigate('sync') }] : []),
    ...(showAmounts && data.products.some((row) => row.unitCost === null) ? [{ title: '商品成本待补充', sub: '缺失成本不等于零成本', icon: Layers, open: () => onBrowse('all', 'cost') }] : []),
    ...(data.shipments.some((row) => row.binding === 'pending') ? [{ title: '物流轨迹等待关联', sub: '按物流商、账号与运单核对', icon: Ship, open: () => onNavigate('logistics') }] : []),
  ];
  const observations = [...(tab === 'arrivals' ? soon : data.shipments)].sort((a, b) => a.eta.localeCompare(b.eta));

  return <div className={styles.referenceHome} data-reference-home="ice_inventory_demo_v4">
    <div className="pagehead"><div><div className="overline">ICE / BUSINESS OVERVIEW</div><h1>经营总览</h1><p className="subtitle">看清资金分布，也看清货物和今天要处理的事。</p></div><div className="actions"><button type="button" className="btn" onClick={() => onBrowse()}>查看商品库存 <ArrowRight size={16} /></button></div></div>
    <div className="ops-strip" aria-label="经营指标">
      {[
        { title: '商品覆盖', value: data.products.length, unit: '款', sub: '查看市场整体商品', icon: Boxes, open: () => onBrowse() },
        { title: '低可售量', value: low.length, unit: '款', sub: '按市场 / 来源SKU', icon: Package, open: () => onBrowse('all', 'low') },
        { title: '运输在途', value: active.length, unit: '票', sub: '按飞书货票状态', icon: Ship, open: () => onNavigate('logistics') },
        { title: '未来7天到货', value: soon.length, unit: '票', sub: '以源表预计到仓日为准', icon: Clock3, open: () => setTab('arrivals') },
      ].map((item) => { const Icon = item.icon; return <button type="button" className="opstat" key={item.title} onClick={item.open}><span className="opstat-label"><Icon size={16} />{item.title}</span><strong>{item.value}<small>{item.unit}</small></strong><span className="meta">{item.sub}</span></button>; })}
    </div>
    <section className="hero v4-hero" aria-label="货值重点观察"><div><div className="hero-kicker">当前可见市场 · 海外库存已知货值</div><div className="total">{showAmounts ? (markets.length ? money(overseas.knownValue) : '暂无有效记录') : '库存与物流概况'}</div><div className="hero-meta">各来源最近有效数据 · 已确认商品的参考成本</div></div><div className="hero-side"><button type="button" className="btn dark" onClick={() => onNavigate('snapshots')}>查看组成与数据口径 <ArrowRight size={16} /></button><span className="hero-meta">{unconfirmed.length} 条对应关系待核对{showAmounts ? ` · ${overseas.missingCostQuantity} 个销售单元成本待补` : ''}</span></div></section>
    <div className="stages v4-stages" aria-label="库存流转三阶段">{stages.map((stage, index) => { const Icon = stage.icon; return <button type="button" className="stage" key={stage.key} disabled={!stage.available} onClick={stage.open}><div className="stage-top"><span className="stage-icon"><Icon size={17} /></span>{stage.label}</div><div className="stage-val">{!stage.available ? '暂无有效记录' : showAmounts ? money(stage.value.knownValue) : number(stage.value.totalQuantity)}</div><div className="stage-meta">{stage.source}</div>{index < 2 && <span className="stage-arrow">›</span>}</button>; })}</div>
    <div className="source-ribbon"><span><Clock3 size={15} /> 库存：BigSeller / 聚水潭快照 ｜ 在途：飞书物流情况表</span><button type="button" className="btn ghost" onClick={() => onNavigate('snapshots')}>查看快照</button></div>
    <div className="notice amber"><span>来源时间未完全对齐，三阶段不直接相加。横幅仅展示海外库存已估值小计，不冒充全链路资产总额。</span></div>
    <div className="grid-two">
      <section className="panel"><div className="panelhead"><h2>{showAmounts ? '市场金额占比' : '各市场库存概况'}</h2><span className="minor">海外实物 · 不含在途</span></div><div className="panelbody">
        {markets.map((market) => { const share = overseas.knownValue > 0 ? market.value.knownValue / overseas.knownValue * 100 : 0; return <button type="button" className="allocation" key={market.id} onClick={() => onBrowse(market.id)}><span className="marketlabel"><span className="marketcode">{market.id}</span><span>{market.name}</span></span><span className="bartrack"><span className="barfill" style={{ display: 'block', width: `${showAmounts ? share : 100}%` }} /></span><span className="amount">{showAmounts ? money(market.value.knownValue) : `${number(market.value.totalQuantity)} 单元`}</span>{showAmounts && <span className="pct">{share.toFixed(1)}%</span>}</button>; })}
        <p className="chartfoot"><Info size={14} /><span>{showAmounts ? '分母为当前范围已知海外库存货值，缺失成本和未确认映射不算零。' : '数量按来源记录显示，不合并不同商品单位。'}</span></p>
      </div></section>
      <section className="panel"><div className="panelhead"><h2>需要处理</h2><span className="badge amber">{issues.length} 项</span></div><div className="panelbody issue-body">{issues.map((issue) => { const Icon = issue.icon; return <div className="issue" key={issue.title}><span className="issue-dot"><Icon size={17} /></span><div className="issue-info"><h3>{issue.title}</h3><p>{issue.sub}</p></div><button type="button" className="btn ghost" aria-label={issue.title} onClick={issue.open}><ArrowRight size={16} /></button></div>; })}{issues.length === 0 && <div className="empty">当前没有需要处理的事项。</div>}</div></section>
    </div>
    <section className="panel home-main-panel"><div className="panelhead"><div className="inline-tabs" aria-label="首页库存与流转"><button type="button" className={`tab ${tab === 'products' ? 'active' : ''}`} onClick={() => setTab('products')}>商品库存概览</button><button type="button" className={`tab ${tab === 'flows' ? 'active' : ''}`} onClick={() => setTab('flows')}>近期货物流转</button><button type="button" className={`tab ${tab === 'arrivals' ? 'active' : ''}`} onClick={() => setTab('arrivals')}>预计到货</button></div><button type="button" className="btn ghost" onClick={() => tab === 'products' ? onBrowse() : onNavigate('logistics')}>查看全部 <ArrowRight size={16} /></button></div>
      {tab === 'products' ? <div className="tablewrap"><table className="inventory-table"><thead><tr><th>商品 / 货号 / 69编码</th><th className="num">国内备货</th><th className="num">海外在库 / 可售</th><th className="num">运输在途</th>{showAmounts && <th className="num">库存已知货值</th>}<th>来源核对</th></tr></thead><tbody>{data.products.map((product) => { const q = getProductMetrics(data, product.id); return <tr key={product.id}><td><button type="button" className="productlink" onClick={() => onOpenProduct(product.id)}><div className="productcell"><span className="stage-icon"><Package size={22} /></span><div><strong>{product.name}</strong><div className="meta"><span className="mono positive">{product.code}</span> · {product.specification}</div><div className="mono tiny muted">69 · {product.barcode}</div></div></div></button></td><td className="num">{number(q.domestic)} {product.unit}</td><td className="num"><b>{number(q.overseas)} {product.unit}</b><div className="meta">可售 {number(q.overseasAvailable)} {product.unit}</div></td><td className="num positive">{number(q.transit)} {product.unit}</td>{showAmounts && <td className="num">{product.unitCost === null ? '成本待补' : confirmedSnapshots(data, product.id).length === 0 ? '—' : q.valuation.unknownRows > 0 ? '部分数量待核对' : money(q.valuation.knownValue)}</td>}<td><button type="button" className="btn small" onClick={() => onOpenProduct(product.id)}>查看来源 <ArrowRight size={14} /></button></td></tr>; })}</tbody></table>{data.products.length === 0 && <div className="empty">未找到当前范围商品。</div>}</div>
      : <div className="tablewrap"><table className="dashboard-table"><thead><tr><th>预计到仓</th><th>货票 / 市场</th><th>商品 / 剩余在途</th><th>{tab === 'arrivals' ? '飞书人工备注' : '当前业务进展'}</th><th /></tr></thead><tbody>{observations.map((shipment) => { const product = data.products.find((entry) => entry.id === shipment.productId); return <tr key={shipment.id}><td>{shipment.eta}</td><td>{shipment.number}<div className="meta">{MARKETS.find((entry) => entry.id === shipment.market)?.name}</div></td><td>{product?.code} · {remainingInTransit(shipment.quantity, shipment.receivedQuantity)} {product?.unit}</td><td className="longtext"><span className="badge blue">{shipment.feishuStatus}</span><div className="meta">{shipment.note}</div></td><td><button type="button" className="btn small" onClick={() => onNavigate('logistics')}>查看物流</button></td></tr>; })}</tbody></table>{observations.length === 0 && <div className="empty">当前没有对应货票。</div>}</div>}
      <div className="tablefoot"><span>{tab === 'flows' ? '展示货票最新业务进展，非历史出入库流水；库存仍取各自快照。' : '点击商品可核对原始SKU、品名、数量与来源时间。'}</span><span>数量按商品单位展示</span></div>
    </section>
  </div>;
}
