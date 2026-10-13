import type { ReactNode } from 'react';
import { Package, Search, ArrowUpRight } from 'lucide-react';
import { MARKETS, MAPPING_LABELS } from './fixtures';
import type { DemoFilters, DemoProduct, MappingStatus, Market, Valuation } from './types';
import styles from './demo.module.css';

export function number(value: number | null): string {
  return value === null ? '—' : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(value);
}

export function money(value: number | null): string {
  return value === null ? '待补充' : new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(value);
}

export function dateTime(value: string): string {
  return value.slice(0, 16).replace('T', ' ');
}

export function marketName(market: Market): string {
  return MARKETS.find((entry) => entry.id === market)?.short ?? market;
}

export function Pill({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'green' | 'amber' | 'red' | 'blue' }) {
  return <span className={`${styles.pill} ${styles[`pill_${tone}`]}`}>{children}</span>;
}

export function MappingPill({ status }: { status: MappingStatus }) {
  const tones = { confirmed: 'green', pending: 'amber', unmatched: 'neutral', review: 'red', disabled: 'neutral' } as const;
  return <Pill tone={tones[status]}>{MAPPING_LABELS[status]}</Pill>;
}

export function ProductArt({ product, large = false }: { product: DemoProduct; large?: boolean }) {
  return <span className={`${styles.productArt} ${large ? styles.productArtLarge : ''}`} style={{ background: product.color }} aria-label="未上传商品图片，当前为占位图"><Package size={large ? 32 : 20} strokeWidth={1.3} />{large && <small>暂无商品图片</small>}</span>;
}

export function ProductName({ product, onOpen }: { product: DemoProduct; onOpen: (id: string) => void }) {
  return <button type="button" className={styles.productName} onClick={() => onOpen(product.id)}><ProductArt product={product} /><span><strong>{product.name}</strong><small>{product.code} <span className={styles.faint}>/ {product.specification}</span></small></span></button>;
}

export function SectionHeading({ title, eyebrow, action }: { title: string; eyebrow?: string; action?: ReactNode }) {
  return <div className={styles.sectionHeading}><div>{eyebrow && <p className={styles.eyebrow}>{eyebrow}</p>}<h2>{title}</h2></div>{action}</div>;
}

export function TextLink({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return <button type="button" className={styles.textLink} onClick={onClick}>{children}<ArrowUpRight size={14} /></button>;
}

export function EmptyState({ onReset, text = '没有符合条件的记录' }: { onReset?: () => void; text?: string }) {
  return <div className={styles.empty}><Search size={28} strokeWidth={1.4} /><h3>{text}</h3><p>试试其他货号、69编码或外部 SKU，也可以清空筛选。</p>{onReset && <button type="button" className={styles.secondaryButton} onClick={onReset}>清空筛选</button>}</div>;
}

export function ProductFilters({ filters, onChange, onReset, showAmounts }: { filters: DemoFilters; onChange: (filters: DemoFilters) => void; onReset: () => void; showAmounts: boolean }) {
  return <div className={styles.filters}><label className={styles.searchInput}><Search size={16} /><input aria-label="搜索商品" placeholder="搜索货号 / 69编码 / 外部 SKU / 商品名称" value={filters.query} onChange={(event) => onChange({ ...filters, query: event.target.value })} /></label><select aria-label="筛选市场" value={filters.market} onChange={(event) => onChange({ ...filters, market: event.target.value as DemoFilters['market'] })}><option value="all">全部市场</option>{MARKETS.map((market) => <option key={market.id} value={market.id}>{market.name}</option>)}</select><select aria-label="筛选异常" value={filters.exception} onChange={(event) => onChange({ ...filters, exception: event.target.value as DemoFilters['exception'] })}><option value="all">全部状态</option><option value="low">低可售量</option><option value="mapping">映射待处理</option><option value="stale">快照陈旧</option>{showAmounts && <option value="cost">缺少成本</option>}</select><button type="button" className={styles.secondaryButton} onClick={onReset}>清空</button></div>;
}

export function Coverage({ value }: { value: Valuation }) {
  return <span className={styles.coverage}>已知数量成本覆盖 {value.coverage === null ? '—' : `${Math.round(value.coverage * 100)}%`}<span>缺成本 {number(value.missingCostQuantity)} · 未归集 {number(value.unmappedQuantity)}{value.unknownRows > 0 ? ` · 未知 ${value.unknownRows} 行` : ''}</span></span>;
}
