import { useState } from 'react';
import { Search } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { MARKETS } from './fixtures';
import { getScenarioFacts, remainingInTransit } from './model';
import { filterShipments, latestTrackingEvent } from './settings-model';
import { LogisticsView } from './operations-views';
import type { DemoData, Market, ScenarioId, ShipmentFilters, ShipmentStatusFilter } from './types';
import { EmptyState, marketName, money, number, Pill, SectionHeading } from './widgets';
import styles from '@/ui/shared/workspace-visual.module.css';

const STATUS_TABS: { id: ShipmentStatusFilter; label: string }[] = [
  { id: 'all', label: '全部货票' }, { id: 'active', label: '运输在途' },
  { id: 'soon', label: '7天内预计到货' }, { id: 'pending', label: '运单待绑定' }, { id: 'completed', label: '已到货上架' },
];
const SCENARIOS: ScenarioId[] = ['shipping', 'arrived', 'snapshot', 'reverse'];

export function MarketLogisticsView({ data, markets, scenario, onScenario, showAmounts, onOpenProduct }: {
  data: DemoData; markets: Market[]; scenario: ScenarioId; onScenario: (id: ScenarioId) => void;
  showAmounts: boolean; onOpenProduct: (id: string) => void;
}) {
  const [filters, setFilters] = useState<ShipmentFilters>({ market: 'all', status: 'all', query: '' });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const shipments = filterShipments(data, filters);
  const selected = data.shipments.find((row) => row.id === selectedId);
  const scoped = filterShipments(data, { ...filters, status: 'all' });
  const pending = scoped.filter((row) => row.binding === 'pending').length;
  const active = scoped.filter((row) => row.receivedQuantity < row.quantity).length;
  function reset() { setFilters({ market: 'all', status: 'all', query: '' }); }
  return <>
    <section className={styles.panel}>
      <SectionHeading title="按市场集中查看物流" action={<span className={styles.subtle}>先看所有货票，再打开单票详情</span>} />
      <div className={styles.marketTabs} aria-label="物流市场">
        <button type="button" aria-pressed={filters.market === 'all'} onClick={() => setFilters({ ...filters, market: 'all' })}>全部市场 <b>{data.shipments.length}</b></button>
        {MARKETS.filter((market) => market.id !== 'CN' && markets.includes(market.id)).map((market) => <button type="button" key={market.id} aria-pressed={filters.market === market.id} onClick={() => setFilters({ ...filters, market: market.id })}>{market.name} <b>{data.shipments.filter((row) => row.market === market.id).length}</b></button>)}
      </div>
      <div className={styles.marketSummary}><strong>{filters.market === 'all' ? '全部可见市场' : `${marketName(filters.market)}市场`}</strong><span>{scoped.length} 票</span><span>在途 {active} 票</span><span>已到货 {scoped.length - active} 票</span><span>待绑定 {pending} 票</span><small>按当前搜索范围；不同商品单位不强行相加</small></div>
    </section>
    <section className={styles.panel}>
      <div className={styles.statusTabs} aria-label="物流状态分类">{STATUS_TABS.map((status) => <button type="button" key={status.id} aria-pressed={filters.status === status.id} onClick={() => setFilters({ ...filters, status: status.id })}>{status.label} <span>{filterShipments(data, { ...filters, status: status.id }).length}</span></button>)}</div>
      <div className={`${styles.filters} ${styles.panelFilters}`}><label className={styles.searchInput}><Search size={16} /><input aria-label="搜索物流货票" value={filters.query} placeholder="货票 / 运单 / 货号 / 69编码 / 商品 / 备注" onChange={(event) => setFilters({ ...filters, query: event.target.value })} /></label><button type="button" className={styles.secondaryButton} onClick={reset}>清空物流筛选</button><span className={styles.subtle}>{shipments.length} 票 · 按预计到仓排序</span></div>
      <div className={styles.tableScroll}><table className={`${styles.table} ${styles.logisticsTable}`}>
        <thead><tr><th>货票 / 运单</th><th>商品 / 剩余在途</th><th>市场 / 预计到仓</th><th>飞书 · 业务状态与备注</th><th>喜运达 · 最近轨迹</th>{showAmounts && <th>在途已估值</th>}<th /></tr></thead>
        <tbody>{shipments.map((shipment) => {
          const product = data.products.find((row) => row.id === shipment.productId)!;
          const event = latestTrackingEvent(shipment);
          const remaining = remainingInTransit(shipment.quantity, shipment.receivedQuantity);
          return <tr key={shipment.id}>
            <td><button type="button" className={styles.inlineLink} onClick={() => setSelectedId(shipment.id)}>{shipment.number}</button><small className={styles.cellSub}>{shipment.waybill}</small></td>
            <td><button type="button" className={styles.inlineLink} onClick={() => onOpenProduct(product.id)}>{product.code} · {product.name}</button><small className={styles.cellSub}>剩余 {number(remaining)} {product.unit} / 发出 {number(shipment.quantity)} {product.unit}</small></td>
            <td>{marketName(shipment.market)}<small className={styles.cellSub}>{shipment.eta}</small></td>
            <td><Pill tone={remaining === 0 ? 'green' : 'blue'}>{shipment.feishuStatus}</Pill><small className={`${styles.cellSub} ${styles.wrappedNote}`}>{shipment.note}</small></td>
            <td><Pill tone={shipment.binding === 'pending' ? 'amber' : 'neutral'}>{shipment.binding === 'pending' ? '轨迹待绑定' : event?.text ?? '暂无轨迹'}</Pill><small className={styles.cellSub}>{event?.at ?? (shipment.account || '来源账号缺失')}</small></td>
            {showAmounts && <td>{remaining === 0 ? '在途已结束' : product.unitCost === null ? '成本待补充' : money(remaining * product.unitCost)}</td>}
            <td><button type="button" className={styles.smallButton} aria-label={`查看货票${shipment.number}`} onClick={() => setSelectedId(shipment.id)}>详情</button></td>
          </tr>;
        })}</tbody>
      </table>{shipments.length === 0 && <EmptyState text="当前市场和条件下没有物流记录" onReset={reset} />}</div>
      <p className={styles.tableFootnote}>市场、状态和搜索同时生效。到货货票保留可查，不再计入在途；飞书与API分别展示，不推定库存已增加。</p>
    </section>
    {markets.includes('TH') && <details className={styles.flowDemo}><summary>演示：飞书到货与库存快照如何分开</summary><p>仅切换泰国示例货票 DEMO-TH-1013 的观察场景，不执行同步。收起后可专注市场物流列表。</p><div className={styles.buttonRow}>{SCENARIOS.map((id) => <button type="button" key={id} className={styles.smallButton} aria-pressed={scenario === id} onClick={() => onScenario(id)}>{getScenarioFacts(id).label}</button>)}</div></details>}
    <Dialog open={!!selected} onOpenChange={(open) => { if (!open) setSelectedId(null); }}><DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-5xl"><DialogHeader><DialogTitle>货票详情 · {selected?.number}</DialogTitle><DialogDescription>保留市场筛选。关闭后返回同一物流列表，不跳到其他市场。</DialogDescription></DialogHeader>
      {selected && <div className={styles.detailContent}><LogisticsView embedded data={{ ...data, shipments: [selected] }} scenario={scenario} onScenario={onScenario} showAmounts={showAmounts} onOpenProduct={(id) => { setSelectedId(null); onOpenProduct(id); }} /></div>}
    </DialogContent></Dialog>
  </>;
}
