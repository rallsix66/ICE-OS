import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { ReferenceHome, type ReferenceHomeProps } from './reference-home';
import { MARKETS, MAPPING_LABELS } from './fixtures';
import { calculateValuation, canManageMappings, confirmedSnapshots, filterProducts, getProductMetrics, isSnapshotAttributable, latestSnapshots } from './model';
import type { DemoData, DemoFilters, DemoProduct, DemoRole, MappingStatus } from './types';
import { EmptyState, MappingPill, money, number, Pill, ProductFilters, ProductName, SectionHeading, marketName } from './widgets';
import styles from '@/ui/shared/workspace-visual.module.css';

function ProductSignals({ data, product }: { data: DemoData; product: DemoProduct }) {
  const rows = confirmedSnapshots(data, product.id);
  const hasMappingIssue = data.mappings.some((entry) => (entry.productId === product.id || entry.candidateProductId === product.id) && (entry.status !== 'confirmed' || latestSnapshots(data).some((row) => row.mappingId === entry.id && !isSnapshotAttributable(row, data.mappings))));
  if (rows.some((row) => row.market !== 'CN' && row.available !== null && row.available < 100)) return <Pill tone="red">低可售量</Pill>;
  if (rows.some((row) => row.freshness === 'stale')) return <Pill tone="amber">含陈旧快照</Pill>;
  if (hasMappingIssue) return <Pill tone="amber">映射待处理</Pill>;
  return <Pill tone="green">资料可追溯</Pill>;
}

export function OverviewView(props: ReferenceHomeProps) {
  return <ReferenceHome {...props} />;
}

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
