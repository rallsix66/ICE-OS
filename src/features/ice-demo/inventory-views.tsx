import { useState } from 'react';
import { ArrowRight, ArrowUpRight, AlertTriangle, Layers, Package, Ship, Warehouse, Globe2, CircleCheck, Clock3 } from 'lucide-react';
import { MARKETS, MAPPING_LABELS } from './fixtures';
import { calculateValuation, canManageMappings, confirmedSnapshots, filterProducts, getProductMetrics, getOverviewInventory, isSnapshotAttributable, latestSnapshots, remainingInTransit, shipmentValuation } from './model';
import type { DemoData, DemoFilters, DemoProduct, DemoRole, DemoView, MappingStatus, Market, Valuation } from './types';
import { Coverage, EmptyState, MappingPill, money, number, Pill, ProductFilters, ProductName, SectionHeading, TextLink, marketName } from './widgets';
import styles from './demo.module.css';

function ValueCard({ label, value, icon, showAmounts, onClick, hasData = true }: { hasData?: boolean; label: string; value: Valuation; icon: 'domestic' | 'transit' | 'overseas'; showAmounts: boolean; onClick: () => void }) {
  const Icon = icon === 'domestic' ? Warehouse : icon === 'transit' ? Ship : Globe2;
  return <button type="button" className={styles.valueCard} onClick={onClick} disabled={!hasData}><div className={styles.valueCardTop}><span>{label}{showAmounts ? '估算货值' : '来源记录数量'}</span><Icon size={19} /></div><strong className={styles.amount}>{!hasData ? '暂无有效记录' : showAmounts ? money(value.knownValue) : number(value.totalQuantity)}</strong><p>{showAmounts ? '人民币 · 已估值小计' : '按商品基本销售单元计数'}</p>{showAmounts ? <Coverage value={value} /> : <span className={styles.coverage}>未归集 {number(value.unmappedQuantity)}<span>缺失、陈旧和映射状态需单独核对</span></span>}<ArrowUpRight className={styles.cardArrow} size={16} /></button>;
}

function ProductSignals({ data, product }: { data: DemoData; product: DemoProduct }) {
  const rows = confirmedSnapshots(data, product.id);
  const hasMappingIssue = data.mappings.some((entry) => (entry.productId === product.id || entry.candidateProductId === product.id) && (entry.status !== 'confirmed' || latestSnapshots(data).some((row) => row.mappingId === entry.id && !isSnapshotAttributable(row, data.mappings))));
  if (rows.some((row) => row.market !== 'CN' && row.available !== null && row.available < 100)) return <Pill tone="red">低可售量</Pill>;
  if (rows.some((row) => row.freshness === 'stale')) return <Pill tone="amber">含陈旧快照</Pill>;
  if (hasMappingIssue) return <Pill tone="amber">映射待处理</Pill>;
  return <Pill tone="green">资料可追溯</Pill>;
}

export function OverviewView({ data, showAmounts, onBrowse, onNavigate, onOpenProduct }: { data: DemoData; showAmounts: boolean; onBrowse: (market?: Market | 'all', exception?: DemoFilters['exception']) => void; onNavigate: (view: DemoView) => void; onOpenProduct: (id: string) => void }) {
  const raw = latestSnapshots(data);
  const stock = getOverviewInventory(data);
  const domestic = calculateValuation(raw.filter((row) => row.market === 'CN'), data.products, data.mappings);
  const overseas = calculateValuation(raw.filter((row) => row.market !== 'CN'), data.products, data.mappings);
  const transit = shipmentValuation(data);
  const lowProducts = filterProducts(data, { query: '', market: 'all', exception: 'low' });
  const mappingCount = raw.filter((row) => !isSnapshotAttributable(row, data.mappings)).length;
  const staleCount = raw.filter((row) => row.freshness === 'stale').length;
  const activeTickets = data.shipments.filter((row) => remainingInTransit(row.quantity, row.receivedQuantity) > 0).length;
  const distributions = MARKETS.filter((market) => market.id !== 'CN').map((market) => ({ ...market, value: calculateValuation(raw.filter((row) => row.market === market.id), data.products, data.mappings) }));
  const chartTotal = distributions.reduce((sum, row) => sum + (showAmounts ? row.value.knownValue : row.value.totalQuantity), 0);

  return <>
    <div className={styles.overviewIntro}><span><span className={styles.liveDot} />四源独立观察，商品身份统一追溯</span><span>来源时间并未全部对齐 <Pill tone="amber">跨阶段合计待核对</Pill></span></div>
    <div className={styles.valueGrid}><ValueCard hasData={raw.some((row) => row.market === 'CN')} label="国内" value={domestic} icon="domestic" showAmounts={showAmounts} onClick={() => onBrowse('CN')} /><ValueCard hasData={data.shipments.length > 0} label="在途" value={transit} icon="transit" showAmounts={showAmounts} onClick={() => onNavigate('logistics')} /><ValueCard hasData={raw.some((row) => row.market !== 'CN')} label="海外" value={overseas} icon="overseas" showAmounts={showAmounts} onClick={() => onBrowse()} /><div className={styles.valueExplanation}><div className={styles.explanationIcon}><Layers size={20} /></div><strong>看清分项，不猜总量</strong><p>飞书到货不会增加海外库存；BigSeller 新快照才改变来源数量。</p><button type="button" onClick={() => onNavigate('logistics')}>体验流转场景 <ArrowRight size={15} /></button></div></div>
    <div className={styles.summaryStrip}>
      <button type="button" disabled={stock.domestic === null} onClick={() => onBrowse('CN')}><span>国内实物库存</span><strong>{number(stock.domestic)}<small>销售单元</small></strong><span>聚水潭最近有效快照</span></button>
      <button type="button" onClick={() => onBrowse()}><span>海外实物库存</span><strong>{number(stock.overseas)}<small>销售单元</small></strong><span>含 {staleCount} 条陈旧来源记录</span></button>
      <button type="button" onClick={() => onBrowse('all', 'low')}><span>海外可售库存</span><strong>{number(stock.overseasAvailable)}<small>销售单元</small></strong><span>{lowProducts.length} 款商品可售量较低</span></button>
      <button type="button" onClick={() => onNavigate('logistics')}><span>飞书剩余在途</span><strong>{number(stock.transit)}<small>销售单元</small></strong><span>{activeTickets} 票未完成货票 · 不加到海外库存</span></button>
    </div>
    <div className={styles.overviewColumns}>
      <section className={styles.panel}><SectionHeading title={showAmounts ? '海外市场货值分布' : '海外市场数量分布'} eyebrow="MARKET DISTRIBUTION" action={<span className={styles.subtle}>{showAmounts ? '仅已估值海外实物 · 不含在途' : '原始实物记录 · 不含在途'}</span>} /><div className={styles.stackedBar} aria-label="市场占比">{distributions.map((market) => <span key={market.id} style={{ width: `${chartTotal === 0 ? 0 : (showAmounts ? market.value.knownValue : market.value.totalQuantity) / chartTotal * 100}%`, background: market.color }} />)}</div><div className={styles.marketRows}>{distributions.map((market) => { const amount = showAmounts ? market.value.knownValue : market.value.totalQuantity; return <button type="button" key={market.id} className={styles.marketRow} onClick={() => onBrowse(market.id)}><span className={styles.countryCode} style={{ color: market.color }}>{market.id}</span><span className={styles.marketLabel}><strong>{market.name}</strong><small>{showAmounts ? `估值覆盖 ${Math.round((market.value.coverage ?? 0) * 100)}%` : `未归集 ${number(market.value.unmappedQuantity)}`}{market.id === 'ID' ? ' · 来源陈旧' : ''}</small></span><div className={styles.marketTrack}><span style={{ width: `${chartTotal === 0 ? 0 : amount / chartTotal * 100}%`, background: market.color }} /></div><span className={styles.marketAmount}>{showAmounts ? money(amount) : number(amount)}<small>{chartTotal === 0 ? '—' : `${Math.round(amount / chartTotal * 100)}%`}</small></span><ArrowUpRight size={14} /></button>; })}</div></section>
      <section className={styles.panel}><SectionHeading title="今天需要关注" eyebrow="ATTENTION CENTER" action={<span className={styles.attentionDot} />} /><div className={styles.attentionList}><button type="button" onClick={() => onNavigate('products')}><span className={`${styles.attentionIcon} ${styles.amber}`}><Package size={17} /></span><span><strong>商品身份待复核</strong><small>原始数量保留，未进入商品归集</small></span><b>{mappingCount}</b><ChevronArrow /></button><button type="button" onClick={() => onNavigate('snapshots')}><span className={`${styles.attentionIcon} ${styles.amber}`}><Clock3 size={17} /></span><span><strong>印尼快照陈旧</strong><small>新批次失败，沿用10月10日成功值</small></span><b>{staleCount}</b><ChevronArrow /></button>{showAmounts && <button type="button" onClick={() => onBrowse('all', 'cost')}><span className={`${styles.attentionIcon} ${styles.blue}`}><Layers size={17} /></span><span><strong>成本资料待补充</strong><small>不把缺失成本当作零成本</small></span><b>{data.products.filter((row) => row.unitCost === null).length}</b><ChevronArrow /></button>}<button type="button" onClick={() => onNavigate('logistics')}><span className={`${styles.attentionIcon} ${styles.blue}`}><Ship size={17} /></span><span><strong>运单等待绑定</strong><small>来源账号缺失，未自动认领</small></span><b>{data.shipments.filter((row) => row.binding === 'pending').length}</b><ChevronArrow /></button></div><div className={styles.attentionNote}><CircleCheck size={15} /><span>异常有依据，修正有记录。</span><TextLink onClick={() => onNavigate('logs')}>查看日志</TextLink></div></section>
    </div>
    <section className={styles.panel}><SectionHeading title={`商品库存概览 · ${data.products.length} 款`} eyebrow="INVENTORY AT A GLANCE" action={<TextLink onClick={() => onBrowse()}>全部商品库存</TextLink>} />
      <div className={styles.tableScroll}><table className={styles.table}><thead><tr><th>商品 / 货号 / 69编码</th><th>国内实物</th><th>海外实物 / 可售</th><th>飞书在途</th>{showAmounts && <th>库存已估值</th>}<th>来源核对</th></tr></thead>
      <tbody>{data.products.map((product) => { const metrics = getProductMetrics(data, product.id); return <tr key={product.id}>
        <td><ProductName product={product} onOpen={onOpenProduct} /><small className={styles.cellSub}>69 · {product.barcode}</small></td>
        <td>{number(metrics.domestic)}<small className={styles.cellSub}>{product.unit}</small></td>
        <td>{number(metrics.overseas)} {product.unit}<small className={styles.cellSub}>可售 {number(metrics.overseasAvailable)} {product.unit}</small></td>
        <td>{number(metrics.transit)} {product.unit}</td>
        {showAmounts && <td>{product.unitCost === null ? <Pill tone="amber">成本待补充</Pill> : metrics.domestic === null && metrics.overseas === null ? '—' : metrics.valuation.unknownRows > 0 ? '部分数量待核对' : money(metrics.valuation.knownValue)}</td>}
        <td><button type="button" className={styles.smallButton} onClick={() => onOpenProduct(product.id)}>查看库存来源</button></td>
      </tr>; })}</tbody></table></div>
      <p className={styles.tableFootnote}>数量以各商品基本销售单位观察，— 不等于零。已估值仅含可归集的国内/海外实物，不含在途；三阶段不直接相加。</p>
    </section>
  </>;
}

function ChevronArrow() { return <ArrowUpRight size={14} className={styles.faint} />; }

interface ProductListProps { data: DemoData; showAmounts: boolean; filters: DemoFilters; onFilters: (filters: DemoFilters) => void; onReset: () => void; onOpenProduct: (id: string) => void }

export function InventoryView({ data, showAmounts, filters, onFilters, onReset, onOpenProduct }: ProductListProps) {
  const products = filterProducts(data, filters);
  const unassigned = latestSnapshots(data, filters.market).filter((row) => !isSnapshotAttributable(row, data.mappings));
  return <><ProductFilters filters={filters} onChange={onFilters} onReset={onReset} showAmounts={showAmounts} markets={MARKETS.filter((entry) => data.mappings.some((mapping) => mapping.market === entry.id)).map((entry) => entry.id)} /><section className={styles.panel}><SectionHeading title={`商品库存 · ${products.length} 款`} action={<span className={styles.subtle}>实物口径 / 当前有效映射 / — 表示无有效快照</span>} />{products.length === 0 ? <EmptyState onReset={onReset} /> : <div className={styles.tableScroll}><table className={`${styles.table} ${styles.inventoryTable}`}><thead><tr><th>商品 / 公司货号</th><th>69编码</th>{MARKETS.map((market) => <th key={market.id}>{market.short}</th>)}<th>飞书在途</th>{showAmounts && <th>海外已估值</th>}<th>状态</th></tr></thead><tbody>{products.map((product) => { const metrics = getProductMetrics(data, product.id); const value = calculateValuation(confirmedSnapshots(data, product.id).filter((row) => row.market !== 'CN'), data.products, data.mappings); return <tr key={product.id}><td><ProductName product={product} onOpen={onOpenProduct} /></td><td className={styles.codeCell}>{product.barcode}</td>{MARKETS.map((market) => <td key={market.id} className={filters.market === market.id ? styles.highlightCell : ''} title={metrics.byMarket[market.id] === null ? '无当前可归集的有效快照，不能视为零库存' : `基本单位：${product.unit}`}>{number(metrics.byMarket[market.id])}</td>)}<td className={styles.indigoText}>{number(metrics.transit)}</td>{showAmounts && <td>{product.unitCost === null ? <Pill tone="amber">缺成本</Pill> : value.totalQuantity === 0 ? '—' : money(value.knownValue)}</td>}<td><ProductSignals data={data} product={product} /></td></tr>; })}</tbody></table></div>}<p className={styles.tableFootnote}>市场筛选定位关联商品，表内保留该商品各市场对照。可售、锁定及批次明细请点击商品查看；未估值不等于零货值。</p></section><div className={styles.infoBox}><AlertTriangle size={18} /><span><strong>{unassigned.length} 条来源记录暂未归集</strong> · 原始实物 {number(unassigned.reduce((total, row) => total + (row.current ?? 0), 0))} 个销售单元保留在快照区。映射确认后仍需新版本快照，不能重写历史。</span></div></>;
}

export function ProductsView({ data, showAmounts, filters, onFilters, onReset, onOpenProduct, role, onMapping, mappingAllowed = canManageMappings(role) }: ProductListProps & { role: DemoRole; mappingAllowed?: boolean; onMapping: (id: string, action: 'confirm' | 'review') => void }) {
  const [section, setSection] = useState<'catalog' | 'mapping'>('catalog');
  const [mappingStatus, setMappingStatus] = useState<MappingStatus | 'all'>('all');
  const products = filterProducts(data, filters);
  const visibleIds = new Set(products.map((product) => product.id));
  const relevantMappings = data.mappings.filter((row) => visibleIds.has(row.productId ?? row.candidateProductId ?? '') && (filters.market === 'all' || row.market === filters.market));
  const mappings = relevantMappings.filter((row) => mappingStatus === 'all' || row.status === mappingStatus).sort((a, b) => Number(a.status === 'confirmed') - Number(b.status === 'confirmed'));
  return <>
    <div className={styles.sectionTabs} aria-label="商品库分区"><button type="button" aria-pressed={section === 'catalog'} onClick={() => setSection('catalog')}>商品资料</button><button type="button" aria-pressed={section === 'mapping'} onClick={() => setSection('mapping')}>来源映射复核</button></div>
    <ProductFilters filters={filters} onChange={onFilters} onReset={onReset} showAmounts={showAmounts} markets={MARKETS.filter((entry) => data.mappings.some((mapping) => mapping.market === entry.id)).map((entry) => entry.id)} />
    {section === 'catalog' ? <section className={styles.panel}>
      <SectionHeading title={`商品资料 · ${products.length} 款`} action={<span className={styles.subtle}>每行一款商品，点击查看完整身份与来源</span>} />
      <div className={styles.tableScroll}><table className={styles.table}><thead><tr><th>商品 / 公司货号</th><th>69编码</th><th>外贸中文 / 英文名称</th><th>规格 / 单位 / 分类</th><th>来源对应关系</th>{showAmounts && <th>单位参考成本</th>}<th /></tr></thead><tbody>
        {products.map((product) => {
          const bindings = data.mappings.filter((mapping) => mapping.productId === product.id || mapping.candidateProductId === product.id);
          return <tr key={product.id}><td><ProductName product={product} onOpen={onOpenProduct} /></td><td className={styles.codeCell}>{product.barcode}</td><td>{product.foreignName}<small className={styles.cellSub}>{product.englishName}</small></td><td>{product.specification} / {product.unit}<small className={styles.cellSub}>{product.category}</small></td><td>{bindings.filter((mapping) => mapping.status === 'confirmed').length} 条已确认<small className={styles.cellSub}>{bindings.filter((mapping) => mapping.status !== 'confirmed').length} 条待处理 / 停用</small></td>{showAmounts && <td>{product.unitCost === null ? '成本待补充' : `${money(product.unitCost)} / ${product.unit}`}</td>}<td><button type="button" className={styles.smallButton} onClick={() => onOpenProduct(product.id)}>商品详情</button></td></tr>;
        })}
      </tbody></table>{products.length === 0 && <EmptyState onReset={onReset} />}</div>
      <p className={styles.tableFootnote}>商品资料是统一身份档案，库存另在“商品库存”查看；来源SKU对应关系在“来源映射复核”处理。</p>
    </section> : <section className={styles.panel}>
      <SectionHeading title="来源映射复核台" action={<span className={styles.subtle}>确认身份与查看资料分开处理</span>} />
      <div className={styles.statusTabs}><button type="button" onClick={() => setMappingStatus('all')} aria-pressed={mappingStatus === 'all'}>全部 {relevantMappings.length}</button>{(Object.keys(MAPPING_LABELS) as MappingStatus[]).map((status) => <button type="button" key={status} onClick={() => setMappingStatus(status)} aria-pressed={mappingStatus === status}>{MAPPING_LABELS[status]} <span>{relevantMappings.filter((row) => row.status === status).length}</span></button>)}</div>
      <div className={`${styles.tableScroll} ${styles.mappingScroll}`}><table className={styles.table}><thead><tr><th>来源 / 账号</th><th>市场 / 外部 SKU</th><th>确认商品或候选</th><th>映射状态</th><th>版本</th><th>本地演示操作</th></tr></thead><tbody>
        {mappings.map((mapping) => { const product = data.products.find((row) => row.id === (mapping.productId ?? mapping.candidateProductId)); return <tr key={mapping.id}>
          <td>{mapping.source}<small className={styles.cellSub}>{mapping.account}</small></td><td>{marketName(mapping.market)}<small className={styles.cellSub}>{mapping.externalSku}</small></td>
          <td>{product ? <button type="button" className={styles.inlineLink} onClick={() => onOpenProduct(product.id)}>{product.code}<small className={styles.cellSub}>{product.name}{mapping.status !== 'confirmed' ? ' · 待审核身份' : ''}</small></button> : '无候选'}</td>
          <td><MappingPill status={mapping.status} /></td><td className={styles.codeCell}>v{mapping.version}</td><td>{mapping.status === 'disabled' ? <span className={styles.subtle}>保留历史</span> : mappingAllowed ? <button type="button" className={mapping.status === 'confirmed' ? styles.smallButton : styles.smallPrimary} onClick={() => onMapping(mapping.id, mapping.status === 'confirmed' ? 'review' : 'confirm')}>{mapping.status === 'confirmed' ? '重新核对' : '确认映射'}</button> : <span className={styles.subtle}>当前演示角色只读</span>}</td>
        </tr>; })}
      </tbody></table>{mappings.length === 0 && <EmptyState text="当前状态下没有映射记录" onReset={() => { onReset(); setMappingStatus('all'); }} />}</div>
      <p className={styles.tableFootnote}>确认 / 重核只改变本地映射及操作日志。历史快照固定当时身份；新映射版本仍须等待新快照。</p>
    </section>}
  </>;
}
