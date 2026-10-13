'use client';

import { useState } from 'react';
import { X, ArrowRight } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { canManageMappings, canViewAmounts, getProductMetrics, isSnapshotAttributable, remainingInTransit } from './model';
import type { DemoData, DemoRole } from './types';
import { dateTime, EmptyState, MappingPill, marketName, money, number, Pill, ProductArt } from './widgets';
import styles from './demo.module.css';

const DETAIL_VIEWS = [
  { id: 'identity', label: '商品身份' },
  { id: 'mappings', label: '来源 SKU 映射' },
  { id: 'snapshots', label: '库存来源与历史' },
  { id: 'shipments', label: '关联货票' },
  { id: 'logs', label: '操作日志' },
] as const;

interface ProductDetailProps {
  data: DemoData;
  productId: string;
  role: DemoRole;
  showAmounts?: boolean;
  mappingAllowed?: boolean;
  onClose: () => void;
  onMapping: (id: string, action: 'confirm' | 'review') => void;
}

export function ProductDetail({ data, productId, role, showAmounts: amountOverride, mappingAllowed, onClose, onMapping }: ProductDetailProps) {
  const [view, setView] = useState<(typeof DETAIL_VIEWS)[number]['id']>('identity');
  const product = data.products.find((entry) => entry.id === productId);
  const showAmounts = amountOverride ?? canViewAmounts(role);
  const mappings = data.mappings.filter((entry) => entry.productId === productId || entry.candidateProductId === productId);
  const mappingIds = new Set(mappings.map((entry) => entry.id));
  const snapshots = data.snapshots.filter((entry) => mappingIds.has(entry.mappingId))
    .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
  const shipments = data.shipments.filter((entry) => entry.productId === productId);
  const logs = data.logs.filter((entry) => product && entry.productCode === product.code);
  const metrics = getProductMetrics(data, productId);

  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent className={`sm:max-w-5xl ${styles.detailDialog}`} showCloseButton={false}>
      <div className={styles.detailHeader}>
        <div>
          <p className={styles.eyebrow}>PRODUCT / TRACEABILITY</p>
          <DialogTitle>{product ? `${product.code} · ${product.name}` : '商品不存在'}</DialogTitle>
          <DialogDescription>虚构商品档案 · 身份、来源、货票与变化记录</DialogDescription>
        </div>
        <button type="button" aria-label="关闭商品详情" className={styles.iconButton} onClick={onClose}><X size={20} /></button>
      </div>
      {!product ? <EmptyState text="找不到该演示商品" /> : <>
        <div className={styles.detailSummary}>
          <div><span>国内实物</span><strong>{number(metrics.domestic)}</strong></div>
          <div><span>海外实物</span><strong>{number(metrics.overseas)}</strong></div>
          <div><span>可售数量</span><strong>{number(metrics.available)}</strong></div>
          <div><span>飞书剩余在途</span><strong>{number(metrics.transit)}</strong></div>
        </div>
        <p className={styles.detailHint}>按商品基本单位「{product.unit}」分别观察，不作跨阶段相加；— 表示无可归集快照或数量未知。</p>
        <nav aria-label="商品详情分区" className={styles.statusTabs}>
          {DETAIL_VIEWS.map((entry) => <button type="button" key={entry.id} aria-pressed={view === entry.id} onClick={() => setView(entry.id)}>{entry.label}</button>)}
        </nav>
        <div className={styles.detailBody}>
          {view === 'identity' && <>
            <div className={styles.identityHero}>
              <ProductArt product={product} large />
              <div><Pill tone="blue">人工维护货号</Pill><h3>{product.name}</h3><p>{product.englishName}</p><small>图片未上传，当前占位不代表真实商品外观。</small></div>
            </div>
            <dl className={styles.identityGrid}>
              <div><dt>公司货号</dt><dd>{product.code}</dd></div>
              <div><dt>69编码（字符串）</dt><dd className={styles.codeCell}>{product.barcode}</dd></div>
              <div><dt>外贸中文名称</dt><dd>{product.foreignName}</dd></div>
              <div><dt>外贸英文名称</dt><dd>{product.englishName}</dd></div>
              <div><dt>规格 / 单位</dt><dd>{product.specification} / {product.unit}</dd></div>
              <div><dt>商品分类</dt><dd>{product.category}</dd></div>
              {showAmounts && <><div><dt>演示标准单位成本</dt><dd>{product.unitCost === null ? <Pill tone="amber">成本待补充，不是零</Pill> : `${money(product.unitCost)} / ${product.unit}`}</dd></div><div><dt>成本版本 / 币种</dt><dd>{product.costVersion} / CNY</dd></div></>}
            </dl>
            <div className={styles.infoBox}><ArrowRight size={18} /><span>公司货号用于业务查找；各市场 SKU 通过独立 Variant 和版本映射汇总。这里不会生成新的公司商品编号。</span></div>
          </>}
          {view === 'mappings' && <>
            <p className={styles.detailHint}>候选仅供复核。重核立即停止当前归集；重新确认也不改写旧快照，等待匹配新版本的快照。</p>
            <div className={styles.tableScroll}><table className={styles.table}>
              <thead><tr><th>市场 / 仓库</th><th>来源 / 账号</th><th>外部 SKU / Variant</th><th>状态 / 版本</th><th>演示操作</th></tr></thead>
              <tbody>{mappings.map((entry) => <tr key={entry.id}>
                <td>{marketName(entry.market)}<small className={styles.cellSub}>{entry.warehouse}</small></td>
                <td>{entry.source}<small className={styles.cellSub}>{entry.account}</small></td>
                <td>{entry.externalSku}<small className={styles.cellSub}>{entry.variantId}</small></td>
                <td><MappingPill status={entry.status} /><small className={styles.cellSub}>v{entry.version}</small></td>
                <td>{entry.status === 'disabled' ? '已停用，保留历史' : (mappingAllowed ?? canManageMappings(role))
                  ? <button type="button" className={styles.smallButton} onClick={() => onMapping(entry.id, entry.status === 'confirmed' ? 'review' : 'confirm')}>{entry.status === 'confirmed' ? '重新核对' : '确认映射'}</button>
                  : <span className={styles.subtle}>当前演示视角只读</span>}</td>
              </tr>)}</tbody>
            </table></div>
          </>}
          {view === 'snapshots' && <>
            <p className={styles.detailHint}>按采集时间倒序。历史冻结当时的身份和数量；候选、旧版本或重核记录只作为来源证据，不能自动归集。</p>
            <div className={styles.tableScroll}><table className={styles.table}>
              <thead><tr><th>来源 / 市场 / SKU</th><th>实物</th><th>可售</th><th>锁定</th><th>来源在途</th><th>批次 / 采集时间</th><th>归集状态</th></tr></thead>
              <tbody>{snapshots.map((entry) => <tr key={entry.id}>
                <td>{entry.source} · {marketName(entry.market)}<small className={styles.cellSub}>{entry.externalSku}</small></td>
                <td>{number(entry.current)}</td><td>{number(entry.available)}</td><td>{number(entry.locked)}</td><td>{number(entry.sourceTransit)}</td>
                <td className={styles.codeCell}>{entry.batchId}<small className={styles.cellSub}>{dateTime(entry.capturedAt)}</small></td>
                <td><Pill tone={!entry.isLatest ? 'neutral' : isSnapshotAttributable(entry, data.mappings) ? 'green' : 'amber'}>{!entry.isLatest ? '历史证据' : isSnapshotAttributable(entry, data.mappings) ? '当前可归集' : '当前不归集'}</Pill><small className={styles.cellSub}>映射 v{entry.mappingVersion}{entry.freshness === 'stale' ? ' · 陈旧' : ''}</small></td>
              </tr>)}</tbody>
            </table></div>
            {snapshots.length === 0 && <EmptyState text="暂无该商品关联的来源快照" />}
          </>}
          {view === 'shipments' && <>
            <p className={styles.detailHint}>业务状态来自飞书演示记录；API 签收不代表库存已增加。</p>
            <div className={styles.tableScroll}><table className={styles.table}>
              <thead><tr><th>货票 / 目的仓</th><th>飞书状态</th><th>发货 / 已到货</th><th>剩余在途</th><th>运单 / 账号</th></tr></thead>
              <tbody>{shipments.map((entry) => <tr key={entry.id}>
                <td>{entry.number}<small className={styles.cellSub}>{entry.warehouse}</small></td><td><Pill tone="blue">{entry.feishuStatus}</Pill></td>
                <td>{number(entry.quantity)} / {number(entry.receivedQuantity)}</td><td>{number(remainingInTransit(entry.quantity, entry.receivedQuantity))}</td>
                <td>{entry.waybill}<small className={styles.cellSub}>{entry.account || '账号缺失 · 待绑定'}</small></td>
              </tr>)}</tbody>
            </table></div>
            {shipments.length === 0 && <EmptyState text="暂无关联货票（演示样本）" />}
          </>}
          {view === 'logs' && <>
            <p className={styles.detailHint}>通过货号关联的演示记录，含本地映射操作；刷新后恢复初始样本。</p>
            <div className={styles.tableScroll}><table className={styles.table}>
              <thead><tr><th>时间 / 操作者</th><th>动作 / 来源</th><th>市场 / 业务标识</th><th>变化依据</th></tr></thead>
              <tbody>{logs.map((entry) => <tr key={entry.id}>
                <td>{dateTime(entry.at)}<small className={styles.cellSub}>{entry.actor}</small></td><td>{entry.action}<small className={styles.cellSub}>{entry.source}{entry.session ? ' · 本次会话' : ''}</small></td>
                <td>{marketName(entry.market)}<small className={styles.cellSub}>{entry.externalSku || entry.shipment || entry.batchId}</small></td><td>{entry.detail}</td>
              </tr>)}</tbody>
            </table></div>
            {logs.length === 0 && <EmptyState text="暂无该商品的演示操作记录" />}
          </>}
        </div>
      </>}
    </DialogContent>
  </Dialog>;
}
